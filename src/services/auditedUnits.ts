// serverside/src/services/auditedUnits.ts — ENG.9
//
// A candidate may take at most two audited units in any year of study. They are shown on the
// transcript but are not part of the curriculum, so they never enter a mean, a weighted average
// or a classification.

import Student from "../models/Student";
import Unit from "../models/Unit";
import ProgramUnit from "../models/ProgramUnit";
import AcademicYear from "../models/AcademicYear";
import AuditedUnit from "../models/AuditedUnit";
import InstitutionSettings from "../models/InstitutionSettings";
import { findStudentByRegNo } from "../utils/regNoQualifier";

export const MAX_AUDITED_PER_YEAR = 2;

export async function addAuditedUnit(args: {
  institution: unknown; regNo: string; unitCode: string; academicYearId: string; yearOfStudy?: number; userId?: unknown;
}) {
  const student: any = await findStudentByRegNo(Student, args.regNo, args.institution, "_id program currentYearOfStudy regNo");
  if (!student) throw new Error(`Student ${args.regNo} not found`);
  const year: any = await AcademicYear.findOne({ _id: args.academicYearId, institution: args.institution }).select("year").lean();
  if (!year) throw new Error("Academic year not found");
  const unit: any = await Unit.findOne({ institution: args.institution, code: String(args.unitCode).trim().toUpperCase() }).lean();
  if (!unit) throw new Error(`Unit ${args.unitCode} not found`);

  if (await ProgramUnit.exists({ program: student.program, unit: unit._id }))
    throw new Error(`${unit.code} is part of ${student.regNo}'s curriculum, so it cannot be audited.`);

  const yearOfStudy = args.yearOfStudy ?? student.currentYearOfStudy ?? 1;
  const sameYear = await AuditedUnit.countDocuments({ student: student._id, yearOfStudy });
  if (sameYear >= MAX_AUDITED_PER_YEAR)
    throw new Error(`ENG.9: a student may audit at most ${MAX_AUDITED_PER_YEAR} units in a year of study (already ${sameYear} in year ${yearOfStudy}).`);

  try {
    return await AuditedUnit.create({
      institution: args.institution, student: student._id, unit: unit._id,
      academicYear: args.academicYearId, yearOfStudy, recordedBy: args.userId,
    });
  } catch (e: any) {
    if (e?.code === 11000) throw new Error(`${unit.code} is already recorded as audited for ${student.regNo} in ${year.year}.`);
    throw e;
  }
}

export async function setAuditedResult(args: { institution: unknown; id: string; mark: number | null }) {
  const doc: any = await AuditedUnit.findOne({ _id: args.id, institution: args.institution });
  if (!doc) throw new Error("Audited unit not found");
  if (args.mark === null) { doc.mark = null; doc.grade = undefined; }
  else {
    if (!Number.isFinite(args.mark) || args.mark < 0 || args.mark > 100) throw new Error("Mark must be 0-100.");
    const settings: any = await InstitutionSettings.findOne({ institution: args.institution }).lean();
    const scale = [...(settings?.gradingScale || [])].sort((a: any, b: any) => b.min - a.min);
    doc.mark = args.mark;
    doc.grade = scale.find((s: any) => args.mark! >= s.min)?.grade ?? (args.mark >= 40 ? "D" : "E");
  }
  await doc.save();
  return doc;
}

export async function listAuditedUnits(studentId: unknown) {
  const rows: any[] = await AuditedUnit.find({ student: studentId })
    .populate("unit", "code name").populate("academicYear", "year").sort({ yearOfStudy: 1 }).lean();
  return rows.map((r) => ({
    _id: String(r._id), unitCode: r.unit?.code, unitName: r.unit?.name, academicYear: r.academicYear?.year,
    yearOfStudy: r.yearOfStudy, mark: r.mark ?? null, grade: r.grade ?? null,
    note: "Audited — not counted towards classification (ENG.9)",
  }));
}

export async function removeAuditedUnit(institution: unknown, id: string) {
  const r = await AuditedUnit.deleteOne({ _id: id, institution });
  if (r.deletedCount === 0) throw new Error("Audited unit not found");
}