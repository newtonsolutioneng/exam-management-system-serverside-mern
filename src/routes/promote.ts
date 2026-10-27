// serverside/src/routes/promote.ts
import { lapTimer } from "../utils/perfLog";
import { Router, Response } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import type { AuthenticatedRequest } from "../middleware/auth";
import { bulkPromoteClass, calculateStudentStatus, previewPromotion, promoteStudent } from "../services/statusEngine";
import Program from "../models/Program";
import PromotionReportLog from "../models/PromotionReportLog";
import {
  generatePromotionWordDoc, generateEligibleSummaryDoc, generateIneligibilityNotice, PromotionData,
  generateSpecialExamNotice, generateStudentTranscript, generateSupplementaryExamsDoc, generateSpecialExamsDoc,
  generateStayoutExamsDoc, generateAcademicLeaveDoc, generateDeregistrationDoc, generateDiscontinuationDoc, generateRepeatYearDoc,
  generateIncompleteListDoc, generateCarryForwardDoc, generateDefermentDoc, generateAwardListDoc,
  generateStayoutSuppDoc,
  generateRepeatSuppDoc,
  generateReadmissionSuppDoc,
  generateCarryForwardSuppDoc,
  generateAcademicLeaveSuppDoc,
  generateSimpleAwardListDoc,
} from "../utils/promotionReport";
import fs from "fs";
import path from "path"
import AdmZip from "adm-zip";
import Student from "../models/Student";
import { logAudit } from "../lib/auditLogger";
import ProgramUnit from "../models/ProgramUnit";
import Mark from "../models/Mark";
import ProblemResult from "../models/ProblemResult";
import { generateConsolidatedMarkSheet, ConsolidatedData } from "../utils/consolidatedMS";
import MarkDirect from "../models/MarkDirect";
import { undoPromotion } from "../services/undoPromotion";
import AcademicYear from "../models/AcademicYear";
import InstitutionSettings from "../models/InstitutionSettings";
import { loadInstitutionSettings } from "../utils/loadInstitutionSettings";

const router = Router();

/** Remember that the CMS or the reports were generated for this class (used to warn before promoting). */
async function logReportsGenerated(req: AuthenticatedRequest, programId: string, yearOfStudy: number, academicYear: string, kind: "cms" | "reports") {
  try {
    await PromotionReportLog.findOneAndUpdate(
      { program: programId, yearOfStudy: Number(yearOfStudy), academicYear, kind },
      { $set: { institution: req.user.institution, at: new Date(), by: req.user._id } },
      { upsert: true },
    );
  } catch (e) { console.warn("[promote] could not record report generation:", (e as Error).message); }
}

// preview-promotion
router.post("/preview-promotion", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, yearToPromote, academicYearName } = req.body;
    if (!programId || !yearToPromote || !academicYearName) return res.status(400).json({ error: "Missing parameters" });
    const previewData = await previewPromotion( programId, yearToPromote, academicYearName );
    res.json({ success: true, data: previewData });
  }),
);

// bulk-promote
router.post( "/bulk-promote", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, yearToPromote, academicYearName } = req.body;
    if (!programId || !yearToPromote || !academicYearName) return res.status(400).json({ error: "Missing required promotion parameters" }); 

    // Promoting moves students on, which changes what the CMS and reports for this year show. Make sure the
    // coordinator has generated both first, unless they knowingly skip the check.
    if (!req.body.skipReportCheck) {
      const done = await PromotionReportLog.find({ program: programId, yearOfStudy: Number(yearToPromote), academicYear: academicYearName }).lean();
      const missing = [
        ...(done.some((d: any) => d.kind === "cms") ? [] : ["the Consolidated Mark Sheet (CMS)"]),
        ...(done.some((d: any) => d.kind === "reports") ? [] : ["the summary reports"]),
      ];
      if (missing.length) {
        return res.status(409).json({
          success: false, code: "REPORTS_NOT_DOWNLOADED", missing,
          message: `You have not generated ${missing.join(" and ")} for this class yet.`,
        });
      }
    }

    const results = await bulkPromoteClass( programId, yearToPromote, academicYearName );
    res.json({ success: true, message: `Process completed: ${results.promoted} promoted, ${results.failed} failed.`, data: results });
  }),
);

