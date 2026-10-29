// serverside/src/routes/students.ts — GET /students/template — COMPLETE

import { REG_QUALIFIERS } from "../utils/academicRules";
import { Router, Response } from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import path from "path";
import Student from "../models/Student";
import Program from "../models/Program";
import AcademicYear from "../models/AcademicYear";
import {
  requireAuth,
  requireRole,
  AuthenticatedRequest,
  getScopedProgramIds,
} from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { logAudit } from "../lib/auditLogger";
import { paginate } from "../utils/paginate";
import { normalizeProgramName } from "../services/programNormalizer";
import { validateRegNo } from "../utils/validateRegNo";
import { loadInstitutionSettings } from "../utils/loadInstitutionSettings";
import { loadLogoBuffer } from "../utils/loadLogoBuffer";
import { ApiError } from "../middleware/errorHandler";
import {
  getIntakeDefinitions,
  resolveAdmissionIntake,
} from "../utils/intakeDefinitions";
import { intakeCodesOf } from "../utils/semesterLabels";
import { splitRegNo, loadExistingByBase } from "../utils/regNoQualifier";
import { transferFromQualifier } from "../services/complianceTracking";
import multer from "multer";
import * as xlsxLib from "xlsx";

/** Qualifiers doc: mid-entry students carry M2 / M3 when no qualifier was supplied. */
/** A programme can only be entered in a year it actually has (BEd 1–its duration, BSc 1–its duration). */
const entryYearError = (
  year: number,
  p: { durationYears?: number; name?: string },
): string | null =>
  p.durationYears && (year < 1 || year > p.durationYears)
    ? `Year ${year} does not exist in ${p.name ?? "this programme"} (years 1–${p.durationYears}).`
    : null;

const midEntryQualifier = (entryType: string): string =>
  entryType === "Mid-Entry-Y2"
    ? REG_QUALIFIERS.midEntry(2)
    : entryType === "Mid-Entry-Y3"
      ? REG_QUALIFIERS.midEntry(3)
      : "";

const router = Router();

// ── Lean interfaces ────────────────────────────────────────────────────────────
interface ProgramLean {
  _id: mongoose.Types.ObjectId;
  name: string;
  code: string;
  durationYears: number;
  degreeType: string;
  intakes?: string[];
}

interface ProgramRef {
  _id: mongoose.Types.ObjectId;
  code: string;
  name: string;
  intakes?: string[];
  durationYears?: number;
  degreeType?: string;
}

interface AcademicYearLean {
  _id: mongoose.Types.ObjectId;
  year: string;
  intakeSemesters?: Array<{ intake: string; semester: number }>;
}

// Reg-pattern shape from InstitutionSettings
interface RegNoPattern {
  prefix: string;
  separator: string;
  yearDigits: number;
  example: string;
  manualRegex?: string;
}

const uploadStudentExcelMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /\.(xlsx|xls|csv)$/i.test(file.originalname));
  },
});

// ── GET /students ──────────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, parseInt(req.query.limit as string) || 20);
      const search = ((req.query.search as string) ?? "").trim();

      if (!search) {
        res.json({ students: [], total: 0, page, totalPages: 0 });
        return;
      }

      const allowedProgramIds = await getScopedProgramIds(req);
      const filter: Record<string, unknown> = {
        institution: req.user.institution,
        program: { $in: allowedProgramIds },
        $or: [
          { regNo: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
        ],
      };

      const [students, total] = await Promise.all([
        paginate(
          Student.find(filter)
            .select(
              "regNo name program currentYearOfStudy status qualifierSuffix intake",
            )
            .populate("program", "name code departmentCode schoolCode")
            .lean(),
          page,
          limit,
        ),
        Student.countDocuments(filter),
      ]);

      res.json({
        students,
        total,
        page,
        totalPages: Math.ceil(total / Math.min(100, limit)),
      });
    },
  ),
);

// ── GET /students/stats ────────────────────────────────────────────────────────
router.get(
  "/stats",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const allowedProgramIds = await getScopedProgramIds(req);
      const base = {
        institution: req.user.institution,
        program: { $in: allowedProgramIds },
      };

      const [total, active, graduated, discontinued] = await Promise.all([
        Student.countDocuments(base),
        Student.countDocuments({ ...base, status: "active" }),
        Student.countDocuments({ ...base, status: "graduated" }),
        Student.countDocuments({ ...base, status: "discontinued" }),
      ]);

      res.json({
        total,
        active,
        inactive: total - active,
        graduated,
        discontinued,
      });
    },
  ),
);

