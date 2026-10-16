// serverside/src/routes/programUnits.ts
import { Response, Router } from "express";
import ProgramUnit from "../models/ProgramUnit";
import Mark from "../models/Mark";
import { getScopedProgramIds, requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import type { AuthenticatedRequest } from "../middleware/auth";
import mongoose from "mongoose";
import multer from "multer";
import Program from "../models/Program";
import Unit from "../models/Unit";
import { logAudit } from "../lib/auditLogger";
import { invalidateCache } from "../utils/cache";
import {
  parseCurriculumSheet,
  planCurriculum,
  applyCurriculumPlan,
  buildCurriculumTemplate,
  buildGraduationAudit,
  type ProgramCtx,
} from "../services/curriculumService";

const router = Router();

const curriculumUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.(xlsx|xls|csv)$/i.test(file.originalname)),
});

/** Program must exist in this institution AND be inside the caller's department/school scope. */
async function loadScopedProgram(req: AuthenticatedRequest, programId: unknown): Promise<ProgramCtx | null> {
  if (!mongoose.Types.ObjectId.isValid(String(programId))) return null;
  const allowed = (await getScopedProgramIds(req)).map(String);
  if (!allowed.includes(String(programId))) return null;
  return Program.findOne({ _id: programId, institution: req.user.institution })
    .select("code name schoolCode departmentCode durationYears").lean<ProgramCtx>();
}

// GET /program-units/stats - SCOPED
router.get("/stats", requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const institutionId = req.user.institution;
    
    // SCOPING: Coordinators only see stats for programs in their department
    if (req.user.role === "coordinator" && !req.user.institutionWide) {
      const scopedProgramIds = await getScopedProgramIds(req);
      const count = await ProgramUnit.countDocuments({
        institution: institutionId,
        program: { $in: scopedProgramIds }
      });
      res.json({ totalUnits: count });
    } else {
      // Admin or institution-wide coordinator sees all
      const count = await ProgramUnit.countDocuments({
        institution: institutionId,
      });
      res.json({ totalUnits: count });
    }
  })
);

// --- POST /program-units/bulk: add several units to ONE year/semester slot of a program ---
// Body: { programId, requiredYear, requiredSemester, units: [{ unitId } | { code, name }, isElective? ] }
// Units given as { code, name } that do not exist yet are created in the program's department.
router.post("/bulk", requireAuth,
  requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, requiredYear, requiredSemester, units } = req.body as {
      programId: string; requiredYear: number; requiredSemester: number;
      units: Array<{ unitId?: string; code?: string; name?: string; isElective?: boolean }>;
    };
    const program = await loadScopedProgram(req, programId);
    if (!program) return res.status(404).json({ message: "Program not found in your scope." });

    const year = Number(requiredYear), sem = Number(requiredSemester);
    if (!Number.isInteger(year) || year < 1 || year > Math.min(program.durationYears || 6, 6)) {
      return res.status(400).json({ message: `Year of study must be between 1 and ${program.durationYears}.` });
    }
    if (![1, 2, 3].includes(sem)) return res.status(400).json({ message: "Semester must be 1, 2 or 3." });
    if (!Array.isArray(units) || units.length === 0) return res.status(400).json({ message: "Select at least one unit." });
    if (units.length > 60) return res.status(400).json({ message: "At most 60 units per request." });

    const institutionId = req.user.institution;
    const resolved: Array<{ unitId: mongoose.Types.ObjectId; code: string; isElective: boolean }> = [];
    const skipped: string[] = [];
    let created = 0;

    for (const u of units) {
      let unitDoc: { _id: mongoose.Types.ObjectId; code: string } | null = null;
      if (u.unitId && mongoose.Types.ObjectId.isValid(u.unitId)) {
        unitDoc = await Unit.findOne({ _id: u.unitId, institution: institutionId }).select("code").lean<{ _id: mongoose.Types.ObjectId; code: string }>();
      } else if (u.code && u.name) {
        const code = u.code.trim().toUpperCase();
        unitDoc = await Unit.findOne({ institution: institutionId, departmentCode: program.departmentCode, code }).select("code").lean<{ _id: mongoose.Types.ObjectId; code: string }>();
        if (!unitDoc) {
          const nu = await Unit.create({
            institution: institutionId, code, name: u.name.trim(),
            departmentCode: program.departmentCode, schoolCode: program.schoolCode,
          });
          unitDoc = { _id: nu._id as mongoose.Types.ObjectId, code: nu.code };
          created++;
        }
      }
      if (!unitDoc) { skipped.push(u.code || u.unitId || "?"); continue; }
      resolved.push({ unitId: unitDoc._id, code: unitDoc.code, isElective: !!u.isElective });
    }

    const already = await ProgramUnit.find({
      institution: institutionId, program: program._id, unit: { $in: resolved.map((r) => r.unitId) },
    }).select("unit").lean<Array<{ unit: mongoose.Types.ObjectId }>>();
    const alreadySet = new Set(already.map((a) => a.unit.toString()));

    const toLink = resolved.filter((r) => !alreadySet.has(r.unitId.toString()));
    if (toLink.length) {
      await ProgramUnit.insertMany(
        toLink.map((r) => ({
          institution: institutionId, program: program._id, unit: r.unitId,
          requiredYear: year, requiredSemester: sem, isElective: r.isElective,
        })),
      );
    }
    if (created) invalidateCache(`units:${institutionId}:${program.departmentCode}`);

    await logAudit(req, {
      action: "curriculum_slot_units_linked", actor: req.user._id,
      details: { programId: String(program._id), year, semester: sem, linked: toLink.length, created },
    });
    res.status(201).json({
      linked: toLink.length, createdUnits: created,
      alreadyLinked: resolved.filter((r) => alreadySet.has(r.unitId.toString())).map((r) => r.code),
      skipped,
    });
  })
);

