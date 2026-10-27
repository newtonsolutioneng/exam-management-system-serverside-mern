// serverside/src/services/gradeAppeals.ts — ENG.26 (appeals), ENG.27(ii) (release of results), ENG.10(d) manual practical flag

import Student from "../models/Student";
import ProgramUnit from "../models/ProgramUnit";
import AcademicYear from "../models/AcademicYear";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import GradeAppeal from "../models/GradeAppeal";
import InstitutionSettings from "../models/InstitutionSettings";
import { findStudentByRegNo } from "../utils/regNoQualifier";
import { computeFinalGrade } from "./gradeCalculator";

async function resolveUnit(institution: unknown, regNo: string, unitCode: string, academicYearId: string) {
  const student: any = await findStudentByRegNo(Student, regNo, institution, "_id program regNo");
  if (!student) throw new Error(`Student ${regNo} not found`);
  const year: any = await AcademicYear.findOne({ _id: academicYearId, institution }).lean();
  if (!year) throw new Error("Academic year not found");
  const pus: any[] = await ProgramUnit.find({ program: student.program }).populate("unit", "code").lean();
  const pu = pus.find((p) => String(p.unit?.code || "").toUpperCase() === String(unitCode).trim().toUpperCase());
  if (!pu) throw new Error(`Unit ${unitCode} is not in ${student.regNo}'s programme`);
  return { student, year, pu };
}

export async function setResultsReleased(institution: unknown, academicYearId: string, releasedAt: Date | null) {
  const y = await AcademicYear.findOneAndUpdate({ _id: academicYearId, institution }, { $set: { resultsReleasedAt: releasedAt } }, { new: true });
  if (!y) throw new Error("Academic year not found");
  return y;
}

export async function fileAppeal(args: {
  institution: unknown; regNo: string; unitCode: string; academicYearId: string; grounds: string;
  lateReason?: string; userId?: unknown; now?: Date;
}) {
  if (!args.grounds?.trim()) throw new Error("State the grounds of the appeal.");
  const { student, year, pu } = await resolveUnit(args.institution, args.regNo, args.unitCode, args.academicYearId);
  if (!year.resultsReleasedAt) throw new Error("The release date of results is not recorded for this academic year. Record it first (ENG.27).");

  const settings: any = await InstitutionSettings.findOne({ institution: args.institution }).select("ruleSet").lean();
  const days: number = settings?.ruleSet?.gradeAppealWindowDays ?? 28;
  const closes = new Date(new Date(year.resultsReleasedAt).getTime() + days * 24 * 3600 * 1000);
  const late = (args.now ?? new Date()) > closes;
  if (late && !args.lateReason?.trim())
    throw new Error(`The ${days}-day appeal window closed on ${closes.toDateString()} (ENG.26). Give a reason to accept it late.`);

  const mk: any = (await Mark.findOne({ student: student._id, programUnit: pu._id, academicYear: year._id }).lean())
               ?? (await MarkDirect.findOne({ student: student._id, programUnit: pu._id, academicYear: year._id }).lean());
  if (!mk) throw new Error("There is no result recorded for that unit and year.");

  return GradeAppeal.create({
    institution: args.institution, student: student._id, programUnit: pu._id, academicYear: year._id,
    filedBy: args.userId, grounds: args.grounds.trim(), late, lateReason: late ? args.lateReason!.trim() : undefined,
    markAtFiling: mk.agreedMark ?? 0,
  });
}

export async function decideAppeal(args: {
  institution: unknown; id: string; outcome: "upheld" | "dismissed"; newMark?: number | null; note?: string; userId?: unknown;
}) {
  const a: any = await GradeAppeal.findOne({ _id: args.id, institution: args.institution });
  if (!a) throw new Error("Appeal not found");
  if (a.status !== "open") throw new Error("This appeal has already been decided.");
  if (args.outcome === "upheld" && args.newMark != null && (!Number.isFinite(args.newMark) || args.newMark < 0 || args.newMark > 100))
    throw new Error("The new mark must be 0-100.");
  a.status = args.outcome; a.newMark = args.outcome === "upheld" ? (args.newMark ?? null) : null;
  a.note = args.note?.trim(); a.decidedAt = new Date(); a.decidedBy = args.userId;
  await a.save();
  return a;
}

export async function listAppeals(institution: unknown) {
  const rows: any[] = await GradeAppeal.find({ institution })
    .populate("student", "regNo name").populate({ path: "programUnit", populate: { path: "unit", select: "code" } })
    .populate("academicYear", "year").sort({ filedAt: -1 }).limit(200).lean();
  return rows.map((r) => ({
    _id: String(r._id), regNo: r.student?.regNo, name: r.student?.name, unitCode: r.programUnit?.unit?.code,
    academicYear: r.academicYear?.year, filedAt: r.filedAt, grounds: r.grounds, late: r.late, lateReason: r.lateReason ?? null,
    markAtFiling: r.markAtFiling, status: r.status, newMark: r.newMark ?? null, note: r.note ?? null,
  }));
}

/**
 * ENG.10(d), manual form: "attended and passed in the practicals". Direct-mark sheets carry no
 * practical score, so the coordinator records the outcome here. For detailed sheets a recorded
 * practical mark still decides the verdict when the setting is on.
 */
export async function setPracticalResult(args: {
  institution: unknown; regNo: string; unitCode: string; academicYearId: string; passed: boolean;
}) {
  const { student, year, pu } = await resolveUnit(args.institution, args.regNo, args.unitCode, args.academicYearId);
  const key = { student: student._id, programUnit: pu._id, academicYear: year._id };
  const set = { $set: { practicalFailed: !args.passed } };
  let mk: any = await Mark.findOneAndUpdate(key, set, { new: true });
  if (!mk) mk = await MarkDirect.findOneAndUpdate(key, set, { new: true });
  if (!mk) throw new Error("There is no result recorded for that unit and year.");
  await computeFinalGrade({ markId: mk._id as any });
  return { practicalFailed: !args.passed };
}