
// serverside/src/services/carryForwardService.ts
import mongoose from "mongoose";
import Student from "../models/Student";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import FinalGrade from "../models/FinalGrade";
import ProgramUnit from "../models/ProgramUnit";
import InstitutionSettings from "../models/InstitutionSettings";
import type { CarryForwardUnit } from "./carryForwardTypes";
import { REG_QUALIFIERS, assessCarryForwardEligibility } from "../utils/academicRules";

export interface CarryForwardResult {
  granted:   boolean;
  cfUnits:   CarryForwardUnit[];
  qualifier: string;
  reason:    string;
}

// ─── assessAndGrantCarryForward ───────────────────────────────────────────────
// Called from promoteStudent after supplementary results are finalized.
// Determines carry-forward eligibility per ENG.14 and persists to student record.

export const assessAndGrantCarryForward = async (
  studentId:        string,
  programId:        string,
  yearOfStudy:      number,
  academicYearName: string,
): Promise<CarryForwardResult> => {
  const student = await Student.findById(studentId).lean();
  if (!student) throw new Error("Student not found");

  const settings = await InstitutionSettings.findOne({ institution: (student as any).institution }).lean();
  const passMark = (settings as any)?.passMark ?? 40;

  // ENG.14(a): B.Sc may carry forward into years 2, 3 and 4 (never into the final year).
  // ENG.14(b): B.Ed (Technology) may carry forward into years 2 and 3 only,
  //            i.e. never into year 4 even though that is not the last year of a 5-year programme.
  const programDoc = await mongoose.model("Program").findById(programId).lean() as any;
  const finalYear  = programDoc?.durationYears || 5;
  const isBEd      = programDoc?.degreeType === "BEd";
  const lastCfFromYear = isBEd ? Math.min(2, finalYear - 1) : finalYear - 1;
  if (yearOfStudy > lastCfFromYear) {
    return {
      granted: false, cfUnits: [], qualifier: "",
      reason: isBEd
        ? `ENG.14(b): B.Ed carry-forward is allowed into years 2 and 3 only (not into Year ${yearOfStudy + 1}).`
        : `ENG.14(a): No carry-forward into the final year (Year ${finalYear}).`,
    };
  }

  const programUnits = await ProgramUnit.find({ program: programId, requiredYear: yearOfStudy })
    .populate("unit").lean() as any[];

  const totalUnits = programUnits.length;
  const puIds      = programUnits.map((pu: any) => pu._id);

  const [detailedMarks, directMarks] = await Promise.all([
    Mark.find({ student: studentId, programUnit: { $in: puIds } }).lean(),
    MarkDirect.find({ student: studentId, programUnit: { $in: puIds } }).lean(),
  ]);

  const markMap = new Map<string, any>();
  [...detailedMarks, ...directMarks].forEach((m: any) => markMap.set(m.programUnit.toString(), m));

  const failedUnitCodes: string[]    = [];
  const noCAUnitCodes:   string[]    = [];
  const failedDetails:   Array<{ programUnitId: string; unitCode: string; unitName: string }> = [];

  for (const pu of programUnits) {
    const puId = (pu as any)._id.toString();
    const m    = markMap.get(puId);
    if (!m) continue;
    if ((m as any).isSpecial || (m as any).attempt === "special") continue;

    const mark  = (m as any).agreedMark ?? 0;
    // A supplementary mark carries no coursework by design (ENG.13f); only a first-sitting row can lack CA.
    const hasCA = ((m as any).caTotal30 ?? 0) > 0 || (m as any).attempt === "supplementary";

    if (mark < passMark || ((settings as any)?.ruleSet?.enforcePracticalPass === true && (m as any).practicalFailed === true)) {
      const code = (pu as any).unit?.code || "N/A";
      failedUnitCodes.push(code);
      if (!hasCA) noCAUnitCodes.push(code); // ENG.15a: missing CA → cannot CF
      failedDetails.push({ programUnitId: puId, unitCode: code, unitName: (pu as any).unit?.name || "N/A" });
    }
  }

  const eligibility = assessCarryForwardEligibility(failedUnitCodes, noCAUnitCodes, totalUnits);
  if (!eligibility.eligible) return { granted: false, cfUnits: [], qualifier: "", reason: eligibility.reason };

  // Determine CF cycle number from existing qualifierSuffix
  const priorQualifier = (student as any).qualifierSuffix || "";
  const priorMatch     = priorQualifier.match(/RP(\d+)C/);
  const cfNumber       = priorMatch ? Math.min(parseInt(priorMatch[1]) + 1, 3) : 1;
  const qualifier      = REG_QUALIFIERS.carryForward(cfNumber);

  const cfUnits: CarryForwardUnit[] = eligibility.units.map((code: string) => {
    const detail = failedDetails.find((d) => d.unitCode === code);
    return {
      programUnitId:    detail?.programUnitId || "",
      unitCode:         code,
      unitName:         detail?.unitName || "N/A",
      fromYear:         yearOfStudy,
      fromAcademicYear: academicYearName,
      attemptNumber:    cfNumber + 2,
      qualifier,
      addedAt:          new Date(),
      status:           "pending" as const,
    };
  });

  await Student.findByIdAndUpdate(studentId, {
    $push: { carryForwardUnits: { $each: cfUnits } },
    $set:  { qualifierSuffix: qualifier },
  });

  return {
    granted:   true,
    cfUnits,
    qualifier,
    reason:    `ENG.14: Carry forward granted — ${cfUnits.length} unit(s): ${cfUnits.map((u) => u.unitCode).join(", ")}`,
  };
};

