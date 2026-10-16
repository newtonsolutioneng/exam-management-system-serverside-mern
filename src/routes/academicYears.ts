
// serverside/src/routes/academicYears.ts
import { Response, Router } from "express";
import AcademicYear from "../models/AcademicYear";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { logAudit } from "../lib/auditLogger";
import type { AuthenticatedRequest } from "../middleware/auth";
import { cached, invalidateCache } from "../utils/cache";
import Student from "../models/Student";
import InstitutionSettings from "../models/InstitutionSettings";
import { getIntakeDefinitions } from "../utils/intakeDefinitions";
import {
  buildIntakeConfig,
  intakeFromDate,
  defaultSemesterFor,
  normalizeIntake,
  type IntakeCode,
  type IntakeDefinition,
} from "../utils/semesterLabels";

const LABEL_STYLES = ["INTAKE", "SEMESTER"] as const;

/**
 * Legacy records stored a single free-text intake (even "AUG") and no semester mapping.
 * Normalise on read so the UI always receives valid codes + a semester number for each.
 */
function normalizeYearDoc<T extends { intakes?: string[]; intakeSemesters?: any[]; semesterLabelStyle?: string; startDate?: Date }>(y: T, defs: IntakeDefinition[]) {
  const codes: IntakeCode[] = [];
  for (const raw of y.intakes ?? []) {
    const c = normalizeIntake(raw, defs);
    if (c && !codes.includes(c)) codes.push(c);
  }
  if (codes.length === 0) codes.push(y.startDate ? intakeFromDate(new Date(y.startDate), defs) : defs[0].code);

  const built = buildIntakeConfig(codes, y.intakeSemesters, defs);
  const cfg = "error" in built
    // stored mapping clashed (e.g. hand-edited data) → fall back to defaults
    ? buildIntakeConfig(codes, [], defs)
    : built;
  const safe = "error" in cfg
    ? { intakes: codes, intakeSemesters: codes.map((intake) => ({ intake, semester: defaultSemesterFor(intake, defs) })) }
    : cfg;

  return {
    ...y,
    intakes: safe.intakes,
    intakeSemesters: safe.intakeSemesters,
    semesterLabelStyle: y.semesterLabelStyle === "SEMESTER" ? "SEMESTER" : "INTAKE",
  };
}

const router = Router();

// 1. CREATE
router.post(
  "/",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { year, startDate, endDate, intakes, intakeSemesters, semesterLabelStyle } = req.body;
    const start = new Date(startDate);
    const defs = await getIntakeDefinitions(req.user.institution);

    
    // Backwards compatible: if the client sends no intakes, derive one from the start date.
    const cfg = buildIntakeConfig(
      Array.isArray(intakes) && intakes.length ? intakes : [intakeFromDate(start, defs)],
      intakeSemesters,
      defs,
    );
    if ("error" in cfg) return res.status(400).json({ message: cfg.error });

    const exists = await AcademicYear.exists({ institution: req.user.institution, year });
    if (exists) {
      return res.status(409).json({
        message: `Academic year ${year} already exists. Open it and tick the extra intake(s) instead of creating it again.`,
      });
    }
    const academicYear = await AcademicYear.create({
      institution: req.user.institution,
      year,
      intakes: cfg.intakes,
      intakeSemesters: cfg.intakeSemesters,
      semesterLabelStyle: (LABEL_STYLES as readonly string[]).includes(semesterLabelStyle) ? semesterLabelStyle : "INTAKE",
      startDate: start,
      endDate: new Date(endDate),
      isCurrent: false,
    });

    await logAudit(req, {
      action: "academic_year_created",
      actor: req.user._id,
      details: {
        year,
        intakes: cfg.intakes,
        intakeSemesters: cfg.intakeSemesters,
        startDate: start.toISOString(),
        endDate: new Date(endDate).toISOString(),
        institutionId: req.user.institution?.toString(),
      },
    });
    invalidateCache(`academicYears:${req.user.institution}`);
    res.status(201).json(academicYear);
  })
);

