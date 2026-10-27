// serverside/src/services/nullificationService.ts
//
// ENG.17 — nullification of examination results.
//  (a) a student required to repeat, or discontinued, or deregistered, who promotes himself/herself
//      to the next year: every result of that year of study is nullified;
//  (b) a student who sits an examination without a genuine examination card: that unit's results.
// Nothing is nullified automatically. detectIllegalPromotions() only lists suspects; the coordinator
// reviews and calls nullify(), which is previewable and reversible (liftNullification).

import mongoose from "mongoose";
import Student from "../models/Student";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import FinalGrade from "../models/FinalGrade";
import ProgramUnit from "../models/ProgramUnit";
import AcademicYear from "../models/AcademicYear";
import Nullification from "../models/Nullification";
import { computeFinalGrade } from "./gradeCalculator";

export interface NullifyRequest {
  institution: unknown;
  studentId:   string;
  scope:       "year" | "unit";
  ground:      "illegal_promotion" | "no_exam_card";
  yearOfStudy?: number;     // scope "year"
  programUnitId?: string;   // scope "unit"
  academicYearId?: string;  // scope "unit" (required) / "year" (optional narrowing)
  reason:      string;
  userId:      unknown;
}

export interface NullifyPlan {
  student: { _id: string; regNo: string; name: string };
  affected: Array<{ source: "detailed" | "direct"; markId: string; programUnit: string; unitCode: string; academicYear: string; agreedMark: number }>;
}

async function buildPlan(req: NullifyRequest): Promise<NullifyPlan> {
  const student: any = await Student.findOne({ _id: req.studentId, institution: req.institution }).select("regNo name program").lean();
  if (!student) throw new Error("Student not found");

  let puFilter: any;
  if (req.scope === "year") {
    if (!req.yearOfStudy) throw new Error("yearOfStudy is required to nullify a year.");
    puFilter = { program: student.program, requiredYear: req.yearOfStudy };
  } else {
    if (!req.programUnitId || !req.academicYearId) throw new Error("programUnitId and academicYearId are required to nullify a unit.");
    puFilter = { _id: req.programUnitId, program: student.program };
  }
  const pus: any[] = await ProgramUnit.find(puFilter).populate("unit", "code").lean();
  if (pus.length === 0) throw new Error("No matching unit found in the student's programme.");
  const codeOf = new Map(pus.map((p) => [String(p._id), p.unit?.code || "?"]));

  const filter: any = { student: student._id, programUnit: { $in: pus.map((p) => p._id) } };
  if (req.academicYearId) filter.academicYear = req.academicYearId;

  const [detailed, direct] = await Promise.all([
    Mark.find(filter).populate("academicYear", "year").lean() as Promise<any[]>,
    MarkDirect.find(filter).populate("academicYear", "year").lean() as Promise<any[]>,
  ]);
  const row = (source: "detailed" | "direct") => (m: any) => ({
    source, markId: String(m._id), programUnit: String(m.programUnit),
    unitCode: codeOf.get(String(m.programUnit)) || "?", academicYear: m.academicYear?.year || "", agreedMark: m.agreedMark ?? 0,
  });
  return {
    student: { _id: String(student._id), regNo: student.regNo, name: student.name },
    affected: [...detailed.map(row("detailed")), ...direct.map(row("direct"))],
  };
}

export const previewNullification = buildPlan;

export async function nullify(req: NullifyRequest): Promise<{ nullificationId: string; count: number }> {
  if (!req.reason?.trim()) throw new Error("A reason is required (it goes on the disciplinary record).");
  const plan = await buildPlan(req);
  if (plan.affected.length === 0) throw new Error("There are no results to nullify for that selection.");

  const record = await Nullification.create({
    institution: req.institution, student: req.studentId, scope: req.scope, ground: req.ground,
    yearOfStudy: req.yearOfStudy, programUnit: req.programUnitId, academicYear: req.academicYearId,
    reason: req.reason.trim(),
    affected: plan.affected.map((a) => ({ source: a.source, markId: a.markId, programUnit: a.programUnit, agreedMark: a.agreedMark })),
    nullifiedBy: req.userId, nullifiedAt: new Date(),
  });

  const now = new Date();
  const detailedIds = plan.affected.filter((a) => a.source === "detailed").map((a) => a.markId);
  const directIds   = plan.affected.filter((a) => a.source === "direct").map((a) => a.markId);
  const set = { $set: { deletedAt: now, nullificationId: record._id } };
  if (detailedIds.length) await Mark.updateMany({ _id: { $in: detailedIds } }, set);
  if (directIds.length)   await MarkDirect.updateMany({ _id: { $in: directIds } }, set);

  // Final grades and recorded attempts for the nullified sittings are removed too.
  const pairs = new Map<string, { programUnit: string; year: string }>();
  for (const a of plan.affected) pairs.set(`${a.programUnit}|${a.academicYear}`, { programUnit: a.programUnit, year: a.academicYear });
  const pus: any[] = await ProgramUnit.find({ _id: { $in: [...new Set(plan.affected.map((a) => a.programUnit))] } }).select("unit").lean();
  const unitOf = new Map(pus.map((p) => [String(p._id), p.unit]));
  const years: any[] = await AcademicYear.find({ year: { $in: [...new Set(plan.affected.map((a) => a.academicYear))] } }).select("year").lean();
  const yearId = new Map(years.map((y) => [y.year, y._id]));

  for (const { programUnit, year } of pairs.values()) {
    const fg: any = { student: req.studentId, programUnit };
    if (yearId.get(year)) fg.academicYear = yearId.get(year);
    await FinalGrade.deleteMany(fg);
    const unitId = unitOf.get(programUnit);
    if (unitId) {
      await Student.updateOne(
        { _id: req.studentId },
        { $pull: { "unitAttemptRegistry.$[e].attempts": { academicYear: year } } },
        { arrayFilters: [{ "e.unitId": unitId }] },
      );
    }
  }

  await Student.updateOne({ _id: req.studentId }, { $push: { statusEvents: {
    fromStatus: "", toStatus: "", date: now, academicYear: "",
    reason: `ENG.17: results nullified (${req.scope === "year" ? `year ${req.yearOfStudy}` : "unit"}; ${req.ground.replace("_", " ")}): ${req.reason.trim()}`,
  } } });

  return { nullificationId: String(record._id), count: plan.affected.length };
}