// ─── clearCarryForwardUnit ────────────────────────────────────────────────────
// Called from gradeCalculator when a CF unit is graded PASS.

export const clearCarryForwardUnit = async (
  studentId:     string,
  programUnitId: string,
): Promise<void> => {
  await Student.findByIdAndUpdate(studentId, {
    $pull: { carryForwardUnits: { programUnitId } },
  });

  const updated   = await Student.findById(studentId).select("carryForwardUnits").lean();
  const remaining = ((updated as any)?.carryForwardUnits || []).length;

  if (remaining === 0) {
    await Student.findByIdAndUpdate(studentId, { $set: { qualifierSuffix: "" } });
  }
};

// ─── getCarryForwardStudentsForUnit ──────────────────────────────────────────
// Used by scoresheetStudentList to include CF students on ORDINARY scoresheets.

export const getCarryForwardStudentsForUnit = async (
  programUnitId: string,
  programId:     string,
): Promise<Array<{ student: any; cfUnit: CarryForwardUnit; attemptLabel: string }>> => {
  const students = await Student.find({
    program:                              programId,
    "carryForwardUnits.programUnitId":    programUnitId,
    "carryForwardUnits.status":           "pending",
  }).lean() as any[];

  return students
    .map((student: any) => {
      const cfUnit = (student.carryForwardUnits as CarryForwardUnit[]).find(
        (u) => u.programUnitId === programUnitId && u.status === "pending",
      );
      if (!cfUnit) return null;
      return { student, cfUnit, attemptLabel: cfUnit.qualifier || "RP1C" };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
};

// ─── getStayoutStudentsForUnit ────────────────────────────────────────────────
// ENG.15h: Stayout students retake in ORDINARY of NEXT year.

export const getStayoutStudentsForUnit = async (
  programUnitId: string,
  programId:     string,
): Promise<Array<{ student: any; attemptLabel: string }>> => {
  const pu = await ProgramUnit.findById(programUnitId).lean() as any;
  if (!pu) return [];

  const expectedYear = (pu.requiredYear || 1) + 1;

  const failedGrades = await FinalGrade.find({
    programUnit: programUnitId,
    status:      { $ne: "PASS" },
    attemptType: { $in: ["1ST_ATTEMPT", "SUPPLEMENTARY"] },
  }).populate("student").lean() as any[];

  const result: Array<{ student: any; attemptLabel: string }> = [];

  for (const grade of failedGrades) {
    const student = grade.student as any;
    if (!student)                                              continue;
    if (student.program?.toString() !== programId)             continue;
    if (student.currentYearOfStudy  !== expectedYear)          continue;
    if (student.status              !== "active")              continue;
    if ((student.qualifierSuffix || "").includes("C"))         continue; // CF students handled separately

    result.push({ student, attemptLabel: "A/SO" });
  }

  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// deferSuppToNextOrdinary
// Called by the coordinator route POST /student/defer-supp.
// Marks specific failed/special units as deferred to the next ordinary period.
// Allows the student to be promoted despite pending units (ENG.13b / ENG.18c).
// ─────────────────────────────────────────────────────────────────────────────
 
export const deferSuppToNextOrdinary = async (
  studentId:      string,
  programUnitIds: string[],
  academicYear:   string,
  reason:         "supp_deferred" | "special_deferred",
): Promise<void> => {
  const student = await Student.findById(studentId).lean() as any;
  if (!student) throw new Error("Student not found");
 
  const programUnits = await ProgramUnit.find({
    _id: { $in: programUnitIds },
  }).populate("unit").lean() as any[];
 
  const entries = programUnits.map((pu: any) => ({
    programUnitId:    pu._id.toString(),
    unitCode:         pu.unit?.code  || "N/A",
    unitName:         pu.unit?.name  || "N/A",
    fromYear:         student.currentYearOfStudy,
    fromAcademicYear: academicYear,
    reason,
    addedAt:          new Date(),
    status:           "pending" as const,
  }));
 
  // Remove any existing pending deferred entries for these units first
  await Student.findByIdAndUpdate(studentId, {
    $pull: { deferredSuppUnits: { programUnitId: { $in: programUnitIds } } },
  });
 
  // Add the new deferred entries
  await Student.findByIdAndUpdate(studentId, {
    $push: {
      deferredSuppUnits: { $each: entries } ,
      statusEvents: {
        fromStatus:  student.status,
        toStatus:    student.status,
        date:        new Date(),
        academicYear,
        reason:      `ENG.13b/ENG.18c: Deferred ${reason.replace("_", " ")} for units: ${entries.map(e => e.unitCode).join(", ")}`,
      },
    },
  });
};
 
// ─────────────────────────────────────────────────────────────────────────────
// getDeferredSuppStudentsForUnit
// Returns students who deferred their supp/special for this specific unit
// to the next ordinary period. Called by scoresheetStudentList.
// ─────────────────────────────────────────────────────────────────────────────
 
export const getDeferredSuppStudentsForUnit = async (
  programUnitId: string,
  programId:     string,
): Promise<Array<{
  student:      any;
  attemptLabel: string;
  isSupp:       boolean;
  isSpecial:    boolean;
}>> => {
  const students = await Student.find({
    program:                           programId,
    "deferredSuppUnits.programUnitId": programUnitId,
    "deferredSuppUnits.status":        "pending",
  }).lean() as any[];
 
  return students
    .map((student: any) => {
      const entry = (student.deferredSuppUnits || []).find(
        (u: any) => u.programUnitId === programUnitId && u.status === "pending",
      );
      if (!entry) return null;
 
      const isSpecial = entry.reason === "special_deferred";
      return {
        student,
        attemptLabel: isSpecial ? "Special" : "Supp",
        isSupp:       !isSpecial,
        isSpecial,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
};
 
// ─────────────────────────────────────────────────────────────────────────────
// clearDeferredSuppUnit
// Called from gradeCalculator when a deferred unit is graded PASS.
// ─────────────────────────────────────────────────────────────────────────────
 
export const clearDeferredSuppUnit = async (
  studentId:     string,
  programUnitId: string,
): Promise<void> => {
  await Student.findByIdAndUpdate(
    studentId,
    { $set: { "deferredSuppUnits.$[elem].status": "passed" } },
    { arrayFilters: [{ "elem.programUnitId": programUnitId, "elem.status": "pending" }] },
  );
};
