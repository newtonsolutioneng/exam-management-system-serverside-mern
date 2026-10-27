// // serverside/src/routes/disciplinary.ts
// //
// // ENDPOINTS
// // ──────────────────────────────────────────────────────────────────────────────
// // POST   /disciplinary/raise             → file a new case (coordinator/admin)
// // GET    /disciplinary                   → list cases for institution (paginated)
// // GET    /disciplinary/student/:studentId → all cases for one student
// // GET    /disciplinary/:caseId           → single case detail
// // PATCH  /disciplinary/:caseId/outcome   → record hearing outcome
// // PATCH  /disciplinary/:caseId/reinstate → lift suspension (admin only)
// // PATCH  /disciplinary/:caseId/appeal    → log an appeal and outcome
// //
// // HOW THE CHAIN WORKS (SENT_HOME example)
// // ──────────────────────────────────────────────────────────────────────────────
// // 1. Coordinator calls POST /disciplinary/raise
// // 2. DisciplinaryCase created with outcome = "PENDING"
// // 3. student.status updated to "disciplinary_suspension" (new enum value)
// // 4. statusEvents entry written → JourneyTimeline picks it up automatically
// // 5. Next time that student tries to log in, requireAuth finds status "suspended"
// //    and blocks them with 403
// // 6. Coordinator calls PATCH /disciplinary/:id/outcome with outcome = "SENT_HOME"
// // 7. suspensionStart/End set, qualifierSuffix updated to RP1D
// // 8. AuditLog records every step

// import { Router, Response } from "express";
// import { asyncHandler } from "../middleware/asyncHandler";
// import {
//   requireAuth,
//   requireRole,
//   AuthenticatedRequest,
// } from "../middleware/auth";
// import { logAudit } from "../lib/auditLogger";
// import { ApiError } from "../middleware/errorHandler";
// import DisciplinaryCase, {
//   DisciplinaryOutcome,
// } from "../models/DisciplinaryCase";
// import Student from "../models/Student";
// import AcademicYear from "../models/AcademicYear";
// import mongoose from "mongoose";

// const router = Router();
// // All disciplinary routes require authentication
// router.use(requireAuth);

// // ─── POST /disciplinary/raise ─────────────────────────────────────────────────
// // Files a new disciplinary case against a student.
// // Sets student.status = "disciplinary_suspension" immediately — they are
// // blocked from the system from this moment forward.
// router.post(
//   "/raise",
//   requireRole("coordinator", "admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { studentId, grounds, description, hearingDate, academicYearId } =
//       req.body;
//     const institutionId = req.user.institution;

//     if (!studentId || !grounds || !description) {
//       throw {
//         statusCode: 400,
//         message: "studentId, grounds, and description are required.",
//       } as ApiError;
//     }

//     const student = await Student.findOne({
//       _id: studentId,
//       institution: institutionId,
//     });
//     if (!student) {
//       throw {
//         statusCode: 404,
//         message: "Student not found in this institution.",
//       } as ApiError;
//     }

//     // Resolve academic year — use current if not provided
//     let yearId = academicYearId;
//     if (!yearId) {
//       const currentYear = await AcademicYear.findOne({
//         institution: institutionId,
//         isCurrent: true,
//       })
//         .select("_id")
//         .lean();
//       if (!currentYear)
//         throw {
//           statusCode: 400,
//           message: "No current academic year set.",
//         } as ApiError;
//       yearId = currentYear._id;
//     }

//     // Snapshot current status before we change it
//     const priorStatus = student.status;

//     // Create the case first — if this fails we don't touch the student
//     const disciplinaryCase = await DisciplinaryCase.create({
//       institution: institutionId,
//       student: studentId,
//       raisedBy: req.user._id,
//       academicYear: yearId,
//       yearOfStudy: student.currentYearOfStudy,
//       grounds,
//       description,
//       hearingDate: hearingDate ? new Date(hearingDate) : undefined,
//       outcome: "PENDING",
//       priorStudentStatus: priorStatus,
//     });

