// serverside/src/services/academicAudit.ts
import mongoose from "mongoose";
import Student from "../models/Student";
import FinalGrade from "../models/FinalGrade";
import { calculateStudentStatus } from "./statusEngine";
import { failedUnitAttempts } from "./attemptRegistry";
import ProgramUnit from "../models/ProgramUnit";
import Unit from "../models/Unit";
import { REG_QUALIFIERS } from "../utils/academicRules";
import InstitutionSettings from "../models/InstitutionSettings";

/**
 * PRODUCTION-READY: ENG 22.b Automatic Discontinuation Logic
 * This handles both the 5th Attempt Rule and the Repeat Year Failure Rule.
 */
export interface AuditResult {
  discontinued: boolean;
  reason:       string;
}

// export const performAcademicAudit = async ( studentId: string, session?: mongoose.ClientSession ) => {
//   const student = await Student.findById(studentId).session(session || null);

export const performAcademicAudit = async (
  studentId: string,
  session?: mongoose.ClientSession,
): Promise<AuditResult> => {
  // ── Load student ───────────────────────────────────────────────────────────
  const query = Student.findById(studentId);
  if (session) query.session(session);
  const student = await query;
  if (!student) throw new Error("Student not found for audit.");

  // CHECK 1: ENG.22(b)(i) — 5th Attempt Rule
  //
  // A student is discontinued if they have a FinalGrade where:
  //   - attemptNumber >= 5  (this is their 5th attempt at this unit)
  //   - status !== "PASS"   (they failed it)
  //
  // The attemptNumber field is set by gradeCalculator.ts when computing
  // FinalGrade. It counts FinalGrade documents per (student, programUnit).
  //
  // Note: We look for >= 5 not === 5 because a corrupted import could
  // theoretically create 6 records. We catch anything at or beyond the limit.
  // ─────────────────────────────────────────────────────────────────────────
  const fgQuery = FinalGrade.findOne({
    student: studentId,
    attemptNumber: { $gte: 5 },
    status: { $ne: "PASS" },
  }).populate({ path: "programUnit", populate: { path: "unit" } });

  if (session) fgQuery.session(session);
  const fatalGrade = await fgQuery;

  if (fatalGrade) {
    const unitCode =
      (fatalGrade.programUnit as any)?.unit?.code || "Unknown Unit";
    const attemptN = fatalGrade.attemptNumber ?? 5;

    const reason = `ENG.22(b)(i): Failed unit ${unitCode} at attempt ${attemptN}. Discontinued.`;

    await Student.findByIdAndUpdate(
      studentId,
      {
        $set: { status: "discontinued", remarks: reason },
        $push: {
          statusHistory: {
            status: "discontinued",
            previousStatus: (student as any).status,
            date: new Date(),
            reason,
          },
        },
      },
      session ? { session } : {},
    );

    return { discontinued: true, reason };
  }

  // CHECK 1b: ENG.22(b) via the attempt registry — a unit not passed after five sittings.
  const registryFails = await failedUnitAttempts(studentId);
  const fifth = registryFails.find((f) => f.attempts >= 5);
  if (fifth) {
    const unitDoc: any = await Unit.findById(fifth.unitId).select("code").lean();
    const reason = `ENG.22(b): Failed unit ${unitDoc?.code || fifth.unitId} after ${fifth.attempts} attempts. Discontinued.`;
    await Student.findByIdAndUpdate(
      studentId,
      {
        $set: { status: "discontinued", remarks: reason },
        $push: { statusHistory: { status: "discontinued", previousStatus: (student as any).status, date: new Date(), reason } },
      },
      session ? { session } : {},
    );
    return { discontinued: true, reason };
  }

  // CHECK 1c: ENG.22(c)/(e) — a stay-out student (ENG.15(h)) who fails the retake.
  const stayout = await checkStayoutRetakes(student);
  if (stayout.discontinue) {
    const reason = stayout.reason;
    await Student.findByIdAndUpdate(
      studentId,
      {
        $set: { status: "discontinued", remarks: reason, ...stayout.setUnits },
        $push: { statusHistory: { status: "discontinued", previousStatus: (student as any).status, date: new Date(), reason } },
      },
      session ? { session } : {},
    );
    return { discontinued: true, reason };
  }
  if (stayout.setUnits && Object.keys(stayout.setUnits).length) {
    await Student.findByIdAndUpdate(studentId, { $set: stayout.setUnits }, session ? { session } : {});
  }

  // CHECK 2: ENG.22(b)(ii) — Repeat Year Failure Rule
  //
  // A student who was ALREADY in a repeat year (ENG.16) and fails again
  // (mean < 40% OR ≥ 50% units failed) is discontinued.
  //
  // FIX from original: status should be "repeat", not "active".
  // A student actively repeating a year has status === "repeat".
  // Checking status === "active" means this rule NEVER fired.
  //
  // We also check academicHistory to confirm they are genuinely in a
  // repeat year for the current year of study, not just that their
  // status field is "repeat" from a previous year.
  // ─────────────────────────────────────────────────────────────────────────
  const isInRepeatYear =
    (student as any).status === "repeat" &&
    ((student as any).academicHistory || []).some(
      (h: any) =>
        h.yearOfStudy === (student as any).currentYearOfStudy && h.isRepeatYear,
    );

  if (isInRepeatYear) {
    const performance = await calculateStudentStatus(
      studentId,
      (student as any).program.toString(),
      "CURRENT", // FIX: was "N/A" — "CURRENT" explicitly resolves to current year
      (student as any).currentYearOfStudy,
      { forPromotion: true },
    );

    if (performance.status === "REPEAT YEAR") {
      const reason =
        `ENG.22(b)(ii): Failed to clear repeat year requirements ` +
        `(Mean ${performance.weightedMean}% — ${performance.summary.failed}/${performance.summary.totalExpected} ` +
        `units failed). Discontinued.`;

      await Student.findByIdAndUpdate(
        studentId,
        {
          $set: { status: "discontinued", remarks: reason },
          $push: {
            statusHistory: {
              status: "discontinued",
              previousStatus: "repeat",
              date: new Date(),
              reason,
            },
          },
        },
        session ? { session } : {},
      );

      return { discontinued: true, reason };
    }
  }

  return { discontinued: false, reason: "" };
};

