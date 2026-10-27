// serverside/src/routes/studentSearch.ts

import { refreshStudentWAA } from "../services/graduationEngine";
import express, { Response } from "express";
import { splitRegNo, regNoAnyQualifierRegex } from "../utils/regNoQualifier";
import Student from "../models/Student";
import FinalGrade from "../models/FinalGrade";
import MarkDirect from "../models/MarkDirect";
import InstitutionSettings from "../models/InstitutionSettings";
import Mark from "../models/Mark";
import Unit from "../models/Unit";
import AcademicYear from "../models/AcademicYear";
import ProgramUnit from "../models/ProgramUnit";
import { AuthenticatedRequest, requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { computeFinalGrade } from "../services/gradeCalculator";
import { calculateStudentStatus } from "../services/statusEngine";
import { scopeQuery } from "../lib/multiTenant";
import { deferAdmission, grantAcademicLeave, readmitStudent, revertStatusToActive } from "../services/academicLeave";
import { getYearWeight } from "../utils/weightingRegistry";
import { resolveStudentStatus } from "../utils/studentStatusResolver";
import { logAudit } from "../lib/auditLogger";
import { listAuditedUnits } from "../services/auditedUnits";

const router = express.Router();

// ── Resolve plain unit code from analysis item ─────────────────────────────
function codeOf(item: string): string {
  return (item || "").split(":")[0].trim().toUpperCase();
}
 
// ── Attempt count for a student × programUnit ──────────────────────────────
// unitAttemptRegistry is the most accurate source (set by gradeCalculator).
// Falls back to counting FinalGrade documents.
async function attemptCount(student: any, programUnitId: string): Promise<number> {
  const reg = (student.unitAttemptRegistry || []).find(
    (r: any) => r.unitId?.toString() === programUnitId,
  );
  if (reg?.attempts?.length) return reg.attempts.length;
  return FinalGrade.countDocuments({ student: student._id, programUnit: programUnitId });
}
 
// ── Build rich challenge unit objects ──────────────────────────────────────
// Attaches name, attempt count, and any context fields.
// yearPUs = all ProgramUnits for this year (pre-fetched, zero extra queries).
async function enrich(
  student:  any,
  codes:    string[],
  yearPUs:  any[],
  extra?:   Record<string, string>,  // per-code extra fields (e.g. grounds for specials)
): Promise<Array<{ code: string; name?: string; attempt?: number; [k: string]: unknown }>> {
  const results = [];
  for (const code of codes) {
    const pu    = yearPUs.find((p: any) => p.unit?.code?.toUpperCase() === code);
    const puId  = pu?._id?.toString() ?? "";
    const count = puId ? await attemptCount(student, puId) : undefined;
    results.push({
      code,
      name:    pu?.unit?.name,
      attempt: count,
      ...(extra?.[code] ? { grounds: extra[code] } : {}),
    });
  }
  return results;
}

router.get("/search", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { q } = req.query;
  if (!q || typeof q !== "string" || q.trim().length < 3)
    return res.status(400).json({ error: "Enter at least 3 characters" });
  const students = await Student.find(scopeQuery(req, { regNo: { $regex: `^${q.trim()}`, $options: "i" } }))
    .limit(10).select("regNo name program admissionYear").populate("program", "name");
  res.json(students);
}));

router.get("/record", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  let { regNo, yearOfStudy } = req.query;
  if (!regNo || typeof regNo !== "string") return res.status(400).json({ error: "regNo is required" });
  const targetYearOfStudy = parseInt(yearOfStudy as string) || 1;
  regNo = decodeURIComponent(regNo);

  const [student, settings] = await Promise.all([
    Student.findOne({ regNo: { $regex: regNoAnyQualifierRegex(splitRegNo(regNo).base) } }).populate("program"),
    InstitutionSettings.findOne().lean(),
  ]);
  if (!student) return res.status(404).json({ error: "Student not found" });
  if (!settings) return res.status(500).json({ error: "Institution settings missing" });

  const [grades, detailedMarks, directMarks] = await Promise.all([
    FinalGrade.find({ student: student._id }).populate({ path: "programUnit", populate: { path: "unit", select: "code name" } }).populate("academicYear", "year").lean(),
    Mark.find({ student: student._id }).lean(),
    MarkDirect.find({ student: student._id }).populate({ path: "programUnit", populate: { path: "unit", select: "code name" } }).populate("academicYear", "year").lean(),
  ]);

  const marksMap = new Map();
  detailedMarks.forEach((m) => marksMap.set(m.programUnit.toString(), m));
  const gradedUnitIds = new Set(grades.map((g) => (g.programUnit as any)?._id.toString()));

  const processedGrades: any[] = grades
    .filter((g: any) => g.programUnit?.requiredYear === targetYearOfStudy)
    .map((g: any) => {
      const pUnit = g.programUnit;
      const raw = marksMap.get(pUnit._id.toString());
      return { ...g, unit: { code: pUnit?.unit?.code, name: pUnit?.unit?.name }, semester: pUnit?.requiredSemester || "N/A", status: (raw?.isSpecial || g.status === "SPECIAL") ? "SPECIAL" : g.status, agreedMark: g.totalMark };
    });

  directMarks.forEach((dm: any) => {
    const pUnit = dm.programUnit;
    if (pUnit?.requiredYear === targetYearOfStudy && !gradedUnitIds.has(pUnit._id.toString())) {
      const mark = dm.agreedMark || 0;
      const matchedScale = [...((settings as any).gradingScale || [])].sort((a, b) => b.min - a.min).find((s) => mark >= s.min);
      processedGrades.push({
        _id: dm._id, academicYear: dm.academicYear, semester: String(dm.semester || pUnit.requiredSemester || "N/A"),
        unit: { code: pUnit.unit?.code || "N/A", name: pUnit.unit?.name || "N/A" },
        totalMark: mark, agreedMark: mark, grade: matchedScale ? matchedScale.grade : "E",
        status: (() => {
          if (dm.attempt === "special") return "SPECIAL";
          if (dm.attempt === "supplementary") return "SUPPLEMENTARY";
          if (dm.attempt === "re-take") return "RETAKE";
          return mark >= (settings as any).passMark ? "PASS" : "SUPPLEMENTARY";
        })(),
      });
    }
  });

  const auditedUnits = await listAuditedUnits(student._id); // ENG.9: shown on the transcript, never counted
  const sortedGrades = processedGrades.sort((a, b) => String(a.semester || "").localeCompare(String(b.semester || "")));
  const LOCKED = ["on_leave","deferred","discontinued","deregistered","graduated","graduand"];

  if (LOCKED.includes(student.status)) {
    const resolved = resolveStudentStatus(student);
    const vm: Record<string, "info"|"warning"|"error"|"success"> = { on_leave:"info", deferred:"info", discontinued:"error", deregistered:"error", graduated:"success", graduand:"success" };
    return res.json({
      student: { _id: student._id, name: student.name, regNo: student.regNo, programId: (student.program as any)?._id, currentYear: student.currentYearOfStudy, programName: (student.program as any)?.name, status: student.status },
      grades: sortedGrades,
      auditedUnits,
      academicStatus: { status: resolved.status, variant: vm[student.status] ?? "info", details: resolved.reason || `Student is currently ${resolved.status}.`, weightedMean: "0.00", summary: { totalExpected: 0, passed: 0, failed: 0, missing: 0, isOnLeave: true }, passedList: [], failedList: [], specialList: [], missingList: [], incompleteList: [], academicYearName: "" },
    });
  }

  const academicStatus = await calculateStudentStatus(student._id, (student.program as any)._id, "", targetYearOfStudy);
  res.json({ student: { _id: student._id, name: student.name, regNo: student.regNo, programId: (student.program as any)?._id, currentYear: student.currentYearOfStudy, programName: (student.program as any)?.name, status: student.status }, grades: sortedGrades, auditedUnits, academicStatus });
 }));