//     // Now lock the student out — status event for JourneyTimeline
//     const currentAcademicYear = await AcademicYear.findById(yearId)
//       .select("year")
//       .lean();
//     student.status = "disciplinary_suspension" as any; // we add this to the enum below

//     student.statusEvents.push({
//       fromStatus: priorStatus,
//       toStatus: "disciplinary_suspension",
//       date: new Date(),
//       academicYear: currentAcademicYear?.year ?? "Unknown",
//       reason: `Disciplinary case filed: ${grounds}. Case ID: ${disciplinaryCase._id}`,
//     });

//     student.statusHistory.push({
//       status: "disciplinary_suspension",
//       previousStatus: priorStatus,
//       date: new Date(),
//       reason: `Disciplinary case ${disciplinaryCase._id} filed by coordinator.`,
//     });

//     await student.save();

//     await logAudit(req, {
//       action: "disciplinary_case_raised",
//       actor: req.user._id,
//       targetUser: studentId,
//       details: {
//         caseId: disciplinaryCase._id,
//         grounds,
//         studentId,
//         priorStatus,
//       },
//     });

//     res.status(201).json({
//       message:
//         "Disciplinary case filed. Student has been suspended pending hearing.",
//       caseId: disciplinaryCase._id,
//     });
//   }),
// );

// // ─── GET /disciplinary ────────────────────────────────────────────────────────
// // Lists all cases for the institution with optional outcome filter
// router.get(
//   "/",
//   requireRole("coordinator", "admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { outcome, page = "1", limit = "20" } = req.query;
//     const institutionId = req.user.institution;

//     const filter: Record<string, unknown> = { institution: institutionId };
//     if (outcome && typeof outcome === "string") filter.outcome = outcome;

//     const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
//     const total = await DisciplinaryCase.countDocuments(filter);

//     const cases = await DisciplinaryCase.find(filter)
//       .sort({ createdAt: -1 })
//       .skip(skip)
//       .limit(parseInt(limit as string))
//       .populate("student", "name regNo currentYearOfStudy program")
//       .populate("raisedBy", "name email")
//       .populate("resolvedBy", "name email")
//       .lean();

//     res.json({ total, page: parseInt(page as string), cases });
//   }),
// );

// // ─── GET /disciplinary/student/:studentId ─────────────────────────────────────
// // All cases for a single student — used in StudentSearch / JourneyTimeline
// router.get(
//   "/student/:studentId",
//   requireRole("coordinator", "admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { studentId } = req.params;
//     const institutionId = req.user.institution;

//     if (!mongoose.Types.ObjectId.isValid(studentId)) {
//       throw { statusCode: 400, message: "Invalid student ID." } as ApiError;
//     }

//     const cases = await DisciplinaryCase.find({
//       student: studentId,
//       institution: institutionId,
//     })
//       .sort({ createdAt: -1 })
//       .populate("raisedBy", "name email")
//       .populate("resolvedBy", "name email")
//       .lean();

//     res.json(cases);
//   }),
// );

// // ─── GET /disciplinary/:caseId ────────────────────────────────────────────────
// router.get(
//   "/:caseId",
//   requireRole("coordinator", "admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { caseId } = req.params;
//     const institutionId = req.user.institution;

//     const disciplinaryCase = await DisciplinaryCase.findOne({
//       _id: caseId,
//       institution: institutionId,
//     })
//       .populate("student", "name regNo currentYearOfStudy status")
//       .populate("raisedBy", "name email")
//       .populate("resolvedBy", "name email")
//       .lean();

//     if (!disciplinaryCase)
//       throw { statusCode: 404, message: "Case not found." } as ApiError;

//     res.json(disciplinaryCase);
//   }),
// );