// download-report-progress
router.post( "/download-report-progress", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, yearToPromote, academicYearName } = req.body;

    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive");
    const sendProgress = (percent: number, message: string, file?: string) => { const data = JSON.stringify({ percent, message, file }); res.write(`data: ${data}\n\n`); };

    try {
      sendProgress(10, "Fetching student data and raw marks...");
      // 1. Fetch Basic Data
      const preview = await previewPromotion( programId, yearToPromote, academicYearName );
      const program = await Program.findById(programId).lean();

      const academicYearDoc = await AcademicYear.findOne({year: academicYearName}).lean();
      const targetAcadYearId = (academicYearDoc as any)?._id?.toString();

      const academicYearDocForSession = await AcademicYear.findOne({year: academicYearName}).lean();
      const institutionSettings = await InstitutionSettings.findOne({institution: program?.institution}).lean();

      // const passMark = institutionSettings?.passMark ?? 40;
      const settings = await loadInstitutionSettings((program as any)?.institution?.toString() || "");
      const passMark = settings.passMark;
      const gradingScale = institutionSettings?.gradingScale ?? [];

      const sessionExamType: "ORDINARY" | "SUPPLEMENTARY" = academicYearDocForSession?.session === "SUPPLEMENTARY" ? "SUPPLEMENTARY" : "ORDINARY";
          
      const logoPath = path.join( __dirname, "../../public/institutionLogoExcel.png", );
      const logoBuffer = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : Buffer.alloc(0);

      // 3. Fetch Marks
      const allStudents = [...preview.eligible, ...preview.blocked];
      const studentIds = allStudents.map((s) => { const id = s._id || s.student?._id || s.id || s.student; return id?.toString(); }).filter((id) => id && id.length >= 24); 
      // const rawMarks = await Mark.find({ student: { $in: studentIds } }).populate({ path: "programUnit", populate: { path: "unit", select: "code name" }}).lean();
      // const filteredMarks = rawMarks.filter((m: any) => { return m.programUnit && Number(m.programUnit.requiredYear) === Number(yearToPromote); });
      // Fetch from both Detailed (Mark) and Direct (MarkDirect) models
      const [detailedMarks, directMarks] = await Promise.all([
        Mark.find({ student: { $in: studentIds } }).populate({ path: "programUnit", populate: { path: "unit", select: "code name" }}).lean(),
        MarkDirect.find({ student: { $in: studentIds } }).populate({ path: "programUnit", populate: { path: "unit", select: "code name" }}).lean()
      ]);
      // Merge them: Direct marks often take precedence if duplicates exist
      const combinedMarks = [...detailedMarks, ...directMarks];
      // Filter marks strictly for the Year of Study being promoted
      // const filteredMarks = combinedMarks.filter((m: any) => { return m.programUnit && Number(m.programUnit.requiredYear) === Number(yearToPromote);});

      const filteredMarks = combinedMarks.filter((m: any) => {
        const rightYear = m.programUnit && Number(m.programUnit.requiredYear) === Number(yearToPromote);
        const rightCohort = !targetAcadYearId || (m.academicYear?.toString() === targetAcadYearId);
        return rightYear && rightCohort;
      });
      const offeredUnitsRaw = await ProgramUnit.find({ program: programId, requiredYear: yearToPromote }).populate("unit").lean();
      const offeredUnits = offeredUnitsRaw.map((pu: any) => ({ code: pu.unit?.code || "N/A", name: pu.unit?.name || "N/A" }));

      // 5. Prepare Data Objects (Separated for type safety)
      const wordData: PromotionData = {
        programName: program?.name || "Program",
        academicYear: academicYearName,
        yearOfStudy: yearToPromote,
        totalYears: (program as any)?.durationYears,
        eligible: preview.eligible,
        blocked: preview.blocked,
        offeredUnits,
        logoBuffer,
        examType: sessionExamType,
        institutionId: (program as any)?.institution?.toString() || "",
      };

      const studentsByHistory = await Student.find({
        program: programId,
        status: {
          $nin: ["graduated", "graduand", "discontinued", "deregistered"],
        }, // ← KEY FIX
        $or: [
          { currentYearOfStudy: yearToPromote },
          {
            academicHistory: {
              $elemMatch: { yearOfStudy: yearToPromote, academicYear: academicYearName },
            },
          },
        ],
      }).lean();
      // Deduplicate — preview already has blocked (on_leave, deferred etc).
      // Merge so every student who ever touched this year is on the CMS.
      const previewIds = new Set([...preview.eligible, ...preview.blocked].map((s) => (s.id || s._id)?.toString()));
      const historyOnly = studentsByHistory.filter((s) => !previewIds.has(s._id.toString()));

      const allCmsStudents = [ ...preview.eligible, ...preview.blocked, ...historyOnly ];

      const excelData: ConsolidatedData = {
        programName: program?.name || "Program", academicYear: academicYearName, yearOfStudy: yearToPromote,
        session: sessionExamType, students: allCmsStudents, marks: filteredMarks, offeredUnits, logoBuffer,
        institutionId: program?.institution?.toString() || "", programId: programId, passMark, gradingScale, 
      };  
      
      // 6. Generate and Zip reports
      const cleanAcadYear = academicYearName.replace(/\//g, "_");
      const progCode = program?.code || "PROG";
      const progName = program?.name || "Program";
      const yearPrefix = `Year_${yearToPromote}`;

      const getFileName = (reportType: string) => `${reportType}_${progCode}_${progName}_${cleanAcadYear}_${yearPrefix}.docx`.replace(/\s+/g, "_");
      const zip = new AdmZip();

      // Helper to conditionally add documents
      const addDocIfNotEmpty = async (
        list: any[], fileName: string, generator: (data: any, ...args: any[]) => Promise<Buffer>, ...extraArgs: any[] ) => {
        if (list && list.length > 0) { const buffer = await generator(wordData, ...extraArgs); zip.addFile(fileName, buffer); return true; }
        return false;
      };
     
      sendProgress(30, "Generating Main Summary & Marksheet...");
      // zip.addFile(`Summary_Ordinary_Exams_${progCode}_${progName}_${yearPrefix}_${cleanAcadYear}.docx`, await generatePromotionWordDoc(wordData));
      // zip.addFile(`${progName}__${progCode}_${cleanAcadYear}_${yearPrefix}_CMS.xlsx`, await generateConsolidatedMarkSheet(excelData));
      const summaryPrefix = sessionExamType === "SUPPLEMENTARY" ? "Summary_Supp_Special" : "Summary_Ordinary";
      zip.addFile(`${summaryPrefix}_${progCode}_${progName}_${yearPrefix}_${cleanAcadYear}.docx`, await generatePromotionWordDoc(wordData));
      zip.addFile(`${progName}__${progCode}_${cleanAcadYear}_${yearPrefix}_CMS.xlsx`, await generateConsolidatedMarkSheet(excelData));

      sendProgress(40, "Checking Pass List...");
      await addDocIfNotEmpty(wordData.eligible, getFileName("PASS_LIST"), generateEligibleSummaryDoc);

      sendProgress(50, "Checking Supplementary List...");
      // const suppList = wordData.blocked.filter(s => s.status.includes("SUPP"));
      // await addDocIfNotEmpty(suppList, getFileName("Supplementary_List"), generateSupplementaryExamsDoc);

      // 1. First-attempt SUPP (not from prior hurdle)
const suppFirstAttempt = wordData.blocked.filter(
  (s) =>
    s.status.includes("SUPP") &&
    !s.reasons?.some((r: string) =>
      /stayout|a\/so|repeat\s+year|a\/ra|readmission|readmit|carry\s*forward|a\/cf|academic\s*leave/i.test(r),
    ),
);
await addDocIfNotEmpty(suppFirstAttempt, getFileName("Supplementary_List"), generateSupplementaryExamsDoc);
 
// 2. Supp after Carry Forward (A/CFS)
const suppCF = wordData.blocked.filter(
  (s) =>
    s.status.includes("SUPP") &&
    s.reasons?.some((r: string) => /carry\s*forward|a\/cf/i.test(r)),
);
await addDocIfNotEmpty(suppCF, getFileName("Supplementary_After_Carry_Forward"), generateCarryForwardSuppDoc);
 
// 3. Supp after Stay Out (A/SOS)
const suppStayout = wordData.blocked.filter(
  (s) =>
    s.status.includes("SUPP") &&
    s.reasons?.some((r: string) => /stayout|a\/so/i.test(r)),
);
await addDocIfNotEmpty(suppStayout, getFileName("Supplementary_After_Stayout"), generateStayoutSuppDoc);
 
// 4. Supp after Repeat Year (A/RA)
const suppRepeat = wordData.blocked.filter(
  (s) =>
    s.status.includes("SUPP") &&
    s.reasons?.some((r: string) => /repeat\s+year|a\/ra/i.test(r)),
);
await addDocIfNotEmpty(suppRepeat, getFileName("Supplementary_After_Repeat_Year"), generateRepeatSuppDoc);
 
// 5. Supp after Readmission
const suppReadmit = wordData.blocked.filter(
  (s) =>
    s.status.includes("SUPP") &&
    s.reasons?.some((r: string) => /readmission|readmit/i.test(r)),
);
await addDocIfNotEmpty(suppReadmit, getFileName("Supplementary_After_Readmission"), generateReadmissionSuppDoc);
 
// 6. Supp after Academic Leave
const suppLeave = wordData.blocked.filter(
  (s) =>
    s.status.includes("SUPP") &&
    s.reasons?.some((r: string) => /academic\s*leave|on\s*leave|a\/sp/i.test(r)),
);
await addDocIfNotEmpty(suppLeave, getFileName("Supplementary_After_Academic_Leave"), generateAcademicLeaveSuppDoc);

      sendProgress(60, "Checking Special Exams...");
      const getSpecialGround = (s: any): string => {
        const grounds = (s.specialGrounds || "").toLowerCase();
        const remarks = (s.remarks || "").toLowerCase();
        const leaveType = (s.academicLeavePeriod?.type || "").toLowerCase();
        const details = (s.details || "").toLowerCase();
        return `${grounds} ${remarks} ${leaveType} ${details}`;
      };

      const isSpecialStudent = (s: any): boolean => /spec/i.test(s.status);
      const finSpecials = wordData.blocked.filter((s: any) => isSpecialStudent(s) && getSpecialGround(s).includes("financial"));
      const compSpecials = wordData.blocked.filter((s: any) => isSpecialStudent(s) && /compassionate|medical|sick/.test(getSpecialGround(s)));
      const otherSpecials = wordData.blocked.filter((s: any) => isSpecialStudent(s) && !getSpecialGround(s).includes("financial") && !/compassionate|medical|sick/.test(getSpecialGround(s)));
     
      await addDocIfNotEmpty(finSpecials, getFileName("Special_Exams_Financial"), generateSpecialExamsDoc, "Financial");
      await addDocIfNotEmpty(compSpecials, getFileName("Special_Exams_Compassionate"), generateSpecialExamsDoc, "Compassionate");
      await addDocIfNotEmpty(otherSpecials, getFileName("Special_Exams_Other"), generateSpecialExamsDoc, "Other");

      sendProgress(70, "Checking Stayout & Repeat Year...");
      const stayoutList = wordData.blocked.filter(s => s.status === "STAYOUT");
      await addDocIfNotEmpty(stayoutList, getFileName("Stayout_Retake_List"), generateStayoutExamsDoc);

      const repeatList = wordData.blocked.filter(s => s.status === "REPEAT YEAR");
      await addDocIfNotEmpty(repeatList, getFileName("Repeat_Year_List"), generateRepeatYearDoc);

      sendProgress(75, "Checking Academic Exceptions...");
      // 1. INCOMPLETE LIST
      const incompleteList = wordData.blocked.filter(s => s.status.includes("INC") && !s.status.includes("SPEC"));
      await addDocIfNotEmpty(incompleteList, getFileName("Incomplete_Results_List"), generateIncompleteListDoc);

      // 2. ACADEMIC LEAVE - Financial
      const isFinancialLeave = (s: any): boolean => {
        const type    = (s.academicLeavePeriod?.type || "").toLowerCase();
        const remarks = (s.remarks || "").toLowerCase();
        const isLeaveStatus = ["ACADEMIC LEAVE", "ON LEAVE"].includes(s.status);
        return isLeaveStatus && (type === "financial" || remarks.includes("financial"));
      };
      const finLeave  = wordData.blocked.filter(isFinancialLeave);
      await addDocIfNotEmpty(finLeave, getFileName("Academic_Leave_Financial"), generateAcademicLeaveDoc, "Financial", "ACADEMIC LEAVE");

      // 3. ACADEMIC LEAVE - Compassionate  
      const isCompassionateLeave = (s: any): boolean => {
        const type    = (s.academicLeavePeriod?.type || "").toLowerCase();
        const remarks = (s.remarks || "").toLowerCase();
        const isLeaveStatus = ["ACADEMIC LEAVE", "ON LEAVE"].includes(s.status);
        return isLeaveStatus && ( type === "compassionate" || remarks.includes("compassionate") || remarks.includes("medical"));
      };      
      const compLeave = wordData.blocked.filter(isCompassionateLeave);    
      await addDocIfNotEmpty(compLeave, getFileName("Academic_Leave_Compassionate"), generateAcademicLeaveDoc, "Compassionate", "ACADEMIC LEAVE");

      sendProgress(80, "Checking Discontinuations & Deregistrations...");
      const discoList = wordData.blocked.filter(s => s.status === "CRITICAL FAILURE" || s.status === "DISCONTINUED");
      await addDocIfNotEmpty(discoList, getFileName("Discontinuation_List"), generateDiscontinuationDoc);

      const deregList = wordData.blocked.filter(s => s.status === "DEREGISTERED");
      await addDocIfNotEmpty(deregList, getFileName("Deregistration_List"), generateDeregistrationDoc);

      sendProgress(85, "Checking Deferment List...");
      const defermentList = wordData.blocked.filter((s) => s.status === "DEFERMENT");
      await addDocIfNotEmpty( defermentList, getFileName("Deferment_List"), generateDefermentDoc );

      sendProgress(90, "Checking Carry Forward List...");
      const carryList = wordData.eligible.filter(s => s.reasons?.length > 0 && s.status !== "ALREADY PROMOTED");
      await addDocIfNotEmpty(carryList, getFileName("Carry_Forward_List"), generateCarryForwardDoc);

      // 7. Zip and Send
      sendProgress(95, "Creating ZIP Archive...");
      const zipBase64 = zip.toBuffer().toString("base64");
      res.write(`data: ${JSON.stringify({ percent: 100, message: "Complete!", file: zipBase64 })}\n\n`);
      res.end();
      await logReportsGenerated(req, programId, yearToPromote, academicYearName, "reports");

    } catch (err) {
      console.error("Report Generation Error:", err);
      res.write(`data: ${JSON.stringify({ error: "Failed to generate" })}\n\n`);
      res.end();
    }
  }),
);

