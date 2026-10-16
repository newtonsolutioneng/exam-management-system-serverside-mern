// // src/routes/programs.ts
// import { Response, Router } from "express";
// import Program from "../models/Program";
// import { requireAuth, requireRole } from "../middleware/auth";
// import { asyncHandler } from "../middleware/asyncHandler";
// import { logAudit } from "../lib/auditLogger";
// import type { AuthenticatedRequest } from "../middleware/auth";
// import { cached, invalidateCache } from "../utils/cache";

// const router = Router();

// // CREATE
// router.post("/", requireAuth,
//   requireRole("admin", "coordinator"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { name, code, description, durationYears } = req.body;

//     const exists = await Program.findOne({
//       code: code?.toUpperCase(),
//       institution: req.user.institution,
//     });

//     if (exists) {
//       await logAudit(req, {
//         action: "program_create_failed",
//         actor: req.user._id,
//         details: {
//           reason: "Duplicate program code",
//           attemptedCode: code?.toUpperCase(),
//           attemptedName: name,
//           institutionId: req.user.institution?.toString(),
//         },
//       });
//       return res.status(400).json({
//         message: "Program code already exists in your institution",
//       });
//     }

//     const program = await Program.create({
//       name,
//       code: code?.toUpperCase(),
//       description,
//       durationYears,
//       institution: req.user.institution,
//     });

    

//     await logAudit(req, {
//       action: "program_created",
//       actor: req.user._id,
//       details: {
//         name: program.name,
//         code: program.code,
//         durationYears: program.durationYears,
//         institutionId: req.user.institution?.toString(),
//       },
//     });
//     invalidateCache(`programs:${req.user.institution}`);
//     res.status(201).json(program);
//   })
// );

// // GET ALL
// router.get("/", requireAuth,
//   requireRole("admin", "coordinator"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     // const programs = await Program.find({
//     //   institution: req.user.institution,
//     // }).sort({ code: 1 });

//   const institutionId = req.user.institution;
//   // Wrap in cache
//   const programs = await cached(`programs:${institutionId}`, () => 
//     Program.find({ institution: institutionId }).sort({ code: 1 }).lean() 
//   );

//   await logAudit(req, { action: "programs_listed", actor: req.user._id, details: { count: programs.length, institutionId: institutionId?.toString() }});
//   res.json(programs);
// }));

