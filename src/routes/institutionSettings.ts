// serverside/src/routes/institutionSettings.ts — COMPLETE, FINAL VERSION
import { legacyFieldsFromExample } from "../utils/regNoShape";
import express, { Response } from "express";
import InstitutionSettings   from "../models/InstitutionSettings";
import Program from "../models/Program";
import Student from "../models/Student";
import AcademicYear from "../models/AcademicYear";
import { getIntakeDefinitions } from "../utils/intakeDefinitions";
import { validateIntakeDefinitions, LEGACY_INTAKE_DEFINITIONS } from "../utils/semesterLabels";
import { AuthenticatedRequest, requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler }         from "../middleware/asyncHandler";
import { logAudit }             from "../lib/auditLogger";
import { cached, invalidateCache } from "../utils/cache";
import { invalidateSettingsCache } from "../utils/loadInstitutionSettings";
import multer from "multer";
import path   from "path";
import fs     from "fs";

interface ApiError { statusCode: number; message: string }

const router = express.Router();

// ── Logo upload (admin only) ──────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), "uploads", "logos");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo-${Date.now()}${ext}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits:  { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".png", ".jpg", ".jpeg", ".svg"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPG, JPEG, SVG files allowed"));
    }
  },
});

// ── GET /institution-settings — ALL authenticated users (read) ────────────────
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const institutionId = req.user.institution?.toString();
    if (!institutionId) {
      res.status(400).json({ message: "No institution linked to this account" });
      return;
    }

    const settings = await cached(
      `settings:${institutionId}`,
      () => InstitutionSettings.findOne({ institution: institutionId }).lean(),
      300,
    );

    await logAudit(req, {
      action:  "institution_settings_viewed",
      details: { institutionId },
    });

    // Always hand clients a usable intake list (legacy SEPT/JAN/MAY until configured)
    res.json(
      settings
        ? {
            ...settings,
            intakeDefinitions:
              (settings as { intakeDefinitions?: unknown[] }).intakeDefinitions?.length
                ? (settings as { intakeDefinitions?: unknown[] }).intakeDefinitions
                : LEGACY_INTAKE_DEFINITIONS,
          }
        : null,
    );
  }),
);

// ── POST /institution-settings — COORDINATOR + ADMIN ─────────────────────────
// Coordinator manages: ruleSet, gradingScale, waaClassification,
//                      semesterWeights, enforceRegNoPattern, supportedIntakes
// Admin manages:       docMeta, schools, departments (via separate PATCH routes)
//
// Both roles can POST to this endpoint, but each saves different fields.
// The server accepts the full payload and applies whichever fields are present.
// Field-level authorization is enforced inside the handler.
router.post(
  "/",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const institutionId = req.user.institution?.toString();
    if (!institutionId) {
      res.status(400).json({ message: "No institution linked to this account" });
      return;
    }

    const data = req.body as Record<string, unknown>;
    const role = req.user.role;

    // ── Field-level authorization ─────────────────────────────────────────────
    // Coordinator can ONLY save academic/grading fields
    // Admin can ONLY save identity/structure fields via this endpoint
    // (admin uses PATCH /schools and PATCH /schools/:code/departments for structure)
    const COORDINATOR_FIELDS = new Set([
      "ruleSet",
      "gradingScale",
      "waaClassification",
      "semesterWeights",
      "enforceRegNoPattern",
      "supportedIntakes",
      "intakeDefinitions",
    ]);

    const ADMIN_FIELDS = new Set([
      "docMeta",
      // schools/departments are managed via PATCH endpoints
    ]);

    const allowedFields = role === "admin" ? ADMIN_FIELDS : COORDINATOR_FIELDS;

    // Strip fields the caller is not allowed to set
    const filteredData: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      if (allowedFields.has(key)) {
        filteredData[key] = data[key];
      }
    }

    if (Object.keys(filteredData).length === 0) {
      res.status(422).json({
        message: `No writable fields provided for role "${role}". ` +
          (role === "coordinator"
            ? "Coordinators can set: ruleSet, gradingScale, waaClassification, semesterWeights, enforceRegNoPattern, supportedIntakes"
            : "Admins can set: docMeta (schools via PATCH /schools)"),
      });
      return;
    }

    // Validate CA + Exam weights if ruleSet provided
    if (filteredData.ruleSet) {
      const rs = filteredData.ruleSet as Record<string, number>;
      if (rs.caWeight !== undefined && rs.examWeight !== undefined) {
        const total = Number(rs.caWeight) + Number(rs.examWeight);
        if (Math.abs(total - 100) > 0.01) {
          res.status(422).json({
            message: `CA weight (${rs.caWeight}) + Exam weight (${rs.examWeight}) must equal 100`,
          });
          return;
        }
      }
    }

    // Intake definitions: validate, and don't allow removing one that is still in use
    if (filteredData.intakeDefinitions !== undefined) {
      const checked = validateIntakeDefinitions(filteredData.intakeDefinitions);
      if ("error" in checked) {
        res.status(422).json({ message: checked.error });
        return;
      }
      const oldDefs = await getIntakeDefinitions(institutionId);
      const newCodes = new Set(checked.definitions.map((d) => d.code));
      for (const old of oldDefs) {
        if (newCodes.has(old.code)) continue;
        const [programs, students, years] = await Promise.all([
          Program.countDocuments({ institution: institutionId, intakes: old.code }),
          Student.countDocuments({ institution: institutionId, intake: old.code }),
          AcademicYear.countDocuments({ institution: institutionId, intakes: old.code }),
        ]);
        if (programs + students + years > 0) {
          res.status(422).json({
            message:
              `Cannot remove the ${old.code} intake: it is used by ${programs} program(s), ` +
              `${students} student(s) and ${years} academic year(s). Move them to another intake first.`,
          });
          return;
        }
      }
      filteredData.intakeDefinitions = checked.definitions;
      filteredData.supportedIntakes  = checked.definitions.map((d) => d.code); // keep legacy field in sync
    }

    const previous = await InstitutionSettings.findOne({ institution: institutionId }).lean();

    const updated = await InstitutionSettings.findOneAndUpdate(
      { institution: institutionId },
      { $set: { ...filteredData, institution: institutionId } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId);

    await logAudit(req, {
      action:  previous ? "institution_settings_updated" : "institution_settings_created",
      details: { institutionId, role, fields: Object.keys(filteredData) },
    });

    res.json({ message: "Settings saved successfully", settings: updated });
  }),
);

