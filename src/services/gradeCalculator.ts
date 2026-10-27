// serverside/src/services/gradeCalculator.ts

import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import FinalGrade from "../models/FinalGrade";
import Student from "../models/Student";
import InstitutionSettings from "../models/InstitutionSettings";
import { calculateFinalResult } from "../utils/gradingCore";
import mongoose from "mongoose";
import { recordAttempt } from "./attemptRegistry";
import type { AuthenticatedRequest } from "../middleware/auth";

interface ComputeOptions {
  markId:          mongoose.Types.ObjectId;
  coordinatorReq?: AuthenticatedRequest;
  session?:        mongoose.ClientSession;
}

export async function computeFinalGrade({ markId, session }: ComputeOptions) {
  // ── 1. Resolve mark document ──────────────────────────────────────────────
  let markDoc: any = await Mark
    .findById(markId).populate(["student","academicYear","programUnit"]).session(session || null);

  let isDirect = false;
  if (!markDoc) {
    markDoc  = await MarkDirect
      .findById(markId).populate(["student","academicYear","programUnit"]).session(session || null);
    isDirect = true;
  }
  if (!markDoc) throw new Error("Mark not found");

  const settings = await InstitutionSettings.findOne({ institution: markDoc.institution }).session(session || null);
  if (!settings) throw new Error("Institution settings not found");

  // ── Extract values from nested ruleSet ───────────────────────────────────
  const ruleSet = settings.ruleSet || {};
  const catMax = ruleSet.catMax || 20;
  const assignmentMax = ruleSet.assignmentMax || 10;
  const practicalMax = ruleSet.practicalMax || 10;
  const passMark = ruleSet.passMark || 40;
  const hasLab = ruleSet.hasLab ?? true;
  const hasPractical = ruleSet.hasPractical ?? true;
  const hasWorkshop = ruleSet.hasWorkshop ?? false;

  // Determine unit type from mark document
  let unitType: "theory" | "lab" | "workshop" = "theory";
  if (markDoc.unitType) {
    unitType = markDoc.unitType;
  } else if (hasWorkshop) {
    unitType = "workshop";
  } else if (hasLab) {
    unitType = "lab";
  }

  // ── 2. Raw calculation ────────────────────────────────────────────────────
  const result = calculateFinalResult({
    cat1: markDoc.cat1Raw || 0, cat2: markDoc.cat2Raw || 0, cat3: markDoc.cat3Raw || 0,
    ass1: markDoc.assgnt1Raw || 0, ass2: markDoc.assgnt2Raw || 0, ass3: markDoc.assgnt3Raw || 0,
    practical: markDoc.practicalRaw || 0,
    examQ1: markDoc.examQ1Raw || 0, examQ2: markDoc.examQ2Raw || 0,
    examQ3: markDoc.examQ3Raw || 0, examQ4: markDoc.examQ4Raw || 0, examQ5: markDoc.examQ5Raw || 0,
    unitType: unitType,
    examMode: (markDoc.examMode as any) || "standard",
    attempt:  markDoc.attempt || "1st",
    caMax:    markDoc.caMax,
    examMax:  markDoc.examMax,
    settings: {
      catMax: catMax,
      assMax: assignmentMax,
      practicalMax: practicalMax,
      passMark: passMark,
    },
  });

  // ── 3. Preservation strategy ──────────────────────────────────────────────
  // ENG.13(f): a supplementary mark excludes CA and is capped at the pass mark (40%).
  const isSuppAttempt = markDoc.attempt === "supplementary";
  // ENG.13(e): a wholly-coursework unit is supplemented by extra coursework (capped at the pass mark).
  const caOnlyUnit = markDoc.examMax === 0;
  const preservedCA = result.caTotal === 0 && markDoc.caTotal30 > 0 ? markDoc.caTotal30 : result.caTotal;
  const finalCA    = isSuppAttempt ? (caOnlyUnit ? Math.min(passMark, preservedCA) : 0) : preservedCA;
  const rawFinalExam = result.examTotal === 0 && markDoc.examTotal70 > 0 ? markDoc.examTotal70 : result.examTotal;
  const finalExam  = isSuppAttempt ? Math.min(passMark, rawFinalExam) : rawFinalExam;
  const finalAgreed = finalCA + finalExam;

  // ── 4. Special exam override (ENG.18) ─────────────────────────────────────
  const isSpecial = markDoc.isSpecial === true || markDoc.attempt === "special";
  let grade: string;
  let status: string;
  let attemptType: string;

  // Get grading scale
  const gradingScale = settings.gradingScale || [
    { min: 70, max: 100, grade: "A", label: "Excellent" },
    { min: 60, max: 69,  grade: "B", label: "Good" },
    { min: 50, max: 59,  grade: "C", label: "Satisfactory" },
    { min: 40, max: 49,  grade: "D", label: "Pass" },
    { min: 0,  max: 39,  grade: "E", label: "Fail" },
  ];
  
  const sortedScale = [...gradingScale].sort((a, b) => b.min - a.min);

  if (isSpecial && finalExam === 0) {
    // Special approved but exam NOT yet sat — keep as pending special
    grade       = "I";
    status      = "SPECIAL";
    attemptType = "SPECIAL";
  } else if (isSpecial && finalExam > 0) {
    // Special exam has been COMPLETED — grade it like a normal exam
    grade       = sortedScale.find((s) => finalAgreed >= s.min)?.grade ?? "E";
    status      = finalAgreed >= passMark ? "PASS" : "SUPPLEMENTARY";
    attemptType = "1ST_ATTEMPT";
  } else {
    // Normal (non-special) exam
    grade       = sortedScale.find((s) => finalAgreed >= s.min)?.grade ?? "E";
    status      = finalAgreed >= passMark ? "PASS" : "SUPPLEMENTARY";
    attemptType = markDoc.attempt === "supplementary" ? "SUPPLEMENTARY"
                : markDoc.attempt === "re-take"        ? "RETAKE"
                : "1ST_ATTEMPT";
  }

  // ── 4b. Practical pass (ENG.10(d)) ────────────────────────────────────────
  // Optional (settings.ruleSet.enforcePracticalPass). Applies to lab/workshop units on
  // detailed sheets where a practical mark was actually recorded; a supplementary sitting
  // does not re-assess the practical, so the earlier verdict is kept.
  let practicalFailed = markDoc.practicalFailed === true;
  if (ruleSet.enforcePracticalPass === true && !isDirect && !isSuppAttempt
      && (unitType === "lab" || unitType === "workshop")
      && markDoc.practicalRaw !== undefined && markDoc.practicalRaw !== null && practicalMax > 0) {
    practicalFailed = (markDoc.practicalRaw / practicalMax) * 100 < passMark;
  }
  if (ruleSet.enforcePracticalPass === true && practicalFailed && status === "PASS") {
    status = "SUPPLEMENTARY";
    grade  = "E";
  }

  // ── 5. Update source mark ─────────────────────────────────────────────────
  const markUpdate = {
    $set: {
      ...(isDirect ? {} : { practicalFailed }),
      caTotal30:   finalCA,
      examTotal70: (isSpecial && finalExam === 0) ? 0 : finalExam,
      agreedMark:  (isSpecial && finalExam === 0) ? finalCA : finalAgreed,
    },
  };
  if (isDirect) await MarkDirect.updateOne({ _id: markId }, markUpdate).session(session || null);
  else          await Mark.updateOne({ _id: markId }, markUpdate).session(session || null);

  // ── 5b. Attempt tracking (ENG.16(b), ENG.22(b)) ───────────────────────────
  // A pending special (exam not yet sat) is not an attempt.
  let attemptNumber = 1;
  if (!(isSpecial && finalExam === 0)) {
    try {
      const unitRef: any = markDoc.programUnit;
      let unitId: any = unitRef?.unit;
      if (!unitId && unitRef?._id) {
        const pu: any = await mongoose.model("ProgramUnit").findById(unitRef._id).select("unit").lean();
        unitId = pu?.unit;
      }
      const ay: any = markDoc.academicYear;
      const rec = await recordAttempt({
        studentId:    markDoc.student._id || markDoc.student,
        unitId:       unitId || (unitRef?._id ?? unitRef),
        academicYear: String(ay?.year ?? ay?._id ?? ay),
        type:         attemptType === "SPECIAL" ? "1ST_ATTEMPT" : attemptType,
        mark:         finalAgreed,
        passed:       status === "PASS",
        session,
      });
      attemptNumber = rec.attemptNumber;
    } catch (err) {
      console.error("[gradeCalculator] attempt registry:", (err as Error).message);
    }
  }

  // ── 6. Upsert FinalGrade ──────────────────────────────────────────────────
  await FinalGrade.findOneAndUpdate(
    {
      student:      markDoc.student._id     || markDoc.student,
      programUnit:  markDoc.programUnit._id  || markDoc.programUnit,
      academicYear: markDoc.academicYear._id || markDoc.academicYear,
    },
    {
      $set: {
        totalMark:    (isSpecial && finalExam === 0) ? finalCA : finalAgreed,
        grade,
        caTotal30:    finalCA,
        examTotal70:  (isSpecial && finalExam === 0) ? 0 : finalExam,
        status,
        isSpecial:    isSpecial && finalExam === 0,
        attemptType,
        attemptNumber,
        institution:  markDoc.institution,
        semester:     markDoc.semester || "SEMESTER 1",
      },
    },
    { upsert: true, session },
  );

  // ── 7. Carry-forward resolution (ENG.14) ──────────────────────────────────
  if (status === "PASS") {
    _resolveCFUnit(
      (markDoc.student._id    || markDoc.student).toString(),
      (markDoc.programUnit._id || markDoc.programUnit).toString(),
    ).catch((err: Error) => console.error("[gradeCalculator] CF resolution:", err.message));
  }

  return {
    caTotal:   finalCA,
    examTotal: (isSpecial && finalExam === 0) ? 0 : finalExam,
    finalMark: (isSpecial && finalExam === 0) ? finalCA : finalAgreed,
    grade,
    status,
  };
}

async function _resolveCFUnit(studentId: string, programUnitId: string): Promise<void> {
  const studentDoc = await Student.findById(studentId)
    .select("carryForwardUnits qualifierSuffix").lean() as any;
  if (!studentDoc) return;

  const hasCF = ((studentDoc.carryForwardUnits || []) as any[]).some(
    (u: any) => u.programUnitId === programUnitId,
  );
  if (!hasCF) return;

  await Student.findByIdAndUpdate(studentId, { $pull: { carryForwardUnits: { programUnitId } } });

  const refreshed = await Student.findById(studentId).select("carryForwardUnits").lean() as any;
  if (((refreshed?.carryForwardUnits || []) as any[]).length === 0) {
    await Student.findByIdAndUpdate(studentId, { $set: { qualifierSuffix: "" } });
  }
}