const formatChallenges = (analysis: any) => ({
  supplementary: analysis.failedList.filter((f: any) => f.attempt === "A/S").map((f: any) => f.displayName.split(":")[0]),
  retakes: analysis.failedList.filter((f: any) => ["A/RA","A/RPU"].includes(f.attempt)).map((f: any) => f.displayName.split(":")[0]),
  stayouts: analysis.failedList.filter((f: any) => f.attempt === "A/SO").map((f: any) => f.displayName.split(":")[0]),
  specials: analysis.specialList.map((s: any) => s.displayName.split(":")[0]),
  incomplete: [...analysis.incompleteList, ...analysis.missingList].map((i) => i.split(":")[0]),
});

// router.get("/journey", requireAuth,
//   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
//     const { regNo } = req.query;
//     if (!regNo) return res.status(400).json({ error: "regNo is required" });

//     const student = (await Student.findOne(
//       scopeQuery(req, { regNo: { $regex: regNoAnyQualifierRegex(splitRegNo(regNo).base) } }),
//     )
//       .populate("admissionAcademicYear", "year")
//       .populate("program")
//       .lean()) as any;
//     if (!student) return res.status(404).json({ error: "Student not found" });

//     // ── Robust admission year resolution ────────────────────────────────────
//     // Tries every field the Student schema might use before falling back.
//     const admissionYearString = (() => {
//       // A) Populated ObjectId ref → { year: "2016/2017" }
//       const ref = student.admissionAcademicYear?.year;
//       if (ref && typeof ref === "string" && ref.includes("/")) return ref;

//       // B) Plain string field "admissionYear" (some schemas store it directly)
//       const plain = student.admissionYear;
//       if (plain && typeof plain === "string" && plain.trim()) {
//         if (plain.includes("/")) return plain.trim();
//         const yr = parseInt(plain.trim());
//         if (!isNaN(yr) && yr > 1990) return `${yr}/${yr + 1}`;
//       }

//       // C) Legacy field name
//       const legacy = student.admissionAcademicYearString;
//       if (legacy && typeof legacy === "string" && legacy.trim())
//         return legacy.trim();

//       // D) Extract from regNo — e.g. "E024-01-1231/2016" → "2016/2017"
//       const regMatch = (student.regNo || "").match(/\/(\d{4})$/);
//       if (regMatch) {
//         const yr = parseInt(regMatch[1]);
//         if (yr > 1990 && yr < 2100) return `${yr}/${yr + 1}`;
//       }

//       // E) Earliest entry in academicHistory
//       const sorted = [...(student.academicHistory || [])].sort(
//         (a: any, b: any) => (a.yearOfStudy || 0) - (b.yearOfStudy || 0),
//       );
//       const earliest = sorted[0]?.academicYear;
//       if (earliest && typeof earliest === "string" && earliest.includes("/"))
//         return earliest;

//       return "N/A";
//     })();

//     const journey: any[] = [];
//     const program = student.program as any;
//     const entryType = student.entryType || "Direct";
//     const duration = program?.durationYears || 5;
//     const isGraduated = ["graduand", "graduated"].includes(student.status);

//     const incrementYear = (yr: string, offset: number): string => {
//       if (!yr || !yr.includes("/")) return yr;
//       const [start] = yr.split("/").map(Number);
//       return `${start + offset}/${start + offset + 1}`;
//     };

//     // ── Part A: Academic history entries ──────────────────────────────────────
//     // Display weight comes directly from the registry — NOT from stored history.
//     // This guarantees correct percentages (15/15/20/25/25) in the Telemetry card.
//     let activeWeightedSum = 0; // used only for non-graduated students
//     let activeWeightTotal = 0;

//     for (const record of (student.academicHistory || []) as any[]) {
//       if ((record.yearOfStudy || 1) > duration) continue; // skip over-duration entries

//       // Weight for display — always from registry, never from stored history
//       const weight = getYearWeight(program, entryType, record.yearOfStudy);

//       let resolvedYear = record.academicYear;
//       if (
//         !resolvedYear ||
//         (record.yearOfStudy > 1 && resolvedYear === admissionYearString)
//       ) {
//         resolvedYear = incrementYear(
//           admissionYearString,
//           record.yearOfStudy - 1,
//         );
//       }

//       // Challenge display: call engine for non-graduated students only
//       let challenges = {
//         supplementary: [] as string[],
//         retakes: [] as string[],
//         stayouts: [] as string[],
//         specials: [] as string[],
//         incomplete: [] as string[],
//       };
//       let totalUnits = record.unitsTakenCount || 0;
//       let displayStatus = record.isRepeatYear
//         ? "REPEAT YEAR"
//         : "PASS (PROMOTED)";