// ── POST /institution-settings/logo — ADMIN ONLY ──────────────────────────────
router.post(
  "/logo",
  requireAuth,
  requireRole("admin"),
  uploadLogo.single("logo"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.file) {
      throw { statusCode: 400, message: "No file uploaded" } as ApiError;
    }

    const institutionId = req.user.institution?.toString();
    if (!institutionId) {
      throw { statusCode: 400, message: "No institution linked" } as ApiError;
    }

    // Delete old logo file
    const existing = await InstitutionSettings.findOne({ institution: institutionId })
      .select("branding.universityLogoPath")
      .lean() as { branding?: { universityLogoPath?: string } } | null;

    if (existing?.branding?.universityLogoPath) {
      const oldPath = path.join(process.cwd(), existing.branding.universityLogoPath);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const logoPath = `uploads/logos/${req.file.filename}`;
    

    await InstitutionSettings.findOneAndUpdate(
      { institution: institutionId },
      { $set: { "branding.universityLogoPath": logoPath } },
      { upsert: true },
    );

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId);

    await logAudit(req, {
      action:  "institution_logo_uploaded",
      details: { institutionId, logoPath },
    });

    res.json({ message: "Logo uploaded successfully", path: logoPath });
  }),
);

// ── GET /institution-settings/logo — serve logo (all authenticated users) ─────
router.get(
  "/logo",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const institutionId = req.user.institution?.toString();
    if (!institutionId) { res.status(400).json({ message: "No institution linked" }); return; }

    const settings = await InstitutionSettings.findOne({ institution: institutionId })
      .select("branding.universityLogoPath")
      .lean() as { branding?: { universityLogoPath?: string } } | null;

    const logoPath = settings?.branding?.universityLogoPath;
    if (!logoPath) { res.status(404).json({ message: "No logo uploaded" }); return; }

    const fullPath = path.join(process.cwd(), logoPath);
    if (!fs.existsSync(fullPath)) { res.status(404).json({ message: "Logo file not found" }); return; }

    res.sendFile(fullPath);
  }),
);

