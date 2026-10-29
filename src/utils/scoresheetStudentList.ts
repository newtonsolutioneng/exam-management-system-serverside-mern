// serverside/src/utils/scoresheetStudentList.ts

import { lapTimer } from "./perfLog";
import mongoose from "mongoose";
import type * as ExcelJS from "exceljs";
import Student from "../models/Student";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import FinalGrade from "../models/FinalGrade";
import ProgramUnit from "../models/ProgramUnit";
import AcademicYear from "../models/AcademicYear";
import { buildDisplayRegNo } from "./academicRules";
import { splitRegNo, regNoAnyQualifierRegex } from "./regNoQualifier";
import { getCarryForwardStudentsForUnit, getDeferredSuppStudentsForUnit, getStayoutStudentsForUnit } from "../services/carryForwardService";


export interface ScoresheetStudent {
  regNo:            string;
  displayRegNo:     string;
  name:             string;
  studentId:        string;
  attemptLabel:     string;
  isSupp:           boolean;
  isSpecial:        boolean;
  isCarriedSpecial: boolean;
  isCarryForward:   boolean;
  isStayout:        boolean;
  isRepeatYear:     boolean;
  isDeferredSupp:   boolean;   // NEW: student from higher year, sitting deferred unit
  isExtra:          boolean;   // added by the coordinator: not part of the main class
  /** CF / stay-out retake: the first-sitting coursework mark is carried (pre-filled and locked), the student re-sits the exam only */
  lockCA:           boolean;
  prevMark?:        any;
  qualifierSuffix?: string;
}
 
const ATTEMPT = {FIRST: "1st", SUPPLEMENTARY: "Supp", RETAKE: "Retake", SPECIAL: "Special", REPEAT_YEAR: "Repeat", STAYOUT: "Retake", CF: "Retake"};
 
const EXCLUDED = ["deregistered", "discontinued", "graduated", "graduand", "deferred", "on_leave"];
 
// ─── Resolve the best grade status for a student on a specific unit ───────────
async function _resolveUnitStatus(
  studentId: string,
  puId:      string,
  passMark:  number,
): Promise<{ status: string | null; mark: any | null }> {
  const fg = await FinalGrade.findOne({ student: studentId, programUnit: puId })
    .sort({ createdAt: -1 }).lean() as any;
  if (fg) return { status: fg.status, mark: fg };
 
  const md = await MarkDirect.findOne({ student: studentId, programUnit: puId })
    .sort({ createdAt: -1 }).lean() as any;
  if (md) {
    const isSpecial = md.isSpecial || md.attempt === "special";
    return {
      status: isSpecial ? "SPECIAL"
            : (md.agreedMark ?? 0) >= passMark ? "PASS" : "SUPPLEMENTARY",
      mark: md,
    };
  }
 
  const dm = await Mark.findOne({ student: studentId, programUnit: puId })
    .sort({ createdAt: -1 }).lean() as any;
  if (dm) {
    const isSpecial = dm.isSpecial || dm.attempt === "special";
    return {
      status: isSpecial ? "SPECIAL"
            : (dm.agreedMark ?? 0) >= passMark ? "PASS" : "SUPPLEMENTARY",
      mark: dm,
    };
  }
 
  return { status: null, mark: null };
}
 
// ─── Find a SPECIAL mark from ANY prior year for a specific unit ──────────────
async function _findPriorSpecialMark(studentId: string, puId: string): Promise<any | null> {
  const fg = await FinalGrade.findOne({ student: studentId, programUnit: puId, status: "SPECIAL" })
    .sort({ createdAt: -1 }).lean() as any;
  if (fg && (fg.caTotal30 ?? 0) > 0) return { ...fg, _source: "finalGrade" };
 
  const dm = await Mark.findOne({ student: studentId, programUnit: puId, isSpecial: true })
    .sort({ createdAt: -1 }).lean() as any;
  if (dm && (dm.caTotal30 ?? 0) > 0) return { ...dm, _source: "detailed" };
 
  const md = await MarkDirect.findOne({ student: studentId, programUnit: puId, attempt: "special" })
    .sort({ createdAt: -1 }).lean() as any;
  if (md && (md.caTotal30 ?? 0) > 0) return { ...md, _source: "direct" };
 
  return null;
}
 