// // ─── PATCH /disciplinary/:caseId/outcome ─────────────────────────────────────
// // Record the hearing result. This is the most important endpoint.
// //
// // outcome = "SENT_HOME"    → suspension formalised, RP1D qualifier set
// // outcome = "WARNING"      → student stays enrolled, just warned
// // outcome = "DISCONTINUED" → calls ENG.22 path, student fully discontinued
// // outcome = "DISMISSED"    → case dropped, student status restored to priorStatus
// router.patch(
//   "/:caseId/outcome",
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { caseId } = req.params;
//     const {
//       outcome,
//       outcomeNotes,
//       suspensionStart,
//       suspensionEnd,
//       hearingDate,
//     } = req.body;
//     const institutionId = req.user.institution;

//     const validOutcomes: DisciplinaryOutcome[] = [
//       "WARNING",
//       "SENT_HOME",
//       "REINSTATED",
//       "DISCONTINUED",
//       "DISMISSED",
//     ];
//     if (!validOutcomes.includes(outcome)) {
//       throw {
//         statusCode: 400,
//         message: `outcome must be one of: ${validOutcomes.join(", ")}`,
//       } as ApiError;
//     }

//     const disciplinaryCase = await DisciplinaryCase.findOne({
//       _id: caseId,
//       institution: institutionId,
//     });
//     if (!disciplinaryCase)
//       throw { statusCode: 404, message: "Case not found." } as ApiError;
//     if (disciplinaryCase.outcome !== "PENDING") {
//       throw {
//         statusCode: 409,
//         message: "This case has already been resolved.",
//       } as ApiError;
//     }

//     const student = await Student.findById(disciplinaryCase.student);
//     if (!student)
//       throw { statusCode: 404, message: "Student record missing." } as ApiError;

//     const currentAcademicYear = await AcademicYear.findById(
//       disciplinaryCase.academicYear,
//     )
//       .select("year")
//       .lean();
//     const yearStr = currentAcademicYear?.year ?? "Unknown";

//     // Update the case
//     disciplinaryCase.outcome = outcome;
//     disciplinaryCase.outcomeNotes = outcomeNotes;
//     disciplinaryCase.resolvedBy = req.user._id as any;
//     disciplinaryCase.resolvedAt = new Date();
//     if (hearingDate) disciplinaryCase.hearingDate = new Date(hearingDate);
//     if (suspensionStart)
//       disciplinaryCase.suspensionStart = new Date(suspensionStart);
//     if (suspensionEnd) disciplinaryCase.suspensionEnd = new Date(suspensionEnd);

//     // ── Update student status based on outcome ────────────────────────────────
//     let newStudentStatus = student.status as string;

//     if (outcome === "SENT_HOME") {
//       // Student stays suspended — now it's formalised
//       // Set RP1D qualifier for documents
//       student.qualifierSuffix = `RP${Math.min((student.qualifierSuffix?.match(/\d/) ? parseInt(student.qualifierSuffix) : 0) + 1, 5)}D`;
//       newStudentStatus = "disciplinary_suspension";
//     } else if (outcome === "DISCONTINUED") {
//       // Full discontinuation — same path as ENG.22
//       newStudentStatus = "discontinued";
//       student.qualifierSuffix = "";
//     } else if (outcome === "DISMISSED" || outcome === "WARNING") {
//       // Restore to prior status
//       newStudentStatus = disciplinaryCase.priorStudentStatus;
//       student.qualifierSuffix = "";
//     }

//     student.status = newStudentStatus as any;
//     student.statusEvents.push({
//       fromStatus: "disciplinary_suspension",
//       toStatus: newStudentStatus,
//       date: new Date(),
//       academicYear: yearStr,
//       reason: `Disciplinary outcome: ${outcome}. ${outcomeNotes ?? ""}`,
//     });
//     student.statusHistory.push({
//       status: newStudentStatus,
//       previousStatus: "disciplinary_suspension",
//       date: new Date(),
//       reason: `Disciplinary case ${caseId} resolved: ${outcome}`,
//     });

//     await student.save();
//     await disciplinaryCase.save();

