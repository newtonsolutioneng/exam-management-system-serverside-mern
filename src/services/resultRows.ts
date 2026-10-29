// serverside/src/services/resultRows.ts
//
// One scoresheet row → one mark. Shared by the detailed and direct importers and by the
// problem-results "Retry". A row that cannot be applied returns { ok:false, code, message }
// (it is stored as a ProblemResult by the caller) instead of throwing.

import { Types } from "mongoose";
import Student from "../models/Student";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import ProgramUnit from "../models/ProgramUnit";
import type { ProblemCode } from "../models/ProblemResult";
import { computeFinalGrade } from "./gradeCalculator";
import { findStudentByRegNo, splitRegNo } from "../utils/regNoQualifier";
import type { MarkDistribution, UnitKind, ExamModeKind } from "../utils/markDistribution";

export interface RowContext {
  institutionId: any;
  userId: any;
  batchId: string;
  templateType: "detailed" | "direct";
  unitCode: string;
  academicYearId: any;
  distribution: MarkDistribution;
  /** e.g. "2018/2019" — lets the row check deferrals made from this academic year */
  academicYearLabel?: string;
  unitType: UnitKind;
  examMode: ExamModeKind;
  /** students of this sheet, loaded in one query (base reg no -> lean student); falls back to a per-row query */
  students?: Map<string, Record<string, any>>;
}

export type ProgramUnitMap = Map<string, Record<string, unknown>>;

/** `${programId}_${UNIT CODE}` → ProgramUnit. Program-relative, so equal unit codes in two departments never clash. */
export async function loadProgramUnitMap(institutionId: any): Promise<ProgramUnitMap> {
  const all = await ProgramUnit.find({ institution: institutionId }).populate("unit").lean();
  return new Map(
    all.map((pu) => {
      const o = pu as Record<string, any>;
      return [`${String(o.program)}_${String(o.unit?.code ?? "").toUpperCase()}`, o];
    }),
  );
}

export type RowOutcome =
  | { ok: true; regNo: string; created: boolean; previousMark?: number; newMark?: number }
  | { ok: false; code: ProblemCode; message: string; action: string; regNo: string; programId?: string };

const ACTIONS: Record<ProblemCode, (unit: string) => string> = {
  STUDENT_NOT_FOUND: () => "Register the student (or correct the reg no), then press Retry.",
  UNIT_NOT_LINKED: (u) => `Link ${u} to the student's programme curriculum, then press Retry.`,
  INVALID_MARK: () => "Correct the marks (or the unit's mark distribution), re-upload the row or edit it here, then press Retry.",
  SAVE_FAILED: () => "Press Retry; if it fails again, contact the administrator.",
};
const fail = (code: ProblemCode, regNo: string, message: string, unit: string, programId?: string): RowOutcome =>
  ({ ok: false, code, message, action: ACTIONS[code](unit), regNo, programId });

const cell = (row: unknown[], i: number) => row[i];
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";
/** Numeric cell → number; blank → 0; text → NaN (reported, never silently turned into 0). */
const num = (v: unknown): number => (blank(v) ? 0 : Number(v));

function attemptFromDetailed(v: unknown): string {
  const l = String(v ?? "").trim().toLowerCase();
  return l.includes("supp") ? "supplementary" : l.includes("special") ? "special" : l.includes("retake") ? "re-take" : "1st";
}
function attemptFromDirect(raw: unknown): string {
  const r = String(raw ?? "").toLowerCase().trim();
  if (!r) return "1st";
  if (r === "a/s" || r.startsWith("supp")) return "supplementary";
  if (r === "spec" || r.includes("special")) return "special";
  if (/rp\d+c/i.test(r) || r === "a/cf") return "re-take";
  if (r === "a/so" || r === "a/sos" || r.includes("stayout")) return "re-take";
  if (/rpu\d*/i.test(r)) return "re-take";
  return "1st";
}

/** Column positions on each template (0-based). */
const COL = {
  detailed: { reg: 1, attempt: 3, ca: 13, exam: 19, internal: 20, agreed: 22,
    raws: { cat1Raw: 4, cat2Raw: 5, cat3Raw: 6, assgnt1Raw: 8, assgnt2Raw: 9, assgnt3Raw: 10, practicalRaw: 12,
            examQ1Raw: 14, examQ2Raw: 15, examQ3Raw: 16, examQ4Raw: 17, examQ5Raw: 18 } },
  direct: { reg: 1, attempt: 3, ca: 4, exam: 5, internal: 6, external: 7, agreed: 8 },
} as const;

/**
 * True when the typed input cells of a sheet row hold nothing to apply, so uploading an EMPTY copy of a sheet
 * (reg numbers filled in by the template, no marks typed) can never overwrite marks that are already saved.
 * Formula cells are ignored (an unopened-then-saved sheet shows 0 in them). Rows of a later sitting
 * (supp / special / retake) whose only content is the locked, pre-filled coursework count as empty too.
 */
export function rowHasNoEntries(row: unknown[], templateType: "detailed" | "direct"): boolean {
  const anyIn = (idx: number[]) => idx.some((i) => !blank(row[i]));
  const examSide = templateType === "detailed" ? [14, 15, 16, 17, 18, 21] : [5, 7];
  const caSide   = templateType === "detailed" ? [4, 5, 6, 8, 9, 10, 12] : [4];
  if (anyIn(examSide)) return false;
  if (!anyIn(caSide)) return true;
  const attempt = templateType === "detailed" ? attemptFromDetailed(row[3]) : attemptFromDirect(row[3]);
  return attempt !== "1st";
}