// ─── Batch versions of the two look-ups above ─────────────────────────────────
// One query per collection for the whole class instead of up to six per student (the per-student
// version made a 500-student sheet take minutes). The decision rules are identical.
interface UnitPrefetch { fg: Map<string, any[]>; md: Map<string, any[]>; dm: Map<string, any[]> }

const _t = (d: any) => (d?.createdAt ? new Date(d.createdAt).getTime() : 0);

export async function _prefetchUnit(studentIds: string[], puId: string): Promise<UnitPrefetch> {
  const group = (docs: any[]) => {
    const m = new Map<string, any[]>();
    for (const d of docs) { const k = String(d.student); (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    for (const list of m.values()) list.sort((a, b) => _t(b) - _t(a)); // newest first
    return m;
  };
  if (!studentIds.length) return { fg: new Map(), md: new Map(), dm: new Map() };
  const q = { student: { $in: studentIds }, programUnit: puId };
  const [fg, md, dm] = await Promise.all([
    FinalGrade.find(q).lean(), MarkDirect.find(q).lean(), Mark.find(q).lean(),
  ]);
  return { fg: group(fg as any[]), md: group(md as any[]), dm: group(dm as any[]) };
}

export function _statusFrom(pre: UnitPrefetch, sid: string, passMark: number): { status: string | null; mark: any | null } {
  const fg = pre.fg.get(sid)?.[0];
  if (fg) return { status: fg.status, mark: fg };
  for (const md of [pre.md.get(sid)?.[0], pre.dm.get(sid)?.[0]]) {
    if (!md) continue;
    const isSpecial = md.isSpecial || md.attempt === "special";
    return { status: isSpecial ? "SPECIAL" : (md.agreedMark ?? 0) >= passMark ? "PASS" : "SUPPLEMENTARY", mark: md };
  }
  return { status: null, mark: null };
}

export function _priorSpecialFrom(pre: UnitPrefetch, sid: string): any | null {
  const fg = pre.fg.get(sid)?.find((d) => d.status === "SPECIAL");
  if (fg && (fg.caTotal30 ?? 0) > 0) return { ...fg, _source: "finalGrade" };
  const dm = pre.dm.get(sid)?.find((d) => d.isSpecial === true);
  if (dm && (dm.caTotal30 ?? 0) > 0) return { ...dm, _source: "detailed" };
  const md = pre.md.get(sid)?.find((d) => d.attempt === "special");
  if (md && (md.caTotal30 ?? 0) > 0) return { ...md, _source: "direct" };
  return null;
}

/**
 * The first-sitting coursework mark a CF / stay-out student carries into the retake (ENG.14, ENG.15h:
 * exam-only retake). Newest mark with real CA that is not itself a supplementary sitting; the detailed
 * Mark is preferred because it holds the raw CAT / assignment / practical scores.
 */
export function _priorCAFrom(pre: UnitPrefetch, sid: string): any | null {
  const real = (d: any) => (d?.caTotal30 ?? 0) > 0 && String(d.attempt ?? "").toLowerCase() !== "supplementary";
  const dm = pre.dm.get(sid)?.find(real);
  if (dm) return { ...dm, _source: "detailed" };
  const md = pre.md.get(sid)?.find(real);
  if (md) return { ...md, _source: "direct" };
  const fg = pre.fg.get(sid)?.find(real);
  if (fg) return { ...fg, _source: "finalGrade" };
  return null;
}

// ─── Derive attempt flags from a mark ────────────────────────────────────────
function _flagsFromMark(
  mark:          any | null,
  studentStatus: string,
  priorSpecial:  any | null,
): Partial<ScoresheetStudent> & { attemptLabel: string } {
  if (!mark) {
    const isRepeat = studentStatus === "repeat";
    return { attemptLabel: isRepeat ? ATTEMPT.REPEAT_YEAR : ATTEMPT.FIRST, isRepeatYear: isRepeat };
  }
 
  const attempt   = (mark.attempt || mark.attemptType || "1st").toLowerCase();
  const isSpecial = mark.isSpecial === true || attempt === "special" ||
                    mark.status === "SPECIAL" || mark.attemptType === "SPECIAL";
  const isSupp    = attempt === "supplementary" || mark.status === "SUPPLEMENTARY" ||
                    mark.attemptType === "SUPPLEMENTARY";
  const isRetake  = attempt === "re-take" || attempt === "retake" || mark.attemptType === "RETAKE";
 
  if (isSpecial) return {
    attemptLabel:     ATTEMPT.SPECIAL,
    isSpecial:        true,
    isCarriedSpecial: priorSpecial != null,
    prevMark:         priorSpecial ?? mark,
  };
  if (isSupp)            return { attemptLabel: ATTEMPT.SUPPLEMENTARY, isSupp: true };
  if (isRetake)          return { attemptLabel: ATTEMPT.RETAKE };
  if (studentStatus === "repeat") return { attemptLabel: ATTEMPT.REPEAT_YEAR, isRepeatYear: true };
  return { attemptLabel: ATTEMPT.FIRST };
}
 
// ─────────────────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────────────────
 
export const buildScoresheetStudentList = async (params: {
  programId:      mongoose.Types.ObjectId;
  programUnitId:  mongoose.Types.ObjectId;
  unitId:         mongoose.Types.ObjectId;
  yearOfStudy:    number;
  academicYearId: mongoose.Types.ObjectId;
  session:        "ORDINARY" | "SUPPLEMENTARY" | "CLOSED";
  passMark:       number;
  /** Reg nos of students outside the main class (other cohorts, late registrations …) to add to the sheet. */
  extraRegNos?:   string[];
  institutionId?: unknown;
}): Promise<ScoresheetStudent[]> => {
  const { programId, programUnitId, yearOfStudy, academicYearId, session, passMark } = params;
 
  const lap = lapTimer("scoresheet student list");
  const academicYear = await AcademicYear.findById(academicYearId).lean() as any;
  if (!academicYear) throw new Error("Academic year not found");
  lap("academic year");
 
  const result:   ScoresheetStudent[] = [];
  const addedIds: Set<string>         = new Set();
 
  const add = (
    student:      any,
    attemptLabel: string,
    flags:        Partial<ScoresheetStudent> = {},
    prevMark?:    any,
  ) => {
    const id = student._id.toString();
    if (addedIds.has(id)) return;
    addedIds.add(id);
    result.push({
      regNo:            student.regNo,
      displayRegNo:     buildDisplayRegNo(student.regNo, student.qualifierSuffix),
      name:             student.name,
      studentId:        id,
      attemptLabel,
      isSupp:           false,
      isSpecial:        false,
      isCarriedSpecial: false,
      isCarryForward:   false,
      isStayout:        false,
      isRepeatYear:     false,
      isDeferredSupp:   false,
      isExtra:          false,
      lockCA:           false,
      qualifierSuffix:  student.qualifierSuffix || "",
      prevMark,
      ...flags,
    });
  };
 
  // ── ORDINARY ───────────────────────────────────────────────────────────────
  if (session === "ORDINARY" || session === "CLOSED") {
 
    // Primary pool: students with marks for this unit + this academic year
    const [detailedIds, directIds] = await Promise.all([
      Mark.find({ programUnit: programUnitId, academicYear: academicYearId }).distinct("student"),
      MarkDirect.find({ programUnit: programUnitId, academicYear: academicYearId }).distinct("student"),
    ]);
    const allMarkedIds = [...new Set([
      ...detailedIds.map((id: any) => id.toString()),
      ...directIds.map((id: any) => id.toString()),
    ])];
    lap("marked ids");
 
    if (allMarkedIds.length > 0) {
      const studentsWithMarks = await Student.find({
        _id:    { $in: allMarkedIds },
        status: { $nin: EXCLUDED },
      }).sort({ regNo: 1 }).lean() as any[];
 
      const preMarked = await _prefetchUnit(studentsWithMarks.map((st: any) => st._id.toString()), programUnitId.toString());
      const looked = studentsWithMarks.map((student: any) => {
        const sid = student._id.toString();
        const { mark } = _statusFrom(preMarked, sid, passMark);
        return { mark, priorSpecial: mark?.isSpecial ? _priorSpecialFrom(preMarked, sid) : null };
      });
      for (let i = 0; i < studentsWithMarks.length; i++) {
        const student = studentsWithMarks[i];
        const { mark, priorSpecial } = looked[i];
        const flags = _flagsFromMark(mark, student.status, priorSpecial);
        add(student, flags.attemptLabel, flags, flags.prevMark ?? mark ?? undefined);
      }
    }
 
    // Current-year fallback: students in this year with no mark for this unit yet.
    // Also used when nothing has been uploaded for this unit/year yet — otherwise a sheet for a
    // year that is not flagged "current" came out completely blank.
    if (academicYear.isCurrent || allMarkedIds.length === 0) {
      const currentStudents = await Student.find({
        program:            programId,
        currentYearOfStudy: yearOfStudy,
        status:             { $nin: EXCLUDED },
        _id:                { $nin: allMarkedIds },
      }).sort({ regNo: 1 }).lean() as any[];
 
      const preCurrent = await _prefetchUnit(currentStudents.map((st: any) => st._id.toString()), programUnitId.toString());
      const lookedCurrent = currentStudents.map((student: any) => {
        const sid = student._id.toString();
        const { status: priorStatus } = _statusFrom(preCurrent, sid, passMark);
        return { priorStatus, priorSpecial: priorStatus === "PASS" ? null : _priorSpecialFrom(preCurrent, sid) };
      });
      for (let i = 0; i < currentStudents.length; i++) {
        const student = currentStudents[i];
        const { priorStatus, priorSpecial } = lookedCurrent[i];

        const isRepeat = student.status === "repeat";
        // A student who already PASSED this unit is skipped, EXCEPT a repeat-year student: repeating the
        // year means full re-enrolment, every unit, CATs and exam, marked out of 100% (ENG.16).
        if (priorStatus === "PASS" && !isRepeat) continue;

        if (priorSpecial) {
          add(student, ATTEMPT.SPECIAL, { isSpecial: true, isCarriedSpecial: true }, priorSpecial);
        } else if (isRepeat) {
          add(student, ATTEMPT.REPEAT_YEAR, { isRepeatYear: true });
        } else if (priorStatus === "SUPPLEMENTARY") {
          const ca = _priorCAFrom(preCurrent, student._id.toString());
          add(student, ATTEMPT.RETAKE, { isStayout: true, lockCA: !!ca }, ca ?? undefined);
        } else {
          add(student, ATTEMPT.FIRST);
        }
      }
    }
 
    lap("current students");
    // Carry-forward students (ENG.14) — already filtered by programUnitId
    try {
      const cfStudents = await getCarryForwardStudentsForUnit(
        programUnitId.toString(), programId.toString(),
      );
      // A carried-forward unit is still a SUPPLEMENTARY sitting: coursework locked at 0, mark capped at the pass mark (ENG.13f)
      for (const { student } of cfStudents) {
        if (EXCLUDED.includes(student.status)) continue;
        add(student, ATTEMPT.SUPPLEMENTARY, { isCarryForward: true, isSupp: true });
      }
    } catch { }
 
    lap("carry-forward");
    // Stayout students (ENG.15h) — already filtered by programUnitId
    try {
      const stayoutStudents = await getStayoutStudentsForUnit(
        programUnitId.toString(), programId.toString(),
      );
      const soList = stayoutStudents.filter(({ student }: any) => !EXCLUDED.includes(student.status));
      const preSo = await _prefetchUnit(soList.map(({ student }: any) => student._id.toString()), programUnitId.toString());
      for (const { student } of soList) {
        const ca = _priorCAFrom(preSo, student._id.toString());
        add(student, ATTEMPT.STAYOUT, { isStayout: true, lockCA: !!ca }, ca ?? undefined);
      }
    } catch { }
 
    lap("stayout");
    // ── NEW: Deferred-supp/special students (ENG.13b / ENG.18c) ─────────────
    // Students from a HIGHER year who have a pending deferred supp or special
    // for THIS specific programUnit. They were promoted despite the pending unit
    // and are now sitting it in this ordinary period.
    try {
      const deferredStudents = await getDeferredSuppStudentsForUnit(
        programUnitId.toString(), programId.toString(),
      );
      for (const { student, attemptLabel, isSupp, isSpecial } of deferredStudents) {
        if (EXCLUDED.includes(student.status)) continue;
        let prevMark: any = null;
        if (isSpecial) {
          prevMark = await _findPriorSpecialMark(
            student._id.toString(), programUnitId.toString(),
          );
        }
        add(student, attemptLabel, {
          isSupp,
          isSpecial,
          isCarriedSpecial: isSpecial && prevMark != null,
          isDeferredSupp:   true,
        }, prevMark ?? undefined);
      }
    } catch { }
 
  // ── SUPPLEMENTARY ──────────────────────────────────────────────────────────
  } else if (session === "SUPPLEMENTARY") {
 
    const failingGrades = await FinalGrade.find({
      programUnit:  programUnitId,
      academicYear: academicYearId,
      status:       { $in: ["SUPPLEMENTARY", "SPECIAL"] },
    }).lean() as any[];
 
    const directFailing = await MarkDirect.find({
      programUnit:  programUnitId,
      academicYear: academicYearId,
      agreedMark:   { $lt: passMark },
      attempt:      { $ne: "special" },
    }).lean() as any[];
 
    const specialMarksDirect = await MarkDirect.find({
      programUnit:  programUnitId,
      academicYear: academicYearId,
      attempt:      "special",
    }).lean() as any[];
    const specialMarksDetailed = await Mark.find({
      programUnit:  programUnitId,
      academicYear: academicYearId,
      $or: [{ isSpecial: true }, { attempt: "special" }],
    }).lean() as any[];
 
    const candidateIds = new Set<string>([
      ...failingGrades.map((g: any) => g.student.toString()),
      ...directFailing.map((m: any) => m.student.toString()),
      ...specialMarksDirect.map((m: any) => m.student.toString()),
      ...specialMarksDetailed.map((m: any) => m.student.toString()),
    ]);
 
    if (candidateIds.size > 0) {
      const candidates = await Student.find({
        _id:    { $in: [...candidateIds] },
        status: { $nin: EXCLUDED },
      }).sort({ regNo: 1 }).lean() as any[];
 
      const totalUnits = await ProgramUnit.countDocuments({
        program: programId, requiredYear: yearOfStudy,
      });
 
      for (const student of candidates) {
        const sid = student._id.toString();

        // ENG.13b / ENG.18c: unit deferred to the next ordinary — not on this year's supplementary sheet
        const deferredHere = ((student as any).deferredSuppUnits ?? []).some((d: any) =>
          d.status === "pending" && d.programUnitId === programUnitId.toString() && d.fromAcademicYear === academicYear.year);
        if (deferredHere) continue;
 
        const gradeForUnit = failingGrades.find((g: any) => g.student.toString() === sid);
        const isSpecialUnit = gradeForUnit?.status === "SPECIAL" || gradeForUnit?.isSpecial ||
          specialMarksDirect.some((m: any) => m.student.toString() === sid) ||
          specialMarksDetailed.some((m: any) => m.student.toString() === sid);
 
        if (!isSpecialUnit) {
          const failedCount = await FinalGrade.countDocuments({
            student: student._id, academicYear: academicYearId, status: "SUPPLEMENTARY",
          });
          const failedFrac = totalUnits > 0 ? failedCount / totalUnits : 0;
          if (failedFrac > 1/3 && failedFrac < 1/2) continue; // stayout — not on supp
          if (failedFrac >= 1/2 || student.status === "repeat") continue; // repeat year
        }
 
        let prevMark: any = null;
        if (isSpecialUnit) {
          prevMark = await _findPriorSpecialMark(sid, programUnitId.toString());
        }
 
        add(student, isSpecialUnit ? ATTEMPT.SPECIAL : ATTEMPT.SUPPLEMENTARY, {
          isSupp:    !isSpecialUnit,
          isSpecial: isSpecialUnit,
        }, prevMark ?? undefined);
      }
    }
  }
 
  lap("deferred / supplementary");
  lap.done();
  // ── Students outside the main class (coordinator-supplied reg nos) ─────────
  for (const raw of params.extraRegNos ?? []) {
    const { base } = splitRegNo(raw);
    if (!base) continue;
    const student = await Student.findOne({
      regNo: { $regex: regNoAnyQualifierRegex(base) },
      ...(params.institutionId ? { institution: params.institutionId } : {}),
    }).lean() as any;
    if (!student || EXCLUDED.includes(student.status)) continue;
    const { status: priorStatus } = await _resolveUnitStatus(student._id.toString(), programUnitId.toString(), passMark);
    const retake = priorStatus === "SUPPLEMENTARY";
    add(student, retake ? ATTEMPT.RETAKE : ATTEMPT.FIRST, { isStayout: retake, isExtra: true });
  }

  // Sort: primary (1), CF (2), stayout/deferred (3), extras last (4)
  return result.sort((a, b) => {
    const rank = (s: ScoresheetStudent) =>
      s.isExtra ? 4 : s.isCarryForward || s.isDeferredSupp || s.isStayout ? 2 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.regNo.localeCompare(b.regNo);
  });
};
 
// getExistingMarksForStudents — cross-year, prefers special marks
export const getExistingMarksForStudents = async (
  studentIds:    string[],
  programUnitId: mongoose.Types.ObjectId,
): Promise<Map<string, any>> => {
  const [detailed, direct] = await Promise.all([
    Mark.find({ student: { $in: studentIds }, programUnit: programUnitId })
      .sort({ createdAt: -1 }).lean(),
    MarkDirect.find({ student: { $in: studentIds }, programUnit: programUnitId })
      .sort({ createdAt: -1 }).lean(),
  ]);
 
  const map = new Map<string, any>();
  for (const m of direct) {
    const key = m.student.toString();
    if (!map.has(key)) map.set(key, { ...m, source: "direct" });
  }
  for (const m of detailed) {
    const key = m.student.toString();
    const ex  = map.get(key);
    if (!ex || (m as any).isSpecial || !ex.isSpecial) {
      map.set(key, { ...m, source: "detailed" });
    }
  }
  return map;
};

export function buildRichRegNo(
  regNo: string, qualifier: string | undefined | null, fontName = "Book Antiqua", baseSize = 8,
): ExcelJS.CellRichTextValue | string {
  if (!qualifier || qualifier.trim() === "") return regNo;

  return {
    richText: [
      { text: regNo, font: { name: fontName, size: baseSize, bold: false }},
      { text: qualifier.trim(), font: { name: fontName, size: Math.max(baseSize - 2, 5), vertAlign: "subscript",  color: { argb: "FF002B1B" }}},
      // { text: qualifier.trim(), font: { name: fontName, size: Math.max(baseSize - 2, 5), vertAlign: "subscript"}},
    ],
  };
}

/**
 * CMS variant — Arial font, slightly larger base size.
 */
export function buildRichRegNoCMS(
  regNo: string,
  qualifier: string | undefined | null
): ExcelJS.CellRichTextValue | string {
  return buildRichRegNo(regNo, qualifier, "Times New Roman", 8);
}