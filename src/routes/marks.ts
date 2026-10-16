
// src/routes/marks.ts  — PATCHED
// Key fixes:
//   1. Added POST /marks/upload-direct route so client's templateMode="direct" upload works
//   2. Added detailed console logging around the template-detection switch
//   3. Error handler now logs the full stack before rethrowing
import { Router, Response } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import type { AuthenticatedRequest } from "../middleware/auth";
import { generateFullScoresheetTemplate } from "../utils/uploadTemplate";
import { uploadMarksFile } from "../middleware/upload";
import { importMarksFromBuffer } from "../services/marksImporter";
import { logAudit } from "../lib/auditLogger";
import mongoose from "mongoose";
import fs from "fs";
import * as xlsx from "xlsx";
import path from "path";
import Unit from "../models/Unit";
import { generateDirectScoresheetTemplate } from "../utils/directTemplate";
import { importDirectMarksFromBuffer } from "../services/directMarksImporter";
import AcademicYear from "../models/AcademicYear";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import { loadLogoBuffer } from "../utils/loadLogoBuffer";
import { randomUUID } from "node:crypto";
import Program from "../models/Program";
import { getScopedProgramIds } from "../middleware/auth";
import Student from "../models/Student";
import ProblemResult from "../models/ProblemResult";
import ProgramUnit from "../models/ProgramUnit";
import FinalGrade from "../models/FinalGrade";
import { retryProblems } from "../services/resultUpload";
import { buildDisplayRegNo } from "../utils/academicRules";
import { parseDistribution } from "../utils/markDistribution";
import { cleanRegNo, loadExistingByBase, splitRegNo } from "../utils/regNoQualifier";

/** "E024-01-1/2024, E024-01-2/2024\nE024-01-3/2024" → clean reg nos */
const parseRegNoList = (v: unknown): string[] =>
  [...new Set(String(v ?? "").split(/[\s,;]+/).map(cleanRegNo).filter(Boolean))].slice(0, 200);