//     await logAudit(req, {
//       action: "disciplinary_outcome_recorded",
//       actor: req.user._id,
//     //   targetUser: student._id,
//       details: { caseId, outcome, outcomeNotes, newStudentStatus },
//     });

//     res.json({
//       message: `Disciplinary outcome recorded: ${outcome}`,
//       studentStatus: newStudentStatus,
//     });
//   }),
// );

// // ─── PATCH /disciplinary/:caseId/reinstate ────────────────────────────────────
// // Admin reinstates a student who was SENT_HOME.
// // Separate from outcome so there's an explicit audit trail for reinstatement.
// router.patch(
//   "/:caseId/reinstate",
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { caseId } = req.params;
//     const { notes } = req.body;
//     const institutionId = req.user.institution;

//     const disciplinaryCase = await DisciplinaryCase.findOne({
//       _id: caseId,
//       institution: institutionId,
//     });
//     if (!disciplinaryCase)
//       throw { statusCode: 404, message: "Case not found." } as ApiError;
//     if (disciplinaryCase.outcome !== "SENT_HOME") {
//       throw {
//         statusCode: 409,
//         message: "Only SENT_HOME cases can be reinstated.",
//       } as ApiError;
//     }

//     const student = await Student.findById(disciplinaryCase.student);
//     if (!student)
//       throw { statusCode: 404, message: "Student record missing." } as ApiError;

//     const currentAcademicYear = await AcademicYear.findById(
//       disciplinaryCase.academicYear,
//     )
//       .select("year")
//       .lean();

//     disciplinaryCase.outcome = "REINSTATED";
//     disciplinaryCase.outcomeNotes =
//       (disciplinaryCase.outcomeNotes ?? "") + ` | REINSTATED: ${notes ?? ""}`;
//     disciplinaryCase.resolvedAt = new Date();
//     disciplinaryCase.resolvedBy = req.user._id as any;

//     const restoredStatus = disciplinaryCase.priorStudentStatus;
//     student.status = restoredStatus as any;
//     student.qualifierSuffix = ""; // Clear disciplinary qualifier on reinstatement
//     student.statusEvents.push({
//       fromStatus: "disciplinary_suspension",
//       toStatus: restoredStatus,
//       date: new Date(),
//       academicYear: currentAcademicYear?.year ?? "Unknown",
//       reason: `Student reinstated. ${notes ?? ""}`,
//     });

//     await student.save();
//     await disciplinaryCase.save();

//     await logAudit(req, {
//       action: "disciplinary_student_reinstated",
//       actor: req.user._id,
//     //   targetUser: student._id,
//       details: { caseId, restoredStatus, notes },
//     });

//     res.json({
//       message: "Student reinstated. Status restored.",
//       restoredStatus,
//     });
//   }),
// );

// // ─── PATCH /disciplinary/:caseId/appeal ──────────────────────────────────────
// // Record an appeal and its outcome.
// // appealOutcome = "UPHELD"   → student wins, trigger reinstatement
// // appealOutcome = "DISMISSED" → outcome stands
// router.patch(
//   "/:caseId/appeal",
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { caseId } = req.params;
//     const { appealDate, appealOutcome, appealNotes } = req.body;
//     const institutionId = req.user.institution;

//     if (!["UPHELD", "DISMISSED"].includes(appealOutcome)) {
//       throw {
//         statusCode: 400,
//         message: "appealOutcome must be UPHELD or DISMISSED.",
//       } as ApiError;
//     }

//     const disciplinaryCase = await DisciplinaryCase.findOne({
//       _id: caseId,
//       institution: institutionId,
//     });
//     if (!disciplinaryCase)
//       throw { statusCode: 404, message: "Case not found." } as ApiError;
//     if (disciplinaryCase.appealed) {
//       throw {
//         statusCode: 409,
//         message: "An appeal has already been recorded for this case.",
//       } as ApiError;
//     }

//     disciplinaryCase.appealed = true;
//     disciplinaryCase.appealDate = appealDate
//       ? new Date(appealDate)
//       : new Date();
//     disciplinaryCase.appealOutcome = appealOutcome;
//     disciplinaryCase.appealNotes = appealNotes;