export async function liftNullification(args: { institution: unknown; id: string; userId: unknown; reason: string }): Promise<{ restored: number }> {
  if (!args.reason?.trim()) throw new Error("A reason is required to lift a nullification.");
  const rec: any = await Nullification.findOne({ _id: args.id, institution: args.institution });
  if (!rec) throw new Error("Nullification not found");
  if (rec.liftedAt) throw new Error("This nullification was already lifted.");

  const restore = { $set: { deletedAt: null, nullificationId: null } };
  const [detailed, direct] = await Promise.all([
    Mark.find({ nullificationId: rec._id, deletedAt: { $ne: null } }).select("_id").lean() as Promise<any[]>,
    MarkDirect.find({ nullificationId: rec._id, deletedAt: { $ne: null } }).select("_id").lean() as Promise<any[]>,
  ]);
  if (detailed.length) await Mark.updateMany({ _id: { $in: detailed.map((m) => m._id) } }, restore);
  if (direct.length)   await MarkDirect.updateMany({ _id: { $in: direct.map((m) => m._id) } }, restore);
  for (const m of [...detailed, ...direct]) {
    try { await computeFinalGrade({ markId: m._id as any }); }
    catch (e: any) { console.warn(`[nullification] grade recalc failed for ${m._id}: ${e.message}`); }
  }

  rec.liftedAt = new Date(); rec.liftedBy = args.userId; rec.liftReason = args.reason.trim();
  await rec.save();
  return { restored: detailed.length + direct.length };
}

/**
 * ENG.17(a) suspects: students who are repeating, discontinued or deregistered but have results
 * recorded for a year of study beyond the one they were barred in. Review before acting —
 * a data-entry mistake looks the same as a self-promotion.
 */
export async function detectIllegalPromotions(institution: unknown): Promise<Array<{
  studentId: string; regNo: string; name: string; status: string; barredYear: number; resultsInYears: number[];
}>> {
  const students: any[] = await Student.find({ institution, status: { $in: ["repeat", "discontinued", "deregistered"] } })
    .select("regNo name status currentYearOfStudy program academicHistory").lean();
  const out = [];
  for (const s of students) {
    const barredYear: number = s.status === "repeat"
      ? Math.max(0, ...((s.academicHistory || []) as any[]).filter((h) => h.isRepeatYear).map((h) => h.yearOfStudy))
      : s.currentYearOfStudy;
    if (!barredYear) continue;
    const later: any[] = await ProgramUnit.find({ program: s.program, requiredYear: { $gt: barredYear } }).select("_id requiredYear").lean();
    if (later.length === 0) continue;
    const ids = later.map((p) => p._id);
    const [d, m] = await Promise.all([
      Mark.find({ student: s._id, programUnit: { $in: ids } }).select("programUnit").lean() as Promise<any[]>,
      MarkDirect.find({ student: s._id, programUnit: { $in: ids } }).select("programUnit").lean() as Promise<any[]>,
    ]);
    if (d.length + m.length === 0) continue;
    const yearOf = new Map(later.map((p) => [String(p._id), p.requiredYear]));
    const years = [...new Set([...d, ...m].map((x) => yearOf.get(String(x.programUnit))!))].sort();
    out.push({ studentId: String(s._id), regNo: s.regNo, name: s.name, status: s.status, barredYear, resultsInYears: years });
  }
  return out;
}

export const _isObjectId = mongoose.isValidObjectId;