// ── PATCH /institution-settings/schools — ADMIN ONLY ─────────────────────────
router.patch(
  "/schools",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { school }    = req.body as { school: Record<string, unknown> };
    const institutionId = req.user.institution?.toString();

    if (!school?.code || !school?.name) {
      throw { statusCode: 400, message: "School code and name are required" } as ApiError;
    }

    // Uniqueness: same name, different code = clash
    const nameClash = await InstitutionSettings.findOne({
      institution:  institutionId,
      "schools.name": { $regex: new RegExp(`^${String(school.name).trim()}$`, "i") },
      "schools.code": { $ne: String(school.code).toUpperCase() },
    });
    if (nameClash) {
      throw {
        statusCode: 409,
        message: `A school named "${school.name}" already exists.`,
      } as ApiError;
    }

    const existing = await InstitutionSettings.findOne({
      institution:    institutionId,
      "schools.code": String(school.code).toUpperCase(),
    });

    const schoolDoc = { ...school, code: String(school.code).toUpperCase() };

    if (existing) {
      await InstitutionSettings.updateOne(
        { institution: institutionId, "schools.code": String(school.code).toUpperCase() },
        { $set: { "schools.$": schoolDoc } },
      );
    } else {
      await InstitutionSettings.updateOne(
        { institution: institutionId },
        { $push: { schools: schoolDoc } },
        { upsert: true },
      );
    }

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId!);
    res.json({ message: `School ${school.code} saved` });
  }),
);

// ── PATCH /institution-settings/schools/:schoolCode/departments — ADMIN ONLY ──
// Reg number patterns inside departments are COORDINATOR responsibility.
// Admin creates the department shell; coordinator fills in regNoPatterns.
router.patch(
  "/schools/:schoolCode/departments",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { schoolCode } = req.params;
    const { department } = req.body as { department: Record<string, unknown> };
    const institutionId  = req.user.institution?.toString();

    if (!department?.code || !department?.name) {
      throw { statusCode: 400, message: "Department code and name are required" } as ApiError;
    }

    const nameClash = await InstitutionSettings.findOne({
      institution:    institutionId,
      "schools.code": schoolCode.toUpperCase(),
      "schools.departments.name": {
        $regex: new RegExp(`^${String(department.name).trim()}$`, "i"),
      },
      "schools.departments.code": { $ne: String(department.code).toUpperCase() },
    });
    if (nameClash) {
      throw {
        statusCode: 409,
        message: `A department named "${department.name}" already exists in this school.`,
      } as ApiError;
    }

    const deptDoc = { ...department, code: String(department.code).toUpperCase() };

    const result = await InstitutionSettings.updateOne(
      {
        institution:    institutionId,
        "schools.code": schoolCode.toUpperCase(),
        "schools.departments.code": { $ne: String(department.code).toUpperCase() },
      },
      { $push: { "schools.$.departments": deptDoc } },
    );

    if (result.matchedCount === 0) {
      await InstitutionSettings.updateOne(
        {
          institution:    institutionId,
          "schools.code": schoolCode.toUpperCase(),
          "schools.departments.code": String(department.code).toUpperCase(),
        },
        { $set: { "schools.$[s].departments.$[d]": deptDoc } },
        {
          arrayFilters: [
            { "s.code": schoolCode.toUpperCase() },
            { "d.code": String(department.code).toUpperCase() },
          ],
        },
      );
    }

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId!);
    res.json({ message: `Department ${department.code} saved in ${schoolCode}` });
  }),
);

// ── PATCH /institution-settings/schools/:schoolCode/departments/:deptCode/reg-patterns
// COORDINATOR ONLY — set/update reg number patterns for a department they belong to
// router.patch(
//   "/schools/:schoolCode/departments/:deptCode/reg-patterns",
//   requireAuth,
//   requireRole("coordinator", "admin"),
//   asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
//     const { schoolCode, deptCode } = req.params;
//     const { regNoPatterns }        = req.body as {
//       regNoPatterns: Array<{
//         prefix: string; separator: string; yearDigits: number;
//         example: string; manualRegex?: string;
//       }>;
//     };
//     const institutionId = req.user.institution?.toString();

//     // Coordinators can only update patterns for their own department
//     if (req.user.role === "coordinator") {
//       const myDept  = req.user.departmentCode;
//       const mySchool= req.user.schoolCode;
//       if (
//         !req.user.institutionWide &&
//         (myDept !== deptCode.toUpperCase() || mySchool !== schoolCode.toUpperCase())
//       ) {
//         throw {
//           statusCode: 403,
//           message:    "You can only configure reg number patterns for your own department.",
//         } as ApiError;
//       }
//     }

//     if (!Array.isArray(regNoPatterns)) {
//       throw { statusCode: 400, message: "regNoPatterns must be an array" } as ApiError;
//     }

//     await InstitutionSettings.updateOne(
//       {
//         institution:    institutionId,
//         "schools.code": schoolCode.toUpperCase(),
//         "schools.departments.code": deptCode.toUpperCase(),
//       },
//       {
//         $set: {
//           "schools.$[s].departments.$[d].regNoPatterns": regNoPatterns,
//           "schools.$[s].departments.$[d].enforceRegNoPattern": true,
//         },
//       },
//       {
//         arrayFilters: [
//           { "s.code": schoolCode.toUpperCase() },
//           { "d.code": deptCode.toUpperCase() },
//         ],
//       },
//     );