// ── GET /students/template ─────────────────────────────────────────────────────
// Generates an Excel registration template scoped to the coordinator's department.
// If programId is supplied, locks the program column to that program.
// If no programId, shows a dropdown of all programs in coordinator's scope.
// University name and logo come from InstitutionSettings (DB), not env vars.
// Reg-no patterns from InstitutionSettings.schools[schoolCode].departments[deptCode]
// are shown in the header and used for data-validation in the Reg No column.
router.get(
  "/template",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { programId, academicYearId } = req.query;
      const institutionId = req.user.institution.toString();

      // ── 1. Load institution settings + logo from DB ────────────────────────────
      const [settings, logoBuffer] = await Promise.all([
        loadInstitutionSettings(institutionId),
        loadLogoBuffer(institutionId),
      ]);

      const universityName = settings.docMeta.universityName || "University";
      const schoolName = settings.docMeta.schoolName || "";

      // ── 2. Resolve coordinator's department reg-no patterns ────────────────────
      // Used to: (a) show format hint in header, (b) add cell validation
      const mySchoolCode = req.user.schoolCode ?? null;
      const myDeptCode = req.user.departmentCode ?? null;

      let deptPatterns: RegNoPattern[] = [];
      let deptName = "";

      if (mySchoolCode && myDeptCode && settings) {
        // settings.schools is ISchool[] from loadInstitutionSettings
        const schoolsRaw =
          (
            settings as unknown as {
              schools?: Array<{
                code: string;
                name: string;
                departments?: Array<{
                  code: string;
                  name: string;
                  regNoPatterns?: RegNoPattern[];
                }>;
              }>;
            }
          ).schools ?? [];

        const school = schoolsRaw.find(
          (s) => s.code === mySchoolCode.toUpperCase(),
        );
        const dept = school?.departments?.find(
          (d) => d.code === myDeptCode.toUpperCase(),
        );
        deptPatterns = dept?.regNoPatterns ?? [];
        deptName = dept?.name ?? "";
      }

      const enforcePatterns =
        (settings as unknown as { enforceRegNoPattern?: boolean })
          .enforceRegNoPattern ?? false;
      const patternExample =
        deptPatterns.length > 0
          ? deptPatterns.map((p) => p.example).join("  or  ")
          : "";

      // ── 3. Scope programs to coordinator's department ──────────────────────────
      const allowedProgramIds = await getScopedProgramIds(req);
      let programs: ProgramRef[] = [];
      let selectedProgram: ProgramRef | null = null;

      if (programId && mongoose.Types.ObjectId.isValid(programId as string)) {
        const pid = new mongoose.Types.ObjectId(programId as string);
        if (allowedProgramIds.map(String).includes(pid.toString())) {
          selectedProgram =
            (await Program.findOne({
              _id: pid,
              institution: req.user.institution,
            })
              .select("code name intakes durationYears degreeType")
              .lean<ProgramRef>()) ?? null;
        }
        if (selectedProgram) programs = [selectedProgram];
      }

      if (!selectedProgram) {
        // Load all scoped programs for the dropdown
        programs = await Program.find({
          institution: req.user.institution,
          _id: { $in: allowedProgramIds },
          isActive: true,
        })
          .select("code name")
          .sort({ name: 1 })
          .lean<ProgramRef[]>();
      }

      // ── 4. Resolve academic year ──────────────────────────────────────────────
      const yearFilter =
        academicYearId &&
        mongoose.Types.ObjectId.isValid(academicYearId as string)
          ? { _id: new mongoose.Types.ObjectId(academicYearId as string) }
          : { institution: req.user.institution, isCurrent: true };

      const yearDoc = await AcademicYear.findOne(yearFilter)
        .select("year")
        .lean<AcademicYearLean>();
      const currentYearString = yearDoc?.year ?? "General";

      // Intakes offered in the template: the selected program's, else all the institution defines
      const tplDefs = await getIntakeDefinitions(req.user.institution);
      const tplIntakes = selectedProgram?.intakes?.length
        ? selectedProgram.intakes
        : intakeCodesOf(tplDefs);

      // ── 5. Build workbook ─────────────────────────────────────────────────────
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Registration Template");
      const fontName = "Book Antiqua";

      const centerBold = {
        alignment: {
          horizontal: "center" as const,
          vertical: "middle" as const,
        },
        font: { bold: true, name: fontName },
      };

      const thinBorder = {
        top: { style: "thin" as const },
        left: { style: "thin" as const },
        bottom: { style: "thin" as const },
        right: { style: "thin" as const },
      };

      // ── Row 1: Logo (left) + University name (center) ─────────────────────────
      let currentRow = 1;

      // if (logoBuffer && logoBuffer.length > 0) {
      //   const logoId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
      //   worksheet.addImage(logoId, { tl:  { col: 0, row: 0 }, ext: { width: 80, height: 80 }});
      // }

      // University name — columns B to E merged, row 1
      worksheet.mergeCells("B1:E1");
      const uniCell = worksheet.getCell("B1");
      uniCell.value = universityName.toUpperCase();
      uniCell.style = {
        ...centerBold,
        font: { ...centerBold.font, size: 14, underline: true },
      };
      worksheet.getRow(1).height = 45;

      // ── Row 2: School name ─────────────────────────────────────────────────────
      if (schoolName) {
        worksheet.mergeCells("B2:E2");
        const schCell = worksheet.getCell("B2");
        schCell.value = schoolName.toUpperCase();
        schCell.style = {
          ...centerBold,
          font: { ...centerBold.font, size: 11 },
        };
        worksheet.getRow(2).height = 20;
        currentRow = 2;
      }

      // ── Row 3: Department + Program ───────────────────────────────────────────
      currentRow++;
      const progRowNum = currentRow;
      worksheet.mergeCells(`A${progRowNum}:E${progRowNum}`);
      const progCell = worksheet.getCell(`A${progRowNum}`);
      progCell.value = selectedProgram
        ? `${selectedProgram.code} — ${selectedProgram.name.toUpperCase()}`
        : deptName
          ? `${deptName.toUpperCase()} — ALL PROGRAMS (select below)`
          : "ALL PROGRAMS — Select from dropdown";
      progCell.style = {
        ...centerBold,
        font: { ...centerBold.font, size: 11 },
      };
      worksheet.getRow(progRowNum).height = 20;

      // ── Row 4: Academic year ───────────────────────────────────────────────────
      currentRow++;
      worksheet.mergeCells(`A${currentRow}:E${currentRow}`);
      const yrCell = worksheet.getCell(`A${currentRow}`);
      yrCell.value = `REGISTRATION TEMPLATE — ${currentYearString} ACADEMIC YEAR`;
      yrCell.style = { ...centerBold, font: { ...centerBold.font, size: 11 } };
      worksheet.getRow(currentRow).height = 18;

      // ── Row 5: Reg-no format notice (only if patterns configured) ──────────────
      currentRow++;
      worksheet.mergeCells(`A${currentRow}:E${currentRow}`);
      const fmtCell = worksheet.getCell(`A${currentRow}`);
      if (patternExample) {
        fmtCell.value = `Reg No format for ${myDeptCode}: ${patternExample}${enforcePatterns ? " (enforced)" : " (reference)"} — Qualifier column is optional`;
        fmtCell.style = {
          alignment: {
            horizontal: "center" as const,
            vertical: "middle" as const,
          },
          font: {
            name: fontName,
            size: 9,
            color: { argb: "FF1E40AF" },
            bold: true,
          },
          fill: {
            type: "pattern" as const,
            pattern: "solid" as const,
            fgColor: { argb: "FFDBEAFE" },
          },
        };
      } else {
        fmtCell.value =
          "Reg No, Full Name and Program are required. Qualifier is set by the system (Year 2 → M2, Year 3 → M3); type TF2 / TF3 only for a transfer student.";
        fmtCell.style = {
          alignment: {
            horizontal: "center" as const,
            vertical: "middle" as const,
          },
          font: { name: fontName, size: 9, color: { argb: "FF6B7280" } },
          fill: {
            type: "pattern" as const,
            pattern: "solid" as const,
            fgColor: { argb: "FFF9FAFB" },
          },
        };
      }
      worksheet.getRow(currentRow).height = 16;

      // ── Empty spacer row ───────────────────────────────────────────────────────
      currentRow++;
      worksheet.getRow(currentRow).height = 6;

      // ── Header row ────────────────────────────────────────────────────────────
      const headerRowNum = currentRow + 1;
      currentRow = headerRowNum;
      const headerRow = worksheet.getRow(headerRowNum);
      [
        "Reg No",
        "Full Name",
        "Program",
        "Year of Study",
        "Intake",
        "Qualifier (auto)",
      ].forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.style = {
          font: {
            bold: true,
            name: fontName,
            size: 10,
            color: { argb: "FFFFFFFF" },
          },
          fill: {
            type: "pattern" as const,
            pattern: "solid" as const,
            fgColor: { argb: "FF1E3A5F" },
          },
          alignment: {
            horizontal: "center" as const,
            vertical: "middle" as const,
          },
          border: thinBorder,
        };
      });
      headerRow.height = 22;

      // ── Data rows ─────────────────────────────────────────────────────────────
      const dataStartRow = headerRowNum + 1;
      const dataEndRow = dataStartRow + 500;
      const fixedProgramName = selectedProgram?.name ?? "";

      // Build reg-no regex patterns for data validation
      // Excel doesn't support JS regex natively, so we use "Custom" validation
      // with a helper formula only if manualRegex is not supplied.
      // For simple prefix patterns we use a text-contains approach.
      const firstPattern = deptPatterns[0] ?? null;

      for (let r = dataStartRow; r <= dataEndRow; r++) {
        const row = worksheet.getRow(r);
        row.font = { name: fontName, size: 10 };

        for (let c = 1; c <= 6; c++) {
          row.getCell(c).border = thinBorder;
        }

        // Col A — Reg No
        const regCell = row.getCell(1);
        regCell.protection = { locked: false };
        // Add data validation hint if pattern configured
        if (enforcePatterns && firstPattern) {
          regCell.dataValidation = {
            type: "textLength",
            operator: "greaterThan",
            allowBlank: true,
            formulae: [2], // must be > 2 chars
            showErrorMessage: true,
            errorTitle: "Invalid Reg Number",
            error: `Format: ${patternExample}`,
          };
        }

        // Col B — Full Name
        row.getCell(2).protection = { locked: false };

        // Col C — Program
        const progDataCell = row.getCell(3);
        if (selectedProgram) {
          // Locked to selected program
          progDataCell.value = fixedProgramName;
          progDataCell.fill = {
            type: "pattern" as const,
            pattern: "solid" as const,
            fgColor: { argb: "FFF0FDF4" },
          };
          progDataCell.font = {
            name: fontName,
            size: 10,
            color: { argb: "FF166534" },
          };
          progDataCell.protection = { locked: true };
        } else {
          progDataCell.protection = { locked: false };
          if (programs.length > 0) {
            // Build dropdown list — max 255 chars for Excel
            const optStr = programs.map((p) => p.name).join(",");
            const safeOpts =
              optStr.length <= 250
                ? `"${optStr}"`
                : `"${programs
                    .slice(0, Math.floor(programs.length / 2))
                    .map((p) => p.name)
                    .join(",")}"`;
            progDataCell.dataValidation = {
              type: "list",
              allowBlank: false,
              formulae: [safeOpts],
              showErrorMessage: true,
              errorTitle: "Invalid Program",
              error: "Please select a program from the dropdown list.",
            };
          }
        }

        // Col D — Year of Study
        const yearDataCell = row.getCell(4);
        yearDataCell.protection = { locked: false };
        yearDataCell.dataValidation = {
          type: "list",
          allowBlank: false,
          formulae: [
            `"${Array.from({ length: Math.min(selectedProgram?.durationYears || 6, 6) }, (_, i) => i + 1).join(",")}"`,
          ],
          showErrorMessage: true,
          errorTitle: "Invalid Year",
          error: `Year of study must be 1–${Math.min(selectedProgram?.durationYears || 6, 6)} for this programme.`,
        };

        // Col F — Qualifier: set by the system from the year of study (Year 2 → M2, Year 3 → M3, Year 1 → none).
        // Left unlocked so a transfer (TF2/TF3/TF2S2/TF3S2) can still be typed over the automatic value.
        row.getCell(6).protection = { locked: false };

        // Col E — Intake
        const intakeCell = row.getCell(5);
        intakeCell.protection = { locked: false };
        intakeCell.value = tplIntakes[0]; // the program's first intake
        intakeCell.dataValidation = {
          type: "list",
          allowBlank: false,
          formulae: [`"${tplIntakes.join(",")}"`],
          showErrorMessage: true,
          errorTitle: "Invalid Intake",
          error: `Intake must be one of: ${tplIntakes.join(", ")}.`,
        };
      }

      // ── Alternate row shading for readability ─────────────────────────────────
      for (let r = dataStartRow; r <= dataEndRow; r += 2) {
        const row = worksheet.getRow(r);
        for (let c = 1; c <= 5; c++) {
          const cell = row.getCell(c);
          if (
            !cell.fill ||
            (cell.fill as ExcelJS.FillPattern).type !== "pattern"
          ) {
            cell.fill = {
              type: "pattern" as const,
              pattern: "solid" as const,
              fgColor: { argb: "FFF9FAFB" },
            };
          }
        }
      }

      // ── Column widths ─────────────────────────────────────────────────────────
      worksheet.getColumn("A").width = 28; // Reg No — wide enough for E024-01-0001/2024
      worksheet.getColumn("B").width = 40; // Full Name
      worksheet.getColumn("C").width = 52; // Program name — longest field
      worksheet.getColumn("D").width = 18; // Year of Study
      worksheet.getColumn("E").width = 12; // Intake
      worksheet.getColumn("F").width = 20; // Qualifier — optional (RP1, M2, TF2 …)

      // ── Freeze header rows ────────────────────────────────────────────────────
      worksheet.views = [{ state: "frozen", ySplit: headerRowNum }];

      // ── Sheet protection — lock structure but allow data entry ────────────────
      worksheet.protect("", {
        selectLockedCells: true,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
      });

      // ── Generate buffer and send ──────────────────────────────────────────────
      const buffer = await workbook.xlsx.writeBuffer();
      const safeYear = currentYearString.replace(/\//g, "-");
      const cleanName = selectedProgram
        ? selectedProgram.name
            .replace(/[^a-zA-Z0-9\s]/g, "")
            .replace(/\s+/g, "_")
            .toUpperCase()
            .slice(0, 40)
        : (myDeptCode ?? "ALL");
      const filename = `Registration_Template_${cleanName}_${safeYear}.xlsx`;

      res
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("Access-Control-Expose-Headers", "Content-Disposition")
        .send(Buffer.from(buffer as ArrayBuffer));

      await logAudit(req, {
        action: "template_download",
        details: {
          type: "student_registration",
          programId,
          universityName,
          deptCode: myDeptCode,
        },
      });
    },
  ),
);