// // UPDATE
// router.put(
//   "/:id",
//   requireAuth,
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const before = await Program.findOne({
//       _id: req.params.id,
//       institution: req.user.institution,
//     }).lean();

//     if (!before) {
//       await logAudit(req, {
//         action: "program_update_failed",
//         actor: req.user._id,
//         details: {
//           programId: req.params.id,
//           reason: "Not found or institution mismatch",
//           attemptedChanges: req.body,
//           institutionId: req.user.institution?.toString(),
//         },
//       });
//       return res.status(404).json({ message: "Program not found" });
//     }

//     const program = await Program.findOneAndUpdate(
//       { _id: req.params.id, institution: req.user.institution },
//       req.body,
//       { new: true, runValidators: true }
//     );

//     await logAudit(req, {
//       action: "program_updated",
//       actor: req.user._id,
//       details: {
//         programId: req.params.id,
//         institutionId: req.user.institution?.toString(),
//         before: {
//           name: before.name,
//           code: before.code,
//           durationYears: before.durationYears,
//         },
//         after: req.body,
//       },
//     });
//     invalidateCache(`programs:${req.user.institution}`);
//     res.json(program);
//   })
// );

// // DELETE
// router.delete("/:id", requireAuth,
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const program = await Program.findOneAndDelete({ _id: req.params.id, institution: req.user.institution });

//     if (!program) {
//       await logAudit(req, { action: "program_delete_failed", actor: req.user._id, details: { programId: req.params.id, reason: "Not found or institution mismatch", institutionId: req.user.institution?.toString()}});
//       return res.status(404).json({ message: "Program not found" });
//     }

//     await logAudit(req, { action: "program_deleted", actor: req.user._id, details: {programId: req.params.id, name: program.name, code: program.code, durationYears: program.durationYears, institutionId: req.user.institution?.toString()}});
//     invalidateCache(`programs:${req.user.institution}`);
//     res.json({ message: "Program deleted successfully" });
//   })
// );

// export default router;







// // src/routes/programs.ts
// import { Response, Router } from "express";
// import Program from "../models/Program";
// import { requireAuth, requireRole, getScopedProgramIds } from "../middleware/auth";
// import { asyncHandler } from "../middleware/asyncHandler";
// import { logAudit } from "../lib/auditLogger";
// import type { AuthenticatedRequest } from "../middleware/auth";
// import { cached, invalidateCache } from "../utils/cache";

// interface ApiError {
//   statusCode: number;
//   message: string;
// }

// interface MongoError {
//   code?: number;
//   keyPattern?: Record<string, number>;
// }

// const router = Router();

// // CREATE
// router.post(
//   "/",
//   requireAuth,
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const {
//       name, code, description, durationYears, degreeType, schoolCode, departmentCode,
//     } = req.body as {
//       name:           string;
//       code:           string;
//       description?:   string;
//       durationYears:  number;
//       degreeType:     string;
//       schoolCode:     string;
//       departmentCode: string;
//     };
    
//     // Validation
//     if (!name || !code) {
//       throw { statusCode: 400, message: "Name and code are required" } as ApiError;
//     }

//     if (!schoolCode || !departmentCode) {
//       throw { statusCode: 400, message: "School and department are required" } as ApiError;
//     }

//     // Check for duplicate code within institution
//     const existingByCode = await Program.findOne({
//       code: code?.toUpperCase(),
//       institution: req.user.institution,
//     });

//     if (existingByCode) {
//       await logAudit(req, {
//         action: "program_create_failed",
//         actor: req.user._id,
//         details: {
//           reason: "Duplicate program code",
//           attemptedCode: code?.toUpperCase(),
//           attemptedName: name,
//           institutionId: req.user.institution?.toString(),
//         },
//       });
//       throw { statusCode: 409, message: "A program with this code already exists in your institution" } as ApiError;
//     }

//     // Check for duplicate name within same school/department
//     const existingByName = await Program.findOne({
//       cleanName: normalizedName,
//       institution: req.user.institution,
//       schoolCode,
//       departmentCode,
//     });

//     if (existingByName) {
//       await logAudit(req, {
//         action: "program_create_failed",
//         actor: req.user._id,
//         details: {
//           reason: "Duplicate program name in department",
//           attemptedName: name,
//           schoolCode,
//           departmentCode,
//         },
//       });
//       throw { statusCode: 409, message: "A program with this name already exists in this department" } as ApiError;
//     }

//     const program = await Program.create({
//       name,
//       code: code?.toUpperCase(),
//       description,
//       durationYears: durationYears || 5,
//       degreeType: degreeType || "BSc",
//       schoolCode,
//       departmentCode,
//       institution: req.user.institution,
//       intakes: ["SEPT"],
//       supportedEntryTypes: ["Direct"],
//       isActive: true,
//     });

//     await logAudit(req, {
//       action: "program_created",
//       actor: req.user._id,
//       details: {
//         name: program.name,
//         code: program.code,
//         durationYears: program.durationYears,
//         schoolCode,
//         departmentCode,
//         institutionId: req.user.institution?.toString(),
//       },
//     });

//     invalidateCache(`programs:${req.user.institution}`);
//     res.status(201).json(program);
//   })
// );

// // GET ALL
// router.get(
//   "/",
//   requireAuth,
//   requireRole("admin", "coordinator"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     // const institutionId = req.user.institution;

//     // const programs = await cached(`programs:${institutionId}`, () =>
//     //   Program.find({ institution: institutionId })
//     //     .select("-__v")
//     //     .sort({ code: 1 })
//     //     .lean()
//     // );

//     const allowedIds = await getScopedProgramIds(req);

//     const programs = await Program.find({
//       institution: req.user.institution,
//       _id:         { $in: allowedIds },
//       isActive:    true,
//     })
//       .select("name code durationYears degreeType schoolCode departmentCode")
//       .sort({ name: 1 })
//       .lean();

//     await logAudit(req, {
//       action: "programs_listed",
//       actor: req.user._id,
//       details: {
//         count: programs.length,
//         // institutionId: institutionId?.toString(),
//       },
//     });

//     res.json(programs);
//   })
// );

// // GET SINGLE
// // router.get(
// //   "/:id",
// //   requireAuth,
// //   // requireRole("admin", "coordinator"),
// //   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
// //     const { id } = req.params;

// //     const program = await Program.findOne({
// //       _id: id,
// //       institution: req.user.institution,
// //     }).lean();

// //     if (!program) {
// //       throw { statusCode: 404, message: "Program not found" } as ApiError;
// //     }

// //     res.json(program);
// //   })
// // );

// router.get(
//   "/:id",
//   requireAuth,
//   asyncHandler(
//     async (req: AuthenticatedRequest, res: Response): Promise<void> => {
//       const allowedIds = await getScopedProgramIds(req);
//       const program = await Program.findOne({
//         _id: req.params.id,
//         institution: req.user.institution,
//         _id2: { $in: allowedIds },
//       }).lean();

//       if (!program) {
//         throw {
//           statusCode: 404,
//           message: "Program not found or outside your access scope",
//         } as ApiError;
//       }
//       res.json(program);
//     },
//   ),
// );

// // UPDATE
// router.put(
//   "/:id",
//   requireAuth,
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { id } = req.params;
//     const updateData = req.body;

//     const before = await Program.findOne({
//       _id: id,
//       institution: req.user.institution,
//     }).lean();

//     if (!before) {
//       await logAudit(req, {
//         action: "program_update_failed",
//         actor: req.user._id,
//         details: {
//           programId: id,
//           reason: "Not found or institution mismatch",
//           institutionId: req.user.institution?.toString(),
//         },
//       });
//       throw { statusCode: 404, message: "Program not found" } as ApiError;
//     }

//     // Check for name conflict if name is being changed
//     if (updateData.name && updateData.name !== before.name) {
//       const nameConflict = await Program.findOne({
//         _id: { $ne: id },
//         name: { $regex: new RegExp(`^${updateData.name.trim()}$`, "i") },
//         institution: req.user.institution,
//         schoolCode: updateData.schoolCode || before.schoolCode,
//         departmentCode: updateData.departmentCode || before.departmentCode,
//       });

//       if (nameConflict) {
//         throw { statusCode: 409, message: "A program with this name already exists in this department" } as ApiError;
//       }
//     }

//     // Check for code conflict if code is being changed
//     if (updateData.code && updateData.code !== before.code) {
//       const codeConflict = await Program.findOne({
//         _id: { $ne: id },
//         code: updateData.code.toUpperCase(),
//         institution: req.user.institution,
//       });

//       if (codeConflict) {
//         throw { statusCode: 409, message: "A program with this code already exists" } as ApiError;
//       }
//     }

//     const program = await Program.findOneAndUpdate(
//       { _id: id, institution: req.user.institution },
//       { $set: updateData },
//       { new: true, runValidators: true }
//     );

//     await logAudit(req, {
//       action: "program_updated",
//       actor: req.user._id,
//       details: {
//         programId: id,
//         institutionId: req.user.institution?.toString(),
//         before: {
//           name: before.name,
//           code: before.code,
//           durationYears: before.durationYears,
//         },
//         after: updateData,
//       },
//     });

//     invalidateCache(`programs:${req.user.institution}`);
//     res.json(program);
//   })
// );

// // DELETE
// router.delete(
//   "/:id",
//   requireAuth,
//   requireRole("admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { id } = req.params;

//     const program = await Program.findOne({
//       _id: id,
//       institution: req.user.institution,
//     });

//     if (!program) {
//       await logAudit(req, {
//         action: "program_delete_failed",
//         actor: req.user._id,
//         details: {
//           programId: id,
//           reason: "Not found or institution mismatch",
//           institutionId: req.user.institution?.toString(),
//         },
//       });
//       throw { statusCode: 404, message: "Program not found" } as ApiError;
//     }

//     // Check if program has any units assigned
//     const ProgramUnit = require("../models/ProgramUnit").default;
//     const hasUnits = await ProgramUnit.exists({ program: id });

//     if (hasUnits) {
//       throw {
//         statusCode: 409,
//         message: "Cannot delete program with existing unit assignments. Remove units first.",
//       } as ApiError;
//     }

//     // Check if program has any students
//     const Student = require("../models/Student").default;
//     const hasStudents = await Student.exists({ program: id });

//     if (hasStudents) {
//       throw {
//         statusCode: 409,
//         message: "Cannot delete program with enrolled students. Archive students first.",
//       } as ApiError;
//     }

//     await program.deleteOne();

//     await logAudit(req, {
//       action: "program_deleted",
//       actor: req.user._id,
//       details: {
//         programId: id,
//         name: program.name,
//         code: program.code,
//         durationYears: program.durationYears,
//         institutionId: req.user.institution?.toString(),
//       },
//     });

//     invalidateCache(`programs:${req.user.institution}`);
//     res.json({ message: "Program deleted successfully" });
//   })
// );

// export default router;








// serverside/src/routes/programs.ts

import { Response, Router } from "express";
import Program from "../models/Program";
import { requireAuth, requireRole, getScopedProgramIds } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { logAudit } from "../lib/auditLogger";
import type { AuthenticatedRequest } from "../middleware/auth";
import { cached, invalidateCache } from "../utils/cache";
import { normalizeProgramName } from "../services/programNormalizer";
import Student from "../models/Student";
import { getIntakeDefinitions } from "../utils/intakeDefinitions";
import { normalizeIntake, intakeCodesOf, type IntakeDefinition } from "../utils/semesterLabels";

/** Validates a program's intake list against the institution's definitions. */
function cleanProgramIntakes(raw: unknown, defs: IntakeDefinition[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw { statusCode: 400, message: "Select at least one intake for the program." } as ApiError;
  }
  const out: string[] = [];
  for (const r of raw) {
    const code = normalizeIntake(r, defs);
    if (!code) {
      throw {
        statusCode: 400,
        message: `Unknown intake "${String(r)}". Defined intakes: ${intakeCodesOf(defs).join(", ")}.`,
      } as ApiError;
    }
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

interface ApiError {
  statusCode: number;
  message: string;
}

const router = Router();

// ── POST /programs ────────────────────────────────────────────────────────
router.post("/", requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const {
      name,
      code,
      description,
      durationYears,
      degreeType,
      schoolCode,
      departmentCode,
      intakes,
    } = req.body as {
      name: string;
      code: string;
      description?: string;
      durationYears: number;
      degreeType: string;
      schoolCode: string;
      departmentCode: string;
      intakes?: string[];
    };

    // ── Validation ──────────────────────────────────────────────────────
    if (!name || !code) {
      throw { statusCode: 400, message: "Name and code are required" } as ApiError;
    }

    if (!schoolCode || !departmentCode) {
      throw { statusCode: 400, message: "School and department are required" } as ApiError;
    }

    const normalizedName = normalizeProgramName(name.trim());
    const upperCode = code.trim().toUpperCase();

    // Intakes: from the institution's definitions; default = its first-semester intake
    const intakeDefs = await getIntakeDefinitions(req.user.institution);
    const programIntakes = intakes === undefined
      ? [(intakeDefs.find((d) => d.defaultSemester === 1) ?? intakeDefs[0]).code]
      : cleanProgramIntakes(intakes, intakeDefs);

    // ── Check duplicate code (institution-wide) ─────────────────────────
    const existingByCode = await Program.findOne({
      code: upperCode,
      institution: req.user.institution,
    });

    if (existingByCode) {
      await logAudit(req, {
        action: "program_create_failed",
        actor: req.user._id,
        details: {
          reason: "Duplicate program code",
          attemptedCode: upperCode,
          attemptedName: name,
          institutionId: req.user.institution?.toString(),
        },
      });
      throw {
        statusCode: 409,
        message: `A program with code "${upperCode}" already exists in your institution.`,
      } as ApiError;
    }

    // ── Check duplicate name (within same department, case-insensitive) ──
    const existingByName = await Program.findOne({
      cleanName: normalizedName,
      institution: req.user.institution,
      schoolCode,
      departmentCode,
    });

    if (existingByName) {
      await logAudit(req, {
        action: "program_create_failed",
        actor: req.user._id,
        details: {
          reason: "Duplicate program name in department",
          attemptedName: name,
          normalizedName,
          schoolCode,
          departmentCode,
        },
      });
      throw {
        statusCode: 409,
        message: `A program with this name already exists in the ${departmentCode} department.`,
      } as ApiError;
    }

    // ── Create ──────────────────────────────────────────────────────────
    const program = await Program.create({
      name,
      code: upperCode,
      description,
      durationYears: durationYears || 5,
      degreeType: degreeType || "BSc",
      schoolCode,
      departmentCode,
      institution: req.user.institution,
      intakes: programIntakes,
      supportedEntryTypes: ["Direct"],
      isActive: true,
    });

    // cleanName is auto-set by the pre-save hook — no need to set it here

    await logAudit(req, {
      action: "program_created",
      actor: req.user._id,
      details: {
        programId: program._id?.toString(),
        name: program.name,
        code: program.code,
        durationYears: program.durationYears,
        schoolCode,
        departmentCode,
        institutionId: req.user.institution?.toString(),
      },
    });

    // Invalidate the programs cache for this institution
    invalidateCache(`programs:${req.user.institution}`);

    res.status(201).json(program);
  }),
);

// ── GET /programs ─────────────────────────────────────────────────────────
// router.get(
//   "/",
//   requireAuth,
//   requireRole("admin", "coordinator"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const allowedIds = await getScopedProgramIds(req);
//     const institutionId = req.user.institution?.toString() ?? "";

//     // Cache the full list — fetcher only runs on cache miss
//     const programs = await cached(
//       `programs:${institutionId}`,
//       async () => {
//         const all = await Program.find({
//           institution: req.user.institution,
//           _id: { $in: allowedIds },
//           isActive: true,
//         })
//           .select("name code durationYears degreeType schoolCode departmentCode description isActive")
//           .sort({ name: 1 })
//           .lean();
//         return all;
//       },
//       600, // 10-minute TTL — programs change very rarely
//     );

//     await logAudit(req, {
//       action: "programs_listed",
//       actor: req.user._id,
//       details: { count: programs.length },
//     });

//     res.json(programs);
//   }),
// );

// serverside/src/routes/programs.ts — UPDATE the GET handler

router.get(
  "/",
  requireAuth,
  requireRole("admin", "coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const allowedIds = await getScopedProgramIds(req);
    const institutionId = req.user.institution?.toString() ?? "";
    
    // Include user ID in cache key so admin and coordinator get different caches
    const userId = req.user._id?.toString() ?? "";
    const cacheKey = `programs:${institutionId}:${userId}`;

    const programs = await cached(
      cacheKey,  // ← CHANGED — now per-user, not per-institution
      async () => {
        const all = await Program.find({
          institution: req.user.institution,
          _id: { $in: allowedIds },
          isActive: true,
        })
          .select("name code durationYears degreeType schoolCode departmentCode description isActive")
          .sort({ name: 1 })
          .lean();
        return all;
      },
      600,
    );

    await logAudit(req, {
      action: "programs_listed",
      actor: req.user._id,
      details: { count: programs.length },
    });

    res.json(programs);
  }),
);

// ── GET /programs/:id ─────────────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  asyncHandler(
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const allowedIds = await getScopedProgramIds(req);

      // Check scope first — is this program even accessible?
      if (!allowedIds.some((id) => id.toString() === req.params.id)) {
        throw {
          statusCode: 404,
          message: "Program not found or outside your access scope",
        } as ApiError;
      }

      const program = await Program.findOne({
        _id: req.params.id,
        institution: req.user.institution,
      }).lean();

      if (!program) {
        throw {
          statusCode: 404,
          message: "Program not found",
        } as ApiError;
      }

      res.json(program);
    },
  ),
);