//       if (!isGraduated) {
//         try {
//           const analysis = await calculateStudentStatus(
//             student._id,
//             student.program,
//             resolvedYear,
//             record.yearOfStudy,
//             { forPromotion: false },
//           );
//           challenges = formatChallenges(analysis);
//           totalUnits = analysis.summary.totalExpected || totalUnits;
//           const mean = record.annualMeanMark || 0;
//           if (
//             !["ACADEMIC LEAVE", "GRADUATED", "DEFERMENT"].includes(
//               analysis.status,
//             )
//           ) {
//             displayStatus = record.isRepeatYear
//               ? "REPEAT YEAR"
//               : mean > 0 || analysis.summary.passed > 0
//                 ? "PASS (PROMOTED)"
//                 : analysis.status;
//           }
//           // Accumulate for active student WAA
//           activeWeightedSum += parseFloat(analysis.weightedMean) * weight;
//           activeWeightTotal += weight;
//         } catch {
//           /* keep defaults */
//         }
//       } else {
//         // Graduated: just get unit count for the Telemetry card
//         try {
//           const count = await ProgramUnit.countDocuments({
//             program: student.program?._id || student.program,
//             requiredYear: record.yearOfStudy,
//           });
//           totalUnits = count || totalUnits;
//         } catch {
//           /* keep stored value */
//         }
//       }

//       journey.push({
//         type: "ACADEMIC",
//         academicYear: resolvedYear,
//         yearOfStudy: record.yearOfStudy,
//         status: displayStatus,
//         totalUnits,
//         weight: Math.round(weight * 100), // ← registry value, always correct
//         challenges,
//         date: record.date || new Date(0),
//         isCurrent: false,
//       });
//     }

//     // ── Part B: Current year (active, non-graduated only) ─────────────────────
//     const LOCKED = [
//       "on_leave",
//       "deferred",
//       "deregistered",
//       "discontinued",
//       "graduated",
//       "graduand",
//     ];
//     const isLocked = LOCKED.includes(student.status);
//     const currentInHistory = (student.academicHistory || []).some(
//       (h: any) => h.yearOfStudy === student.currentYearOfStudy,
//     );
//     const withinDuration = (student.currentYearOfStudy || 1) <= duration;

//     if (!isLocked && !currentInHistory && withinDuration) {
//       const currentYearDoc = await AcademicYear.findOne({
//         institution: student.institution,
//         isCurrent: true,
//       }).lean();
//       const weight = getYearWeight(
//         program,
//         entryType,
//         student.currentYearOfStudy,
//       );

//       try {
//         const live = await calculateStudentStatus(
//           student._id,
//           student.program,
//           "CURRENT",
//           student.currentYearOfStudy,
//         );

//         journey.push({
//           type: "ACADEMIC",
//           academicYear: currentYearDoc?.year || "Current",
//           yearOfStudy: student.currentYearOfStudy,
//           status: live.status,
//           totalUnits: live.summary.totalExpected,
//           weight: Math.round(weight * 100),
//           challenges: formatChallenges(live),
//           date: new Date(),
//           isCurrent: true,
//         });

//         activeWeightedSum += parseFloat(live.weightedMean) * weight;
//         activeWeightTotal += weight;
//       } catch (e: any) {
//         console.warn("[journey] Current year engine error:", e.message);
//       }
//     }

//     // ── Part C: Status events ──────────────────────────────────────────────────
//     (student.statusEvents || []).forEach((ev: any) => {
//       journey.push({
//         type: "STATUS_CHANGE",
//         academicYear: ev.academicYear || "",
//         toStatus: ev.toStatus,
//         reason: ev.reason,
//         date: ev.date || new Date(0),
//       });
//     });

//     // ── Part D: Deferred-supp events (ENG.13b / ENG.18c) ─────────────────────
//     // Each entry in deferredSuppUnits becomes a distinct timeline node so
//     // coordinators can see the full deferral history in the Journey card.
//     for (const entry of (student.deferredSuppUnits || []) as any[]) {
//       journey.push({
//         type: "DEFERRED_SUPP",
//         academicYear: entry.fromAcademicYear || "",
//         yearOfStudy: entry.fromYear || 0,
//         unitCode: entry.unitCode || "N/A",
//         unitName: entry.unitName || "",
//         reason: entry.reason || "supp_deferred", // "supp_deferred" | "special_deferred"
//         status: entry.status || "pending", // "pending" | "passed"
//         date: entry.addedAt || new Date(0),
//       });
//     }

//     journey.sort(
//       (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
//     );

//     // ── Cumulative mean ────────────────────────────────────────────────────────
//     // GRADUATED/GRADUAND: always use finalWeightedAverage (authoritative).
//     // This is the same value shown in the award list — no disparity.
//     // ACTIVE: compute from engine means × registry weights.
//     let projectedMean: number;

//     if (isGraduated) {
//       const stored = parseFloat(student.finalWeightedAverage || "0");
//       if (stored > 0) {
//         projectedMean = stored;
//       } else {
//         // finalWeightedAverage not yet set — trigger recompute via graduation engine
//         // (this path should be rare after running /admin/recompute-graduation-waa)
//         try {
//           const { calculateGraduationStatus } =
//             await import("../services/graduationEngine");
//           const result = await calculateGraduationStatus(
//             student._id.toString(),
//           );
//           projectedMean = result.weightedAggregateAverage;
//         } catch {
//           projectedMean = 0;
//         }
//       }
//     } else {
//       projectedMean =
//         activeWeightTotal > 0 ? activeWeightedSum / activeWeightTotal : 0;
//     }

//     res.json({
//       admissionYear: admissionYearString,
//       intake: student.intake || "SEPT",
//       currentStatus: student.status.toUpperCase(),
//       cumulativeMean: projectedMean.toFixed(2),
//       timeline: journey,
//     });
//   }),
// );