/** Reads ?caMax=&examMax= ; null = use the unit default. Throws a 400-able Error. */
function distributionFromQuery(q: Record<string, unknown>) {
  const parsed = parseDistribution({ caMax: q.caMax, examMax: q.examMax });
  if ("error" in parsed) throw new Error(`invalid: ${parsed.error}`);
  return parsed.distribution;
}

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /marks/template   — Detailed breakdown scoresheet
// ─────────────────────────────────────────────────────────────────────────────
router.get("/template", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, unitId, academicYearId, yearOfStudy, semester, examMode, unitType } = req.query;

    if (!programId || !unitId || !academicYearId || !yearOfStudy || !semester) {
      return res.status(400).json({
        error: "Missing required parameters: programId, unitId, academicYearId, yearOfStudy, semester",
      });
    }

    try {
      if (
        !mongoose.Types.ObjectId.isValid(programId as string) ||
        !mongoose.Types.ObjectId.isValid(unitId as string) ||
        !mongoose.Types.ObjectId.isValid(academicYearId as string)
      ) {
        throw new Error("One or more provided IDs (programId, unitId, academicYearId) are invalid.");
      }

      const [unit, academicYear] = await Promise.all([
        Unit.findById(unitId).lean(),
        AcademicYear.findById(academicYearId).lean(),
      ]);

      if (!academicYear) throw new Error("Academic Year not found.");

      const rawCode   = (unit?.code || "UNIT").trim();
      const rawName   = (unit?.name || "TEMPLATE").trim();
      const yearLabel = (academicYear.year || "YEAR").trim().replace(/\//g, "-");
      const cleanName = `${rawCode}_${rawName}`
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        ?.toUpperCase() || "TEMPLATE";

      const fileName  = `Scoresheet_${cleanName}_${yearLabel}.xlsx`;
      // const logoPath  = path.join(__dirname, "../../public/institutionLogoExcel.png");
      // const logoBuffer = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : Buffer.alloc(0);
      const institutionId = req.user.institution.toString();
      const logoBuffer    = await loadLogoBuffer(institutionId);

      const distribution = distributionFromQuery(req.query);
      const extraRegNos  = parseRegNoList(req.query.extraRegNos);
      if (distribution && req.query.saveDistribution === "true") {
        await Unit.updateOne({ _id: unitId }, { $set: { markDistribution: distribution } });
      }
      if (extraRegNos.length) {
        const known = await loadExistingByBase(Student, institutionId, extraRegNos.map((r) => splitRegNo(r).base));
        const unknown = extraRegNos.filter((r) => !known.has(splitRegNo(r).base));
        if (unknown.length) res.header("X-Unknown-RegNos", encodeURIComponent(unknown.join(",")));
      }

      const excelBuffer = await generateFullScoresheetTemplate(
        new mongoose.Types.ObjectId(programId as string),
        new mongoose.Types.ObjectId(unitId as string),
        parseInt(yearOfStudy as string, 10),
        parseInt(semester as string, 10),
        new mongoose.Types.ObjectId(academicYearId as string),
        logoBuffer,
        examMode as string,
        (unitType as any) || "theory",
        distribution,
        extraRegNos,
      );

      res
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Access-Control-Expose-Headers", "Content-Disposition, X-Unknown-RegNos")
         .attachment(fileName)
        .send(excelBuffer);
    } catch (error: any) {
      console.error("[GET /marks/template] Error:", error.message, error.stack);
     
      if (error.message === "Institution settings not found.") {
        return res.status(400).json({
          message:
            "Institution settings are not configured. Please contact the administrator.",
          error: error.message,
        });
      }
    
      const status = error.message.includes("invalid") ? 400 : 500;
      // return res.status(status).json({ message: "Failed to generate scoresheet template.", error: error.message });
      return res.status(status).json({ message: error.message, error: error.message });
    
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /marks/direct-template   — Direct entry scoresheet
// ─────────────────────────────────────────────────────────────────────────────
router.get("/direct-template", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, unitId, academicYearId, yearOfStudy, semester, examMode, unitType } = req.query;

    if (!programId || !unitId || !academicYearId || !yearOfStudy || !semester) {
      return res.status(400).json({
        error: "Missing required parameters: programId, unitId, academicYearId, yearOfStudy, semester",
      });
    }

    try {
      if (
        !mongoose.Types.ObjectId.isValid(programId as string) ||
        !mongoose.Types.ObjectId.isValid(unitId as string) ||
        !mongoose.Types.ObjectId.isValid(academicYearId as string)
      ) {
        throw new Error("One or more provided IDs (programId, unitId, academicYearId) are invalid.");
      }

      const [unit, academicYear] = await Promise.all([
        Unit.findById(unitId).lean(),
        AcademicYear.findById(academicYearId).lean(),
      ]);

      if (!academicYear) throw new Error("Academic Year not found.");

      const rawCode   = (unit?.code || "UNIT").trim();
      const rawName   = (unit?.name || "TEMPLATE").trim();
      const yearLabel = (academicYear.year || "YEAR").trim().replace(/\//g, "-");
      const cleanName = `${rawCode}_${rawName}`
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        ?.toUpperCase() || "TEMPLATE";

      const fileName   = `Scoresheet_${cleanName}_${yearLabel}.xlsx`;
      // const logoPath   = path.join(__dirname, "../../public/institutionLogoExcel.png");
      // const logoBuffer = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : Buffer.alloc(0);
      const institutionId = req.user.institution.toString();
      const logoBuffer = await loadLogoBuffer(institutionId);
      
      const distribution = distributionFromQuery(req.query);
      const extraRegNos  = parseRegNoList(req.query.extraRegNos);
      if (distribution && req.query.saveDistribution === "true") {
        await Unit.updateOne({ _id: unitId }, { $set: { markDistribution: distribution } });
      }
      if (extraRegNos.length) {
        const known = await loadExistingByBase(Student, institutionId, extraRegNos.map((r) => splitRegNo(r).base));
        const unknown = extraRegNos.filter((r) => !known.has(splitRegNo(r).base));
        if (unknown.length) res.header("X-Unknown-RegNos", encodeURIComponent(unknown.join(",")));
      }

      const buffer = await generateDirectScoresheetTemplate(
        new mongoose.Types.ObjectId(programId as string),
        new mongoose.Types.ObjectId(unitId as string),
        parseInt(yearOfStudy as string, 10),
        parseInt(semester as string, 10),
        new mongoose.Types.ObjectId(academicYearId as string),
        logoBuffer,
        distribution,
        extraRegNos,
        (["theory", "lab", "workshop"].includes(String(unitType)) ? unitType : "theory") as "theory" | "lab" | "workshop",
        examMode === "mandatory_q1" ? "mandatory_q1" : "standard",
      );

      res
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Access-Control-Expose-Headers", "Content-Disposition, X-Unknown-RegNos")
        .attachment(fileName)
        .send(buffer);
    } catch (error: any) {
      console.error("[GET /marks/direct-template] Error:", error.message, error.stack);
      
      if (error.message === "Institution settings not found.") {
        return res.status(400).json({
          message:
            "Institution settings are not configured. Please contact the administrator.",
          error: error.message,
        });
      }
    
      const status = error.message.includes("invalid") ? 400 : 500;
      // return res.status(status).json({ message: "Failed to generate direct template.", error: error.message });
      return res
        .status(status)
        .json({ message: error.message, error: error.message });

    }
  }),
);