export async function processResultRow(
  ctx: RowContext,
  programUnits: ProgramUnitMap,
  row: unknown[],
  regNoOverride?: string,
): Promise<RowOutcome> {
  const { base: regNo } = splitRegNo(regNoOverride ?? row[1]);
  const unit = ctx.unitCode;

  const student = (ctx.students?.get(regNo) ?? (await findStudentByRegNo(Student, regNo, ctx.institutionId))) as Record<string, any> | null;
  if (!student) return fail("STUDENT_NOT_FOUND", regNo, `Student ${regNo} is not registered.`, unit);
  const programId = String(student.program);

  const programUnit = programUnits.get(`${programId}_${unit}`);
  if (!programUnit) {
    return fail("UNIT_NOT_LINKED", regNo, `Unit ${unit} is not linked to ${regNo}'s programme curriculum.`, unit, programId);
  }

  // ENG.13b / ENG.18c: a unit deferred to the next ordinary cannot be sat in this academic year's supplementary
  const sitAttempt = String(cell(row, 3) ?? "").toLowerCase();
  if (ctx.academicYearLabel && (/supp|special|a\/s|spec/.test(sitAttempt))) {
    const deferred = ((student as any).deferredSuppUnits ?? []).find((d: any) =>
      d.status === "pending" && d.programUnitId === String((programUnit as any)._id) && d.fromAcademicYear === ctx.academicYearLabel);
    if (deferred) return fail("INVALID_MARK", regNo,
      `${unit} was deferred to the next ordinary period (ENG.13b/18c) — it cannot be sat in this supplementary. Cancel the deferral first if the student is sitting it now.`, unit, programId);
  }

  const dist = ctx.distribution;
  const detailed = ctx.templateType === "detailed";
  const c = detailed ? COL.detailed : COL.direct;

  // ── Read + validate the numbers ──────────────────────────────────────────
  const ca = num(cell(row, c.ca));
  const exam = num(cell(row, c.exam));
  const rawAgreed = cell(row, c.agreed);
  const attempt = detailed ? attemptFromDetailed(cell(row, c.attempt)) : attemptFromDirect(cell(row, c.attempt));

  const checks: Array<[string, number, number]> = [
    [`CA total`, ca, dist.ca],
    [`Exam total`, exam, dist.exam],
    [`Agreed mark`, blank(rawAgreed) ? 0 : Number(rawAgreed), 100],
  ];
  for (const [label, v, max] of checks) {
    if (Number.isNaN(v)) return fail("INVALID_MARK", regNo, `${label} is not a number.`, unit, programId);
    if (v < 0 || v > max + 1e-9) {
      return fail("INVALID_MARK", regNo,
        `${label} ${v} is outside 0–${max} (this sheet's distribution is CA ${dist.ca} / Exam ${dist.exam}).`, unit, programId);
    }
  }

  const common = {
    student: student._id,
    programUnit: (programUnit as any)._id,
    academicYear: ctx.academicYearId,
    institution: ctx.institutionId,
    uploadedBy: ctx.userId,
    batchId: ctx.batchId,
    attempt,
    isSpecial: attempt === "special",
    isSupplementary: attempt === "supplementary",
    isRetake: attempt === "re-take",
    caMax: dist.ca,
    examMax: dist.exam,
    unitType: ctx.unitType,
    examMode: ctx.examMode,
    deletedAt: null,
  };
  const key = { student: student._id, programUnit: (programUnit as any)._id, academicYear: ctx.academicYearId };

  try {
    let saved: any;
    let previous: any;

    if (detailed) {
      const raws: Record<string, number> = {};
      for (const [field, idx] of Object.entries(COL.detailed.raws)) {
        // ENG.10(d): a blank practical cell means "not recorded", not a score of 0.
        if (field === "practicalRaw" && blank(cell(row, idx))) continue;
        const v = num(cell(row, idx));
        if (Number.isNaN(v)) return fail("INVALID_MARK", regNo, `${field.replace("Raw", "")} is not a number.`, unit, programId);
        raws[field] = v;
      }
      previous = await Mark.findOne(key).select("agreedMark batchId").lean();
      saved = await Mark.findOneAndUpdate(
        key,
        { ...common, ...raws, caTotal30: ca, examTotal70: exam,
          internalExaminerMark: num(cell(row, COL.detailed.internal)), agreedMark: num(rawAgreed) },
        { upsert: true, new: true, runValidators: true },
      );
    } else {
      const extRaw = cell(row, COL.direct.external);
      previous = await MarkDirect.findOne(key).select("agreedMark batchId").lean();
      saved = await MarkDirect.findOneAndUpdate(
        key,
        { $set: { ...common, caTotal30: ca, examTotal70: exam,
            externalTotal100: blank(extRaw) ? null : Number(extRaw),
            agreedMark: blank(rawAgreed) ? ca + exam : Number(rawAgreed),
            isMissingCA: ca === 0 && attempt !== "supplementary" && attempt !== "special",
            uploadedAt: new Date() } },
        { upsert: true, new: true },
      );
    }

    try {
      await computeFinalGrade({ markId: saved._id as Types.ObjectId });
    } catch (e) {
      // the mark is stored; grading can be re-run — surface it as a SAVE_FAILED-free warning via console
      console.warn(`[resultRows] grade calc for ${regNo}/${unit}:`, e instanceof Error ? e.message : e);
    }

    return {
      ok: true, regNo, created: !previous,
      previousMark: previous ? Number(previous.agreedMark ?? 0) : undefined,
      newMark: Number(saved.agreedMark ?? 0),
    };
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "ValidationError") return fail("INVALID_MARK", regNo, e.message ?? "Invalid mark", unit, programId);
    return fail("SAVE_FAILED", regNo, e?.message ?? String(err), unit, programId);
  }
}