router.get("/journey", requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { regNo } = req.query;
    if (!regNo) return res.status(400).json({ error: "regNo is required" });

    const student = (await Student.findOne(
      scopeQuery(req, { regNo: regNo as string }),
    )
      .populate("admissionAcademicYear", "year")
      .populate("program")
      .lean()) as any;

    if (!student) return res.status(404).json({ error: "Student not found" });

    // ── Admission year ─────────────────────────────────────────────────────
    const admissionYearString = (() => {
      const ref = student.admissionAcademicYear?.year;
      if (ref && typeof ref === "string" && ref.includes("/")) return ref;
      const plain = student.admissionYear;
      if (plain && typeof plain === "string" && plain.trim()) {
        if (plain.includes("/")) return plain.trim();
        const yr = parseInt(plain.trim());
        if (!isNaN(yr) && yr > 1990) return `${yr}/${yr + 1}`;
      }
      const regMatch = (student.regNo || "").match(/\/(\d{4})$/);
      if (regMatch) {
        const yr = parseInt(regMatch[1]);
        if (yr > 1990 && yr < 2100) return `${yr}/${yr + 1}`;
      }
      const sorted = [...(student.academicHistory || [])].sort(
        (a: any, b: any) => (a.yearOfStudy || 0) - (b.yearOfStudy || 0),
      );
      const earliest = sorted[0]?.academicYear;
      if (earliest && typeof earliest === "string" && earliest.includes("/"))
        return earliest;
      return "N/A";
    })();

    const incYear = (yr: string, offset: number): string => {
      if (!yr || !yr.includes("/")) return yr;
      const [s] = yr.split("/").map(Number);
      return `${s + offset}/${s + offset + 1}`;
    };

    const program = student.program as any;
    const entryType = student.entryType || "Direct";
    const duration = program?.durationYears || 5;
    const isGraduated = ["graduand", "graduated"].includes(student.status);
    const journey: any[] = [];

    let activeWeightedSum = 0;
    let activeWeightTotal = 0;

    // ── Pre-fetch ALL ProgramUnits for ALL years ───────────────────────────
    // One query total. Avoids N queries in the student loop.
    const allPUs = (await ProgramUnit.find({ program: program._id })
      .populate("unit")
      .lean()) as any[];
    const pusByYear = new Map<number, any[]>();
    for (const pu of allPUs) {
      const y = pu.requiredYear;
      if (!pusByYear.has(y)) pusByYear.set(y, []);
      pusByYear.get(y)!.push(pu);
    }

    // ── Pre-fetch disciplinary cases ───────────────────────────────────────
    let disciplinaryCases: any[] = [];
    try {
      // Dynamic import — safe if DisciplinaryCase model doesn't exist yet
      const DC = (await import("../models/DisciplinaryCase")).default;
      disciplinaryCases = (await DC.find({ student: student._id })
        .sort({ createdAt: 1 })
        .lean()) as any[];
    } catch {
      /* DisciplinaryCase not deployed yet — skip */
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART A: Historical academic years (from student.academicHistory)
    // ═════════════════════════════════════════════════════════════════════
    for (const record of (student.academicHistory || []) as any[]) {
      if ((record.yearOfStudy || 1) > duration) continue;

      const weight = getYearWeight(program, entryType, record.yearOfStudy);
      const yearPUs = pusByYear.get(record.yearOfStudy) ?? [];

      let resolvedYear = record.academicYear;
      if (
        !resolvedYear ||
        (record.yearOfStudy > 1 && resolvedYear === admissionYearString)
      ) {
        resolvedYear = incYear(admissionYearString, record.yearOfStudy - 1);
      }

      // ── CF units from THIS year ────────────────────────────────────────
      const yearCFs = (student.carryForwardUnits || []).filter(
        (u: any) => u.fromYear === record.yearOfStudy,
      );
      const cfList = yearCFs.map((u: any) => ({
        code: u.unitCode,
        name: u.unitName,
        attempt: u.attemptNumber ?? 3,
        status: u.status,
      }));

      // ── Deferred units from THIS year ──────────────────────────────────
      const yearDeferred = (student.deferredSuppUnits || []).filter(
        (u: any) => u.fromYear === record.yearOfStudy,
      );
      const deferredList = yearDeferred.map((u: any) => ({
        code: u.unitCode,
        name: u.unitName,
        reason: u.reason,
        status: u.status,
      }));

      // ── Challenges via status engine ───────────────────────────────────
      let challenges = {
        supplementary: [] as any[],
        retakes: [] as any[],
        stayouts: [] as any[],
        specials: [] as any[],
        carryForwards: cfList,
        deferred: deferredList,
        incomplete: [] as any[],
        discontinuationRisk: [] as any[],
      };
      let totalUnits = yearPUs.length || record.unitsTakenCount || 0;
      let displayStatus = record.isRepeatYear
        ? "REPEAT YEAR"
        : "PASS (PROMOTED)";
      let annualMean = record.annualMeanMark || 0;
      let eng22Risk = false;

      if (!isGraduated) {
        try {
          const analysis = await calculateStudentStatus(
            student._id,
            student.program,
            resolvedYear,
            record.yearOfStudy,
            { forPromotion: false },
          );

          totalUnits = analysis.summary.totalExpected || totalUnits;
          annualMean = parseFloat(analysis.weightedMean) || annualMean;

          if (
            !["ACADEMIC LEAVE", "GRADUATED", "DEFERMENT"].includes(
              analysis.status,
            )
          ) {
            displayStatus = record.isRepeatYear
              ? "REPEAT YEAR"
              : annualMean > 0 || analysis.summary.passed > 0
                ? "PASS (PROMOTED)"
                : analysis.status;
          }

          // Build challenge arrays
          const suppCodes = analysis.failedList
            .filter((f: any) => f.attempt === "A/S")
            .map((f: any) => codeOf(f.displayName));
          const retakeCodes = analysis.failedList
            .filter((f: any) =>
              ["A/RA", "A/RPU", "RP1C", "RP2C", "RP3C"].includes(f.attempt),
            )
            .map((f: any) => codeOf(f.displayName));
          const sosCodes = analysis.failedList
            .filter((f: any) => f.attempt === "A/SO")
            .map((f: any) => codeOf(f.displayName));
          const specCodes = analysis.specialList.map((s: any) =>
            codeOf(s.displayName),
          );
          const specGrounds = Object.fromEntries(
            analysis.specialList.map((s: any) => [
              codeOf(s.displayName),
              s.grounds || "",
            ]),
          );
          const incCodes = [
            ...analysis.incompleteList,
            ...analysis.missingList,
          ].map(codeOf);

          challenges.supplementary = await enrich(student, suppCodes, yearPUs);
          challenges.retakes = await enrich(student, retakeCodes, yearPUs);
          challenges.stayouts = await enrich(student, sosCodes, yearPUs);
          challenges.specials = await enrich(
            student,
            specCodes,
            yearPUs,
            specGrounds,
          );
          challenges.incomplete = await enrich(student, incCodes, yearPUs);

          // ENG.22 risk — any unit at attempt ≥ 4
          for (const pu of yearPUs) {
            const puId = pu._id.toString();
            const count = await attemptCount(student, puId);
            if (count >= 4) {
              challenges.discontinuationRisk.push({
                code: pu.unit?.code,
                name: pu.unit?.name,
                attempt: count,
              });
              eng22Risk = true;
            }
          }

          activeWeightedSum += parseFloat(analysis.weightedMean) * weight;
          activeWeightTotal += weight;
        } catch {
          /* keep defaults */
        }
      } else {
        // Graduated — get unit count only (don't run expensive engine)
        try {
          const count = await ProgramUnit.countDocuments({
            program: program._id,
            requiredYear: record.yearOfStudy,
          });
          totalUnits = count || totalUnits;
        } catch {
          /* keep */
        }
      }

      // Qualifier at this point in time
      // Carry-forward from this year → RP1C/2C. Repeat year → RP1/2. Otherwise blank.
      const yearQualifier = (() => {
        if (cfList.length > 0) return yearCFs[0]?.qualifier || "";
        if (record.isRepeatYear) {
          const repeatCount = (student.academicHistory || []).filter(
            (h: any) => h.isRepeatYear && h.yearOfStudy <= record.yearOfStudy,
          ).length;
          return `RP${Math.min(repeatCount, 5)}`;
        }
        return "";
      })();

      journey.push({
        type: "ACADEMIC",
        academicYear: resolvedYear,
        yearOfStudy: record.yearOfStudy,
        status: displayStatus,
        totalUnits,
        weight: Math.round(weight * 100),
        annualMean: parseFloat(annualMean.toFixed(2)),
        qualifierSuffix: yearQualifier,
        isRepeat: record.isRepeatYear || false,
        eng22Risk,
        challenges,
        date: record.date || new Date(0),
        isCurrent: false,
      });
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART B: Current active year (live engine, not yet in history)
    // ═════════════════════════════════════════════════════════════════════
    const LOCKED = [
      "on_leave",
      "deferred",
      "deregistered",
      "discontinued",
      "graduated",
      "graduand",
      "disciplinary_suspension",
    ];
    const isLocked = LOCKED.includes(student.status);
    const currentInHistory = (student.academicHistory || []).some(
      (h: any) => h.yearOfStudy === student.currentYearOfStudy,
    );
    const withinDuration = (student.currentYearOfStudy || 1) <= duration;

    if (!isLocked && !currentInHistory && withinDuration) {
      const currentYearDoc = (await AcademicYear.findOne({
        institution: student.institution,
        isCurrent: true,
      }).lean()) as any;
      const weight = getYearWeight(
        program,
        entryType,
        student.currentYearOfStudy,
      );
      const yearPUs = pusByYear.get(student.currentYearOfStudy) ?? [];

      const yearCFs = (student.carryForwardUnits || []).filter(
        (u: any) => u.fromYear === student.currentYearOfStudy,
      );
      const cfList = yearCFs.map((u: any) => ({
        code: u.unitCode,
        name: u.unitName,
        attempt: u.attemptNumber ?? 3,
        status: u.status,
      }));
      const yearDeferred = (student.deferredSuppUnits || []).filter(
        (u: any) => u.fromYear === student.currentYearOfStudy,
      );
      const deferredList = yearDeferred.map((u: any) => ({
        code: u.unitCode,
        name: u.unitName,
        reason: u.reason,
        status: u.status,
      }));

      try {
        const live = await calculateStudentStatus(
          student._id,
          student.program,
          "CURRENT",
          student.currentYearOfStudy,
        );

        const suppCodes = live.failedList
          .filter((f: any) => f.attempt === "A/S")
          .map((f: any) => codeOf(f.displayName));
        const retakeCodes = live.failedList
          .filter((f: any) =>
            ["A/RA", "A/RPU", "RP1C", "RP2C", "RP3C"].includes(f.attempt),
          )
          .map((f: any) => codeOf(f.displayName));
        const sosCodes = live.failedList
          .filter((f: any) => f.attempt === "A/SO")
          .map((f: any) => codeOf(f.displayName));
        const specCodes = live.specialList.map((s: any) =>
          codeOf(s.displayName),
        );
        const specGrounds = Object.fromEntries(
          live.specialList.map((s: any) => [
            codeOf(s.displayName),
            s.grounds || "",
          ]),
        );
        const incCodes = [...live.incompleteList, ...live.missingList].map(
          codeOf,
        );

        const riskUnits: any[] = [];
        for (const pu of yearPUs) {
          const count = await attemptCount(student, pu._id.toString());
          if (count >= 4)
            riskUnits.push({
              code: pu.unit?.code,
              name: pu.unit?.name,
              attempt: count,
            });
        }

        journey.push({
          type: "ACADEMIC",
          academicYear: currentYearDoc?.year || "Current",
          yearOfStudy: student.currentYearOfStudy,
          status: live.status,
          totalUnits: live.summary.totalExpected,
          weight: Math.round(weight * 100),
          annualMean: parseFloat(live.weightedMean),
          qualifierSuffix: student.qualifierSuffix || "",
          isRepeat: student.status === "repeat",
          eng22Risk: riskUnits.length > 0,
          isCurrent: true,
          challenges: {
            supplementary: await enrich(student, suppCodes, yearPUs),
            retakes: await enrich(student, retakeCodes, yearPUs),
            stayouts: await enrich(student, sosCodes, yearPUs),
            specials: await enrich(student, specCodes, yearPUs, specGrounds),
            carryForwards: cfList,
            deferred: deferredList,
            incomplete: await enrich(student, incCodes, yearPUs),
            discontinuationRisk: riskUnits,
          },
          date: new Date(),
        });

        activeWeightedSum += parseFloat(live.weightedMean) * weight;
        activeWeightTotal += weight;
      } catch (e: any) {
        console.warn("[journey] Current year engine error:", e.message);
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART C: Status events — enriched with leave details
    // ═════════════════════════════════════════════════════════════════════
    for (const ev of (student.statusEvents || []) as any[]) {
      const toSt = (ev.toStatus || "").toLowerCase();
      let leaveInfo = undefined;

      if (["on_leave", "academic_leave", "deferred"].includes(toSt)) {
        const leave = student.academicLeavePeriod;
        if (leave?.startDate) {
          const start = new Date(leave.startDate);
          const end = leave.endDate ? new Date(leave.endDate) : null;
          const durationMonths = end
            ? Math.round(
                (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30),
              )
            : 0;
          leaveInfo = {
            type: toSt === "deferred" ? "DEFERMENT" : "ACADEMIC LEAVE",
            reason: (leave.type || "other").toUpperCase(),
            duration: end
              ? `${durationMonths} month${durationMonths !== 1 ? "s" : ""}`
              : "Ongoing",
            endDate: end ? end.toISOString().split("T")[0] : undefined,
          };
        }
      }

      journey.push({
        type: "STATUS_CHANGE",
        academicYear: ev.academicYear || "",
        toStatus: ev.toStatus,
        fromStatus: ev.fromStatus,
        reason: ev.reason,
        leaveInfo,
        date: ev.date || new Date(0),
      });
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART D: Deferred supp/special events
    // ENG.13b — coordinator deferred a supp to next ordinary
    // ENG.18c — coordinator deferred a special to next ordinary
    // ═════════════════════════════════════════════════════════════════════
    for (const entry of (student.deferredSuppUnits || []) as any[]) {
      journey.push({
        type: "DEFERRED_SUPP",
        academicYear: entry.fromAcademicYear || "",
        yearOfStudy: entry.fromYear || 0,
        unitCode: entry.unitCode || "N/A",
        unitName: entry.unitName || "",
        reason: entry.reason || "supp_deferred",
        status: entry.status || "pending",
        date: entry.addedAt || new Date(0),
      });
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART E: Carry-forward grant events (ENG.14)
    // One CARRY_FORWARD node per unique fromYear in carryForwardUnits.
    // ═════════════════════════════════════════════════════════════════════
    const cfByYear = new Map<number, any[]>();
    for (const u of (student.carryForwardUnits || []) as any[]) {
      if (!cfByYear.has(u.fromYear)) cfByYear.set(u.fromYear, []);
      cfByYear.get(u.fromYear)!.push(u);
    }
    for (const [fromYear, units] of cfByYear) {
      const yearRecord = (student.academicHistory || []).find(
        (h: any) => h.yearOfStudy === fromYear,
      );
      const yearStr =
        yearRecord?.academicYear || incYear(admissionYearString, fromYear - 1);
      const qualifier = units[0]?.qualifier || "RP1C";

      journey.push({
        type: "CARRY_FORWARD",
        academicYear: yearStr,
        yearOfStudy: fromYear,
        cfUnits: units.map((u: any) => u.unitCode),
        qualifier,
        reason: `ENG.14: ${units.length} unit(s) carried forward to Year ${fromYear + 1}: ${units.map((u: any) => u.unitCode).join(", ")}`,
        date: units[0]?.addedAt || new Date(0),
      });
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART F: Disciplinary cases
    // ═════════════════════════════════════════════════════════════════════
    for (const dc of disciplinaryCases) {
      journey.push({
        type: "DISCIPLINARY",
        academicYear: "",
        grounds: dc.grounds,
        outcome: dc.outcome,
        caseId: dc._id.toString(),
        hearingDate: dc.hearingDate
          ? new Date(dc.hearingDate).toISOString().split("T")[0]
          : undefined,
        reason:
          (dc.description || "").substring(0, 120) +
          ((dc.description || "").length > 120 ? "…" : ""),
        toStatus:
          dc.outcome === "SENT_HOME" ? "disciplinary_suspension" : dc.outcome?.toLowerCase(),
        date: dc.createdAt || new Date(0),
      });
    }

    // ═════════════════════════════════════════════════════════════════════
    // PART G: Graduation event
    // ═════════════════════════════════════════════════════════════════════
    if (isGraduated) {
      const lastHistory = [...(student.academicHistory || [])].sort(
        (a: any, b: any) => (b.yearOfStudy || 0) - (a.yearOfStudy || 0),
      )[0];

      journey.push({
        type: "GRADUATION",
        academicYear: lastHistory?.academicYear || "",
        yearOfStudy: duration,
        status: "GRADUATED",
        annualMean: parseFloat(student.finalWeightedAverage || "0"),
        qualifierSuffix: "",
        reason: student.classification || "Degree Awarded",
        date: student.updatedAt || new Date(),
      });
    }

    // ─── Sort chronologically ──────────────────────────────────────────────
    journey.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    // ─── Cumulative mean ───────────────────────────────────────────────────
    let projectedMean: number;
    if (isGraduated) {
      const stored = parseFloat(student.finalWeightedAverage || "0");
      if (stored > 0) {
        projectedMean = stored;
      } else {
        try {
          const { calculateGraduationStatus } =
            await import("../services/graduationEngine");
          const result = await calculateGraduationStatus(
            student._id.toString(),
          );
          projectedMean = result.weightedAggregateAverage;
        } catch {
          projectedMean = 0;
        }
      }
    } else {
      projectedMean =
        activeWeightTotal > 0 ? activeWeightedSum / activeWeightTotal : 0;
    }

    let classification = "";
    if (projectedMean >= 70) classification = "FIRST CLASS HONOURS";
    else if (projectedMean >= 60)
      classification = "SECOND CLASS HONOURS (UPPER)";
    else if (projectedMean >= 50)
      classification = "SECOND CLASS HONOURS (LOWER)";
    else if (projectedMean >= 40) classification = "PASS";
    else if (projectedMean > 0) classification = "BELOW PASS MARK";

    return res.json({
      admissionYear: admissionYearString,
      intake: student.intake || "SEPT",
      currentStatus: student.status.toUpperCase(),
      cumulativeMean: projectedMean.toFixed(2),
      totalTimeOutYears: student.totalTimeOutYears || 0,
      classification,
      timeline: journey,
    });
  }),
);

router.post("/approve-special", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { markId, reason, undo = false, knownToDean, otherGroundApproved } = req.body;
  let { ground } = req.body as { ground?: string };
   if (!markId) return res.status(400).json({ error: "Mark ID is required" });

  let remarks = "Special Exam Revoked";
  if (!undo) {
    // ENG.18(b): the three grounds are sickness, compassionate and financial, unless otherwise specified and approved.
    if (!ground && typeof reason === "string") ground = reason.trim().toLowerCase(); // older clients send the ground as `reason`
    const GROUNDS = ["sickness", "compassionate", "financial"];
    if (!ground || ![...GROUNDS, "other"].includes(ground))
      return res.status(400).json({ error: "ENG.18(b): the ground must be sickness, compassionate or financial." });
    if (ground === "other" && otherGroundApproved !== true)
      return res.status(400).json({ error: "ENG.18(b): any other ground needs explicit approval (otherGroundApproved)." });
    // ENG.18(d): the good cause must have been known to the Dean while the work or exam was being conducted.
    if (knownToDean !== true)
      return res.status(400).json({ error: "ENG.18(d): confirm that the good cause was made known to the Dean during the period of the assessment." });
    const detail = ground === "other" && reason ? ` — ${reason}` : "";
    remarks = `Special Granted: ${ground.charAt(0).toUpperCase()}${ground.slice(1)}${detail}`;
  }

  const upd = undo
    ? { $set: { isSpecial: false, attempt: "1st", remarks } }
    : { $set: { isSpecial: true, attempt: "special", remarks } };
  let mark = await Mark.findByIdAndUpdate(markId, upd, { new: true });
  if (!mark) mark = await MarkDirect.findByIdAndUpdate(markId, upd, { new: true });
  if (!mark) return res.status(404).json({ error: "Mark record not found" });
  try {
    const gr = await computeFinalGrade({ markId: mark._id as any, coordinatorReq: req });
    res.json({ success: true, message: undo ? "Special exam revoked" : "Special exam approved", newStatus: gr.status });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}));

router.post("/leave", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { studentId, startDate, endDate, reason, leaveType } = req.body;
  const result = await grantAcademicLeave(studentId, new Date(startDate), new Date(endDate), reason, leaveType);
  res.json({ success: true, student: result });
}));

router.post("/defer", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { studentId, years } = req.body;
  const result = await deferAdmission(studentId, parseInt(years) as 1 | 2);
  res.json({ success: true, student: result });
}));