//     if (appealOutcome === "UPHELD") {
//       // Auto-reinstate: student wins their appeal
//       const student = await Student.findById(disciplinaryCase.student);
//       if (student) {
//         student.status = disciplinaryCase.priorStudentStatus as any;
//         student.qualifierSuffix = "";
//         student.statusEvents.push({
//           fromStatus: student.status as string,
//           toStatus: disciplinaryCase.priorStudentStatus,
//           date: new Date(),
//           academicYear: "Appeal",
//           reason: `Appeal upheld. Case ${caseId}. ${appealNotes ?? ""}`,
//         });
//         await student.save();
//       }
//       disciplinaryCase.outcome = "REINSTATED";
//     }

//     await disciplinaryCase.save();

//     await logAudit(req, {
//       action: "disciplinary_appeal_recorded",
//       actor: req.user._id,
//       targetUser: disciplinaryCase.student,
//       details: { caseId, appealOutcome, appealNotes },
//     });

//     res.json({
//       message: `Appeal ${appealOutcome === "UPHELD" ? "upheld — student reinstated" : "dismissed — original outcome stands"}.`,
//     });
//   }),
// );

// export default router;










































// serverside/src/routes/disciplinary.ts - WITH SCOPING
import { REG_QUALIFIERS } from "../utils/academicRules";
import { Router, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  requireAuth,
  requireRole,
  AuthenticatedRequest,
  getScopedProgramIds,
} from "../middleware/auth";
import { logAudit } from "../lib/auditLogger";
import { ApiError } from "../middleware/errorHandler";
import DisciplinaryCase, {
  DisciplinaryOutcome,
} from "../models/DisciplinaryCase";
import Student from "../models/Student";
import AcademicYear from "../models/AcademicYear";
import Program from "../models/Program";
import mongoose from "mongoose";

const router = Router();
router.use(requireAuth);

// Helper to check if coordinator can access a student
async function canAccessStudent(req: AuthenticatedRequest, studentId: string): Promise<boolean> {
  if (req.user.role === "admin") return true;
  if (req.user.institutionWide) return true;
  
  const student = await Student.findById(studentId).populate("program", "departmentCode schoolCode").lean();
  if (!student) return false;
  
  const program = student.program as any;
  return program?.departmentCode === req.user.departmentCode && 
         program?.schoolCode === req.user.schoolCode;
}

// POST /disciplinary/raise
router.post(
  "/raise",
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { studentId, grounds, description, hearingDate, academicYearId } = req.body;
    const institutionId = req.user.institution;

    if (!studentId || !grounds || !description) {
      throw {
        statusCode: 400,
        message: "studentId, grounds, and description are required.",
      } as ApiError;
    }

    // SCOPING: Coordinator can only file cases for students in their department
    if (!await canAccessStudent(req, studentId)) {
      throw {
        statusCode: 403,
        message: "You can only file disciplinary cases for students in your department.",
      } as ApiError;
    }

    const student = await Student.findOne({
      _id: studentId,
      institution: institutionId,
    });
    if (!student) {
      throw {
        statusCode: 404,
        message: "Student not found in this institution.",
      } as ApiError;
    }

    let yearId = academicYearId;
    if (!yearId) {
      const currentYear = await AcademicYear.findOne({
        institution: institutionId,
        isCurrent: true,
      }).select("_id").lean();
      if (!currentYear)
        throw {
          statusCode: 400,
          message: "No current academic year set.",
        } as ApiError;
      yearId = currentYear._id;
    }

    const priorStatus = student.status;

    const disciplinaryCase = await DisciplinaryCase.create({
      institution: institutionId,
      student: studentId,
      raisedBy: req.user._id,
      academicYear: yearId,
      yearOfStudy: student.currentYearOfStudy,
      grounds,
      description,
      hearingDate: hearingDate ? new Date(hearingDate) : undefined,
      outcome: "PENDING",
      priorStudentStatus: priorStatus,
    });

    const currentAcademicYear = await AcademicYear.findById(yearId).select("year").lean();
    student.status = "disciplinary_suspension" as any;
    student.statusEvents.push({
      fromStatus: priorStatus,
      toStatus: "disciplinary_suspension",
      date: new Date(),
      academicYear: currentAcademicYear?.year ?? "Unknown",
      reason: `Disciplinary case filed: ${grounds}. Case ID: ${disciplinaryCase._id}`,
    });
    student.statusHistory.push({
      status: "disciplinary_suspension",
      previousStatus: priorStatus,
      date: new Date(),
      reason: `Disciplinary case ${disciplinaryCase._id} filed by coordinator.`,
    });

    await student.save();

    await logAudit(req, {
      action: "disciplinary_case_raised",
      actor: req.user._id,
      details: { caseId: disciplinaryCase._id, grounds, studentId, priorStatus },
    });

    res.status(201).json({
      message: "Disciplinary case filed. Student has been suspended pending hearing.",
      caseId: disciplinaryCase._id,
    });
  }),
);