router.post(
  "/download-cms",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, yearToPromote, academicYearName } = req.body;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendProgress = (percent: number, message: string, file?: string) => {
      res.write(`data: ${JSON.stringify({ percent, message, file })}\n\n`);
    };

    console.log("[CMS DEBUG] Request body:", {
      programId,
      yearToPromote,
      academicYearName,
    });
    console.log(
      "[CMS DEBUG] User institution:",
      req.user.institution?.toString(),
    );

    try {
      sendProgress(10, "Fetching student data...");
      const lap = lapTimer("download-cms");

      const preview = await previewPromotion(
        programId,
        yearToPromote,
        academicYearName,
      );
      lap("promotion analysis");
      const program = await Program.findById(programId).lean();

      // ── Academic year document (for session type AND mark filtering) ──────
      const academicYearDoc = await AcademicYear.findOne({
        year: academicYearName,
      }).lean();
      const targetAcadYearId = (academicYearDoc as any)?._id?.toString();

      // Results waiting on the coordinator's action list must be dealt with (or knowingly skipped
            // with force=true) before a CMS is generated from incomplete data.
            if (targetAcadYearId && !req.body.force) {
              const openProblems = await ProblemResult.countDocuments({
                institution: req.user.institution, status: "OPEN", academicYear: targetAcadYearId,
              });
              if (openProblems > 0) {
                res.write(`data: ${JSON.stringify({
                  error: `${openProblems} uploaded result(s) still need action (Upload Results → Action list).`,
                  code: "OPEN_PROBLEM_RESULTS", count: openProblems,
                })}\n\n`);
                res.end();
                return;
              }
            }

      const sessionExamType: "ORDINARY" | "SUPPLEMENTARY" =
        (academicYearDoc as any)?.session === "SUPPLEMENTARY"
          ? "SUPPLEMENTARY"
          : "ORDINARY";

      const logoPath = path.join(
        __dirname,
        "../../public/institutionLogoExcel.png",
      );
      const logoBuffer = fs.existsSync(logoPath)
        ? fs.readFileSync(logoPath)
        : Buffer.alloc(0);

      sendProgress(30, "Fetching marks for current cohort...");

      // ── KEY FIX 1: Exclude graduated/discontinued students and restrict to
      //    students whose Year N history entry matches THIS academic year.
      //    This prevents 2016-intake graduates from appearing in 2017/2018 CMS.
      const studentsByHistory = await Student.find({
        program: programId,
        status: {
          $nin: ["graduated", "graduand", "discontinued", "deregistered"],
        },
        $or: [
          // Currently enrolled in this year
          { currentYearOfStudy: yearToPromote },
          // Has a history record for this specific year AND cohort
          {
            academicHistory: {
              $elemMatch: {
                yearOfStudy: yearToPromote,
                academicYear: academicYearName,
              },
            },
          },
        ],
      }).lean();

      const previewIds = new Set(
        [...preview.eligible, ...preview.blocked].map((s) =>
          (s.id || s._id)?.toString(),
        ),
      );
      const historyOnly = studentsByHistory.filter(
        (s) => !previewIds.has(s._id.toString()),
      );
      const allStudents = [
        ...preview.eligible,
        ...preview.blocked,
        ...historyOnly,
      ];
      const studentIds = allStudents
        .map((s) => (s._id || (s as any).id)?.toString())
        .filter(Boolean);

      sendProgress(50, "Loading mark records...");

      // Only this year's units matter below, so don't load (and populate) every mark of every year.
      const yearPuIds = (await ProgramUnit.find({ program: programId, requiredYear: yearToPromote }).select("_id").lean())
        .map((pu: any) => pu._id);
      lap("student lists");
      const [detailedMarks, directMarks] = await Promise.all([
        Mark.find({ student: { $in: studentIds }, programUnit: { $in: yearPuIds } })
          .populate({
            path: "programUnit",
            populate: { path: "unit", select: "code name" },
          })
          .lean(),
          MarkDirect.find({ student: { $in: studentIds }, programUnit: { $in: yearPuIds } })
          .populate({
            path: "programUnit",
            populate: { path: "unit", select: "code name" },
          })
          .lean(),
      ]);

      const combinedMarks = [...detailedMarks, ...directMarks];

      const filteredMarks = combinedMarks.filter((m: any) => {
        const rightYear =
          m.programUnit &&
          Number(m.programUnit.requiredYear) === Number(yearToPromote);
        const rightCohort =
          !targetAcadYearId ||
          m.academicYear?.toString() === targetAcadYearId ||
          m.academicYear?._id?.toString() === targetAcadYearId;
        return rightYear && rightCohort;
      });

      const institutionSettings = await InstitutionSettings.findOne({
        institution: (program as any)?.institution,
      }).lean();
      const passMark = (institutionSettings as any)?.passMark ?? 40;
      const gradingScale = (institutionSettings as any)?.gradingScale ?? [];
      const offeredUnitsRaw = await ProgramUnit.find({
        program: programId,
        requiredYear: yearToPromote,
      })
        .populate("unit")
        .lean();
      const offeredUnits = offeredUnitsRaw.map((pu: any) => ({
        code: pu.unit?.code || "N/A",
        name: pu.unit?.name || "N/A",
      }));

      sendProgress(70, "Generating Consolidated Mark Sheet...");

      const excelData: ConsolidatedData = {
        programName: (program as any)?.name || "Program",
        academicYear: academicYearName,
        yearOfStudy: yearToPromote,
        session: sessionExamType,
        students: allStudents,
        marks: filteredMarks,
        offeredUnits,
        logoBuffer,
        institutionId: (program as any)?.institution?.toString() || "",
        programId,
        passMark,
        gradingScale,
      };

      lap("marks + settings");
      const xlsxBuffer = await generateConsolidatedMarkSheet(excelData);
      lap("generate workbook"); lap.done();

      sendProgress(95, "Preparing download...");

      const base64 = xlsxBuffer.toString("base64");
      res.write(
        `data: ${JSON.stringify({ percent: 100, message: "Complete!", file: base64 })}\n\n`,
      );
      res.end();
      await logReportsGenerated(req, programId, yearToPromote, academicYearName, "cms");
      // } catch (err: any) {
      //   console.error("CMS Generation Error:", err);
      //   res.write(`data: ${JSON.stringify({ error: "Failed to generate CMS" })}\n\n`);
      //   res.end();
      // }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[CMS DEBUG] CATCH BLOCK:", message);
      if (err instanceof Error && err.stack) {
        console.error(
          "[CMS DEBUG] STACK:",
          err.stack.split("\n").slice(0, 5).join("\n"),
        );
      }
      res.write(
        `data: ${JSON.stringify({ error: message || "Failed to generate CMS" })}\n\n`,
      );
      res.end();
    }
  }),
);

