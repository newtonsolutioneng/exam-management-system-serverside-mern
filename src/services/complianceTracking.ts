// serverside/src/services/complianceTracking.ts
//
// Registration and coursework tracking behind ENG.23(a), (b), (d), plus transfer students.
// Everything here only REPORTS unless applyDeregistration() is called explicitly.

import mongoose from "mongoose";
import Student from "../models/Student";
import AcademicYear from "../models/AcademicYear";
import InstitutionSettings from "../models/InstitutionSettings";
import SemesterRegistration from "../models/SemesterRegistration";
import CourseworkRecord from "../models/CourseworkRecord";
import ProgramUnit from "../models/ProgramUnit";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import { REG_QUALIFIERS } from "../utils/academicRules";

export type Sem = 1 | 2 | 3;
export type DeregRule = "registration" | "retake" | "coursework" | "specials";

/** Student statuses that are expected to register / do coursework. */
const IN_SESSION = ["active", "repeat"];

export interface Flagged {
  studentId: string;
  regNo:     string;
  name:      string;
  detail:    string;
}

// ── Transfer students ─────────────────────────────────────────────────────────

export const TRANSFER_RE = /^TF([23])(S2)?$/;

/** TF2 / TF3 / TF2S2 / TF3S2 → structured transfer record (undefined for anything else). */
export function transferFromQualifier(q: string): { entryYear: 2 | 3; secondSemester: boolean; recordedAt: Date } | undefined {
  const m = TRANSFER_RE.exec((q || "").toUpperCase());
  if (!m) return undefined;
  return { entryYear: Number(m[1]) as 2 | 3, secondSemester: !!m[2], recordedAt: new Date() };
}

export async function markAsTransfer(args: {
  studentId: string; institution: unknown; entryYear: number; secondSemester: boolean; fromInstitution?: string;
}) {
  if (args.entryYear !== 2 && args.entryYear !== 3)
    throw new Error("Transfer students enter in year 2 or 3 (qualifiers TF2 / TF3).");
  const qualifier = REG_QUALIFIERS.transfer(args.entryYear as 2 | 3, args.secondSemester);
  const entryType = args.entryYear === 2 ? "Mid-Entry-Y2" : "Mid-Entry-Y3";
  const student = await Student.findOneAndUpdate(
    { _id: args.studentId, institution: args.institution },
    {
      $set: {
        qualifierSuffix: qualifier,
        entryType,
        transfer: {
          fromInstitution: args.fromInstitution, entryYear: args.entryYear,
          secondSemester: args.secondSemester, recordedAt: new Date(),
        },
      },
      $push: { statusEvents: {
        fromStatus: "active", toStatus: "active", date: new Date(), academicYear: "",
        reason: `Recorded as transfer student (${qualifier})${args.fromInstitution ? ` from ${args.fromInstitution}` : ""}`,
      } },
    },
    { new: true },
  );
  if (!student) throw new Error("Student not found");
  return student;
}

// ── Deadlines ─────────────────────────────────────────────────────────────────

async function loadYear(institution: unknown, academicYear: string) {
  const year: any = await AcademicYear.findOne({ _id: academicYear, institution }).lean();
  if (!year) throw new Error("Academic year not found");
  return year;
}

async function deadlineFor(institution: unknown, year: any, semester: Sem) {
  const settings: any = await InstitutionSettings.findOne({ institution }).lean();
  const weeks: number = settings?.ruleSet?.registrationDeadlineWeeks ?? 4;
  const start = (year.semesterStarts || []).find((s: any) => s.semester === semester)?.startDate;
  if (!start) throw new Error(`Semester ${semester} start date is not set for ${year.year}. Set it first.`);
  const deadline = new Date(new Date(start).getTime() + weeks * 7 * 24 * 3600 * 1000);
  return { start: new Date(start), deadline, weeks, settings };
}

/** A student admitted in a later semester of this year is not yet expected in an earlier one. */
function notYetAdmitted(student: any, year: any, semester: Sem): boolean {
  if (String(student.admissionAcademicYear) !== String(year._id)) return false;
  const sem = (year.intakeSemesters || []).find((m: any) => m.intake === student.intake)?.semester;
  return !!sem && sem > semester;
}

// ── Registration (ENG.23(a), (d)) ─────────────────────────────────────────────