//     // Also update the top-level enforceRegNoPattern flag
//     await InstitutionSettings.updateOne(
//       { institution: institutionId },
//       { $set: { enforceRegNoPattern: true } },
//     );

//     invalidateCache(`settings:${institutionId}`);
//     invalidateSettingsCache(institutionId!);

//     await logAudit(req, {
//       action:  "reg_no_patterns_updated",
//       details: { institutionId, schoolCode, deptCode, patternCount: regNoPatterns.length },
//     });

//     res.json({ message: `Reg number patterns updated for ${deptCode}` });
//   }),
// );


// serverside/src/routes/institutionSettings.ts - Add this endpoint with ownership check

// ── PATCH /institution-settings/schools/:schoolCode/departments/:deptCode/reg-patterns
// COORDINATOR ONLY — can only edit their own department
router.patch(
  "/schools/:schoolCode/departments/:deptCode/reg-patterns",
  requireAuth,
  requireRole("coordinator", "admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { schoolCode, deptCode } = req.params;
    const { regNoPatterns } = req.body as {
      regNoPatterns: Array<{
        prefix: string;
        separator: string;
        yearDigits: number;
        example: string;
        manualRegex?: string;
      }>;
    };
    const institutionId = req.user.institution?.toString();

    // ENFORCE: coordinators can only edit their OWN department
    if (req.user.role === "coordinator" && !req.user.institutionWide) {
      if (
        req.user.schoolCode?.toUpperCase() !== schoolCode.toUpperCase() ||
        req.user.departmentCode?.toUpperCase() !== deptCode.toUpperCase()
      ) {
        throw {
          statusCode: 403,
          message: "You can only configure registration number patterns for your own department.",
        } as ApiError;
      }
    }

    if (!Array.isArray(regNoPatterns)) {
      throw { statusCode: 400, message: "regNoPatterns must be an array" } as ApiError;
    }

    // Normalise: the example is the source of truth; the old fields are derived from it.
    for (const p of regNoPatterns) {
      if (p.example?.trim()) {
        p.example = p.example.trim().toUpperCase();
        Object.assign(p, legacyFieldsFromExample(p.example));
      }
    }

    await InstitutionSettings.updateOne(
      {
        institution: institutionId,
        "schools.code": schoolCode.toUpperCase(),
        "schools.departments.code": deptCode.toUpperCase(),
      },
      {
        $set: {
          "schools.$[s].departments.$[d].regNoPatterns": regNoPatterns,
          "schools.$[s].departments.$[d].enforceRegNoPattern": true,
        },
      },
      {
        arrayFilters: [
          { "s.code": schoolCode.toUpperCase() },
          { "d.code": deptCode.toUpperCase() },
        ],
      }
    );

    // Also update the top-level enforceRegNoPattern flag
    await InstitutionSettings.updateOne(
      { institution: institutionId },
      { $set: { enforceRegNoPattern: true } }
    );

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId!);

    await logAudit(req, {
      action: "reg_no_patterns_updated",
      details: { institutionId, schoolCode, deptCode, patternCount: regNoPatterns.length },
    });

    res.json({ message: `Registration number patterns updated for ${deptCode}` });
  })
);

// ── DELETE /institution-settings/schools/:schoolCode — ADMIN ONLY ─────────────
router.delete(
  "/schools/:schoolCode",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { schoolCode } = req.params;
    const institutionId  = req.user.institution?.toString();

    await InstitutionSettings.updateOne(
      { institution: institutionId },
      { $pull: { schools: { code: schoolCode.toUpperCase() } } },
    );

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId!);
    res.json({ message: `School ${schoolCode} removed` });
  }),
);

// ── DELETE /institution-settings/schools/:schoolCode/departments/:deptCode ────
router.delete(
  "/schools/:schoolCode/departments/:deptCode",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { schoolCode, deptCode } = req.params;
    const institutionId            = req.user.institution?.toString();

    await InstitutionSettings.updateOne(
      { institution: institutionId, "schools.code": schoolCode.toUpperCase() },
      { $pull: { "schools.$.departments": { code: deptCode.toUpperCase() } } },
    );

    invalidateCache(`settings:${institutionId}`);
    invalidateSettingsCache(institutionId!);
    res.json({ message: `Department ${deptCode} removed from ${schoolCode}` });
  }),
);

export default router;