// GET /disciplinary - SCOPED
router.get(
  "/",
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { outcome, page = "1", limit = "20" } = req.query;
    const institutionId = req.user.institution;

    const filter: Record<string, unknown> = { institution: institutionId };
    if (outcome && typeof outcome === "string") filter.outcome = outcome;

    // SCOPING: Coordinators only see cases from their department
    if (req.user.role === "coordinator" && !req.user.institutionWide) {
      const scopedProgramIds = await getScopedProgramIds(req);
      const studentsInDept = await Student.find({ 
        institution: institutionId,
        program: { $in: scopedProgramIds }
      }).distinct("_id");
      filter.student = { $in: studentsInDept };
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const total = await DisciplinaryCase.countDocuments(filter);

    const cases = await DisciplinaryCase.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit as string))
      .populate("student", "name regNo currentYearOfStudy program")
      .populate("raisedBy", "name email")
      .populate("resolvedBy", "name email")
      .lean();

    res.json({ total, page: parseInt(page as string), cases });
  }),
);

// GET /disciplinary/student/:studentId - SCOPED
router.get(
  "/student/:studentId",
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { studentId } = req.params;
    const institutionId = req.user.institution;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      throw { statusCode: 400, message: "Invalid student ID." } as ApiError;
    }

    // SCOPING: Coordinator can only view their own department's students
    if (!await canAccessStudent(req, studentId)) {
      throw {
        statusCode: 403,
        message: "You can only view disciplinary cases for students in your department.",
      } as ApiError;
    }

    const cases = await DisciplinaryCase.find({
      student: studentId,
      institution: institutionId,
    })
      .sort({ createdAt: -1 })
      .populate("raisedBy", "name email")
      .populate("resolvedBy", "name email")
      .lean();

    res.json(cases);
  }),
);

// GET /disciplinary/:caseId - SCOPED
router.get(
  "/:caseId",
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { caseId } = req.params;
    const institutionId = req.user.institution;

    const disciplinaryCase = await DisciplinaryCase.findOne({
      _id: caseId,
      institution: institutionId,
    })
      .populate("student", "name regNo currentYearOfStudy status")
      .populate("raisedBy", "name email")
      .populate("resolvedBy", "name email")
      .lean();

    if (!disciplinaryCase)
      throw { statusCode: 404, message: "Case not found." } as ApiError;

    // SCOPING: Coordinator can only view cases from their department
    if (req.user.role === "coordinator" && !req.user.institutionWide) {
      const studentId = (disciplinaryCase.student as any)?._id || disciplinaryCase.student;
      if (!await canAccessStudent(req, studentId.toString())) {
        throw {
          statusCode: 403,
          message: "You can only view disciplinary cases for students in your department.",
        } as ApiError;
      }
    }

    res.json(disciplinaryCase);
  }),
);