// ── POST /students/bulk ────────────────────────────────────────────────────────
router.post(
  "/bulk",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      interface BulkRow {
        regNo: string;
        name: string;
        program: string;
        currentYearOfStudy?: number;
        academicYearId?: string;
        intake?: string;
        admissionAcademicYearString?: string;
        /** Optional — RP1, M2, TF2 … (may also be glued to regNo) */
        qualifier?: string;
      }

      const { students } = req.body as { students: BulkRow[] };
      if (!Array.isArray(students) || students.length === 0) {
        res.status(400).json({ message: "No students provided" });
        return;
      }

      const institutionId = req.user.institution;
      const allowedProgramIds = await getScopedProgramIds(req);

      const incoming = students.map((s) => ({
        // Identity = base reg no. A qualifier typed into the reg no or the
        // Qualifier column is split off and stored separately.
        ...(() => {
          const sp = splitRegNo(s.regNo, s.qualifier);
          return { regNo: sp.base, qualifier: sp.qualifier };
        })(),
        name: (s.name ?? "").trim(),
        rawProgram: (s.program ?? "").trim(),
        normalizedProgram: normalizeProgramName((s.program ?? "").trim()),
        yearOfStudy: Number(s.currentYearOfStudy) || 1,
        academicYearId: s.academicYearId,
        intake: (s.intake ?? "").trim().toUpperCase(),
        admissionAcademicYearString:
          s.admissionAcademicYearString ?? "2024/2025",
      }));

      const invalid = incoming.filter(
        (s) => !s.regNo || !s.name || !s.rawProgram,
      );
      if (invalid.length > 0) {
        res.status(400).json({ message: "Missing Reg No, Name, or Program" });
        return;
      }

      const dbPrograms = await Program.find({
        institution: institutionId,
        _id: { $in: allowedProgramIds },
      })
        .select("name code durationYears degreeType intakes")
        .lean<ProgramLean[]>();
      const intakeDefs = await getIntakeDefinitions(institutionId);

      const programNameMap = new Map(
        dbPrograms.map((p) => [normalizeProgramName(p.name), p]),
      );
      const programIdMap = new Map(
        dbPrograms.map((p) => [p._id.toString(), p]),
      );

      const missingPrograms = [
        ...new Set(incoming.map((s) => s.rawProgram)),
      ].filter(
        (raw) =>
          !programIdMap.has(raw) &&
          !programNameMap.has(normalizeProgramName(raw)),
      );
      if (missingPrograms.length > 0) {
        res.status(400).json({
          message: "Programs not found or not in your scope",
          notFound: missingPrograms,
        });
        return;
      }

      // Resolve academic years
      const academicYearMap = new Map<string, mongoose.Types.ObjectId>();
      const yearStrings = [
        ...new Set(
          incoming
            .filter((s) => !s.academicYearId)
            .map((s) => s.admissionAcademicYearString),
        ),
      ];

      if (yearStrings.length > 0) {
        const bulkOps = yearStrings.map((yearStr) => {
          const [startYear, endYear] = yearStr.split("/").map(Number);
          return {
            updateOne: {
              filter: { year: yearStr, institution: institutionId },
              update: {
                $setOnInsert: {
                  year: yearStr,
                  institution: institutionId,
                  startDate: new Date(`${startYear}-08-01`),
                  endDate: new Date(`${endYear}-07-31`),
                  isCurrent: false,
                },
              },
              upsert: true,
            },
          };
        });
        await AcademicYear.bulkWrite(bulkOps);

        const resolvedYears = await AcademicYear.find({
          institution: institutionId,
          year: { $in: yearStrings },
        })
          .select("year")
          .lean<AcademicYearLean[]>();

        resolvedYears.forEach((y) => academicYearMap.set(y.year, y._id));
      }

      // Intakes each academic year is configured to run (unconfigured years are not checked)
      const yearIds = [
        ...new Set([
          ...incoming
            .map((s) => s.academicYearId)
            .filter(
              (v): v is string => !!v && mongoose.Types.ObjectId.isValid(v),
            ),
          ...[...academicYearMap.values()].map((v) => v.toString()),
        ]),
      ];
      const yearDocs = yearIds.length
        ? await AcademicYear.find({
            _id: { $in: yearIds },
            institution: institutionId,
          })
            .select("year intakeSemesters")
            .lean<AcademicYearLean[]>()
        : [];
      const yearInfo = new Map(
        yearDocs.map((y) => [
          y._id.toString(),
          {
            label: y.year,
            intakes: (y.intakeSemesters ?? []).map((m) => m.intake),
          },
        ]),
      );

      // Duplicate check on the BASE reg no — with or without qualifier it is the same student.
      const existingByBase = await loadExistingByBase(
        Student,
        institutionId,
        incoming.map((s) => s.regNo),
      );
      const seenInBatch = new Set<string>();

      const regNoCache = new Map<string, Promise<unknown>>(); // one settings/programme read per upload
      const results = {
        registered: [] as string[],
        duplicates: [] as string[],
        errors: [] as string[],
        /** existing students that had no qualifier and received one from this upload */
        qualifierUpdated: [] as string[],
        /** things that are accepted but fall outside the regulations (ENG.25 weightings / qualifiers document) */
        warnings: [] as string[],
      };
      const toCreate: Array<Record<string, unknown>> = [];

      for (const s of incoming) {
        const known = existingByBase.get(s.regNo);
        if (known || seenInBatch.has(s.regNo)) {
          results.duplicates.push(
            s.qualifier ? `${s.regNo}${s.qualifier}` : s.regNo,
          );
          if (known && s.qualifier && !known.qualifierSuffix) {
            await Student.updateOne(
              { _id: known._id },
              { $set: { qualifierSuffix: s.qualifier } },
            );
            results.qualifierUpdated.push(s.regNo);
          }
          continue;
        }
        seenInBatch.add(s.regNo);

        const progDoc =
          programIdMap.get(s.rawProgram) ??
          programNameMap.get(s.normalizedProgram);
        if (!progDoc) {
          results.errors.push(`${s.regNo}: Program not found`);
          continue;
        }

        // Reg-no validation (server-side, authoritative)
        const validation = await validateRegNo(
          s.regNo,
          institutionId.toString(),
          progDoc._id.toString(),
          regNoCache,
        );
        if (!validation.valid) {
          results.errors.push(
            `${s.regNo}: ${validation.reason ?? "Invalid reg no format"}`,
          );
          continue;
        }

        const yearErr = entryYearError(s.yearOfStudy, progDoc);
        if (yearErr) {
          results.errors.push(`${s.regNo}: ${yearErr}`);
          continue;
        }

        const entryType:
          | "Direct"
          | "Mid-Entry-Y2"
          | "Mid-Entry-Y3"
          | "Mid-Entry-Y4" =
          s.yearOfStudy === 2
            ? "Mid-Entry-Y2"
            : s.yearOfStudy === 3
              ? "Mid-Entry-Y3"
              : s.yearOfStudy === 4
                ? "Mid-Entry-Y4"
                : "Direct";
        if (entryType === "Mid-Entry-Y4")
          results.warnings.push(
            `${s.regNo}: entry into year 4 has no mid-entry weighting or qualifier in ENG.25 / the qualifiers document; direct-entry weights will be used.`,
          );

        const programType = progDoc.degreeType ?? "BSc";

        let finalYearId: mongoose.Types.ObjectId;
        if (
          s.academicYearId &&
          mongoose.Types.ObjectId.isValid(s.academicYearId)
        ) {
          finalYearId = new mongoose.Types.ObjectId(s.academicYearId);
        } else {
          const resolved = academicYearMap.get(s.admissionAcademicYearString);
          if (!resolved) {
            results.errors.push(`${s.regNo}: Academic year not resolved`);
            continue;
          }
          finalYearId = resolved;
        }

        const yInfo = yearInfo.get(finalYearId.toString());
        const adm = resolveAdmissionIntake({
          intakeRaw: s.intake,
          defs: intakeDefs,
          programName: progDoc.name,
          programIntakes: progDoc.intakes,
          yearLabel: yInfo?.label,
          yearConfiguredIntakes: yInfo?.intakes ?? null,
        });
        if ("error" in adm) {
          results.errors.push(`${s.regNo}: ${adm.error}`);
          continue;
        }

        toCreate.push({
          regNo: s.regNo,
          qualifierSuffix: s.qualifier || midEntryQualifier(entryType),
          transfer: transferFromQualifier(s.qualifier),
          name: s.name,
          institution: institutionId,
          program: progDoc._id,
          programType,
          entryType,
          intake: adm.intake,
          currentYearOfStudy: s.yearOfStudy,
          admissionAcademicYear: finalYearId,
          status: "active",
        });
      }

      if (toCreate.length > 0) {
        try {
          const created = await Student.insertMany(toCreate, {
            ordered: false,
          });
          results.registered.push(...created.map((c) => String(c.regNo)));
        } catch (err: unknown) {
          interface BulkWriteError {
            insertedDocs?: Array<{ regNo?: unknown }>;
            writeErrors?: Array<{ code?: number; op?: { regNo?: unknown } }>;
          }
          const bwe = err as BulkWriteError;
          if (bwe.insertedDocs) {
            results.registered.push(
              ...bwe.insertedDocs.map((d) => String(d.regNo ?? "")),
            );
          }
          if (bwe.writeErrors) {
            bwe.writeErrors
              .filter((e) => e.code === 11000)
              .forEach((e) =>
                results.duplicates.push(String(e.op?.regNo ?? "")),
              );
          }
        }
      }

      await logAudit(req, {
        action: "students_bulk_registered",
        details: {
          registered: results.registered.length,
          duplicates: results.duplicates.length,
          errors: results.errors.length,
        },
      });

      res.status(207).json({
        message: `${results.registered.length} registered, ${results.duplicates.length} duplicates, ${results.errors.length} errors.`,
        ...results,
      });
    },
  ),
);