// ── PUT /programs/:id ─────────────────────────────────────────────────────
router.put(
  "/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const updateData = req.body as Partial<{
      name: string;
      code: string;
      description: string;
      durationYears: number;
      degreeType: string;
      schoolCode: string;
      departmentCode: string;
      isActive: boolean;
      intakes: string[];
    }>;

    // ── Find existing ───────────────────────────────────────────────────
    const before = await Program.findOne({
      _id: id,
      institution: req.user.institution,
    }).lean();

    if (!before) {
      await logAudit(req, {
        action: "program_update_failed",
        actor: req.user._id,
        details: {
          programId: id,
          reason: "Not found or institution mismatch",
        },
      });
      throw { statusCode: 404, message: "Program not found" } as ApiError;
    }

    // ── Check for name conflict (within same department) ────────────────
    if (updateData.name && updateData.name !== before.name) {
      const normalizedName = normalizeProgramName(updateData.name.trim());
      const nameConflict = await Program.findOne({
        _id: { $ne: id },
        cleanName: normalizedName,
        institution: req.user.institution,
        schoolCode: updateData.schoolCode || before.schoolCode,
        departmentCode: updateData.departmentCode || before.departmentCode,
      });

      if (nameConflict) {
        throw {
          statusCode: 409,
          message: "A program with this name already exists in this department.",
        } as ApiError;
      }
    }

    // ── Check for code conflict (institution-wide) ─────────────────────
    if (updateData.code && updateData.code.toUpperCase() !== before.code) {
      const codeConflict = await Program.findOne({
        _id: { $ne: id },
        code: updateData.code.toUpperCase(),
        institution: req.user.institution,
      });

      if (codeConflict) {
        throw {
          statusCode: 409,
          message: `Program code "${updateData.code.toUpperCase()}" is already in use.`,
        } as ApiError;
      }
    }

    // ── Intakes: validate, and keep any intake that enrolled students use ──
    if (updateData.intakes !== undefined) {
      const intakeDefs = await getIntakeDefinitions(req.user.institution);
      const cleaned = cleanProgramIntakes(updateData.intakes, intakeDefs);
      const removed = ((before as { intakes?: string[] }).intakes ?? []).filter((i) => !cleaned.includes(i));
      for (const intake of removed) {
        const n = await Student.countDocuments({
          institution: req.user.institution,
          program: before._id,
          intake,
        });
        if (n > 0) {
          throw {
            statusCode: 400,
            message: `Cannot remove the ${intake} intake: ${n} student(s) in this program were admitted under it.`,
          } as ApiError;
        }
      }
      updateData.intakes = cleaned;
    }

    // ── Update ──────────────────────────────────────────────────────────
    const program = await Program.findOneAndUpdate(
      { _id: id, institution: req.user.institution },
      { $set: updateData },
      { new: true, runValidators: true },
    );

    // The pre-update hook automatically syncs cleanName if name changed

    await logAudit(req, {
      action: "program_updated",
      actor: req.user._id,
      details: {
        programId: id,
        before: { name: before.name, code: before.code, durationYears: before.durationYears },
        after: updateData,
        institutionId: req.user.institution?.toString(),
      },
    });

    // Invalidate cache for this institution
    invalidateCache(`programs:${req.user.institution}`);

    res.json(program);
  }),
);