// GET /promote/award-list?programId=xxx&academicYear=optional
// Returns JSON array of eligible graduates for the frontend preview.
router.get("/award-list", requireAuth, requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, academicYear } = req.query;
    if (!programId) return res.status(400).json({ error: "programId is required" });
 
    const { generateAwardList } = await import("../services/graduationEngine");
    const list = await generateAwardList(programId as string, academicYear as string | undefined);
 
    res.json({ success: true, count: list.length, data: list });
  }),
);
 
// GET /promote/award-list-doc?programId=xxx&academicYear=optional&variant=simple|classified
//   variant=simple     → plain list (S/N, Reg No., Name) — no WAA shown
//   variant=classified → grouped by class with WAA column (default)
router.get("/award-list-doc", requireAuth, requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, academicYear, variant = "classified" } = req.query;
    if (!programId) return res.status(400).json({ error: "programId is required" });
 
    const { generateAwardList }      = await import("../services/graduationEngine");
    const { generateAwardListDoc } = await import("../utils/promotionReport");
 
    const list = await generateAwardList(programId as string, academicYear as string | undefined);
 
    if (list.length === 0) {
      return res.status(404).json({ error: "No eligible graduates found." });
    }
 
    const program    = await Program.findById(programId).lean();
    const logoPath   = path.join(__dirname, "../../public/institutionLogoExcel.png");
    const logoBuffer = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : Buffer.alloc(0);
 
    const docData = {
      programName:   (program as any)?.name || "Program",
      academicYear:  (academicYear as string) || new Date().getFullYear().toString(),
      yearOfStudy:   (program as any)?.durationYears || 5,
      logoBuffer,
      awardList:     list,
      institutionId: req.user.institution.toString(),  // ← ADD
    };
 
    const buffer = (variant === "simple") ? await generateSimpleAwardListDoc(docData) : await generateAwardListDoc(docData);
    const cleanYear = ((academicYear as string) || "ALL").replace(/\//g, "_");
    const progCode  = (program as any)?.code || "PROG";
    const label     = variant === "simple" ? "SIMPLE" : "CLASSIFIED";
    const fileName  = `Award_List_${progCode}_${cleanYear}_${label}.docx`.replace(/\s+/g, "_");
 
    res
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `attachment; filename="${fileName}"`)
      .send(buffer);
  }),
); 

