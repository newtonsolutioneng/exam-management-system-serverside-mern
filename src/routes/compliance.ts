// serverside/src/routes/compliance.ts — registration, coursework and transfer tracking (ENG.23, qualifiers doc)

import express, { Response } from "express";
import Student from "../models/Student";
import AcademicYear from "../models/AcademicYear";
import ProgramUnit from "../models/ProgramUnit";
import { AuthenticatedRequest, requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { scopeQuery } from "../lib/multiTenant";
import { findStudentByRegNo } from "../utils/regNoQualifier";
import { logAudit } from "../lib/auditLogger";
import {
  markAsTransfer, recordRegistrations, findOverdueRegistrations, recordCoursework,
  findCourseworkShortfalls, applyDeregistration, isObjectId, type Sem, type DeregRule,
} from "../services/complianceTracking";
import { previewNullification, nullify, liftNullification, detectIllegalPromotions } from "../services/nullificationService";
import { addAuditedUnit, setAuditedResult, listAuditedUnits, removeAuditedUnit } from "../services/auditedUnits";
import Nullification from "../models/Nullification";
import { findSpecialAbsentees } from "../services/complianceTracking";
import { recordAttachment, attachmentStatus } from "../services/attachments";
import { fileAppeal, decideAppeal, listAppeals, setResultsReleased, setPracticalResult } from "../services/gradeAppeals";

const router = express.Router();
const coord = [requireAuth, requireRole("coordinator")] as const;

const institutionOf = (req: AuthenticatedRequest): unknown => (scopeQuery(req, {}) as any).institution;
const badRequest = (res: Response, error: string) => res.status(400).json({ error });
const semOf = (v: unknown): Sem | null => ([1, 2, 3].includes(Number(v)) ? (Number(v) as Sem) : null);

// ── Transfer student ──────────────────────────────────────────────────────────
router.post("/transfer", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { studentId, regNo, entryYear, secondSemester, fromInstitution } = req.body ?? {};
  const institution = institutionOf(req);
  let id: string | undefined = isObjectId(studentId) ? studentId : undefined;
  if (!id && regNo) {
    const found: any = await findStudentByRegNo(Student, regNo, institution, "_id");
    if (!found) return res.status(404).json({ error: `Student ${regNo} not found` });
    id = String(found._id);
  }
  if (!id) return badRequest(res, "studentId or regNo required");
  let student;
  try {
    student = await markAsTransfer({
    studentId: id, institution, entryYear: Number(entryYear),
     secondSemester: secondSemester === true, fromInstitution,
    });
  } catch (e: any) { return badRequest(res, e.message); }
  res.json({ success: true, regNo: student.regNo, qualifier: student.qualifierSuffix, transfer: student.transfer });
}));

// ── Semester start dates (deadline base) ──────────────────────────────────────
router.put("/semester-starts", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, starts } = req.body ?? {};
  if (!isObjectId(academicYear) || !Array.isArray(starts)) return badRequest(res, "academicYear and starts[] required");
  const clean: Array<{ semester: Sem; startDate: Date }> = [];
  for (const s of starts) {
    const sem = semOf(s?.semester); const d = new Date(s?.startDate);
    if (!sem || isNaN(d.getTime())) return badRequest(res, "Each start needs semester (1-3) and a valid startDate");
    clean.push({ semester: sem, startDate: d });
  }
  const year = await AcademicYear.findOneAndUpdate(
    { _id: academicYear, institution: institutionOf(req) }, { $set: { semesterStarts: clean } }, { new: true },
  );
  if (!year) return res.status(404).json({ error: "Academic year not found" });
  res.json({ success: true, semesterStarts: year.semesterStarts });
}));

// ── Registration ──────────────────────────────────────────────────────────────
router.post("/registrations", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, semester, kind = "semester", studentIds, regNos } = req.body ?? {};
  const sem = semOf(semester);
  if (!isObjectId(academicYear) || !sem) return badRequest(res, "academicYear and semester (1-3) required");
  if (kind !== "semester" && kind !== "retake") return badRequest(res, "kind must be semester or retake");
  const institution = institutionOf(req);

  const ids: string[] = Array.isArray(studentIds) ? studentIds.filter(isObjectId) : [];
  const notFound: string[] = [];
  for (const r of Array.isArray(regNos) ? regNos : []) {
    const s: any = await findStudentByRegNo(Student, r, institution, "_id");
    if (s) ids.push(String(s._id)); else notFound.push(String(r));
  }
  const { recorded } = await recordRegistrations({ institution, academicYear, semester: sem, kind, studentIds: ids, recordedBy: (req.user as any)?._id });
  res.json({ success: true, recorded, notFound });
}));

