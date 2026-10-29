// serverside/src/utils/consolidatedMS.ts

import { lapTimer } from "./perfLog";
import * as ExcelJS     from "exceljs";
import config           from "../config/config";
import { loadInstitutionSettings } from "./loadInstitutionSettings";
import { resolveStudentStatus }    from "./studentStatusResolver";
import { calculateStudentStatus, auditClass }  from "../services/statusEngine";
import { buildDisplayRegNo }       from "./academicRules";
import mongoose                    from "mongoose";
import { buildRichRegNoCMS }       from "./scoresheetStudentList";
import FinalGrade                  from "../models/FinalGrade";
import ProgramUnit                 from "../models/ProgramUnit";
import AcademicYear                from "../models/AcademicYear";
import MarkDirect                  from "../models/MarkDirect";
import Mark                        from "../models/Mark";
import { loadLogoBuffer } from "./loadLogoBuffer";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OfferedUnit { code: string; name: string }

export interface ConsolidatedData {
  programName:   string;
  programId:     string;
  academicYear:  string;
  yearOfStudy:   number;
  session:       "ORDINARY" | "SUPPLEMENTARY" | "CLOSED";
  students:      Array<Record<string, unknown>>;
  marks:         Array<Record<string, unknown>>;
  offeredUnits:  OfferedUnit[];
  logoBuffer:    Buffer | null;
  institutionId: string;
  passMark:      number;
  gradingScale:  Array<{ min: number; grade: string }>;
}

// Resolved mark cell — what the CMS renders in each student×unit cell
interface MarkCell {
  value:       number | string;  // numeric mark, "INC", or "75C" for pending special
  isCrossYear: boolean;          // true = came from a prior academic year (grey italic)
  isSpecial:   boolean;
}

// Map: studentId → (unitCode → MarkCell)
// After buildBatchedMarkMap() this is in-memory — no DB calls in the loop.
type BatchedMarkMap = Map<string, Map<string, MarkCell>>;

// ── CHANGE 1: Batched mark loader (replaces buildStudentMarkMap) ───────────────
//
// Called ONCE before the student loop.
// 3 parallel queries regardless of student or unit count.
//
// Priority order per (student, unit):
//   1. FinalGrade for targetAcadYearId   (highest — set by gradeCalculator)
//   2. MarkDirect for targetAcadYearId   (direct CA+Exam entry)
//   3. Most recent passing FinalGrade from any prior year (cross-year mark)
//   4. Mark (detailed) for targetAcadYearId
//   5. "INC" (no mark at all)
//
// Priority is enforced by insertion order: lower priority items are inserted
// first, higher priority items overwrite them.
async function buildBatchedMarkMap(
  studentIds:       string[],
  programUnitIds:   string[],   // all PU ids for this year
  targetAcadYearId: string,
  passMark:         number,
): Promise<BatchedMarkMap> {
  if (studentIds.length === 0 || programUnitIds.length === 0) {
    return new Map();
  }

  // ── 3 queries, run in parallel ──────────────────────────────────────────
  const [allFinalGrades, allDirectMarks, allDetailedMarks] = await Promise.all([
    FinalGrade.find({ student: { $in: studentIds }, programUnit: { $in: programUnitIds }}).lean(),
    MarkDirect.find({ student: { $in: studentIds }, programUnit: { $in: programUnitIds }}).lean(),
    Mark.find({ student: { $in: studentIds }, programUnit: { $in: programUnitIds }}).lean(),
  ]);

  // ── Build result map ────────────────────────────────────────────────────
  const outer: BatchedMarkMap = new Map();

  const inner = (sId: string): Map<string, MarkCell> => {
    if (!outer.has(sId)) outer.set(sId, new Map());
    return outer.get(sId)!;
  };

  // Priority 4 (lowest): Mark (detailed) for this academic year
  for (const dm of allDetailedMarks as any[]) {
    if (dm.academicYear?.toString() !== targetAcadYearId) continue;
    const sId  = dm.student.toString();
    const code = dm._puCode as string | undefined; // set below after PU lookup
    // We key by puId here, translate to unit code during the row loop
    inner(sId).set(dm.programUnit.toString(), {
      value:       dm.agreedMark ?? "INC",
      isCrossYear: false,
      isSpecial:   dm.isSpecial ?? false,
    });
  }

  // Priority 3: Most recent PASSING FinalGrade from ANY prior year
  // Sort descending by createdAt so first-seen = most recent
  const sortedFG = [...allFinalGrades as any[]].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const seenCY = new Set<string>(); // deduplicate per (student, pu)
  for (const fg of sortedFG) {
    if (fg.academicYear?.toString() === targetAcadYearId) continue; // not cross-year
    if (fg.status !== "PASS") continue;
    const sId  = fg.student.toString();
    const puId = fg.programUnit.toString();
    const key  = `${sId}:${puId}`;
    if (seenCY.has(key)) continue;
    seenCY.add(key);
    const mark = fg.totalMark ?? 0;
    if (mark >= passMark) {
      inner(sId).set(puId, { value: mark, isCrossYear: true, isSpecial: false });
    }
  }

  // Priority 2: MarkDirect for THIS academic year (overwrites cross-year)
  for (const md of allDirectMarks as any[]) {
    if (md.academicYear?.toString() !== targetAcadYearId) continue;
    const sId  = md.student.toString();
    const puId = md.programUnit.toString();
    const isPendingSpecial =
      (md.isSpecial || md.attempt === "special") && (md.examTotal70 ?? 0) === 0;
    const mark = md.agreedMark ?? 0;
    inner(sId).set(puId, {
      value:       isPendingSpecial ? `${mark}C` : (mark || "INC"),
      isCrossYear: false,
      isSpecial:   md.isSpecial || md.attempt === "special",
    });
  }

  // Priority 1 (highest): FinalGrade for THIS academic year (overwrites everything)
  for (const fg of allFinalGrades as any[]) {
    if (fg.academicYear?.toString() !== targetAcadYearId) continue;
    const sId  = fg.student.toString();
    const puId = fg.programUnit.toString();
    const isPendingSpecial = fg.isSpecial && (fg.examTotal70 ?? 0) === 0;
    const mark = fg.totalMark ?? 0;
    inner(sId).set(puId, {
      value:       isPendingSpecial ? `${mark}C` : mark,
      isCrossYear: false,
      isSpecial:   fg.isSpecial || fg.status === "SPECIAL",
    });
  }

  return outer;
}

