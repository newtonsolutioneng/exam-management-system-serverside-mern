// serverside/src/services/attachments.ts — ENG.8(d)-(f), 12, 24(b),(c)

import Student from "../models/Student";
import Program from "../models/Program";
import AttachmentRecord from "../models/AttachmentRecord";
import InstitutionSettings from "../models/InstitutionSettings";
import { findStudentByRegNo } from "../utils/regNoQualifier";

export interface Requirement { kind: "attachment" | "practicum"; yearOfStudy: number; minWeeks: number; label: string }

/**
 * Requirements per degree type.
 *  B.Sc (Engineering): attachment in years 2, 3 and 4, at least 8 weeks each (ENG.8(d)).
 *  B.Ed (Technology): attachment in years 2 and 4 (8 weeks), teaching practicum in year 3 (12 weeks) (ENG.8(e),(f)).
 * Other degree types have none.
 */
export function requirementsFor(degreeType: string): Requirement[] {
  const att = (y: number): Requirement => ({ kind: "attachment", yearOfStudy: y, minWeeks: 8, label: `Practical attachment, year ${y} (min 8 weeks)` });
  if (degreeType === "BEd") return [att(2), { kind: "practicum", yearOfStudy: 3, minWeeks: 12, label: "Teaching practicum, year 3 (min 12 weeks)" }, att(4)];
  if (["BSc", "BEng", "BTech"].includes(degreeType)) return [att(2), att(3), att(4)];
  return [];
}

export async function attachmentsEnforced(institution: unknown): Promise<boolean> {
  const s: any = await InstitutionSettings.findOne({ institution }).select("ruleSet").lean();
  return s?.ruleSet?.enforceAttachments === true;
}

/** Requirements the student has not passed yet (empty when attachments are not enforced). */
export async function outstandingAttachments(studentId: unknown): Promise<string[]> {
  const student: any = await Student.findById(studentId).select("institution program").lean();
  if (!student) return [];
  if (!(await attachmentsEnforced(student.institution))) return [];
  const program: any = await Program.findById(student.program).select("degreeType").lean();
  const reqs = requirementsFor(program?.degreeType ?? "");
  if (reqs.length === 0) return [];
  const done: any[] = await AttachmentRecord.find({ student: studentId, status: "passed" }).lean();
  return reqs
    .filter((r) => !done.some((d) => d.kind === r.kind && d.yearOfStudy === r.yearOfStudy && d.weeks >= r.minWeeks))
    .map((r) => r.label);
}

export async function recordAttachment(args: {
  institution: unknown; regNo: string; kind: "attachment" | "practicum"; yearOfStudy: number;
  weeks: number; status: "pending" | "passed" | "failed"; userId?: unknown;
}) {
  const student: any = await findStudentByRegNo(Student, args.regNo, args.institution, "_id program regNo");
  if (!student) throw new Error(`Student ${args.regNo} not found`);
  const program: any = await Program.findById(student.program).select("degreeType").lean();
  const req = requirementsFor(program?.degreeType ?? "").find((r) => r.kind === args.kind && r.yearOfStudy === args.yearOfStudy);
  if (!req) throw new Error(`A ${args.kind} in year ${args.yearOfStudy} is not required for this programme.`);
  if (!Number.isFinite(args.weeks) || args.weeks < 0) throw new Error("Weeks must be a positive number.");
  if (args.status === "passed" && args.weeks < req.minWeeks)
    throw new Error(`A ${args.kind} must last at least ${req.minWeeks} weeks to be passed (recorded ${args.weeks}).`);
  return AttachmentRecord.findOneAndUpdate(
    { student: student._id, kind: args.kind, yearOfStudy: args.yearOfStudy },
    { $set: { institution: args.institution, weeks: args.weeks, status: args.status, recordedBy: args.userId, recordedAt: new Date() } },
    { upsert: true, new: true },
  );
}

export async function attachmentStatus(institution: unknown, regNo: string) {
  const student: any = await findStudentByRegNo(Student, regNo, institution, "_id program regNo name");
  if (!student) throw new Error(`Student ${regNo} not found`);
  const program: any = await Program.findById(student.program).select("degreeType").lean();
  const reqs = requirementsFor(program?.degreeType ?? "");
  const recs: any[] = await AttachmentRecord.find({ student: student._id }).lean();
  return {
    regNo: student.regNo, name: student.name, enforced: await attachmentsEnforced(institution),
    requirements: reqs.map((r) => {
      const rec = recs.find((x) => x.kind === r.kind && x.yearOfStudy === r.yearOfStudy);
      return { ...r, weeks: rec?.weeks ?? null, status: (rec?.status ?? "not recorded") as string };
    }),
  };
}