/**
 * ENG.16(b): a unit not passed after four attempts blocks progression; the student must
 * repeat the unit (qualifier RPU{n}, n = unit repeats so far, max 5).
 * Idempotent: an RPU qualifier already on the student is kept.
 */
export const applyRepeatUnitRule = async (
  studentId: string,
): Promise<{ blocked: boolean; units: string[]; qualifier: string; reason: string }> => {
  const fails = (await failedUnitAttempts(studentId)).filter((f) => f.attempts === 4);
  if (fails.length === 0) return { blocked: false, units: [], qualifier: "", reason: "" };

  const codes: string[] = [];
  for (const f of fails) {
    const u: any = await Unit.findById(f.unitId).select("code").lean();
    codes.push(u?.code || f.unitId);
  }
  const student: any = await Student.findById(studentId).select("qualifierSuffix status").lean();
  const current: string = student?.qualifierSuffix || "";
  const m = /^RPU(\d)$/.exec(current);
  const qualifier = m ? current : REG_QUALIFIERS.repeatUnit(1);
  const reason = `ENG.16(b): not passed after four attempts — repeat unit(s): ${codes.join(", ")} (${qualifier}).`;

  if (!m) {
    await Student.findByIdAndUpdate(studentId, {
      $set:  { qualifierSuffix: qualifier, remarks: reason },
      $push: { statusEvents: { fromStatus: student?.status, toStatus: student?.status, date: new Date(), academicYear: "", reason } },
    });
  }
  return { blocked: true, units: codes, qualifier, reason };
};

/**
 * ENG.22(c)/(e). Looks at the units recorded when the student was put on stay-out and at the
 * attempt registry. A unit passed at any sitting is resolved. A unit still failed after the
 * retake discontinues the student at once (setting "retake"), or once the supplementary that
 * follows the retake is also failed (setting "supplementary", the default — it matches the
 * ENG.22(e) wording about a further attempt).
 */
export async function checkStayoutRetakes(student: any): Promise<{
  discontinue: boolean; reason: string; setUnits: Record<string, string>;
}> {
  const units: any[] = student.stayoutUnits || [];
  const setUnits: Record<string, string> = {};
  if (!units.some((u) => u.status === "pending")) return { discontinue: false, reason: "", setUnits };

  const settings: any = await InstitutionSettings.findOne({ institution: student.institution }).lean();
  const mode: "retake" | "supplementary" = settings?.ruleSet?.stayoutDiscontinuation ?? "supplementary";

  let reason = "";
  for (const [i, u] of units.entries()) {
    if (u.status !== "pending") continue;
    const pu: any = await ProgramUnit.findById(u.programUnitId).select("unit").lean();
    const entry = (student.unitAttemptRegistry || []).find((e: any) => String(e.unitId) === String(pu?.unit));
    const attempts: any[] = entry?.attempts || [];

    if (attempts.some((a) => a.passed)) { setUnits[`stayoutUnits.${i}.status`] = "passed"; continue; }

    const retakeIdx = attempts.findIndex((a) => a.type !== "SUPPLEMENTARY" && String(a.academicYear) > String(u.fromAcademicYear));
    if (retakeIdx < 0) continue; // not yet retaken
    const suppAfter = attempts.slice(retakeIdx + 1).some((a) => a.type === "SUPPLEMENTARY");

    if (mode === "retake" || suppAfter) {
      setUnits[`stayoutUnits.${i}.status`] = "discontinued";
      reason ||= mode === "retake"
        ? `ENG.22(c): failed unit ${u.unitCode} again on retaking it after stay-out. Discontinued.`
        : `ENG.22(e): failed unit ${u.unitCode} at the retake and again at the following supplementary. Discontinued.`;
    }
  }
  return { discontinue: reason !== "", reason, setUnits };
}