// ── DELETE /students/:id ───────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const allowedProgramIds = await getScopedProgramIds(req);
      const student = await Student.findOneAndDelete({
        _id: req.params.id,
        institution: req.user.institution,
        program: { $in: allowedProgramIds },
      });
      if (!student) {
        throw {
          statusCode: 404,
          message: "Student not found or outside your scope",
        } as ApiError;
      }
      await logAudit(req, {
        action: "delete_student",
        details: { regNo: student.regNo },
      });
      res.json({ message: "Student deleted successfully" });
    },
  ),
);

// ── PATCH /students/:id ────────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { name } = req.body as { name?: string };
      if (!name?.trim()) {
        throw { statusCode: 400, message: "Name is required" } as ApiError;
      }
      const allowedProgramIds = await getScopedProgramIds(req);
      const student = await Student.findOneAndUpdate(
        {
          _id: req.params.id,
          institution: req.user.institution,
          program: { $in: allowedProgramIds },
        },
        { $set: { name: name.trim() } },
        { new: true },
      ).select("name regNo");
      if (!student) {
        throw {
          statusCode: 404,
          message: "Student not found or outside your scope",
        } as ApiError;
      }
      await logAudit(req, {
        action: "update_student_name",
        details: { regNo: student.regNo },
      });
      res.json(student);
    },
  ),
);