router.get("/registrations/overdue", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, semester, kind = "semester" } = req.query as any;
  const sem = semOf(semester);
  if (!isObjectId(academicYear) || !sem) return badRequest(res, "academicYear and semester (1-3) required");
  if (kind !== "semester" && kind !== "retake") return badRequest(res, "kind must be semester or retake");
  try {
    res.json(await findOverdueRegistrations({ institution: institutionOf(req), academicYear, semester: sem, kind }));
  } catch (e: any) { badRequest(res, e.message); }
}));

// ── Coursework ────────────────────────────────────────────────────────────────
router.post("/coursework", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, semester, rows } = req.body ?? {};
  const sem = semOf(semester);
  if (!isObjectId(academicYear) || !sem || !Array.isArray(rows)) return badRequest(res, "academicYear, semester and rows[] required");
  const institution = institutionOf(req);

  const accepted: Array<{ studentId: string; programUnitId: string; percent: number }> = [];
  const errors: string[] = [];
  for (const [i, r] of rows.entries()) {
    const percent = Number(r?.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) { errors.push(`Row ${i + 1}: percent must be 0-100`); continue; }
    const s: any = await findStudentByRegNo(Student, r?.regNo, institution, "_id program");
    if (!s) { errors.push(`Row ${i + 1}: student ${r?.regNo} not found`); continue; }
    const pus: any[] = await ProgramUnit.find({ program: s.program }).populate("unit", "code").lean();
    const pu = pus.find((p) => String(p.unit?.code || "").toUpperCase() === String(r?.unitCode || "").trim().toUpperCase());
    if (!pu) { errors.push(`Row ${i + 1}: unit ${r?.unitCode} is not in ${r?.regNo}'s programme`); continue; }
    accepted.push({ studentId: String(s._id), programUnitId: String(pu._id), percent });
  }
  const { saved } = await recordCoursework({ institution, academicYear, semester: sem, rows: accepted });
  res.json({ success: true, saved, errors });
}));

router.get("/coursework/shortfall", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, semester } = req.query as any;
  const sem = semOf(semester);
  if (!isObjectId(academicYear) || !sem) return badRequest(res, "academicYear and semester (1-3) required");
  res.json(await findCourseworkShortfalls({ institution: institutionOf(req), academicYear, semester: sem }));
}));

// ── Deregistration (preview unless confirm === true) ─────────────────────────
router.post("/deregister", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, semester, rule, confirm } = req.body ?? {};
  const sem = semOf(semester);
  if (!isObjectId(academicYear) || !sem) return badRequest(res, "academicYear and semester (1-3) required");
  if (!["registration", "retake", "coursework", "specials"].includes(rule)) return badRequest(res, "rule must be registration, retake, coursework or specials");
  const institution = institutionOf(req);

  let flagged;
  try {
    if (rule === "coursework") {
      flagged = (await findCourseworkShortfalls({ institution, academicYear, semester: sem })).flagged;
    } else if (rule === "specials") {
      const r = await findSpecialAbsentees({ institution, academicYear });
      if (!r.yearClosed) return badRequest(res, "Absence from special examinations is judged only once the academic year is CLOSED.");
      flagged = r.flagged;
    } else {
      const r = await findOverdueRegistrations({ institution, academicYear, semester: sem, kind: rule === "retake" ? "retake" : "semester" });
      if (!r.pastDeadline) return badRequest(res, `The deadline (${r.deadline.toDateString()}) has not passed yet.`);
      flagged = r.flagged;
    }
  } catch (e: any) { return badRequest(res, e.message); }

  if (confirm !== true) return res.json({ preview: true, count: flagged.length, flagged });

  const { deregistered } = await applyDeregistration({ institution, rule: rule as DeregRule, academicYear, studentIds: flagged.map((f) => f.studentId) });
  await logAudit(req, { action: "bulk_deregister", details: { rule, academicYear, semester: sem, count: deregistered } } as any);
  res.json({ success: true, deregistered });
}));

// ── ENG.17 nullification ──────────────────────────────────────────────────────
router.get("/nullify/suspects", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  res.json({ suspects: await detectIllegalPromotions(institutionOf(req)) });
}));