// ── Attempt notation (unchanged from original) ────────────────────────────────
function buildAttemptNotation(
  studentStatusRaw: string,
  studentQualifier: string,
  studentMarks:     any[],
  yearOfStudy:      number,
  academicHistory:  any[],
): string {
  const st = studentStatusRaw.toLowerCase().replace(/_/g, " ");

  if (st === "deferred" || st === "deferment")                  return "DEF";
  if (st === "on leave" || st === "on_leave" || st === "academic leave") return "A/L";
  if (st === "discontinued")                                    return "DISC.";
  if (st === "deregistered")                                    return "DEREG.";
  if (st === "repeat")                                          return "A/RA1";
  if (st === "disciplinary_suspension" || st === "disciplinary suspension") return "SUSP.";

  if (studentQualifier) {
    const q = studentQualifier.trim().toUpperCase();
    if (/^RP(\d+)D$/.test(q)) {
      const n = parseInt(q.replace(/^RP(\d+)D$/, "$1"));
      return `A/RA${n}D`;
    }
    if (/^RP\d+C$/i.test(q)) return q;
    if (/^RP\d+$/i.test(q))  return q;
    if (/^RPU\d*/i.test(q))  return q;
    if (/^RA\d/i.test(q))    return q;
    if (/^M\d$/i.test(q))    return q;
    if (/^TF\d/i.test(q))    return q;
  }

  const attemptTypes = studentMarks.map((m: any) => (m.attempt || "1st").toLowerCase());

  if (attemptTypes.length === 0) {
    const hasRepeat = (academicHistory || []).some(
      (h: any) => h.isRepeatYear && h.yearOfStudy === yearOfStudy,
    );
    return hasRepeat ? "A/RA1" : "B/S";
  }

  if (attemptTypes.every((a: string) => a === "1st" || a === "special")) {
    const hasRepeat = (academicHistory || []).some(
      (h: any) => h.isRepeatYear && h.yearOfStudy === yearOfStudy,
    );
    return hasRepeat ? "A/RA1" : "B/S";
  }

  if (attemptTypes.includes("re-take")) {
    if (studentQualifier && /^RP\d+C$/i.test(studentQualifier)) {
      return studentQualifier.trim().toUpperCase();
    }
    return "A/CF";
  }

  if (attemptTypes.includes("supplementary")) return "A/S";
  return "B/S";
}

// ── Summary table: one label for each RECOMM. cell ─────────────────────────────
// Every recommendation the sheet can print must land in a row of the SUMMARY, otherwise the counts stop
// adding up to the number of students (STAYOUT used to be dropped because the text was "STAYOUT", not "STAY OUT").
export const SUMMARY_LABELS = [
  "PASS", "CARRY FORWARD", "SUPPLEMENTARY", "SPECIAL", "REPEAT YEAR", "STAY OUT", "INCOMPLETE",
  "ACADEMIC LEAVE", "DEFERMENT", "DEREGISTERED/DISC", "DISCIPLINARY SUSPENSION", "GRADUATED", "OTHER",
] as const;
export type SummaryLabel = (typeof SUMMARY_LABELS)[number];