/** Students required to retake units: stay-out, pending carry-forward or deferred supp/special units. */
function retakeRequired(student: any): boolean {
  const pendingCf = (student.carryForwardUnits || []).some((u: any) => u.status === "pending");
  const pendingDeferred = (student.deferredSuppUnits || []).some((u: any) => u.status === "pending");
  const stayout = (student.statusEvents || []).some((e: any) => typeof e?.reason === "string" && e.reason.startsWith("ENG.15h"));
  return pendingCf || pendingDeferred || stayout;
}

export async function recordRegistrations(args: {
  institution: unknown; academicYear: string; semester: Sem; kind: "semester" | "retake";
  studentIds: string[]; recordedBy?: unknown;
}): Promise<{ recorded: number }> {
  if (args.studentIds.length === 0) return { recorded: 0 };
  const owned = await Student.find({ _id: { $in: args.studentIds }, institution: args.institution }).select("_id").lean();
  const ops = owned.map((s: any) => ({
    updateOne: {
      filter: { student: s._id, academicYear: args.academicYear, semester: args.semester, kind: args.kind },
      update: { $setOnInsert: {
        institution: args.institution, student: s._id, academicYear: args.academicYear,
        semester: args.semester, kind: args.kind, registeredAt: new Date(), recordedBy: args.recordedBy,
      } },
      upsert: true,
    },
  }));
  if (ops.length) await SemesterRegistration.bulkWrite(ops as any);
  return { recorded: ops.length };
}

export async function findOverdueRegistrations(args: {
  institution: unknown; academicYear: string; semester: Sem; kind: "semester" | "retake"; now?: Date;
}): Promise<{ deadline: Date; pastDeadline: boolean; flagged: Flagged[] }> {
  const year = await loadYear(args.institution, args.academicYear);
  const { deadline, weeks } = await deadlineFor(args.institution, year, args.semester);
  const now = args.now ?? new Date();

  const students: any[] = await Student.find({ institution: args.institution, status: { $in: IN_SESSION } })
    .select("regNo name status intake admissionAcademicYear carryForwardUnits deferredSuppUnits statusEvents qualifierSuffix").lean();
  const registered = new Set((await SemesterRegistration.find({
    institution: args.institution, academicYear: args.academicYear, semester: args.semester, kind: args.kind,
  }).select("student").lean()).map((r: any) => String(r.student)));

  const flagged: Flagged[] = [];
  for (const s of students) {
    if (registered.has(String(s._id))) continue;
    if (args.kind === "retake" && !retakeRequired(s)) continue;
    if (args.kind === "semester" && notYetAdmitted(s, year, args.semester)) continue;
    flagged.push({
      studentId: String(s._id), regNo: s.regNo, name: s.name,
      detail: `No ${args.kind} registration for semester ${args.semester} by ${deadline.toDateString()} (week ${weeks}).`,
    });
  }
  return { deadline, pastDeadline: now > deadline, flagged };
}

// ── Coursework (ENG.23(b)) ────────────────────────────────────────────────────

export async function recordCoursework(args: {
  institution: unknown; academicYear: string; semester: Sem;
  rows: Array<{ studentId: string; programUnitId: string; percent: number }>;
}): Promise<{ saved: number }> {
  const ops = args.rows.map((r) => ({
    updateOne: {
      filter: { student: r.studentId, programUnit: r.programUnitId, academicYear: args.academicYear, semester: args.semester },
      update: { $set: { institution: args.institution, completedPercent: r.percent } },
      upsert: true,
    },
  }));
  if (ops.length) await CourseworkRecord.bulkWrite(ops as any);
  return { saved: ops.length };
}

/**
 * Students whose coursework completion, averaged over the units recorded for them,
 * is below the threshold (setting minCourseworkAttendance, default 75%).
 * Only students with at least one record are judged — no data is never treated as 0%.
 */