// // ─────────────────────────────────────────────────────────────────────────────
// // GET /marks/upload-stats
// // ─────────────────────────────────────────────────────────────────────────────
// router.get("/upload-stats", requireAuth,
//   requireRole("coordinator", "admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const institutionId = req.user.institution;

//     const [detailedRaw, directRaw] = await Promise.all([
//       Mark.find({ institution: institutionId, deletedAt: null })
//         .populate({ path: "programUnit", populate: [{ path: "unit", select: "code name" }, { path: "program", select: "name code" }] })
//         .populate("academicYear", "year session")
//         .populate("student", "regNo name")
//         .sort({ createdAt: -1 })
//         .lean(),

//       MarkDirect.find({ institution: institutionId, deletedAt: null })
//         .populate({ path: "programUnit", populate: [{ path: "unit", select: "code name" }, { path: "program", select: "name code" }] })
//         .populate("academicYear", "year session")
//         .populate("student", "regNo name")
//         .sort({ createdAt: -1 })
//         .lean(),
//     ]);

//     interface MarkEntry {
//       _id: string; source: "detailed" | "direct"; regNo: string; studentName: string;
//       unitCode: string; unitName: string; programName: string; programCode: string;
//       agreedMark: number; attempt: string; isSpecial: boolean;
//       academicYear: string; session: string; uploadedAt: Date;
//     }

//     const shape = (m: any, source: "detailed" | "direct"): MarkEntry => ({
//       _id:         m._id.toString(),
//       source,
//       regNo:       (m.student as any)?.regNo   || "N/A",
//       studentName: (m.student as any)?.name    || "N/A",
//       unitCode:    (m.programUnit as any)?.unit?.code    || "N/A",
//       unitName:    (m.programUnit as any)?.unit?.name    || "N/A",
//       programName: (m.programUnit as any)?.program?.name || "N/A",
//       programCode: (m.programUnit as any)?.program?.code || "N/A",
//       agreedMark:  m.agreedMark ?? 0,
//       attempt:     m.attempt ?? "1st",
//       isSpecial:   m.isSpecial ?? false,
//       academicYear:(m.academicYear as any)?.year    || "Unknown",
//       session:     (m.academicYear as any)?.session || "ORDINARY",
//       uploadedAt:  m.uploadedAt ?? m.createdAt,
//     });

//     const allEntries: MarkEntry[] = [
//       ...detailedRaw.map((m) => shape(m, "detailed")),
//       ...directRaw.map((m) => shape(m, "direct")),
//     ];

//     const grouped: Record<string, Record<string, Record<string, { programName: string; entries: MarkEntry[] }>>> = {};

//     for (const entry of allEntries) {
//       const yr  = entry.academicYear;
//       const ses = entry.session;
//       const pc  = entry.programCode;
//       if (!grouped[yr])          grouped[yr]          = {};
//       if (!grouped[yr][ses])     grouped[yr][ses]     = {};
//       if (!grouped[yr][ses][pc]) grouped[yr][ses][pc] = { programName: entry.programName, entries: [] };
//       grouped[yr][ses][pc].entries.push(entry);
//     }

//     const summary = {
//       totalRecords:  allEntries.length,
//       detailed:      detailedRaw.length,
//       direct:        directRaw.length,
//       academicYears: Object.keys(grouped).sort().reverse(),
//     };

//     res.json({ summary, grouped });
//   }),
// );