// ── DELETE /programs/:id ──────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;

    const program = await Program.findOne({
      _id: id,
      institution: req.user.institution,
    });

    if (!program) {
      await logAudit(req, {
        action: "program_delete_failed",
        actor: req.user._id,
        details: {
          programId: id,
          reason: "Not found or institution mismatch",
          institutionId: req.user.institution?.toString(),
        },
      });
      throw { statusCode: 404, message: "Program not found" } as ApiError;
    }

    // ── Check for existing unit assignments ─────────────────────────────
    const ProgramUnit = require("../models/ProgramUnit").default;
    const hasUnits = await ProgramUnit.exists({ program: id });

    if (hasUnits) {
      throw {
        statusCode: 409,
        message: "Cannot delete program with existing unit assignments. Remove units first.",
      } as ApiError;
    }

    // ── Check for enrolled students ─────────────────────────────────────
    const Student = require("../models/Student").default;
    const hasStudents = await Student.exists({ program: id });

    if (hasStudents) {
      throw {
        statusCode: 409,
        message: "Cannot delete program with enrolled students. Archive students first.",
      } as ApiError;
    }

    await program.deleteOne();

    await logAudit(req, {
      action: "program_deleted",
      actor: req.user._id,
      details: {
        programId: id,
        name: program.name,
        code: program.code,
        durationYears: program.durationYears,
        institutionId: req.user.institution?.toString(),
      },
    });

    // Invalidate cache for this institution
    invalidateCache(`programs:${req.user.institution}`);

    res.json({ message: "Program deleted successfully" });
  }),
);

export default router;