router.post("/revert-active", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { studentId } = req.body;
  const result = await revertStatusToActive(studentId);
  res.json({ success: true, student: result });
}));

router.post("/readmit", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { studentId, remarks, secondSemester } = req.body;
  if (!studentId) return res.status(400).json({ error: "Student ID required" });
  const result = await readmitStudent(studentId, remarks || "Approved by Senate/Department", secondSemester === true);
  console.log(`[READMISSION] ${result?.regNo} reinstated by ${req.user?.name}`);
  res.json({ success: true, message: "Student readmitted successfully", student: result });
}));

router.get("/raw-marks", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { regNo, yearOfStudy } = req.query;
  if (!regNo) return res.status(400).json({ error: "regNo required" });
  const student = await Student.findOne({ regNo: { $regex: regNoAnyQualifierRegex(splitRegNo(regNo).base) } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  const [dm, dmt] = await Promise.all([
    Mark.find({ student: student._id }).populate({ path: "programUnit", match: yearOfStudy ? { requiredYear: parseInt(yearOfStudy as string) } : {}, populate: { path: "unit", select: "code name" } }).populate("academicYear", "year").lean(),
    MarkDirect.find({ student: student._id }).populate({ path: "programUnit", match: yearOfStudy ? { requiredYear: parseInt(yearOfStudy as string) } : {}, populate: { path: "unit", select: "code name" } }).populate("academicYear", "year").lean(),
  ]);
  res.json([...dm.filter((m) => m.programUnit).map((m) => ({ ...m, entryMode: "detailed" })), ...dmt.filter((m) => m.programUnit).map((m) => ({ ...m, entryMode: "direct" }))]);
}));