router.post("/nullify", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const b = req.body ?? {};
  const institution = institutionOf(req);
  if (!["year", "unit"].includes(b.scope)) return badRequest(res, "scope must be year or unit");
  if (!["illegal_promotion", "no_exam_card"].includes(b.ground)) return badRequest(res, "ground must be illegal_promotion or no_exam_card");
  if (b.scope === "year" && b.ground !== "illegal_promotion") return badRequest(res, "A whole year is nullified only for illegal promotion (ENG.17(a)).");
  if (b.scope === "unit" && b.ground !== "no_exam_card") return badRequest(res, "A single unit is nullified only for no genuine exam card (ENG.17(b)).");

  let studentId: string | undefined = isObjectId(b.studentId) ? b.studentId : undefined;
  if (!studentId && b.regNo) {
    const f: any = await findStudentByRegNo(Student, b.regNo, institution, "_id");
    if (!f) return res.status(404).json({ error: `Student ${b.regNo} not found` });
    studentId = String(f._id);
  }
  if (!studentId) return badRequest(res, "studentId or regNo required");

  let programUnitId: string | undefined;
  if (b.scope === "unit") {
    const st: any = await Student.findById(studentId).select("program").lean();
    const pus: any[] = await ProgramUnit.find({ program: st?.program }).populate("unit", "code").lean();
    const pu = pus.find((p) => String(p.unit?.code || "").toUpperCase() === String(b.unitCode || "").trim().toUpperCase());
    if (!pu) return badRequest(res, `Unit ${b.unitCode} is not in the student's programme`);
    programUnitId = String(pu._id);
  }

  const request = {
    institution, studentId, scope: b.scope, ground: b.ground, yearOfStudy: Number(b.yearOfStudy) || undefined,
    programUnitId, academicYearId: isObjectId(b.academicYear) ? b.academicYear : undefined,
    reason: String(b.reason ?? ""), userId: (req.user as any)?._id,
  };
  try {
    if (b.confirm !== true) return res.json({ preview: true, ...(await previewNullification(request)) });
    const r = await nullify(request);
    await logAudit(req, { action: "nullify_results", details: { studentId, scope: b.scope, ground: b.ground, count: r.count } } as any);
    res.json({ success: true, ...r });
  } catch (e: any) { badRequest(res, e.message); }
}));

router.get("/nullifications", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const rows: any[] = await Nullification.find({ institution: institutionOf(req) })
    .populate("student", "regNo name").populate("programUnit").sort({ nullifiedAt: -1 }).limit(100).lean();
  res.json(rows.map((r) => ({
    _id: String(r._id), regNo: r.student?.regNo, name: r.student?.name, scope: r.scope, ground: r.ground,
   yearOfStudy: r.yearOfStudy, reason: r.reason, count: r.affected?.length ?? 0, nullifiedAt: r.nullifiedAt, liftedAt: r.liftedAt ?? null,
  })));
}));

router.post("/nullifications/:id/lift", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!isObjectId(req.params.id)) return badRequest(res, "Invalid id");
  try {
    const r = await liftNullification({ institution: institutionOf(req), id: req.params.id, userId: (req.user as any)?._id, reason: String(req.body?.reason ?? "") });
    await logAudit(req, { action: "lift_nullification", details: { id: req.params.id, restored: r.restored } } as any);
    res.json({ success: true, ...r });
  } catch (e: any) { badRequest(res, e.message); }
}));

// ── ENG.9 audited units ───────────────────────────────────────────────────────
router.post("/audited-units", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { regNo, unitCode, academicYear, yearOfStudy } = req.body ?? {};
  if (!regNo || !unitCode || !isObjectId(academicYear)) return badRequest(res, "regNo, unitCode and academicYear required");
  try {
    const doc = await addAuditedUnit({ institution: institutionOf(req), regNo, unitCode, academicYearId: academicYear, yearOfStudy: Number(yearOfStudy) || undefined, userId: (req.user as any)?._id });
    res.json({ success: true, id: String(doc._id) });
  } catch (e: any) { badRequest(res, e.message); }
}));

router.get("/audited-units", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const regNo = String(req.query.regNo ?? "");
  if (!regNo) return badRequest(res, "regNo required");
  const st: any = await findStudentByRegNo(Student, regNo, institutionOf(req), "_id regNo name");
  if (!st) return res.status(404).json({ error: `Student ${regNo} not found` });
  res.json({ regNo: st.regNo, name: st.name, units: await listAuditedUnits(st._id) });
}));