// PATCH /disciplinary/:caseId/outcome - ADMIN ONLY (already restricted)
router.patch(
  "/:caseId/outcome",
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { caseId } = req.params;
    const { outcome, outcomeNotes, suspensionStart, suspensionEnd, hearingDate } = req.body;
    const institutionId = req.user.institution;

    const validOutcomes: DisciplinaryOutcome[] = ["WARNING", "SENT_HOME", "REINSTATED", "DISCONTINUED", "DISMISSED"];
    if (!validOutcomes.includes(outcome)) {
      throw { statusCode: 400, message: `outcome must be one of: ${validOutcomes.join(", ")}` } as ApiError;
    }

    const disciplinaryCase = await DisciplinaryCase.findOne({
      _id: caseId,
      institution: institutionId,
    });
    if (!disciplinaryCase) throw { statusCode: 404, message: "Case not found." } as ApiError;
    if (disciplinaryCase.outcome !== "PENDING") {
      throw { statusCode: 409, message: "This case has already been resolved." } as ApiError;
    }

    const student = await Student.findById(disciplinaryCase.student);
    if (!student) throw { statusCode: 404, message: "Student record missing." } as ApiError;

    const currentAcademicYear = await AcademicYear.findById(disciplinaryCase.academicYear).select("year").lean();
    const yearStr = currentAcademicYear?.year ?? "Unknown";

    disciplinaryCase.outcome = outcome;
    disciplinaryCase.outcomeNotes = outcomeNotes;
    disciplinaryCase.resolvedBy = req.user._id as any;
    disciplinaryCase.resolvedAt = new Date();
    if (hearingDate) disciplinaryCase.hearingDate = new Date(hearingDate);
    if (suspensionStart) disciplinaryCase.suspensionStart = new Date(suspensionStart);
    if (suspensionEnd) disciplinaryCase.suspensionEnd = new Date(suspensionEnd);

    let newStudentStatus = student.status as string;

    if (outcome === "SENT_HOME") {
      // Next repeat number = highest RP{n}[D] already on record + 1 (parseInt("RP1") is NaN, so use a regex).
      const priorRp = /^RP(\d)/.exec(student.qualifierSuffix || "");
      const priorRepeats = ((student as any).academicHistory || []).filter((h: any) => h.isRepeatYear).length;
      const nextRp = Math.max(priorRp ? parseInt(priorRp[1], 10) : 0, priorRepeats) + 1;
      student.qualifierSuffix = REG_QUALIFIERS.disciplinaryRepeat(nextRp);
       newStudentStatus = "disciplinary_suspension";
     } else if (outcome === "DISCONTINUED") {
       newStudentStatus = "discontinued";
    } else if (outcome === "DISCONTINUED") {
      newStudentStatus = "discontinued";
      student.qualifierSuffix = "";
    } else if (outcome === "DISMISSED" || outcome === "WARNING") {
      newStudentStatus = disciplinaryCase.priorStudentStatus;
      student.qualifierSuffix = "";
    }

    student.status = newStudentStatus as any;
    student.statusEvents.push({
      fromStatus: "disciplinary_suspension",
      toStatus: newStudentStatus,
      date: new Date(),
      academicYear: yearStr,
      reason: `Disciplinary outcome: ${outcome}. ${outcomeNotes ?? ""}`,
    });
    student.statusHistory.push({
      status: newStudentStatus,
      previousStatus: "disciplinary_suspension",
      date: new Date(),
      reason: `Disciplinary case ${caseId} resolved: ${outcome}`,
    });

    await student.save();
    await disciplinaryCase.save();

    await logAudit(req, {
      action: "disciplinary_outcome_recorded",
      actor: req.user._id,
      details: { caseId, outcome, outcomeNotes, newStudentStatus },
    });

    res.json({ message: `Disciplinary outcome recorded: ${outcome}`, studentStatus: newStudentStatus });
  }),
);