// POST /promote/download-journey-cms
// Generates the multi-year Student Journey CMS workbook for the Board.
router.post("/download-journey-cms", requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, academicYearName } = req.body;
    if (!programId) return res.status(400).json({ error: "programId is required" });
 
    const program = (await Program.findById(programId).lean()) as any;

    const academicYearDoc = academicYearName
  ? await AcademicYear.findOne({ year: academicYearName }).lean() as any
  : null;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
 
    const send = (percent: number, message: string, file?: string) =>
      res.write(`data: ${JSON.stringify({ percent, message, file })}\n\n`);
 
    try {
      send(10, "Loading student data...");
 
      const program    = await Program.findById(programId).lean() as any;
      const logoPath   = path.join(__dirname, "../../public/institutionLogoExcel.png");
      const logoBuffer = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : Buffer.alloc(0);
 
      send(30, "Building academic histories...");
 
      const { generateJourneyCMS } = await import("../utils/journeyCMS");
 
      send(60, "Generating journey workbook...");
 
      const buffer = await generateJourneyCMS({
        // programId,
        // programName:  program?.name || "Program",
        // academicYear: academicYearName || new Date().getFullYear().toString(),
        // logoBuffer,
        // institutionId: program?.institution?.toString() || "",
        programId,
        programName: program.name,
        academicYear: academicYearDoc.year,
        logoBuffer: Buffer.alloc(0), // not used — loadLogoBuffer handles it internally
        institutionId: req.user.institution.toString(),
      });
 
      send(95, "Preparing download...");
 
      const base64 = buffer.toString("base64");
      res.write(`data: ${JSON.stringify({ percent: 100, message: "Complete!", file: base64 })}\n\n`);
      res.end();
    } catch (err: any) {
      console.error("[Journey CMS] Error:", err.message, err.stack);
      res.write(`data: ${JSON.stringify({ error: err.message || "Failed to generate Journey CMS" })}\n\n`);
      res.end();
    }
  }),
);

// promote individual student
router.post("/:studentId", requireAuth, requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { studentId } = req.params;
    const result = await promoteStudent(studentId);

    if (!result.success) return res.status(400).json({error: "Promotion Denied", message: result.message, details: result.details});

    await logAudit(req, { action: "individual_student_promoted", targetUser: studentId as any, details: { message: result.message }});
    res.json(result);
  }),
);

// POST /promote/undo/:studentId
router.post("/undo/:studentId", requireAuth, requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { studentId } = req.params;
 
    const result = await undoPromotion(studentId);
 
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }
 
    await logAudit(req, {
      action:     "promotion_reversed",
      targetUser: studentId as any,
      details: { message: result.message, previousYear: result.previousYear, restoredYear: result.restoredYear },
    });
 
    res.json(result);
  })
);



export default router;