
// serverside/src/services/graduationEngine.ts

import { mapLimit } from "../utils/mapLimit";
import Student from "../models/Student";
import FinalGrade from "../models/FinalGrade";
import MarkDirect from "../models/MarkDirect";
import Mark from "../models/Mark";
import ProgramUnit from "../models/ProgramUnit";
import { getYearWeight } from "../utils/weightingRegistry";
import { classifyWAA } from "../utils/academicRules";
import { outstandingAttachments } from "./attachments";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AwardListEntry {
  studentId:      string;
  regNo:          string;
  name:           string;
  waa:            number;
  classification: string;
  graduationYear: number;
}

export interface GraduationResult {
  studentId:                string;
  regNo:                    string;
  name:                     string;
  weightedAggregateAverage: number;
  classification:           string;
  isEligible:               boolean;
  missingRequirements:      string[];
  yearBreakdown:            Array<{
    yearOfStudy:          number;
    academicYear:         string;
    annualMean:           number;
    weight:               number;
    weightedContribution: number;
    isRepeat:             boolean;
    failedUnits:          number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the best agreed mark for a student + programUnit across all sources.
// Priority: FinalGrade → MarkDirect → Mark
// This is the SINGLE source-of-truth resolver used by both WAA computation
// and the Journey CMS mark display.
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveAgreedMark(
  studentId: string,
  puId:      string,
): Promise<number> {
  // 1. FinalGrade (set by computeFinalGrade — most authoritative)
  const fgs = await FinalGrade.find({
    student:     studentId,
    programUnit: puId,
  }).lean() as any[];

  if (fgs.length > 0) {
    const rank   = (s: string) => s === "PASS" ? 3 : s === "SPECIAL" ? 2 : s === "SUPPLEMENTARY" ? 1 : 0;
    const best   = fgs.sort((a: any, b: any) => rank(b.status) - rank(a.status))[0];
    const mark   = best.totalMark ?? 0;
    if (mark > 0) return mark;
  }

  // 2. MarkDirect (direct CA+Exam entry — no FinalGrade until directMarksImporter_FIXED runs)
  const md = await MarkDirect.findOne({ student: studentId, programUnit: puId }).lean() as any;
  if (md && (md.agreedMark ?? 0) > 0) return md.agreedMark;

  // 3. Mark (detailed breakdown with computeFinalGrade applied)
  const dm = await Mark.findOne({ student: studentId, programUnit: puId }).lean() as any;
  if (dm && (dm.agreedMark ?? 0) > 0) return dm.agreedMark;

  return 0; // no mark found
}

/** Same rules as resolveAgreedMark, for many programme units in 3 queries instead of 3 per unit. */
export async function resolveAgreedMarksBatch(studentId: string, puIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!puIds.length) return out;
  const [fgs, mds, dms] = await Promise.all([
    FinalGrade.find({ student: studentId, programUnit: { $in: puIds } }).lean() as Promise<any[]>,
    MarkDirect.find({ student: studentId, programUnit: { $in: puIds } }).lean() as Promise<any[]>,
    Mark.find({ student: studentId, programUnit: { $in: puIds } }).lean() as Promise<any[]>,
  ]);
  const group = (docs: any[]) => {
    const m = new Map<string, any[]>();
    for (const d of docs) { const k = String(d.programUnit); (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    return m;
  };
  const fgBy = group(fgs), mdBy = group(mds), dmBy = group(dms);
  const rank = (st: string) => st === "PASS" ? 3 : st === "SPECIAL" ? 2 : st === "SUPPLEMENTARY" ? 1 : 0;
  for (const id of puIds) {
    let mark = 0;
    const f = fgBy.get(id);
    if (f?.length) { const best = [...f].sort((a, b) => rank(b.status) - rank(a.status))[0]; if ((best.totalMark ?? 0) > 0) mark = best.totalMark; }
    if (!mark) { const md = mdBy.get(id)?.[0]; if (md && (md.agreedMark ?? 0) > 0) mark = md.agreedMark; }
    if (!mark) { const dm = dmBy.get(id)?.[0]; if (dm && (dm.agreedMark ?? 0) > 0) mark = dm.agreedMark; }
    out.set(id, mark);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core WAA computer
//
// Priority:
//   1. student.finalWeightedAverage  — stored at graduation (most accurate)
//   2. sum of academicHistory[].weightedContribution — stored at promotion
//   3. Recompute from actual marks (FinalGrade + MarkDirect + Mark fallback)
//      and backfill the DB so future calls use Priority 1.
// ─────────────────────────────────────────────────────────────────────────────
async function computeWAA(student: any, opts: { force?: boolean } = {}): Promise<{
  waa:           number;
  yearBreakdown: GraduationResult["yearBreakdown"];
}> {
  const program   = student.program as any;
  const history   = (student.academicHistory || []) as any[];
  const entryType = student.entryType || "Direct";

  // ── Priority 1: finalWeightedAverage ─────────────────────────────────────
  if (!opts.force && student.finalWeightedAverage != null) {
    const stored = parseFloat(student.finalWeightedAverage);
    if (stored > 0) {
      const yearBreakdown = history.map((h: any) => ({
        yearOfStudy:          h.yearOfStudy,
        academicYear:         h.academicYear || "",
        annualMean:           h.annualMeanMark || 0,
        weight:               getYearWeight(program, entryType, h.yearOfStudy),
        weightedContribution: h.weightedContribution || 0,
        isRepeat:             h.isRepeatYear || false,
        failedUnits:          h.failedUnitsCount || 0,
      }));
      return { waa: stored, yearBreakdown };
    }
  }

  // ── Priority 2: stored weightedContribution ───────────────────────────────
  const totalStoredWC = history.reduce(
    (sum: number, h: any) => sum + (h.weightedContribution || 0),
    0,
  );
  if (!opts.force && totalStoredWC > 0) {
    const yearBreakdown = history.map((h: any) => ({
      yearOfStudy:          h.yearOfStudy,
      academicYear:         h.academicYear || "",
      annualMean:           h.annualMeanMark || 0,
      weight:               getYearWeight(program, entryType, h.yearOfStudy),
      weightedContribution: h.weightedContribution || 0,
      isRepeat:             h.isRepeatYear || false,
      failedUnits:          h.failedUnitsCount || 0,
    }));
    return { waa: totalStoredWC, yearBreakdown };
  }

  // ── Priority 3: Recompute from actual marks ───────────────────────────────
  // Reads FinalGrade first, then MarkDirect, then Mark as fallback.
  // Handles legacy students and students whose direct marks have no FinalGrade yet.
  // console.log(`[graduationEngine] Recomputing WAA from marks for ${student.regNo}`);

  const duration       = program?.durationYears || 5;
  let waa              = 0;
  const yearBreakdown: GraduationResult["yearBreakdown"] = [];
  const historyUpdates: Array<{ yearOfStudy: number; annualMean: number; wc: number }> = [];

  for (let yearOfStudy = 1; yearOfStudy <= duration; yearOfStudy++) {
    const weight = getYearWeight(program, entryType, yearOfStudy);

    const programUnits = await ProgramUnit.find({
      program:      student.program._id || student.program,
      requiredYear: yearOfStudy,
    }).lean() as any[];

    const unitCount = programUnits.length || 1;
    let   totalMark = 0;
    let   resolved  = 0; // how many units have a mark

    const marksByUnit = await resolveAgreedMarksBatch(
      student._id.toString(), programUnits.map((pu: any) => pu._id.toString()),
    );

    for (const pu of programUnits) {
      const puId = (pu as any)._id.toString();
      const mark = marksByUnit.get(puId) ?? 0;
      if (mark > 0) {
        totalMark += mark;
        resolved++;
      }
    }

    // If no marks at all for this year, skip (student may not have sat exams)
    const annualMean = unitCount > 0 ? totalMark / unitCount : 0;
    const wc         = annualMean * weight;

    waa += wc;

    yearBreakdown.push({
      yearOfStudy,
      academicYear:         history.find((h: any) => h.yearOfStudy === yearOfStudy)?.academicYear || "",
      annualMean:           parseFloat(annualMean.toFixed(2)),
      weight,
      weightedContribution: parseFloat(wc.toFixed(4)),
      isRepeat:             history.find((h: any) => h.yearOfStudy === yearOfStudy)?.isRepeatYear || false,
      failedUnits:          history.find((h: any) => h.yearOfStudy === yearOfStudy)?.failedUnitsCount || 0,
    });

    historyUpdates.push({ yearOfStudy, annualMean, wc });
  }

  // Backfill DB (fire-and-forget)
  const backfill = _backfillStudentWAA(student._id, waa, historyUpdates).catch((err: Error) =>
    console.warn(`[graduationEngine] Backfill failed for ${student.regNo}:`, err.message),
  );
  if (opts.force) await backfill; // a refresh must be finished before the caller reads the result

  return { waa: parseFloat(waa.toFixed(2)), yearBreakdown };
}

/**
 * Recompute a student's weighted average from the CURRENT marks and store it.
 * Call after a mark is edited: the stored finalWeightedAverage / weightedContribution would otherwise
 * keep showing the old figures on the award list and graduation screens.
 */
export async function refreshStudentWAA(studentId: unknown): Promise<number | null> {
  const student = await Student.findById(studentId).populate("program").lean() as any;
  if (!student) return null;
  const hasStored = student.finalWeightedAverage != null ||
    (student.academicHistory || []).some((h: any) => (h.weightedContribution || 0) > 0);
  if (!hasStored) return null; // nothing stored yet; it will be computed from the marks on demand
  const { waa } = await computeWAA(student, { force: true });
  return waa;
}

// ─── DB backfill ──────────────────────────────────────────────────────────────

async function _backfillStudentWAA(
  studentId:    any,
  waa:          number,
  yearUpdates:  Array<{ yearOfStudy: number; annualMean: number; wc: number }>,
): Promise<void> {
  const student = await Student.findById(studentId).lean() as any;
  if (!student) return;

  const updatedHistory = (student.academicHistory || []).map((h: any) => {
    const upd = yearUpdates.find(u => u.yearOfStudy === h.yearOfStudy);
    if (!upd) return h;
    return { ...h, annualMeanMark: upd.annualMean, weightedContribution: upd.wc };
  });

  const classification = classifyWAA(waa);

  await Student.findByIdAndUpdate(studentId, {
    $set: {
      finalWeightedAverage: waa.toFixed(2),
      classification,
      academicHistory:      updatedHistory,
    },
  });

  // console.log(`[graduationEngine] Backfilled WAA=${waa.toFixed(2)}, class=${classification} for ${studentId}`);
}

// ─── Single student graduation status ─────────────────────────────────────────

export const calculateGraduationStatus = async (
  studentId: string,
): Promise<GraduationResult> => {
  const student = await Student.findById(studentId).populate("program").lean() as any;
  if (!student) throw new Error(`Student ${studentId} not found`);

  const program  = student.program as any;
  const duration = program?.durationYears || 5;
  const history  = (student.academicHistory || []) as any[];
  const missingRequirements: string[] = [];

  // Eligibility checks
  const yearsPresent = new Set(history.map((h: any) => h.yearOfStudy));
  for (let y = 1; y <= duration; y++) {
    if (!yearsPresent.has(y)) missingRequirements.push(`Year ${y} has no academic history record`);
  }
  history.filter((h: any) => (h.failedUnitsCount || 0) > 0).forEach((h: any) => {
    missingRequirements.push(`Year ${h.yearOfStudy} has ${h.failedUnitsCount} uncleared failed unit(s)`);
  });
  const pendingCF = (student.carryForwardUnits || []).filter(
    (u: any) => u.status === "pending" || !u.status,
  );
  if (pendingCF.length > 0) {
    missingRequirements.push(
      `${pendingCF.length} carry-forward unit(s) pending: ${pendingCF.map((u: any) => u.unitCode).join(", ")}`,
    );
  }
  for (const a of await outstandingAttachments(student._id)) missingRequirements.push(`${a} not passed (ENG.24)`);
  if (!["graduand","graduated"].includes(student.status) && missingRequirements.length === 0) {
    missingRequirements.push(`Student status is "${student.status}" — must be "graduand" or "graduated"`);
  }

  const { waa, yearBreakdown } = await computeWAA(student);

  let classification = "FAIL";
  if      (waa >= 70) classification = "FIRST CLASS HONOURS";
  else if (waa >= 60) classification = "SECOND CLASS HONOURS (UPPER DIVISION)";
  else if (waa >= 50) classification = "SECOND CLASS HONOURS (LOWER DIVISION)";
  else if (waa >= 40) classification = "PASS";

  return {
    studentId:                student._id.toString(),
    regNo:                    student.regNo,
    name:                     student.name,
    weightedAggregateAverage: parseFloat(waa.toFixed(2)),
    classification,
    isEligible:               missingRequirements.length === 0,
    missingRequirements,
    yearBreakdown,
  };
};

// ─── Award list ───────────────────────────────────────────────────────────────

export const generateAwardList = async (
  programId:     string,
  academicYear?: string,
): Promise<AwardListEntry[]> => {
  const students = await Student.find({
    program: programId,
    status:  { $in: ["graduand","graduated"] },
  }).populate("program").lean() as any[];

  const awardList: AwardListEntry[] = [];

  const inScope = students.filter((student) => {
    if (!academicYear) return true;
    const lastYear = (student.academicHistory || []).at(-1)?.academicYear || "";
    return lastYear.includes(academicYear) || student.graduationYear === parseInt(academicYear);
  });
  // students are independent; compute a few at a time (matters for large classes)
  const waas = await mapLimit(inScope, 8, (student) => computeWAA(student));
     
  for (let idx = 0; idx < inScope.length; idx++) {
    const student = inScope[idx];
    const { waa } = waas[idx];
    
    let classification = student.classification || "";
    if (!classification || (classification === "PASS" && waa > 50)) {
      if      (waa >= 70) classification = "FIRST CLASS HONOURS";
      else if (waa >= 60) classification = "SECOND CLASS HONOURS (UPPER DIVISION)";
      else if (waa >= 50) classification = "SECOND CLASS HONOURS (LOWER DIVISION)";
      else if (waa >= 40) classification = "PASS";
      else                classification = "FAIL";
    }

    awardList.push({
      studentId:      student._id.toString(),
      regNo:          student.regNo,
      name:           student.name,
      waa:            parseFloat(waa.toFixed(2)),
      classification,
      graduationYear: student.graduationYear || new Date().getFullYear(),
    });
  }

  const classOrder = [
    "FIRST CLASS HONOURS",
    "SECOND CLASS HONOURS (UPPER DIVISION)",
    "SECOND CLASS HONOURS (LOWER DIVISION)",
    "PASS", "FAIL",
  ];
  awardList.sort((a, b) => {
    const ai = classOrder.indexOf(a.classification);
    const bi = classOrder.indexOf(b.classification);
    if (ai !== bi) return ai - bi;
    return b.waa - a.waa;
  });

  return awardList;
};