// ── DELETE /students/bulk/by-program ──────────────────────────────────────────
router.delete(
  "/bulk/by-program",
  requireAuth,
  requireRole("admin"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { programId } = req.body as { programId?: string };
      if (!programId)
        throw { statusCode: 400, message: "Program ID required" } as ApiError;
      const result = await Student.deleteMany({
        program: programId,
        institution: req.user.institution,
      });
      await logAudit(req, {
        action: "bulk_delete_program_students",
        details: { programId, count: result.deletedCount },
      });
      res.json({
        message: `Deleted ${result.deletedCount} students from program.`,
      });
    },
  ),
);

// ── POST /students/upload-excel ───────────────────────────────────────────────
router.post(
  "/upload-excel",
  requireAuth,
  requireRole("coordinator", "admin"),
  uploadStudentExcelMiddleware.single("file"),
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!req.file) {
        res.status(400).json({ message: "No file uploaded." });
        return;
      }

      const institutionId = req.user.institution;
      const allowedProgramIds = await getScopedProgramIds(req);

      // ── Parse workbook ────────────────────────────────────────────────────────
      const workbook = xlsxLib.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawAll = xlsxLib.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: "",
      });

      // Find header row — scan for the cell that says "Reg No"
      let headerIndex = -1;
      for (let i = 0; i < rawAll.length; i++) {
        const row = rawAll[i] as string[];
        const cell = (row[0] ?? "").toString().toLowerCase().trim();
        if (cell === "reg no" || cell === "reg. no." || cell === "regno") {
          headerIndex = i;
          break;
        }
      }

      if (headerIndex === -1) {
        res.status(400).json({
          message:
            "Header row not found. Ensure you downloaded the registration template and that column A header is 'Reg No'.",
        });
        return;
      }

      const dataRows = (rawAll.slice(headerIndex + 1) as string[][]).filter(
        (r) => r.some((c) => String(c ?? "").trim() !== ""),
      );

      if (dataRows.length === 0) {
        res.status(400).json({ message: "No student data found in the file." });
        return;
      }

      // ── Resolve allowed programs ──────────────────────────────────────────────
      const dbPrograms = await Program.find({
        institution: institutionId,
        _id: { $in: allowedProgramIds },
        isActive: true,
      })
        .select("name code durationYears degreeType intakes")
        .lean<ProgramLean[]>();
      const intakeDefs = await getIntakeDefinitions(institutionId);

      const programByName = new Map(
        dbPrograms.map((p) => [normalizeProgramName(p.name), p]),
      );
      const programByCode = new Map(
        dbPrograms.map((p) => [p.code.toUpperCase(), p]),
      );

      // ── Get current academic year (fallback) ──────────────────────────────────
      const currentYear = await AcademicYear.findOne({
        institution: institutionId,
        isCurrent: true,
      })
        .select("_id year intakeSemesters")
        .lean<AcademicYearLean>();
      const currentYearIntakes = (currentYear?.intakeSemesters ?? []).map(
        (m) => m.intake,
      );

      // ── Process rows ──────────────────────────────────────────────────────────
      const regNoCache = new Map<string, Promise<unknown>>(); // one settings/programme read per upload
      const results = {
        registered: [] as string[],
        duplicates: [] as string[],
        errors: [] as string[],
        skipped: 0,
        /** existing students that had no qualifier and received one from this file */
        qualifierUpdated: [] as string[],
        /** things that are accepted but fall outside the regulations (ENG.25 weightings / qualifiers document) */
        warnings: [] as string[],
      };

      const toCreate: Array<Record<string, unknown>> = [];
      const regNosToCreate: string[] = [];

      for (const [i, row] of dataRows.entries()) {
        // Base reg no + optional qualifier (column F, or glued onto the reg no)
        const { base: regNo, qualifier } = splitRegNo(row[0], row[5]);
        const name = String(row[1] ?? "").trim();
        const progRaw = String(row[2] ?? "").trim();
        const yearRaw = parseInt(String(row[3] ?? "1")) || 1;
        const intake = String(row[4] ?? "")
          .trim()
          .toUpperCase();

        // Blank rows — skip silently
        if (!regNo && !name) {
          results.skipped++;
          continue;
        }

        const rowNum = headerIndex + i + 2;

        if (!regNo) {
          results.errors.push(`Row ${rowNum}: Missing Reg No`);
          continue;
        }
        if (!name) {
          results.errors.push(`Row ${rowNum} (${regNo}): Missing Name`);
          continue;
        }
        if (!progRaw) {
          results.errors.push(`Row ${rowNum} (${regNo}): Missing Program`);
          continue;
        }

        // Resolve program — by name first, then by code
        const progDoc =
          programByName.get(normalizeProgramName(progRaw)) ??
          programByCode.get(progRaw.toUpperCase());

        if (!progDoc) {
          results.errors.push(
            `Row ${rowNum} (${regNo}): Program "${progRaw}" not found in your department scope`,
          );
          continue;
        }

        // Server-side reg-no validation
        const validation = await validateRegNo(
          regNo,
          institutionId.toString(),
          progDoc._id.toString(),
          regNoCache,
        );
        if (!validation.valid) {
          results.errors.push(`Row ${rowNum} (${regNo}): ${validation.reason}`);
          continue;
        }

        const adm = resolveAdmissionIntake({
          intakeRaw: intake,
          defs: intakeDefs,
          programName: progDoc.name,
          programIntakes: progDoc.intakes,
          yearLabel: currentYear?.year,
          yearConfiguredIntakes: currentYearIntakes,
        });
        if ("error" in adm) {
          results.errors.push(`Row ${rowNum} (${regNo}): ${adm.error}`);
          continue;
        }
        const safeIntake = adm.intake;
        const yearErr2 = entryYearError(Number(yearRaw) || 1, progDoc as any);
        if (yearErr2) {
          results.errors.push(`Row ${rowNum} (${regNo}): ${yearErr2}`);
          continue;
        }
        const entryType =
          yearRaw === 2
            ? "Mid-Entry-Y2"
            : yearRaw === 3
              ? "Mid-Entry-Y3"
              : yearRaw === 4
                ? "Mid-Entry-Y4"
                : "Direct";
        if (entryType === "Mid-Entry-Y4")
          results.warnings.push(
            `${regNo}: entry into year 4 has no mid-entry weighting or qualifier in ENG.25 / the qualifiers document; direct-entry weights will be used.`,
          );

        toCreate.push({
          regNo,
          qualifierSuffix: qualifier || midEntryQualifier(entryType),
          transfer: transferFromQualifier(qualifier),
          name,
          institution: institutionId,
          program: progDoc._id,
          programType: progDoc.degreeType ?? "BSc",
          entryType,
          intake: safeIntake,
          currentYearOfStudy: yearRaw,
          admissionAcademicYear: currentYear?._id,
          status: "active",
        });
        regNosToCreate.push(regNo);
      }

      // ── Batch duplicate check ─────────────────────────────────────────────────
      if (regNosToCreate.length > 0) {
        // Keyed on the BASE reg no: with or without qualifier = same student.
        const existingByBase = await loadExistingByBase(
          Student,
          institutionId,
          regNosToCreate,
        );
        const seenInFile = new Set<string>();

        const newStudents: Array<Record<string, unknown>> = [];
        for (const s of toCreate) {
          const base = s.regNo as string;
          const qualifier = (s.qualifierSuffix as string) || "";
          const known = existingByBase.get(base);
          if (known || seenInFile.has(base)) {
            results.duplicates.push(`${base}${qualifier}`);
            if (known && qualifier && !known.qualifierSuffix) {
              await Student.updateOne(
                { _id: known._id },
                { $set: { qualifierSuffix: qualifier } },
              );
              results.qualifierUpdated.push(base);
            }
            continue;
          }
          seenInFile.add(base);
          newStudents.push(s);
        }

        if (newStudents.length > 0) {
          try {
            const created = await Student.insertMany(newStudents, {
              ordered: false,
            });
            results.registered.push(...created.map((c) => String(c.regNo)));
          } catch (err: unknown) {
            interface BulkWriteError {
              insertedDocs?: Array<{ regNo?: unknown }>;
              writeErrors?: Array<{ code?: number; op?: { regNo?: unknown } }>;
            }
            const bwe = err as BulkWriteError;
            if (bwe.insertedDocs) {
              results.registered.push(
                ...bwe.insertedDocs.map((d) => String(d.regNo ?? "")),
              );
            }
            if (bwe.writeErrors) {
              bwe.writeErrors
                .filter((e) => e.code === 11000)
                .forEach((e) =>
                  results.duplicates.push(String(e.op?.regNo ?? "")),
                );
            }
          }
        }
      }

      await logAudit(req, {
        action: "students_excel_upload",
        details: {
          filename: req.file.originalname,
          registered: results.registered.length,
          duplicates: results.duplicates.length,
          errors: results.errors.length,
          skipped: results.skipped,
        },
      });

      const total =
        results.registered.length +
        results.duplicates.length +
        results.errors.length;

      res.status(207).json({
        message: `${results.registered.length} registered, ${results.duplicates.length} already exist${results.qualifierUpdated.length ? ` (${results.qualifierUpdated.length} qualifier(s) added)` : ""}, ${results.errors.length} errors from ${total} rows.`,
        ...results,
      });
    },
  ),
);

export default router;