// --- GET /program-units/template?programId= : Excel template (prefilled with the current curriculum) ---
router.get("/template", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const program = await loadScopedProgram(req, req.query.programId);
    if (!program) return res.status(404).json({ message: "Program not found in your scope." });
    const buf = await buildCurriculumTemplate(req.user.institution, program);
    res
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="Curriculum_${program.code}.xlsx"`)
      .header("Access-Control-Expose-Headers", "Content-Disposition")
      .send(buf);
  })
);

// --- POST /program-units/upload?programId=&commit=true|false&removeMissing=true|false ---
// commit=false (default) → preview only: what would be created / changed / left alone / rejected.
// commit=true            → apply. Rows with errors are skipped; valid rows are applied.
router.post("/upload", requireAuth,
  requireRole("coordinator"),
 curriculumUpload.single("file"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const program = await loadScopedProgram(req, req.query.programId);
    if (!program) return res.status(404).json({ message: "Program not found in your scope." });
    if (!req.file) return res.status(400).json({ message: "Attach an .xlsx or .csv curriculum file." });

    let plan;
    try {
      plan = await planCurriculum(
        req.user.institution, program,
        parseCurriculumSheet(req.file.buffer, program.durationYears),
      );
    } catch (e) {
      return res.status(400).json({ message: e instanceof Error ? e.message : "Could not read the file." });
    }

    const commit = req.query.commit === "true";
    if (!commit) return res.json({ committed: false, plan });

    const result = await applyCurriculumPlan(req.user.institution, program, plan, req.query.removeMissing === "true");
    invalidateCache(`units:${req.user.institution}:${program.departmentCode}`);
    await logAudit(req, {
      action: "curriculum_uploaded", actor: req.user._id,
      details: { programId: String(program._id), file: req.file.originalname, ...result },
    });
    res.json({ committed: true, result, errors: plan.errors });
  })
);

// --- GET /program-units/audit?studentId= : required vs passed vs missing units for graduation ---
router.get("/audit", requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const studentId = String(req.query.studentId ?? "");
    if (!mongoose.Types.ObjectId.isValid(studentId)) return res.status(400).json({ message: "Valid studentId required." });
    const audit = await buildGraduationAudit(req.user.institution, studentId);
    if (!audit) return res.status(404).json({ message: "Student not found." });
    const allowed = (await getScopedProgramIds(req)).map(String);
    if (!allowed.includes(audit.program._id)) return res.status(403).json({ message: "Student is outside your department scope." });
    res.json(audit);
  })
);


// --- POST /program-units: Link a Unit to a Program (Curriculum Definition) ---
router.post("/", requireAuth,
  requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId, unitId, requiredYear, requiredSemester, isElective } = req.body;

    if (!programId || !unitId || !requiredYear || !requiredSemester) {
      return res.status(400).json({ 
        message: "Program ID, Unit ID, Year, and Semester are required." 
      });
    }

    const institutionId = req.user.institution;
    
    // The program must be inside the caller's scope
    if (!(await loadScopedProgram(req, programId))) {
      return res.status(404).json({ message: "Program not found in your scope." });
    }

    // Check if the link already exists (enforced by index, but good for user feedback)
    const exists = await ProgramUnit.findOne({
      program: programId,
      unit: unitId,
      institution: institutionId,
    });

    if (exists) {
      return res.status(400).json({ 
        message: "This unit is already linked to this program. Use PUT to update." 
      });
    }

    const programUnit = await ProgramUnit.create({
      institution: institutionId,
      program: programId,
      unit: unitId,
      requiredYear: Number(requiredYear),
      requiredSemester: Number(requiredSemester),
      isElective: Boolean(isElective),
    });

    // Populate references for a rich response
    await programUnit.populate([
      { path: "program", select: "name code" },
      { path: "unit", select: "name code" }
    ]);

    res.status(201).json(programUnit);
  })
);

// --- GET /program-units?programId: Get all Units for a specific Program (Curriculum View) ---
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId } = req.query;

    if (!programId) {
      return res.status(400).json({ 
        message: "A programId query parameter is required to view the curriculum." 
      });
    }

    // 1. Find all ProgramUnit documents matching the programId
    const programUnits = await ProgramUnit.find({
      institution: req.user.institution,
      program: programId,
    })
    // 2. Populate the linked Program and Unit details
    .populate([
      { path: "program", select: "name code" },
      { path: "unit", select: "name code" }
    ])
    // 3. Sort by year, semester, and unit code for a readable curriculum list
    .sort({ requiredYear: 1, requiredSemester: 1, "unit.code": 1 }) 
    .lean();

    // 4. Clean the output for the frontend
    const formattedCurriculum = programUnits.map((pu: any) => ({
      _id: pu._id.toString(),
      requiredYear: pu.requiredYear,
      requiredSemester: pu.requiredSemester,
      isElective: pu.isElective,
      // Flatten the Unit details
      unit: {
        _id: pu.unit._id.toString(),
        code: pu.unit.code,
        name: pu.unit.name,
      },
      // Keep Program ID/Name context if needed
      program: {
          _id: pu.program._id.toString(),
          name: pu.program.name,
      }
    }));

    res.json(formattedCurriculum);
  })
);

// --- GET /program-units/lookup?programId=...: Get a simple list of Units for dropdowns, filtered by Program ---

router.get(
  "/lookup",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { programId } = req.query;

    // 1. Validation check
    if (!mongoose.Types.ObjectId.isValid(programId as string)) {
      return res.status(400).json({
        message: "Invalid Program ID format. Expected ObjectId.",
      });
    }

    try {
      // 2. Querying ProgramUnit (The Join Table)
      const curriculum = await ProgramUnit.find({
        institution: req.user.institution,
        program: programId,
      })
      .populate("unit", "code name") // Make sure "unit" matches the field in your ProgramUnit schema
      .lean();

      // 3. Mapping with a safety check (Senior Pattern)
      const flatList = curriculum
        .filter((item: any) => item.unit) // Remove entries where the unit might have been deleted
        .map((item: any) => ({
          code: item.unit.code,
          name: item.unit.name,
          _id: item.unit._id.toString()
        }));

      res.json(flatList);
    } catch (dbError) {
      console.error("Database Error in Lookup:", dbError);
      res.status(500).json({ message: "Database query failed" });
    }
  })
);

// --- PUT /program-units/:id: Update a Curriculum Link (Year/Semester/Elective Status) ---
router.put(
  "/:id",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    // We only allow changing the context fields, not the unit or program link itself.
    const { requiredYear, requiredSemester, isElective } = req.body;

    const updateData: any = {};
    if (requiredYear !== undefined) updateData.requiredYear = Number(requiredYear);
    if (requiredSemester !== undefined) updateData.requiredSemester = Number(requiredSemester);
    if (isElective !== undefined) updateData.isElective = Boolean(isElective);

    // If no valid fields are provided for update
    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ message: "No valid fields provided for update." });
    }

    const programUnit = await ProgramUnit.findOneAndUpdate(
      { _id: req.params.id, institution: req.user.institution },
      updateData,
      { new: true, runValidators: true }
    )
    .populate([
        { path: "program", select: "name code" },
        { path: "unit", select: "name code" }
    ]);

    if (!programUnit) {
      return res.status(404).json({ message: "Curriculum link not found." });
    }

    res.json(programUnit);
  })
);


// --- DELETE /program-units/:id: Remove a Curriculum Link ---
router.delete(
  "/:id",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const programUnitId = req.params.id;
    const institutionId = req.user.institution;
    
    // --- CONSTRAINT ENFORCEMENT: Check if student marks are recorded for this link ---
    const marksCount = await Mark.countDocuments({
      programUnit: programUnitId, // Assuming your Mark model links to ProgramUnit
      institution: institutionId
    });

    if (marksCount > 0) {
      return res.status(400).json({
        message: `Cannot remove this curriculum link. ${marksCount} student marks rely on this link for historical tracking. Please archive the link instead of deleting it.`
      });
    }
    // --- END CONSTRAINT CHECK ---

    const programUnit = await ProgramUnit.findOneAndDelete({
      _id: programUnitId,
      institution: institutionId,
    });

    if (!programUnit) {
      return res.status(404).json({ message: "Curriculum link not found." });
    }

    res.json({ message: "Unit successfully delinked from the program (Curriculum updated)." });
  })
);
export default router;