router.post("/raw-marks", requireAuth, requireRole("coordinator"), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { regNo, unitCode, academicYear, semester, cat1, cat2, cat3, assignment1, practicalRaw, examQ1, examQ2, examQ3, examQ4, examQ5, examMode, caDirect, examDirect, agreedMark, isSpecial, attempt } = req.body;
  if (!regNo || !unitCode || !academicYear) return res.status(400).json({ error: "regNo, unitCode, and academicYear are required" });
  const [student, unitDoc, yearDoc] = await Promise.all([Student.findOne({ regNo: { $regex: regNoAnyQualifierRegex(splitRegNo(regNo).base) } }), Unit.findOne({ code: unitCode.toUpperCase().trim() }), AcademicYear.findOne({ year: academicYear })]);
  if (!student || !unitDoc || !yearDoc) return res.status(404).json({ error: "Required metadata not found" });
  const programUnit = await ProgramUnit.findOne({ program: student.program, unit: unitDoc._id });
  if (!programUnit) return res.status(400).json({ error: `Unit ${unitCode} not linked to student's program.` });
  const isDirectEntry = caDirect !== undefined || examDirect !== undefined;
  if (isDirectEntry) {
    const upd = { institution: student.institution, student: student._id, programUnit: programUnit._id, academicYear: yearDoc._id, semester: semester || "SEMESTER 1", caTotal30: Number(caDirect)||0, examTotal70: Number(examDirect)||0, agreedMark: Number(agreedMark)||(Number(caDirect)+Number(examDirect)), attempt: isSpecial ? "special" : (attempt||"1st"), isSpecial: isSpecial===true, uploadedBy: req.user._id, uploadedAt: new Date() };
    const u = await MarkDirect.findOneAndUpdate({ student: student._id, programUnit: programUnit._id, academicYear: yearDoc._id }, upd, { upsert: true, new: true, setDefaultsOnInsert: true });
    // Re-grade so the official grade, transcript and status reflect the edit (the detailed branch already did).
    const gr = await computeFinalGrade({ markId: u._id as any, coordinatorReq: req });
    await refreshStudentWAA(student._id).catch((e: unknown) => console.warn("[raw-marks] WAA refresh failed:", e instanceof Error ? e.message : e));
    return res.json({ success: true, message: "Direct mark saved and re-graded", data: gr ?? u });
  }
  const upd = { institution: student.institution, student: student._id, programUnit: programUnit._id, academicYear: yearDoc._id, semester: semester||"SEMESTER 1", cat1Raw: Number(cat1)||0, cat2Raw: Number(cat2)||0, cat3Raw: cat3?Number(cat3):undefined, assgnt1Raw: Number(assignment1)||0, practicalRaw: Number(practicalRaw)||0, examQ1Raw: Number(examQ1)||0, examQ2Raw: Number(examQ2)||0, examQ3Raw: Number(examQ3)||0, examQ4Raw: Number(examQ4)||0, examQ5Raw: Number(examQ5)||0, examMode: examMode||"standard", isSpecial: isSpecial===true, attempt: isSpecial?"special":(attempt||"1st"), uploadedBy: req.user._id, uploadedAt: new Date() };
  const u = await Mark.findOneAndUpdate({ student: student._id, programUnit: programUnit._id, academicYear: yearDoc._id }, upd, { upsert: true, new: true, setDefaultsOnInsert: true });
  const gr = await computeFinalGrade({ markId: u._id as any, coordinatorReq: req });
  await refreshStudentWAA(student._id).catch((e: unknown) => console.warn("[raw-marks] WAA refresh failed:", e instanceof Error ? e.message : e));
  return res.json({ success: true, message: "Detailed marks processed", data: gr });
}));