export function classifyRecommendation(raw: string): SummaryLabel {
  const txt = (raw || "").toUpperCase().trim();
  if (txt === "PASS")                              return "PASS";
  if (txt.includes("CARRY FORWARD"))               return "CARRY FORWARD";
  if (txt.includes("DISCIPLINARY"))                return "DISCIPLINARY SUSPENSION";
  if (txt.includes("REPEAT"))                      return "REPEAT YEAR";
  if (/STAY\s*OUT/.test(txt))                      return "STAY OUT";
  if (txt.includes("SUPP"))                        return "SUPPLEMENTARY";
  if (txt.includes("SPEC"))                        return "SPECIAL";
  if (txt.includes("ACADEMIC LEAVE") || txt === "ON LEAVE") return "ACADEMIC LEAVE";
  if (txt.includes("DEFER"))                       return "DEFERMENT";
  if (txt.startsWith("INC"))                       return "INCOMPLETE";
  if (txt.includes("DEREG") || txt.includes("DISCONTINUED")) return "DEREGISTERED/DISC";
  if (txt.includes("GRADUATED"))                   return "GRADUATED";
  return "OTHER";
}

// ── CHANGE 2: ADMIN_STATUS_MAP now includes disciplinary_suspension ────────────
const ADMIN_STATUS_MAP: Record<string, string> = {
  on_leave:                  "ACADEMIC LEAVE",
  deferred:                  "DEFERMENT",
  discontinued:              "DISCONTINUED",
  deregistered:              "DEREGISTERED",
  graduated:                 "GRADUATED",
  repeat:                    "",             // run engine
  "on leave":                "ACADEMIC LEAVE",
  "academic leave":          "ACADEMIC LEAVE",
  deferment:                 "DEFERMENT",
  stayout:                   "",             // run engine
  "already promoted":        "",             // run engine
  // ── NEW ──────────────────────────────────────────────────────────────────
  // Without this entry, a suspended student falls through to calculateStudentStatus
  // which tries to read their marks and emit a "PASS" or "SUPP" recommendation.
  // That's factually wrong and potentially embarrassing in a board report.
  disciplinary_suspension:   "DISCIPLINARY SUSPENSION",
  "disciplinary suspension": "DISCIPLINARY SUSPENSION",
};

