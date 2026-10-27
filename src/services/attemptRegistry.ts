// serverside/src/services/attemptRegistry.ts
//
// Per-student, per-unit attempt history (ENG.16(b), ENG.22(b)).
// An "attempt" is one graded sitting: (academic year + attempt type). Re-grading the
// same sitting updates it; a new year or a new type (1st / supplementary / re-take)
// counts as the next attempt. Pending specials are not attempts (ENG.18).

import Student from "../models/Student";
import type mongoose from "mongoose";

export interface RecordedAttempt {
  attemptNumber: number;
  /** true when this sitting was already recorded (re-grade) */
  existing: boolean;
}

export async function recordAttempt(args: {
  studentId:    unknown;
  unitId:       unknown;
  academicYear: string;
  type:         string;   // 1ST_ATTEMPT | SUPPLEMENTARY | RETAKE
  mark:         number;
  passed:       boolean;
  session?:     mongoose.ClientSession | null;
}): Promise<RecordedAttempt> {
  const { studentId, unitId, academicYear, type, mark, passed, session } = args;
  const q = Student.findById(studentId).select("unitAttemptRegistry");
  if (session) q.session(session);
  const student: any = await q;
  if (!student) return { attemptNumber: 1, existing: false };

  const registry: any[] = student.unitAttemptRegistry || [];
  const entry = registry.find((e: any) => String(e.unitId) === String(unitId));
  const opts = session ? { session } : {};

  if (!entry) {
    await Student.updateOne(
      { _id: studentId },
      { $push: { unitAttemptRegistry: { unitId, attempts: [{ attemptNumber: 1, mark, passed, type, academicYear }] } } },
      opts,
    );
    return { attemptNumber: 1, existing: false };
  }

  const same = (entry.attempts || []).find((a: any) => a.academicYear === academicYear && a.type === type);
  if (same) {
    await Student.updateOne(
      { _id: studentId },
      { $set: { "unitAttemptRegistry.$[e].attempts.$[a].mark": mark, "unitAttemptRegistry.$[e].attempts.$[a].passed": passed } },
      { ...opts, arrayFilters: [{ "e.unitId": unitId }, { "a.academicYear": academicYear, "a.type": type }] },
    );
    return { attemptNumber: same.attemptNumber, existing: true };
  }

  // A sitting after a pass is not a new attempt at a failed unit; ignore re-sits of passed units.
  const attemptNumber = (entry.attempts || []).length + 1;
  await Student.updateOne(
    { _id: studentId },
    { $push: { "unitAttemptRegistry.$[e].attempts": { attemptNumber, mark, passed, type, academicYear } } },
    { ...opts, arrayFilters: [{ "e.unitId": unitId }] },
  );
  return { attemptNumber, existing: false };
}

/** Units whose latest recorded attempt failed, with how many attempts have been used. */
export async function failedUnitAttempts(studentId: unknown): Promise<Array<{ unitId: string; attempts: number }>> {
  const student: any = await Student.findById(studentId).select("unitAttemptRegistry").lean();
  const out: Array<{ unitId: string; attempts: number }> = [];
  for (const e of student?.unitAttemptRegistry || []) {
    const list: any[] = e.attempts || [];
    if (list.length === 0) continue;
    if (list.some((a) => a.passed)) continue; // passed at some point: resolved
    out.push({ unitId: String(e.unitId), attempts: list.length });
  }
  return out;
}