// ─────────────────────────────────────────────────────────────────────────────
// GET /marks/upload-stats
// ─────────────────────────────────────────────────────────────────────────────
router.get("/upload-stats", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const institutionId = req.user.institution;

    const [detailedRaw, directRaw] = await Promise.all([
      Mark.find({ institution: institutionId, deletedAt: null })
        .populate({
          path: "programUnit",
          populate: [
            { path: "unit", select: "code name" },
            { path: "program", select: "name code" },
          ],
        })
        .populate("academicYear", "year session")
        .populate("student", "regNo name")
        .sort({ createdAt: -1 })
        .lean(),

      MarkDirect.find({ institution: institutionId, deletedAt: null })
        .populate({
          path: "programUnit",
          populate: [
            { path: "unit", select: "code name" },
            { path: "program", select: "name code" },
          ],
        })
        .populate("academicYear", "year session")
        .populate("student", "regNo name")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    interface MarkEntry {
      _id: string;
      source: "detailed" | "direct";
      batchId: string;
      regNo: string;
      studentName: string;
      unitCode: string;
      unitName: string;
      programName: string;
      programCode: string;
      agreedMark: number;
      attempt: string;
      isSpecial: boolean;
      academicYear: string;
      session: string;
      uploadedAt: Date;
    }

    const shape = (m: Record<string, unknown>, source: "detailed" | "direct"): MarkEntry => {
      const programUnit = m.programUnit as Record<string, unknown> | undefined;
      const unit = programUnit?.unit as Record<string, unknown> | undefined;
      const program = programUnit?.program as Record<string, unknown> | undefined;
      const student = m.student as Record<string, unknown> | undefined;
      const academicYear = m.academicYear as Record<string, unknown> | undefined;

      const unitCode = String(unit?.code ?? "N/A");
      const uploadedDate = new Date(
        (m.uploadedAt as string | undefined) ?? (m.createdAt as string | undefined) ?? Date.now(),
      )
        .toISOString()
        .split("T")[0];

      return {
        _id: String(m._id ?? ""),
        source,
        batchId:
          typeof m.batchId === "string" && m.batchId.length > 10
            ? m.batchId
            : `${unitCode}|${uploadedDate}|${String(m.attempt ?? "1st")}`,
        regNo: String(student?.regNo ?? "N/A"),
        studentName: String(student?.name ?? "N/A"),
        unitCode,
        unitName: String(unit?.name ?? "N/A"),
        programName: String(program?.name ?? "N/A"),
        programCode: String(program?.code ?? "N/A"),
        agreedMark: Number(m.agreedMark ?? 0),
        attempt: String(m.attempt ?? "1st"),
        isSpecial: Boolean(m.isSpecial ?? false),
        academicYear: String(academicYear?.year ?? "Unknown"),
        session: String(academicYear?.session ?? "ORDINARY"),
        uploadedAt: new Date(
          (m.uploadedAt as string | undefined) ?? (m.createdAt as string | undefined) ?? Date.now(),
        ),
      };
    };

    const allEntries: MarkEntry[] = [
      ...detailedRaw.map((m) => shape(m as unknown as Record<string, unknown>, "detailed")),
      ...directRaw.map((m) => shape(m as unknown as Record<string, unknown>, "direct")),
    ];

    const grouped: Record<
      string,
      Record<string, Record<string, { programName: string; entries: MarkEntry[] }>>
    > = {};

    for (const entry of allEntries) {
      const yr = entry.academicYear;
      const ses = entry.session;
      const pc = entry.programCode;

      if (!grouped[yr]) grouped[yr] = {};
      if (!grouped[yr][ses]) grouped[yr][ses] = {};
      if (!grouped[yr][ses][pc]) {
        grouped[yr][ses][pc] = { programName: entry.programName, entries: [] };
      }
      grouped[yr][ses][pc].entries.push(entry);
    }

    const summary = {
      totalRecords: allEntries.length,
      detailed: detailedRaw.length,
      direct: directRaw.length,
      academicYears: Object.keys(grouped).sort().reverse(),
    };

    res.json({ summary, grouped });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /marks/upload   — Auto-detects template type by inspecting cell E15
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", requireAuth,
  requireRole("coordinator", "admin"),
  uploadMarksFile.single("file"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    console.log(`[POST /marks/upload] File received: "${req.file.originalname}", size=${req.file.size}`);

    try {
      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];

      // Cell E15 contains "CA TOTAL (/30)" in the direct template header row
      const columnEHeader = sheet["E15"]?.v?.toString().toUpperCase() || "";
      console.log(`[POST /marks/upload] Cell E15 value: "${columnEHeader}"`);

      let result;
      let templateType: string;

      if (columnEHeader.includes("CA TOTAL")) {
        templateType = "direct";
        console.log(`[POST /marks/upload] Detected DIRECT ENTRY template`);
        result = await importDirectMarksFromBuffer(req.file.buffer, req.file.originalname, req);
      } else {
        templateType = "detailed";
        console.log(`[POST /marks/upload] Detected DETAILED BREAKDOWN template`);
        result = await importMarksFromBuffer(req.file.buffer, req.file.originalname, req);
      }

      console.log(`[POST /marks/upload] Import result: total=${result.total}, success=${result.success}, errors=${result.errors.length}`);

      await logAudit(req, {
        action: "marks_upload_success",
        details: { templateType, total: result.total, success: result.success },
      });

      res.json({ message: "Import completed", ...result });
    } catch (err: any) {
      console.error("[POST /marks/upload] Fatal error:", err.message, err.stack);
      await logAudit(req, {
        action: "marks_upload_failed",
        details: { error: err.message, filename: req.file.originalname },
      });
      throw err;
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /marks/upload-direct  — Explicit direct-entry upload endpoint
// (The client marksApi.ts calls this when templateMode === "direct")
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload-direct", requireAuth,
  requireRole("coordinator", "admin"),
  uploadMarksFile.single("file"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    console.log(`[POST /marks/upload-direct] File: "${req.file.originalname}", size=${req.file.size}`);

    try {
      const result = await importDirectMarksFromBuffer(req.file.buffer, req.file.originalname, req);

      console.log(`[POST /marks/upload-direct] Done: total=${result.total}, success=${result.success}, errors=${result.errors.length}`);

      await logAudit(req, {
        action: "marks_upload_success",
        details: { templateType: "direct", total: result.total, success: result.success },
      });

      res.json({ message: "Import completed", ...result });
    } catch (err: any) {
      console.error("[POST /marks/upload-direct] Fatal error:", err.message, err.stack);
      await logAudit(req, {
        action: "marks_upload_failed",
        details: { error: err.message, filename: req.file.originalname },
      });
      throw err;
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /marks/batch/:batchId — View marks inside a single scoresheet
// ─────────────────────────────────────────────────────────────────────────────
router.get("/batch/:batchId", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { batchId } = req.params;
    const institutionId = req.user.institution;

    if (!batchId || batchId.length < 10) {
      return res.status(400).json({ message: "Invalid batch ID." });
    }

    // Fetch both detailed and direct marks
    const [detailedMarks, directMarks] = await Promise.all([
      Mark.find({ batchId, institution: institutionId, deletedAt: null })
        .populate({ path: "programUnit", populate: [{ path: "unit", select: "code name" }, { path: "program", select: "name code departmentCode schoolCode" }] })
        .populate("academicYear", "year session")
        .populate("student", "regNo name")
        .sort({ "student.regNo": 1 })
        .lean(),
      MarkDirect.find({ batchId, institution: institutionId, deletedAt: null })
        .populate({ path: "programUnit", populate: [{ path: "unit", select: "code name" }, { path: "program", select: "name code departmentCode schoolCode" }] })
        .populate("academicYear", "year session")
        .populate("student", "regNo name")
        .sort({ "student.regNo": 1 })
        .lean(),
    ]);

    const allMarks = [...detailedMarks, ...directMarks];

    if (allMarks.length === 0) {
      return res.status(404).json({ message: "No marks found for this batch." });
    }

    // Scope check: coordinator can only view batches in their department/school
    if (req.user.role === "coordinator" && !(req.user as any).institutionWide) {
      const scopedProgramIds = await getScopedProgramIds(req);
      const scopedIdStrings = scopedProgramIds.map((id) => id.toString());

      for (const mark of allMarks) {
        const programId = (mark.programUnit as any)?.program?._id?.toString();
        if (programId && !scopedIdStrings.includes(programId)) {
          return res.status(403).json({
            message: "This batch contains marks from programs outside your department.",
          });
        }
      }
    }

    const firstMark = allMarks[0];
    const batchInfo = {
      batchId,
      unitCode: (firstMark.programUnit as any)?.unit?.code || "N/A",
      unitName: (firstMark.programUnit as any)?.unit?.name || "N/A",
      programCode: (firstMark.programUnit as any)?.program?.code || "N/A",
      programName: (firstMark.programUnit as any)?.program?.name || "N/A",
      academicYear: (firstMark.academicYear as any)?.year || "N/A",
      session: (firstMark.academicYear as any)?.session || "ORDINARY",
      totalRecords: allMarks.length,
      uploadedAt: firstMark.uploadedAt || (firstMark as any).createdAt,
    };

    const entries = allMarks.map((m) => ({
      _id: m._id.toString(),
      regNo: (m.student as any)?.regNo || "N/A",
      studentName: (m.student as any)?.name || "N/A",
      caTotal30: (m as any).caTotal30 ?? 0,
      examTotal70: (m as any).examTotal70 ?? 0,
      agreedMark: m.agreedMark ?? 0,
      attempt: m.attempt ?? "1st",
      isSpecial: m.isSpecial ?? false,
    }));

    res.json({ batch: batchInfo, entries });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /marks/batch/:batchId — Soft-delete a single scoresheet
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/batch/:batchId", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { batchId } = req.params;
    const institutionId = req.user.institution;

    if (!batchId || batchId.length < 10) {
      return res.status(400).json({ message: "Invalid batch ID." });
    }

    // Find all marks in this batch
    const [detailedMarks, directMarks] = await Promise.all([
      Mark.find({ batchId, institution: institutionId, deletedAt: null }).populate({
        path: "programUnit",
        populate: { path: "program", select: "_id departmentCode schoolCode" },
      }),
      MarkDirect.find({ batchId, institution: institutionId, deletedAt: null }).populate({
        path: "programUnit",
        populate: { path: "program", select: "_id departmentCode schoolCode" },
      }),
    ]);

    const allMarks = [...detailedMarks, ...directMarks];

    if (allMarks.length === 0) {
      return res.status(404).json({ message: "No marks found for this batch." });
    }

    // Scope check: coordinator can only delete batches in their department/school
    if (req.user.role === "coordinator" && !(req.user as any).institutionWide) {
      const scopedProgramIds = await getScopedProgramIds(req);
      const scopedIdStrings = scopedProgramIds.map((id) => id.toString());

      const outOfScope = allMarks.filter((m) => {
        const programId = (m.programUnit as any)?.program?._id?.toString();
        return programId && !scopedIdStrings.includes(programId);
      });

      if (outOfScope.length > 0) {
        return res.status(403).json({
          message: `Cannot delete this batch. ${outOfScope.length} records belong to programs outside your department.`,
        });
      }
    }

    const now = new Date();

    // Soft-delete all marks in the batch
    const [detailedResult, directResult] = await Promise.all([
      Mark.updateMany(
        { batchId, institution: institutionId, deletedAt: null },
        { $set: { deletedAt: now } },
      ),
      MarkDirect.updateMany(
        { batchId, institution: institutionId, deletedAt: null },
        { $set: { deletedAt: now } },
      ),
    ]);

    const totalDeleted = detailedResult.modifiedCount + directResult.modifiedCount;

    await logAudit(req, {
      action: "marks_batch_deleted",
      details: {
        batchId,
        detailedDeleted: detailedResult.modifiedCount,
        directDeleted: directResult.modifiedCount,
        totalDeleted,
      },
    });

    res.json({
      message: `Batch deleted successfully. ${totalDeleted} records removed.`,
      deletedCount: totalDeleted,
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /marks/batches — Bulk soft-delete multiple scoresheets
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/batches",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { batchIds } = req.body as { batchIds: string[] };
    const institutionId = req.user.institution;

    if (!batchIds || !Array.isArray(batchIds) || batchIds.length === 0) {
      return res.status(400).json({ message: "batchIds array is required." });
    }

    if (batchIds.length > 20) {
      return res.status(400).json({ message: "Maximum 20 batches per request." });
    }

    // Validate all batchIds are non-empty strings
    if (batchIds.some((id) => typeof id !== "string" || id.length < 10)) {
      return res.status(400).json({ message: "One or more batch IDs are invalid." });
    }

    // Fetch all marks for all batches
    const [detailedMarks, directMarks] = await Promise.all([
      Mark.find({
        batchId: { $in: batchIds },
        institution: institutionId,
        deletedAt: null,
      }).populate({
        path: "programUnit",
        populate: { path: "program", select: "_id departmentCode schoolCode" },
      }),
      MarkDirect.find({
        batchId: { $in: batchIds },
        institution: institutionId,
        deletedAt: null,
      }).populate({
        path: "programUnit",
        populate: { path: "program", select: "_id departmentCode schoolCode" },
      }),
    ]);

    const allMarks = [...detailedMarks, ...directMarks];

    if (allMarks.length === 0) {
      return res.status(404).json({ message: "No marks found for these batches." });
    }

    // Scope check
    if (req.user.role === "coordinator" && !(req.user as any).institutionWide) {
      const scopedProgramIds = await getScopedProgramIds(req);
      const scopedIdStrings = scopedProgramIds.map((id) => id.toString());

      const outOfScope = allMarks.filter((m) => {
        const programId = (m.programUnit as any)?.program?._id?.toString();
        return programId && !scopedIdStrings.includes(programId);
      });

      if (outOfScope.length > 0) {
        return res.status(403).json({
          message: `Cannot delete. ${outOfScope.length} records belong to programs outside your department.`,
        });
      }
    }

    const now = new Date();

    const [detailedResult, directResult] = await Promise.all([
      Mark.updateMany(
        { batchId: { $in: batchIds }, institution: institutionId, deletedAt: null },
        { $set: { deletedAt: now } },
      ),
      MarkDirect.updateMany(
        { batchId: { $in: batchIds }, institution: institutionId, deletedAt: null },
        { $set: { deletedAt: now } },
      ),
    ]);

    const totalDeleted = detailedResult.modifiedCount + directResult.modifiedCount;

    await logAudit(req, {
      action: "marks_bulk_batch_deleted",
      details: {
        batchIds,
        batchCount: batchIds.length,
        totalDeleted,
      },
    });

    res.json({
      message: `${batchIds.length} batches deleted. ${totalDeleted} records removed.`,
      deletedCount: totalDeleted,
      batchCount: batchIds.length,
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// ACTION LIST — rows that could not be applied during an upload
// ─────────────────────────────────────────────────────────────────────────────
const coordinatorOnly = [requireAuth, requireRole("coordinator", "admin")] as const;

// GET /marks/problems?status=OPEN|RESOLVED|DISMISSED|ALL&academicYearId=
router.get("/problems", ...coordinatorOnly, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const institution = req.user.institution;
  const status = String(req.query.status ?? "OPEN").toUpperCase();
  const filter: Record<string, unknown> = { institution };
  if (status !== "ALL") filter.status = status;
  if (req.query.academicYearId && mongoose.Types.ObjectId.isValid(String(req.query.academicYearId))) {
    filter.academicYear = req.query.academicYearId;
  }
  const items = await ProblemResult.find(filter)
    .select("-payload")
    .populate("program", "name code")
    .sort({ academicYearLabel: -1, unitCode: 1, rowNumber: 1 })
    .limit(1000)
    .lean();
  const byCode: Record<string, number> = {};
  for (const i of items) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  res.json({ total: items.length, byCode, items });
}));

// POST /marks/problems/retry  { ids?: string[] } — re-apply (all open when no ids)
router.post("/problems/retry", ...coordinatorOnly, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]).filter((i) => mongoose.Types.ObjectId.isValid(i)) : undefined;
  const out = await retryProblems({ institutionId: req.user.institution, userId: req.user._id, ids });
  await logAudit(req, { action: "marks_problems_retry", details: out });
  res.json({ message: `${out.resolved} of ${out.attempted} result(s) applied; ${out.stillOpen} still need action.`, ...out });
}));

// POST /marks/problems/:id/resolve  { regNo } — fix the reg no of one row and apply it
router.post("/problems/:id/resolve", ...coordinatorOnly, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid id." });
  const regNo = String(req.body?.regNo ?? "").trim();
  if (!regNo) return res.status(400).json({ message: "regNo is required." });
  const out = await retryProblems({ institutionId: req.user.institution, userId: req.user._id, ids: [req.params.id], override: { regNo } });
  await logAudit(req, { action: "marks_problem_resolve", details: { id: req.params.id, regNo, ...out } });
  if (!out.attempted) return res.status(404).json({ message: "Open problem not found." });
  const p = await ProblemResult.findById(req.params.id).select("-payload").lean();
  res.status(out.resolved ? 200 : 422).json({ message: out.resolved ? "Result applied." : (p?.message ?? "Still cannot be applied."), problem: p });
}));

// POST /marks/problems/:id/dismiss  { note? } — coordinator decides the row is not needed
router.post("/problems/:id/dismiss", ...coordinatorOnly, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid id." });
  const p = await ProblemResult.findOneAndUpdate(
    { _id: req.params.id, institution: req.user.institution, status: "OPEN" },
    { $set: { status: "DISMISSED", resolvedAt: new Date(), resolvedBy: req.user._id, resolution: String(req.body?.note ?? "Dismissed by coordinator").slice(0, 300) } },
    { new: true },
  ).select("-payload").lean();
  if (!p) return res.status(404).json({ message: "Open problem not found." });
  await logAudit(req, { action: "marks_problem_dismiss", details: { id: req.params.id, regNo: p.regNo, unit: p.unitCode } });
  res.json({ message: "Dismissed.", problem: p });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /marks/cms-preview?programId&academicYearId&yearOfStudy
// How the CMS is building up: students × units of that year of study, filled from uploaded
// results, with what is still missing and which action-list items are open.
// ─────────────────────────────────────────────────────────────────────────────
const CMS_EXCLUDED = ["deregistered", "discontinued", "graduated", "graduand", "deferred", "on_leave"];

router.get("/cms-preview", ...coordinatorOnly, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { programId, academicYearId } = req.query as Record<string, string>;
  const yearOfStudy = parseInt(String(req.query.yearOfStudy ?? ""), 10);
  if (![programId, academicYearId].every((v) => v && mongoose.Types.ObjectId.isValid(v)) || !(yearOfStudy >= 1)) {
    return res.status(400).json({ message: "programId, academicYearId and yearOfStudy are required." });
  }
  const institution = req.user.institution;
  const allowed = (await getScopedProgramIds(req)).map(String);
  if (!allowed.includes(programId)) return res.status(403).json({ message: "Programme is outside your scope." });

  const [programUnits, academicYear] = await Promise.all([
    ProgramUnit.find({ program: programId, requiredYear: yearOfStudy })
      .populate("unit", "code name").sort({ requiredSemester: 1 }).lean(),
    AcademicYear.findById(academicYearId).select("year session").lean(),
  ]);
  if (!academicYear) return res.status(404).json({ message: "Academic year not found." });
  const puIds = programUnits.map((p) => p._id);

  const [grades, directs, details] = await Promise.all([
    FinalGrade.find({ academicYear: academicYearId, programUnit: { $in: puIds } }).sort({ updatedAt: 1 }).lean(),
    MarkDirect.find({ academicYear: academicYearId, programUnit: { $in: puIds } }).select("student programUnit agreedMark attempt").lean(),
    Mark.find({ academicYear: academicYearId, programUnit: { $in: puIds } }).select("student programUnit agreedMark attempt").lean(),
  ]);

  // class = the programme's students in this year of study + anybody who has a result for these units
  const withResults = new Set<string>([...grades, ...directs, ...details].map((g: any) => String(g.student)));
  const students = (await Student.find({
    program: programId,
    status: { $nin: CMS_EXCLUDED },
    $or: [{ currentYearOfStudy: yearOfStudy }, { _id: { $in: [...withResults] } }],
  }).select("regNo name qualifierSuffix status currentYearOfStudy").sort({ regNo: 1 }).limit(600).lean()) as any[];

  type Cell = { mark: number; grade?: string; status?: string; attempt?: string };
  const cell = new Map<string, Cell>();
  for (const m of [...details, ...directs] as any[]) {
    cell.set(`${m.student}_${m.programUnit}`, { mark: Number(m.agreedMark ?? 0), attempt: m.attempt });
  }
  for (const g of grades as any[]) {          // graded result wins over the raw mark
    cell.set(`${g.student}_${g.programUnit}`, { mark: Number(g.totalMark ?? 0), grade: g.grade, status: g.status, attempt: g.attemptType });
  }

  const unitCols = programUnits.map((p: any) => ({
    id: String(p._id), code: p.unit?.code ?? "N/A", name: p.unit?.name ?? "", semester: p.requiredSemester, isElective: !!p.isElective,
    uploaded: 0, expected: students.length,
  }));
  let missing = 0, failed = 0, filled = 0;
  const rows = students.map((s) => {
    const cells: Record<string, Cell | null> = {};
    let rowMissing = 0, rowFailed = 0;
    unitCols.forEach((u) => {
      const c = cell.get(`${s._id}_${u.id}`) ?? null;
      cells[u.id] = c;
      if (!c) { if (!u.isElective) rowMissing++; }
      else { u.uploaded++; filled++; if (c.status === "SUPPLEMENTARY" || c.status === "RETAKE") rowFailed++; }
    });
    missing += rowMissing; failed += rowFailed;
    return { id: String(s._id), regNo: buildDisplayRegNo(s.regNo, s.qualifierSuffix), name: s.name, status: s.status, cells, missing: rowMissing, failed: rowFailed };
  });

  const unitCodes = unitCols.map((u) => u.code);
  const problems = await ProblemResult.find({ institution, status: "OPEN", academicYear: academicYearId, unitCode: { $in: unitCodes } })
    .select("regNo unitCode code message action").limit(100).lean();
  const openInYear = await ProblemResult.countDocuments({ institution, status: "OPEN", academicYear: academicYearId });

  res.json({
    academicYear: academicYear.year, session: (academicYear as any).session ?? "ORDINARY", yearOfStudy,
    units: unitCols, students: rows,
    summary: {
      students: rows.length, units: unitCols.length, filled, missing, failed,
      openProblemsForUnits: problems.length, openProblemsInYear: openInYear,
      ready: missing === 0 && openInYear === 0 && rows.length > 0,
    },
    problems,
  });
}));

export default router;