router.patch("/audited-units/:id", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!isObjectId(req.params.id)) return badRequest(res, "Invalid id");
  const raw = req.body?.mark;
  try { await setAuditedResult({ institution: institutionOf(req), id: req.params.id, mark: raw === null || raw === "" ? null : Number(raw) }); res.json({ success: true }); }
  catch (e: any) { badRequest(res, e.message); }
}));

router.delete("/audited-units/:id", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!isObjectId(req.params.id)) return badRequest(res, "Invalid id");
  try { await removeAuditedUnit(institutionOf(req), req.params.id); res.json({ success: true }); }
  catch (e: any) { badRequest(res, e.message); }
}));

// ── ENG.23(e): special-exam absentees ────────────────────────────────────────
router.get("/specials/absentees", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear } = req.query as any;
  if (!isObjectId(academicYear)) return badRequest(res, "academicYear required");
  try { res.json(await findSpecialAbsentees({ institution: institutionOf(req), academicYear })); }
  catch (e: any) { badRequest(res, e.message); }
}));

// ── Attachments / practicum (ENG.8, 12, 24) ──────────────────────────────────
router.get("/attachments", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const regNo = String(req.query.regNo ?? "");
  if (!regNo) return badRequest(res, "regNo required");
  try { res.json(await attachmentStatus(institutionOf(req), regNo)); } catch (e: any) { res.status(404).json({ error: e.message }); }
}));

router.post("/attachments", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { regNo, kind, yearOfStudy, weeks, status } = req.body ?? {};
  if (!regNo || !["attachment", "practicum"].includes(kind) || !["pending", "passed", "failed"].includes(status))
    return badRequest(res, "regNo, kind (attachment|practicum), yearOfStudy, weeks and status (pending|passed|failed) required");
  try {
    await recordAttachment({ institution: institutionOf(req), regNo, kind, yearOfStudy: Number(yearOfStudy), weeks: Number(weeks), status, userId: (req.user as any)?._id });
    res.json({ success: true });
  } catch (e: any) { badRequest(res, e.message); }
}));

// ── Practical outcome for sheets without a practical mark (ENG.10(d)) ────────
router.post("/practical", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { regNo, unitCode, academicYear, passed } = req.body ?? {};
  if (!regNo || !unitCode || !isObjectId(academicYear) || typeof passed !== "boolean") return badRequest(res, "regNo, unitCode, academicYear and passed (true|false) required");
  try { res.json({ success: true, ...(await setPracticalResult({ institution: institutionOf(req), regNo, unitCode, academicYearId: academicYear, passed })) }); }
  catch (e: any) { badRequest(res, e.message); }
}));

// ── ENG.27(ii) release of results, ENG.26 appeals ────────────────────────────
router.put("/results-release", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { academicYear, releasedAt } = req.body ?? {};
  if (!isObjectId(academicYear)) return badRequest(res, "academicYear required");
  const d = releasedAt ? new Date(releasedAt) : null;
  if (d && isNaN(d.getTime())) return badRequest(res, "releasedAt is not a valid date");
  try { await setResultsReleased(institutionOf(req), academicYear, d); res.json({ success: true }); }
  catch (e: any) { badRequest(res, e.message); }
}));

router.post("/appeals", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { regNo, unitCode, academicYear, grounds, lateReason } = req.body ?? {};
  if (!regNo || !unitCode || !isObjectId(academicYear)) return badRequest(res, "regNo, unitCode and academicYear required");
  try { const a: any = await fileAppeal({ institution: institutionOf(req), regNo, unitCode, academicYearId: academicYear, grounds, lateReason, userId: (req.user as any)?._id }); res.json({ success: true, id: String(a._id), late: a.late }); }
  catch (e: any) { badRequest(res, e.message); }
}));

router.get("/appeals", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  res.json(await listAppeals(institutionOf(req)));
}));

router.patch("/appeals/:id", ...coord, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!isObjectId(req.params.id)) return badRequest(res, "Invalid id");
  const { outcome, newMark, note } = req.body ?? {};
  if (!["upheld", "dismissed"].includes(outcome)) return badRequest(res, "outcome must be upheld or dismissed");
  try { await decideAppeal({ institution: institutionOf(req), id: req.params.id, outcome, newMark: newMark === undefined || newMark === "" ? null : Number(newMark), note, userId: (req.user as any)?._id }); res.json({ success: true }); }
  catch (e: any) { badRequest(res, e.message); }
}));

export default router;