// Coordinator explicitly defers a student's supp/special units to the next
// ordinary examination period, enabling promotion despite pending units.
// (ENG.13b / ENG.18c)
router.post("/defer-supp", requireAuth,
  requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { studentId, programUnitIds, academicYear, reason } = req.body;
 
    // ── Detailed request log ───────────────────────────────────────────────
    console.group("[defer-supp] Incoming request");
    console.log("body.studentId      :", studentId,      typeof studentId);
    console.log("body.programUnitIds :", programUnitIds, Array.isArray(programUnitIds) ? `(length ${programUnitIds?.length})` : typeof programUnitIds);
    console.log("body.academicYear   :", JSON.stringify(academicYear), typeof academicYear);
    console.log("body.reason         :", reason);
    console.groupEnd();
 
    // ── Validation ────────────────────────────────────────────────────────
    if (!studentId) {
      console.error("[defer-supp] 400: studentId missing");
      return res.status(400).json({ error: "studentId is required" });
    }
    if (!programUnitIds?.length) {
      console.error("[defer-supp] 400: programUnitIds missing or empty");
      return res.status(400).json({ error: "programUnitIds (array) is required" });
    }
    if (!academicYear) {
      console.error("[defer-supp] 400: academicYear is falsy —", JSON.stringify(academicYear));
      return res.status(400).json({ error: "academicYear is required" });
    }
    if (!["supp_deferred", "special_deferred"].includes(reason)) {
      console.error("[defer-supp] 400: invalid reason —", reason);
      return res.status(400).json({ error: "reason must be 'supp_deferred' or 'special_deferred'" });
    }
 
    const student = await Student.findById(studentId).lean();
    if (!student) {
      console.error("[defer-supp] 404: student not found for id", studentId);
      return res.status(404).json({ error: "Student not found" });
    }
 
    // Validate all programUnitIds belong to this student's program
    const pUnits = await ProgramUnit.find({
      _id:     { $in: programUnitIds },
      program: (student as any).program,
    }).populate("unit").lean() as any[];
 
    console.log("[defer-supp] programUnitIds requested:", programUnitIds);
    console.log("[defer-supp] pUnits found in DB       :", pUnits.map((p: any) => ({
      _id:     p._id.toString(),
      code:    p.unit?.code,
      program: p.program?.toString(),
    })));
 
    if (pUnits.length !== programUnitIds.length) {
      console.error(
        `[defer-supp] 400: ID count mismatch — requested ${programUnitIds.length}, found ${pUnits.length}`,
        "\nrequested:", programUnitIds,
        "\nfound    :", pUnits.map((p: any) => p._id.toString()),
        "\nstudent.program:", (student as any).program?.toString(),
      );
      return res.status(400).json({
        error: "One or more programUnitIds are invalid or don't belong to this student's program",
      });
    }
 
    // Build deferred entries — skip units already pending
    const existingDeferred  = (student as any).deferredSuppUnits || [];
    const alreadyDeferredIds = new Set(
      existingDeferred
        .filter((u: any) => u.status === "pending")
        .map((u: any) => u.programUnitId),
    );
 
    const newUnitIds = programUnitIds.filter((id: string) => !alreadyDeferredIds.has(id));
 
    if (newUnitIds.length === 0) {
      console.warn("[defer-supp] 400: all units already deferred");
      return res.status(400).json({ error: "All specified units are already deferred" });
    }
 
    const entries = pUnits
      .filter((pu: any) => newUnitIds.includes(pu._id.toString()))
      .map((pu: any) => ({
        programUnitId:    pu._id.toString(),
        unitCode:         pu.unit?.code  || "N/A",
        unitName:         pu.unit?.name  || "N/A",
        fromYear:         (student as any).currentYearOfStudy,
        fromAcademicYear: academicYear,
        reason,
        addedAt:          new Date(),
        status:           "pending",
      }));
 
    console.log("[defer-supp] writing entries:", entries.map((e: any) => ({ code: e.unitCode, reason: e.reason })));
 
    await Student.findByIdAndUpdate(studentId, {
      $push: {
        deferredSuppUnits: { $each: entries },
        statusEvents: {
          fromStatus:  (student as any).status,
          toStatus:    (student as any).status,
          date:        new Date(),
          academicYear,
          reason: `ENG.13b/ENG.18c deferral — ${reason.replace("_", " ")}: ${
            entries.map((e: any) => e.unitCode).join(", ")
          }`,
        },
      },
    });
 
    await logAudit(req, {
      action:     "supp_deferred_to_next_ordinary",
      targetUser: studentId as any,
      details:    { units: entries.map((e: any) => e.unitCode), reason, academicYear },
    });
 
    console.log(`[defer-supp] ✓ deferred ${entries.length} unit(s) for student ${(student as any).regNo}`);
 
    return res.json({
      success:  true,
      message:  `Deferred ${entries.length} unit(s) to next ordinary period`,
      deferred: entries,
    });
  }),
);

// Undo a deferral (before promotion is processed)
router.delete("/defer-supp/:studentId/:programUnitId", requireAuth,
  requireRole("coordinator"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { studentId, programUnitId } = req.params;

    await Student.findByIdAndUpdate(studentId, {
      $pull: { deferredSuppUnits: { programUnitId, status: "pending" } },
    });

    return res.json({ success: true, message: "Deferral cancelled" });
  }),
);

// Returns all pending deferred units for a student (for UI display)
router.get("/deferred-units/:studentId", requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const student = await Student.findById(req.params.studentId)
      .select("deferredSuppUnits")
      .lean() as any;

    if (!student) return res.status(404).json({ error: "Student not found" });

    const pending = (student.deferredSuppUnits || []).filter(
      (u: any) => u.status === "pending",
    );
    return res.json({ success: true, data: pending });
  }),
);

export default router;