// 2. UPDATE (PATCH)
router.patch(
  "/:id",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const before = await AcademicYear.findOne({
      _id: req.params.id,
      institution: req.user.institution,
    }).lean();

    if (!before) {
      await logAudit(req, {
        action: "academic_year_update_failed",
        actor: req.user._id,
        details: {
          academicYearId: req.params.id,
          reason: "Not found or institution mismatch",
          attemptedChanges: req.body,
        },
      });
      return res.status(404).json({ message: "Academic year not found" });
    }

    // Whitelist: never let the client overwrite institution, year, _id, etc.
    const b = req.body ?? {};
    const changes: Record<string, unknown> = {};
    for (const k of ["isCurrent", "session", "isRegistrationOpen", "startDate", "endDate"]) {
      if (b[k] !== undefined) changes[k] = b[k];
    }
    if (b.semesterLabelStyle !== undefined) {
      if (!(LABEL_STYLES as readonly string[]).includes(b.semesterLabelStyle)) {
        return res.status(400).json({ message: "semesterLabelStyle must be INTAKE or SEMESTER" });
      }
      changes.semesterLabelStyle = b.semesterLabelStyle;
    }

    // Intakes / semester mapping
    if (b.intakes !== undefined || b.intakeSemesters !== undefined) {
      const defs = await getIntakeDefinitions(req.user.institution);
      const current = normalizeYearDoc(before as any, defs);
      const cfg = buildIntakeConfig(
        b.intakes !== undefined ? b.intakes : current.intakes,
        b.intakeSemesters !== undefined ? b.intakeSemesters : current.intakeSemesters,
        defs,
      );
      if ("error" in cfg) return res.status(400).json({ message: cfg.error });

      // An intake can't be removed while students are admitted under it for this year.
      const removed = (current.intakes as IntakeCode[]).filter((i: IntakeCode) => !cfg.intakes.includes(i));
      for (const intake of removed) {
        const n = await Student.countDocuments({
          institution: req.user.institution,
          admissionAcademicYear: before._id,
          intake,
        });
        if (n > 0) {
          return res.status(400).json({
            message: `Cannot remove the ${intake} intake: ${n} student(s) were admitted under it in ${before.year}.`,
          });
        }
      }
      changes.intakes = cfg.intakes;
      changes.intakeSemesters = cfg.intakeSemesters;
    }

    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    const { isCurrent } = changes as { isCurrent?: boolean };
    if (isCurrent) {
      await AcademicYear.updateMany(
        { institution: req.user.institution },
        { isCurrent: false }
      );
    }

    const updated = await AcademicYear.findByIdAndUpdate(
      req.params.id,
        { $set: changes },
        { new: true, runValidators: true }
    );
    
    await logAudit(req, {
      action: "academic_year_updated",
      actor: req.user._id,
      details: {
        academicYearId: req.params.id,
        year: before.year,
        institutionId: req.user.institution?.toString(),
        before: { isCurrent: before.isCurrent, session: (before as any).session, startDate: before.startDate, endDate: before.endDate, intakes: before.intakes, intakeSemesters: (before as any).intakeSemesters },
        after: changes, demotedOthers: !!isCurrent }});
    invalidateCache(`academicYears:${req.user.institution}`);
    res.json(updated ? normalizeYearDoc(updated.toObject() as any, await getIntakeDefinitions(req.user.institution)) : updated);
  })
);

// 3. GET ALL
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    // const years = await AcademicYear.find({ institution: req.user.institution }).sort({ startDate: -1 }).lean();
    const institutionId = req.user.institution;
    const years = await cached(`academicYears:${institutionId}`, () => AcademicYear.find({ institution: institutionId }).sort({ startDate: -1 }).lean());
    await logAudit(req, { action: "academic_years_listed", actor: req.user._id, details: { count: years.length, institutionId: req.user.institution?.toString()}});

    const defs = await getIntakeDefinitions(institutionId);
    res.json(years.map((y) => normalizeYearDoc(y as any, defs)));
  })
);

// 4. DELETE
router.delete("/:id", requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const year = await AcademicYear.findOne({ _id: req.params.id, institution: req.user.institution });

    if (!year) {
      await logAudit(req, { action: "academic_year_delete_failed", actor: req.user._id, details: { academicYearId: req.params.id, reason: "Not found or institution mismatch", institutionId: req.user.institution?.toString()}});
      return res.status(404).json({ message: "Year not found" });
    }

    if (year.isCurrent) {
      await logAudit(req, { action: "academic_year_delete_failed", actor: req.user._id, details: { academicYearId: req.params.id, year: year.year, reason: "Attempted deletion of active academic year", institutionId: req.user.institution?.toString()}});
      return res.status(400).json({ message: "Cannot delete the active academic year" });
    }

    await AcademicYear.findByIdAndDelete(req.params.id);

    await logAudit(req, { action: "academic_year_deleted", actor: req.user._id, details: { academicYearId: req.params.id, year: year.year, startDate: year.startDate, endDate: year.endDate, institutionId: req.user.institution?.toString()}});
    invalidateCache(`academicYears:${req.user.institution}`);
    res.json({ message: "Deleted successfully" });
  })
);

export default router;