export async function findCourseworkShortfalls(args: {
  institution: unknown; academicYear: string; semester: Sem;
}): Promise<{ thresholdPercent: number; flagged: Flagged[]; studentsWithoutRecords: number }> {
  const settings: any = await InstitutionSettings.findOne({ institution: args.institution }).lean();
  const thresholdPercent = Math.round((settings?.ruleSet?.minCourseworkAttendance ?? 0.75) * 100);

  const recs: any[] = await CourseworkRecord.find({
    institution: args.institution, academicYear: args.academicYear, semester: args.semester,
  }).lean();
  const byStudent = new Map<string, any[]>();
  for (const r of recs) {
    const k = String(r.student);
    byStudent.set(k, [...(byStudent.get(k) || []), r]);
  }

  const students: any[] = await Student.find({ _id: { $in: [...byStudent.keys()] }, status: { $in: IN_SESSION } })
    .select("regNo name").lean();
  const puIds = [...new Set(recs.map((r) => String(r.programUnit)))];
  const pus: any[] = await ProgramUnit.find({ _id: { $in: puIds } }).populate("unit", "code").lean();
  const codeOf = new Map(pus.map((p) => [String(p._id), p.unit?.code || String(p._id)]));

  const flagged: Flagged[] = [];
  for (const s of students) {
    const list = byStudent.get(String(s._id)) || [];
    const mean = list.reduce((a, r) => a + r.completedPercent, 0) / list.length;
    if (mean < thresholdPercent) {
      const low = list.filter((r) => r.completedPercent < thresholdPercent)
        .map((r) => `${codeOf.get(String(r.programUnit))} ${r.completedPercent}%`).join(", ");
      flagged.push({
        studentId: String(s._id), regNo: s.regNo, name: s.name,
        detail: `Coursework completed ${mean.toFixed(1)}% on average (minimum ${thresholdPercent}%). Units: ${low}.`,
      });
    }
  }
  const allActive = await Student.countDocuments({ institution: args.institution, status: { $in: IN_SESSION } });
  return { thresholdPercent, flagged, studentsWithoutRecords: Math.max(allActive - byStudent.size, 0) };
}

// ── Special examinations (ENG.23(e)) ──────────────────────────────────────────

/**
 * Students with special examinations in the year who sat none of them. Only judged once the
 * year is CLOSED — specials may be sat in the supplementary period or the next ordinary one
 * (ENG.18(c)). "Sat" means an exam score was recorded; failing to do the extra coursework
 * cannot be seen separately, so it is covered by the same check.
 */
export async function findSpecialAbsentees(args: { institution: unknown; academicYear: string }): Promise<{ yearClosed: boolean; flagged: Flagged[] }> {
  const year = await loadYear(args.institution, args.academicYear);
  if (year.session !== "CLOSED") return { yearClosed: false, flagged: [] };

  const filter = { institution: args.institution, academicYear: args.academicYear, isSpecial: true };
  const rows: any[] = [
    ...(await Mark.find(filter).select("student examTotal70 examMax").lean() as any[]),
    ...(await MarkDirect.find(filter).select("student examTotal70 examMax").lean() as any[]),
  ];
  const byStudent = new Map<string, { total: number; sat: number }>();
  for (const r of rows) {
    const k = String(r.student);
    const e = byStudent.get(k) ?? { total: 0, sat: 0 };
    e.total++;
    if ((r.examTotal70 ?? 0) > 0 || r.examMax === 0) e.sat++;
    byStudent.set(k, e);
  }
  const absentIds = [...byStudent.entries()].filter(([, v]) => v.total > 0 && v.sat === 0).map(([k]) => k);
  const students: any[] = await Student.find({ _id: { $in: absentIds }, status: { $in: IN_SESSION } }).select("regNo name").lean();
  return {
    yearClosed: true,
    flagged: students.map((s) => ({
      studentId: String(s._id), regNo: s.regNo, name: s.name,
      detail: `${byStudent.get(String(s._id))!.total} special examination(s) in ${year.year}, none sat.`,
    })),
  };
}

// ── Deregistration ────────────────────────────────────────────────────────────

const RULE_TEXT: Record<DeregRule, string> = {
  registration: "ENG.23(a): not registered by the end of week 4",
  retake:       "ENG.23(d): required to retake but not registered by the end of week 4",
  coursework:   "ENG.23(b): completed less than 75% of coursework",
  specials:     "ENG.23(e): absent from all the special examinations he/she was required to sit",
};

export async function applyDeregistration(args: {
  institution: unknown; rule: DeregRule; academicYear: string; studentIds: string[];
}): Promise<{ deregistered: number }> {
  const year = await loadYear(args.institution, args.academicYear);
  const reason = `${RULE_TEXT[args.rule]} (${year.year})`;
  const students: any[] = await Student.find({
    _id: { $in: args.studentIds }, institution: args.institution, status: { $in: IN_SESSION },
  }).select("status").lean();
  for (const s of students) {
    await Student.findByIdAndUpdate(s._id, {
      $set: { status: "deregistered", remarks: reason },
      $push: {
        statusEvents:  { fromStatus: s.status, toStatus: "deregistered", date: new Date(), academicYear: year.year, reason },
        statusHistory: { status: "deregistered", previousStatus: s.status, date: new Date(), reason },
      },
    });
  }
  return { deregistered: students.length };
}

export const isObjectId = (v: unknown): boolean => typeof v === "string" && mongoose.isValidObjectId(v);