// ── Fallback audit object for admin-gated statuses ───────────────────────────
function makeAdminAudit(
  adminStatusLabel: string,
  offeredUnitCount: number,
  isDisciplinary = false,
): Record<string, unknown> {
  return {
    status:        adminStatusLabel,
    variant:       "info" as const,
    details:       adminStatusLabel,
    weightedMean:  "0.00",
    passedList:    [],
    failedList:    [],
    specialList:   [],
    missingList:   [],
    incompleteList:[],
    summary: {
      totalExpected: offeredUnitCount,
      passed:        0,
      failed:        0,
      missing:       0,
      isOnLeave:     !isDisciplinary,  // disciplinary ≠ on leave, but both block marks
      isDisciplinary,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ════════════════════════════════════════════════════════════════════════════

export const generateConsolidatedMarkSheet = async (
  data: ConsolidatedData,
): Promise<Buffer> => {
  const {
    programName, academicYear, yearOfStudy,
    students, marks, offeredUnits,
    // logoBuffer,
     institutionId, programId,
  } = data;

  // ── Settings (one DB call, with fallback) ─────────────────────────────────
  // const settings = await loadInstitutionSettings(institutionId);
  // const passMark = settings?.passMark ?? 40;
  const settings   = await loadInstitutionSettings(institutionId);
  const logoBuffer = await loadLogoBuffer(institutionId);
  const meta       = settings.docMeta;
  const passMark   = settings.passMark;

  const workbook  = new ExcelJS.Workbook();
  const sheet     = workbook.addWorksheet("CONSOLIDATED MARKSHEET");
  const fontName  = "Arial";
  const tuColIdx  = 5 + offeredUnits.length;
  const totalCols = tuColIdx + 4;

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin" }, left: { style: "thin" },
    bottom: { style: "thin" }, right: { style: "thin" },
  };
  const doubleBottomBorder: Partial<ExcelJS.Borders> = {
    ...thinBorder, bottom: { style: "double" },
  };

  // ── 1. Headers ──────────────────────────────────────────────────────────────
  const centerColIdx = Math.floor(totalCols / 2);
  if (logoBuffer && logoBuffer.length > 0) {
    const logoId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
    sheet.addImage(logoId, {
      tl: { col: centerColIdx - 1, row: 0 },
      ext: { width: 100, height: 60 },
    });
  }

  const setCenteredHeader = (rowNum: number, text: string, fontSize = 10) => {
    sheet.mergeCells(rowNum, 1, rowNum, totalCols);
    const cell = sheet.getCell(rowNum, 1);
    cell.value = text.toUpperCase();
    cell.style = {
      alignment: { horizontal: "center", vertical: "middle" },
      font: { bold: true, name: fontName, size: fontSize - 1 },
    };
  };

  const examPhaseLabel =
    data.session === "SUPPLEMENTARY"
      ? "SUPPLEMENTARY AND SPECIAL EXAMINATION RESULTS"
      : "ORDINARY EXAMINATION RESULTS";

  const yrTxt =
    ["FIRST","SECOND","THIRD","FOURTH","FIFTH"][yearOfStudy - 1] || `${yearOfStudy}TH`;

  // setCenteredHeader(4, `${config.instName}`);
  // setCenteredHeader(5, `${config.schoolName || "SCHOOL OF ENGINEERING"}`);
  // setCenteredHeader(6, `${programName}`);
  setCenteredHeader(4, meta.universityName);
setCenteredHeader(5, meta.schoolName);
setCenteredHeader(6, programName);
  setCenteredHeader(
    7,
    `CONSOLIDATED MARK SHEET - - ${examPhaseLabel} - ${yrTxt} YEAR - ${academicYear} ACADEMIC YEAR`,
  );
  sheet.getCell(7, 1).font = {
    ...(sheet.getCell(7, 1).font ?? {}),
    underline: true,
    bold: true,
    name: fontName,
  };

  // ── 2. Table headers ────────────────────────────────────────────────────────
  const startRow = 9;
  const subRow   = 10;
  sheet.getRow(subRow).height = 48;

  const headers: Record<number, string> = {
    1: "S/N", 2: "REG. NO", 3: "NAME", 4: "ATTEMPT",
    [tuColIdx]:     "T U",
    [tuColIdx + 1]: "TOTAL",
    [tuColIdx + 2]: "MEAN",
    [tuColIdx + 3]: "RECOMM.",
    [tuColIdx + 4]: "STUDENT MATTERS",
  };

  Object.entries(headers).forEach(([col, text]) => {
    const colNum = parseInt(col);
    sheet.mergeCells(startRow, colNum, subRow, colNum);
    const cell = sheet.getCell(startRow, colNum);
    cell.value = text;
    cell.style = {
      alignment: {
        horizontal: "center", vertical: "middle",
        textRotation: colNum === 4 ? 90 : 0, wrapText: true,
      },
      font:   { bold: true, size: 7, name: fontName },
      border: doubleBottomBorder,
    };
  });

  offeredUnits.forEach((unit, i) => {
    const colIdx = 5 + i;
    sheet.getCell(startRow, colIdx).value = (i + 1).toString();
    sheet.getCell(startRow, colIdx).style = {
      alignment: { horizontal: "center", vertical: "middle" },
      font: { bold: true, size: 7, name: fontName },
      border: thinBorder,
    };
    sheet.getCell(subRow, colIdx).value = unit.code;
    sheet.getCell(subRow, colIdx).style = {
      alignment: { horizontal: "center", vertical: "middle", textRotation: 90 },
      font: { bold: true, size: 7, name: fontName },
      border: thinBorder,
    };
  });

  // ── 3. Pre-loop setup ─────────────────────────────────────────────────────
  // Resolve the academic year document ID and all ProgramUnits for this year.
  // These were already fetched in the original — kept exactly as-is.
  const academicYearDoc = await AcademicYear.findOne({ year: academicYear }).lean() as any;
  const targetAcadYearId = academicYearDoc?._id?.toString() || "";

  const allProgramUnits = await ProgramUnit.find({
    program:      programId,
    requiredYear: yearOfStudy,
  }).populate("unit").lean() as any[];

  // ── CHANGE 1 APPLIED HERE ────────────────────────────────────────────────
  // Build the complete mark map for ALL students in 3 queries BEFORE the loop.
  // The loop then does studentMarkMap.get(puId) — pure in-memory lookup.
  const sortedStudents = [...students].sort(
    (a, b) => (String(a.regNo || "")).localeCompare(String(b.regNo || "")),
  );

  const allStudentIds = sortedStudents
    .map((s) => {
      const rawId = (s as any)._id ?? (s as any).id ?? null;
      try { return rawId?.toString() ?? ""; } catch { return ""; }
    })
    .filter((id) => id && mongoose.isValidObjectId(id));

  const allPuIds = allProgramUnits.map((pu: any) => pu._id.toString());

  // ← This replaces the per-student buildStudentMarkMap() call
  const batchedMarkMap: BatchedMarkMap = await buildBatchedMarkMap(
    allStudentIds,
    allPuIds,
    targetAcadYearId,
    passMark,
  );

  // Run the status engine for the whole class up-front (batched), not one student at a time.
  const lap = lapTimer("consolidated mark sheet");
  const classAudit = await auditClass(allStudentIds, programId, academicYear, yearOfStudy);
  lap("status engine (whole class)");

  // ── 4. Student data rows ──────────────────────────────────────────────────
  let currentIndex = 0;

  for (const student of sortedStudents) {
    const rIdx = 11 + currentIndex;

    const rawId = (student as any)._id ?? (student as any).id ?? null;
    let sId = "";
    try { sId = rawId?.toString() ?? ""; } catch { sId = ""; }

    if (!sId || !mongoose.isValidObjectId(sId)) {
      console.warn("[CMS] Skipping invalid _id:", (student as any).regNo ?? "unknown");
      continue;
    }

    // ── Admin status gate ──────────────────────────────────────────────────
    const studentStatusRaw = ((student as any).status ?? "").toString().toLowerCase().trim();
    const adminStatusLabel: string | null =
      ADMIN_STATUS_MAP[studentStatusRaw] ??
      ADMIN_STATUS_MAP[studentStatusRaw.replace(/_/g, " ")] ??
      null;

    const isDisciplinary = studentStatusRaw === "disciplinary_suspension" ||
                           studentStatusRaw === "disciplinary suspension";

    let audit: Record<string, any>;

    if (isDisciplinary) console.log(`[CMS] ${(student as any).regNo}: student record status is "${studentStatusRaw}" (printed as DISCIPLINARY SUSPENSION)`);

    if (typeof adminStatusLabel === "string" && adminStatusLabel.length > 0) {
      // CHANGE 2: disciplinary suspension uses the same admin gate path as
      // DEREGISTERED — marks are blank, recommendation shows status text.
      audit = makeAdminAudit(adminStatusLabel, offeredUnits.length, isDisciplinary);
    } else {
      try {
        const pre = classAudit.get(sId);
        if (pre?.error) throw new Error(pre.error);
        audit = (pre?.audit ?? await calculateStudentStatus(
          sId, programId, academicYear, yearOfStudy, { forPromotion: true },
        )) as Record<string, any>;
      } catch (err: any) {
        console.error(`[CMS] Engine failed for ${(student as any).regNo}:`, err.message);
        audit = {
          status: "SESSION IN PROGRESS", variant: "info",
          details: "Engine error", weightedMean: "0.00",
          passedList: [], failedList: [], specialList: [],
          missingList: [], incompleteList: [],
          summary: { totalExpected: offeredUnits.length, passed: 0, failed: 0, missing: 0 },
        };
      }
    }

    // Marks array for this student — used only by buildAttemptNotation
    const studentMarks = (marks as any[]).filter(
      (m: any) => (m.student?._id?.toString() || m.student?.toString()) === sId,
    );

    const attemptNotation = buildAttemptNotation(
      studentStatusRaw,
      (student as any).qualifierSuffix || "",
      studentMarks,
      yearOfStudy,
      (student as any).academicHistory || [],
    );

    // Display name
    const hasReturnHistory = ((student as any).statusHistory || []).some(
      (h: any) =>
        h.status === "ACTIVE" &&
        (h.previousStatus === "ACADEMIC LEAVE" || h.previousStatus === "DEFERMENT"),
    );
    const repeatCount = ((student as any).academicHistory || []).filter(
      (h: any) => h.isRepeatYear && h.yearOfStudy === yearOfStudy,
    ).length;

    const finalDisplayName = [
      (student as any).name || "",
      hasReturnHistory ? " (REINSTATED)" : "",
      repeatCount > 0  ? ` (RPT${repeatCount})` : "",
    ].join("").toUpperCase();

    const rowData: Array<number | string | object> = [
      currentIndex + 1,
      buildRichRegNoCMS((student as any).regNo || "", (student as any).qualifierSuffix || ""),
      finalDisplayName,
      attemptNotation,
    ];

    // ── CHANGE 1 APPLIED IN LOOP ─────────────────────────────────────────
    // BEFORE: const markCellMap = await buildStudentMarkMap(sId, ...)  ← await in loop
    // AFTER:  const studentMarkMap = batchedMarkMap.get(sId)           ← in-memory
    const studentMarkMap = batchedMarkMap.get(sId) ?? new Map<string, MarkCell>();

    const resolvedStatus = resolveStudentStatus(student as any);
    const rowMarkData: Array<{ isCrossYear: boolean; isSpecial: boolean } | null> = [];

    offeredUnits.forEach((unit) => {
      if (resolvedStatus.isLocked || isDisciplinary) {
        // CHANGE 2: Disciplinary students show blank mark cells (same as DEREGISTERED)
        rowData.push("");
        rowMarkData.push(null);
        return;
      }

      // Translate unit code → puId → look up in batched map
      const pu  = allProgramUnits.find((p: any) => p.unit?.code === unit.code);
      const puId = pu?._id?.toString() ?? "";
      const m    = puId ? studentMarkMap.get(puId) : undefined;

      rowData.push(m ? m.value : "INC");
      rowMarkData.push(m ?? null);
    });

    // Recommendation
    let recomm = audit.status as string;
    const isEngineStatus = !adminStatusLabel || adminStatusLabel === "";
    const lockedLabels = new Set([
      "REPEAT YEAR", "STAYOUT", "DEREGISTERED",
      "ACADEMIC LEAVE", "DEFERMENT", "DISCONTINUED", "GRADUATED",
      // CHANGE 2: Disciplinary is now a locked label — no SUPP/PASS recommendation
      "DISCIPLINARY SUSPENSION",
    ]);

    if (isEngineStatus && !lockedLabels.has(audit.status as string)) {
      const parts: string[] = [];
      if ((audit.failedList as any[])?.length)      parts.push(`SUPP ${(audit.failedList as any[]).length}`);
      if ((audit.specialList as any[])?.length)     parts.push(`SPEC ${(audit.specialList as any[]).length}`);
      if ((audit.incompleteList as any[])?.length)  parts.push(`INC ${(audit.incompleteList as any[]).length}`);
      if (parts.length > 0) recomm = parts.join("; ");
      // After the supplementary sitting: two or fewer units still failed → proceeds and carries them forward (ENG.14)
      if ((audit as any).carryForward?.eligible) recomm = "CARRY FORWARD";
    }

    // Student matters
    const mattersList: string[] = [];

    // CHANGE 2: Disciplinary cases surface in "STUDENT MATTERS" column
    if (isDisciplinary) mattersList.push("DISCIPLINARY");

    const leaveType           = (student as any).academicLeavePeriod?.type;
    const remarks             = ((student as any).remarks        || "").toLowerCase();
    const specialGroundsField = ((student as any).specialGrounds || "").toLowerCase();

    if (
      (typeof adminStatusLabel === "string" && adminStatusLabel.length > 0 && !isDisciplinary) ||
      ["ACADEMIC LEAVE", "DEFERMENT", "ON LEAVE"].includes(audit.status as string)
    ) {
      if (leaveType === "financial" || remarks.includes("financial") || specialGroundsField.includes("financial")) {
        mattersList.push("FINANCIAL");
      } else if (
        leaveType === "compassionate" || remarks.includes("compassionate") ||
        remarks.includes("medical")   || specialGroundsField.includes("compassionate")
      ) {
        mattersList.push("COMPASSIONATE");
      } else if (leaveType) {
        mattersList.push(leaveType.toUpperCase());
      }
    }

    for (const spec of ((audit.specialList as any[]) || [])) {
      const g = (spec.grounds || "").split(":").pop()?.trim().toUpperCase() || "";
      if (g && g !== "SPECIAL" && g !== "REASON PENDING") mattersList.push(g);
    }

    const cfUnits: Array<{ code: string }> = (audit as any).carryForward?.units || [];
    if (cfUnits.length > 0) mattersList.push(`C/F: ${cfUnits.map((u) => u.code).join(", ")}`);

    const finalMatters = Array.from(new Set(mattersList)).join(", ");

    const totalMarks =
      ((audit.passedList as any[]) || []).reduce((a: number, b: any) => a + (b.mark || 0), 0) +
      ((audit.failedList as any[]) || []).reduce((a: number, b: any) => a + (b.mark || 0), 0);

    // CHANGE 2: isDisciplinary also blocks the totals columns
    const isBlocked =
      (audit.summary as any)?.isOnLeave ||
      isDisciplinary ||
      ["ACADEMIC LEAVE", "DEFERMENT", "DEREGISTERED"].includes(audit.status as string);

    rowData.push(
      (audit.summary as any)?.totalExpected ?? offeredUnits.length,
      isBlocked ? "-" : totalMarks,
      isBlocked ? "-" : parseFloat((audit.weightedMean as string) || "0").toFixed(2),
      recomm,
      finalMatters,
    );

    // Write row
    const row = sheet.getRow(rIdx);
    row.values = rowData as ExcelJS.Row["values"];

    // Style row
    row.eachCell((cell, colNum) => {
      cell.border    = thinBorder;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.font      = { size: 8, name: fontName };

      if (colNum === totalCols - 1) {
        cell.protection = { locked: false };
        const txt = (cell.value?.toString() || "").toUpperCase();
        if (
          txt.includes("ACADEMIC LEAVE") ||
          txt.includes("FINANCIAL") ||
          txt.includes("COMPASSIONATE")
        ) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
        }
        // CHANGE 2: Disciplinary recommendation cell — red fill
        if (txt.includes("DISCIPLINARY")) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
          cell.font = { bold: true, size: 8, name: fontName, color: { argb: "FF9C0006" } };
        }
      }

      if (colNum === totalCols) {
        cell.protection = { locked: false };
        cell.alignment  = { horizontal: "left", vertical: "middle" };
        const txt = (cell.value?.toString() || "").toUpperCase();
        if (txt.includes("FINANCIAL") || txt.includes("COMPASSIONATE")) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
          cell.font = { bold: true, size: 8, name: fontName };
        }
        // CHANGE 2: "DISCIPLINARY" in student matters — red bold
        if (txt.includes("DISCIPLINARY")) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
          cell.font = { bold: true, size: 8, name: fontName, color: { argb: "FF9C0006" } };
        }
      }

      if (colNum === 2 || colNum === 3) {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      }

      if (colNum >= 5 && colNum < tuColIdx) {
        const val     = cell.value?.toString() || "";
        const unitIdx = colNum - 5;
        const mData   = rowMarkData[unitIdx];

        // CHANGE 2: Disciplinary student — pink fill, same as DEREGISTERED/locked
        if (resolvedStatus.isLocked || isDisciplinary) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
        } else if (val === "INC" || val.endsWith("C")) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
        } else if (typeof cell.value === "number" && cell.value < passMark) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
          cell.font = { color: { argb: "FF9C0006" }, bold: true, size: 8, name: fontName };
        } else if (mData?.isCrossYear) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
          cell.font = { size: 8, name: fontName, italic: true };
        }
      }
    });

    row.getCell(totalCols).protection = { locked: false };
    currentIndex++;
  }

  const lastDataRow = 10 + currentIndex; // use currentIndex not sortedStudents.length
                                          // because some students may have been skipped

  // ── 5. Unit statistics ──────────────────────────────────────────────────────
  const statsStart  = lastDataRow + 2;
  const statsLabels = [
    "Mean", "Standard Deviation", "Maximum", "Minimum",
    "No. of Candidates", "No. of Passes", "No. of Fails", "No. of Blanks",
  ];

  statsLabels.forEach((label, i) => {
    const rIdx = statsStart + i;
    const r    = sheet.getRow(rIdx);
    r.height   = 15;
    const labelCell = r.getCell(3);
    labelCell.value  = label;
    labelCell.font   = { bold: true, size: 7, name: fontName };
    labelCell.border = thinBorder;

    offeredUnits.forEach((_, uIdx) => {
      const colIdx    = 5 + uIdx;
      const colLetter = sheet.getColumn(colIdx).letter;
      const cell      = r.getCell(colIdx);
      const range     = `${colLetter}11:${colLetter}${lastDataRow}`;
      cell.border = thinBorder;
      cell.numFmt = "0.0";
      cell.font   = { size: 7, name: fontName };

      if (label === "No. of Passes") {
        cell.value  = { formula: `COUNTIF(${range}, ">=${passMark}")` };
        cell.numFmt = "0";
      } else if (label === "No. of Fails") {
        cell.value  = { formula: `COUNTIFS(${range}, "<${passMark}", ${range}, "<>")` };
        cell.numFmt = "0";
      } else if (label === "No. of Blanks") {
        cell.value  = { formula: `COUNTIF(${range}, "INC")` };
        cell.numFmt = "0";
      } else {
        const funcMap: Record<string, string> = {
          "Mean": "AVERAGE", "Standard Deviation": "STDEV.P",
          "Maximum": "MAX", "Minimum": "MIN", "No. of Candidates": "COUNT",
        };
        const fn = funcMap[label];
        if (fn) cell.value = { formula: `IFERROR(ROUND(${fn}(${range}), 1), 0)` };
      }
    });

    r.getCell(3).border = { ...r.getCell(3).border, left: { style: "thick" } };
    r.getCell(tuColIdx - 1).border = { ...r.getCell(tuColIdx - 1).border, right: { style: "thick" } };
    if (i === 0) {
      for (let c = 3; c < tuColIdx; c++)
        r.getCell(c).border = { ...r.getCell(c).border, top: { style: "thick" } };
    }
    if (i === statsLabels.length - 1) {
      for (let c = 3; c < tuColIdx; c++)
        r.getCell(c).border = { ...r.getCell(c).border, bottom: { style: "thick" } };
    }
  });

  // ── 6. Summary table ────────────────────────────────────────────────────────
  const summaryStart      = lastDataRow + 12;
  const summaryHeaderCell = sheet.getCell(`B${summaryStart}`);
  summaryHeaderCell.value = "SUMMARY";
  summaryHeaderCell.font  = { bold: true, size: 10, underline: true, name: fontName };

  const summaryData: Record<string, number> = Object.fromEntries(SUMMARY_LABELS.map((l) => [l, 0]));

  let summarised = 0;
  sheet.getColumn(tuColIdx + 3).eachCell({ includeEmpty: false }, (cell, rowNum) => {
    if (rowNum > 10 && rowNum <= lastDataRow) {
      summaryData[classifyRecommendation(cell.value?.toString() || "")]++;
      summarised++;
    }
  });
  if (summarised !== currentIndex) {
    console.warn(`[CMS] summary counted ${summarised} recommendation cells for ${currentIndex} students`);
  }

  const activeSummaryEntries = Object.entries(summaryData).filter(([, count]) => count > 0);
  activeSummaryEntries.forEach(([label, count], i) => {
    const rIdx      = summaryStart + 1 + i;
    const labelCell = sheet.getCell(`B${rIdx}`);
    const countCell = sheet.getCell(`C${rIdx}`);
    labelCell.value  = label;
    countCell.value  = count;
    labelCell.border = thinBorder;
    countCell.border = thinBorder;
    labelCell.font   = { size: 8, name: fontName, bold: true };
    countCell.font   = { size: 8, name: fontName };
    // CHANGE 2: Highlight disciplinary row in summary
    if (label === "DISCIPLINARY SUSPENSION") {
      labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
      countCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
      labelCell.font = { size: 8, name: fontName, bold: true, color: { argb: "FF9C0006" } };
    }
  });

  // ── 7. Offered units table ──────────────────────────────────────────────────
  const unitsStart = summaryStart + activeSummaryEntries.length + 4;
  sheet.mergeCells(unitsStart, 2, unitsStart, 6);
  sheet.getCell(unitsStart, 2).value = "LIST OF UNITS OFFERED";
  sheet.getCell(unitsStart, 2).font  = { bold: true, underline: true };

  const mid = Math.ceil(offeredUnits.length / 2);
  for (let i = 0; i < mid; i++) {
    const rIdx  = unitsStart + 2 + i;
    const r     = sheet.getRow(rIdx);
    const left  = offeredUnits[i];
    const right = offeredUnits[mid + i];
    r.getCell(2).value = i + 1;
    r.getCell(3).value = left.code;
    sheet.mergeCells(rIdx, 4, rIdx, 7);
    r.getCell(4).value = left.name;
    if (right) {
      r.getCell(9).value  = mid + i + 1;
      r.getCell(10).value = right.code;
      sheet.mergeCells(rIdx, 11, rIdx, 14);
      r.getCell(11).value = right.name;
    }
    [2, 3, 4, 9, 10, 11].forEach((col) => {
      const cell = r.getCell(col);
      cell.border = { ...thinBorder };
      if (col === 2)                            cell.border.left   = { style: "thick" };
      if (col === 11 || (!right && col === 4))  cell.border.right  = { style: "thick" };
      if (i === 0)                              cell.border.top    = { style: "thick" };
      if (i === mid - 1)                        cell.border.bottom = { style: "thick" };
      cell.font = { size: 8 };
    });
  }

  // ── 8. Main table thick borders ─────────────────────────────────────────────
  for (let i = startRow; i <= lastDataRow; i++) {
    sheet.getCell(i, 1).border =
      { ...sheet.getCell(i, 1).border, left: { style: "thick" } };
    sheet.getCell(i, totalCols).border =
      { ...sheet.getCell(i, totalCols).border, right: { style: "thick" } };
  }
  sheet.getRow(startRow).eachCell(
    (c) => (c.border = { ...c.border, top: { style: "thick" } }),
  );
  sheet.getRow(lastDataRow).eachCell(
    (c) => (c.border = { ...c.border, bottom: { style: "thick" } }),
  );

  // ── 9. Sheet formatting ──────────────────────────────────────────────────────
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 25;
  sheet.getColumn(4).width = 7;
  offeredUnits.forEach((_, i) => (sheet.getColumn(5 + i).width = 4.5));
  sheet.getColumn(tuColIdx).width     = 5;
  sheet.getColumn(tuColIdx + 1).width = 7;
  sheet.getColumn(tuColIdx + 2).width = 7;
  sheet.getColumn(tuColIdx + 3).width = 20;
  sheet.getColumn(tuColIdx + 4).width = 20;

  sheet.views = [{ state: "frozen", xSplit: 4, ySplit: 10 }];
  sheet.protect("1234", { selectLockedCells: true, selectUnlockedCells: true });
  sheet.pageSetup = {
    orientation: "landscape", paperSize: 9,
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
  };

  lap("build sheet");
  const result = await workbook.xlsx.writeBuffer();
  lap("write file"); lap.done();
  return Buffer.from(result as ArrayBuffer);
};