// PATCH /disciplinary/:caseId/reinstate - ADMIN ONLY
router.patch(
  "/:caseId/reinstate",
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { caseId } = req.params;
    const { notes } = req.body;
    const institutionId = req.user.institution;

    const disciplinaryCase = await DisciplinaryCase.findOne({
      _id: caseId,
      institution: institutionId,
    });
    if (!disciplinaryCase) throw { statusCode: 404, message: "Case not found." } as ApiError;
    if (disciplinaryCase.outcome !== "SENT_HOME") {
      throw { statusCode: 409, message: "Only SENT_HOME cases can be reinstated." } as ApiError;
    }

    const student = await Student.findById(disciplinaryCase.student);
    if (!student) throw { statusCode: 404, message: "Student record missing." } as ApiError;

    const currentAcademicYear = await AcademicYear.findById(disciplinaryCase.academicYear).select("year").lean();

    disciplinaryCase.outcome = "REINSTATED";
    disciplinaryCase.outcomeNotes = (disciplinaryCase.outcomeNotes ?? "") + ` | REINSTATED: ${notes ?? ""}`;
    disciplinaryCase.resolvedAt = new Date();
    disciplinaryCase.resolvedBy = req.user._id as any;

    const restoredStatus = disciplinaryCase.priorStudentStatus;
    student.status = restoredStatus as any;
    student.qualifierSuffix = "";
    student.statusEvents.push({
      fromStatus: "disciplinary_suspension",
      toStatus: restoredStatus,
      date: new Date(),
      academicYear: currentAcademicYear?.year ?? "Unknown",
      reason: `Student reinstated. ${notes ?? ""}`,
    });

    await student.save();
    await disciplinaryCase.save();

    await logAudit(req, {
      action: "disciplinary_student_reinstated",
      actor: req.user._id,
      details: { caseId, restoredStatus, notes },
    });

    res.json({ message: "Student reinstated. Status restored.", restoredStatus });
  }),
);

// PATCH /disciplinary/:caseId/appeal - ADMIN ONLY
router.patch(
  "/:caseId/appeal",
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { caseId } = req.params;
    const { appealDate, appealOutcome, appealNotes } = req.body;
    const institutionId = req.user.institution;

    if (!["UPHELD", "DISMISSED"].includes(appealOutcome)) {
      throw { statusCode: 400, message: "appealOutcome must be UPHELD or DISMISSED." } as ApiError;
    }

    const disciplinaryCase = await DisciplinaryCase.findOne({
      _id: caseId,
      institution: institutionId,
    });
    if (!disciplinaryCase) throw { statusCode: 404, message: "Case not found." } as ApiError;
    if (disciplinaryCase.appealed) {
      throw { statusCode: 409, message: "An appeal has already been recorded for this case." } as ApiError;
    }

    disciplinaryCase.appealed = true;
    disciplinaryCase.appealDate = appealDate ? new Date(appealDate) : new Date();
    disciplinaryCase.appealOutcome = appealOutcome;
    disciplinaryCase.appealNotes = appealNotes;

    if (appealOutcome === "UPHELD") {
      const student = await Student.findById(disciplinaryCase.student);
      if (student) {
        student.status = disciplinaryCase.priorStudentStatus as any;
        student.qualifierSuffix = "";
        student.statusEvents.push({
          fromStatus: student.status as string,
          toStatus: disciplinaryCase.priorStudentStatus,
          date: new Date(),
          academicYear: "Appeal",
          reason: `Appeal upheld. Case ${caseId}. ${appealNotes ?? ""}`,
        });
        await student.save();
      }
      disciplinaryCase.outcome = "REINSTATED";
    }

    await disciplinaryCase.save();

    await logAudit(req, {
      action: "disciplinary_appeal_recorded",
      actor: req.user._id,
      details: { caseId, appealOutcome, appealNotes },
    });

    res.json({ message: `Appeal ${appealOutcome === "UPHELD" ? "upheld — student reinstated" : "dismissed — original outcome stands"}.` });
  }),
);

export default router;