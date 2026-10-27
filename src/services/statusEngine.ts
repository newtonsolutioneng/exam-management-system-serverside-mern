
// serverside/src/services/statusEngine.ts
// KEY CHANGES vs prior version:
//   1. StudentStatusResult gains `deferredList` field
//   2. calculateStudentStatus suppresses deferred units from fail/special counts
//      and populates deferredList — so the status box reflects post-defer reality
//   3. academicYearName is always returned (fixes the 400 on defer submit)

import { mapLimit } from "../utils/mapLimit";
import FinalGrade from "../models/FinalGrade";
import ProgramUnit from "../models/ProgramUnit";
import Student from "../models/Student";
import Mark from "../models/Mark";
import InstitutionSettings from "../models/InstitutionSettings";
import MarkDirect from "../models/MarkDirect";
import AcademicYear from "../models/AcademicYear";
import { getYearWeight } from "../utils/weightingRegistry";
import { performAcademicAudit, applyRepeatUnitRule } from "./academicAudit";
import { getAttemptLabel, REG_QUALIFIERS, classifyWAA } from "../utils/academicRules";
import { validateHistoricalYears } from "./historicalYearValidator";
import { outstandingAttachments } from "./attachments";

function _qualifierShouldClearOnPromotion(qualifier: string): boolean {
  if (!qualifier || qualifier.trim() === "") return false;
  return /^RP\d+$/.test(qualifier.trim());
}

let _assessAndGrant: ((studentId: string, programId: string, yearOfStudy: number, academicYearName: string) => Promise<{ granted: boolean; cfUnits: any[]; qualifier: string; reason: string }>) | null = null;

async function tryAssessAndGrantCarryForward(
  studentId: string, programId: string, yearOfStudy: number, academicYearName: string,
): Promise<{ granted: boolean; cfUnits: any[]; qualifier: string; reason: string }> {
  try {
    if (!_assessAndGrant) {
      const mod = await import("./carryForwardService");
      _assessAndGrant = mod.assessAndGrantCarryForward;
    }
    return await _assessAndGrant!(studentId, programId, yearOfStudy, academicYearName);
  } catch (err: any) {
    console.warn("[StatusEngine] carryForwardService unavailable:", err.message);
    return { granted: false, cfUnits: [], qualifier: "", reason: err.message };
  }
}

const syncTerminalStatusToDb = async (
  studentId: string, engineStatus: string, details: string, academicYear: string,
): Promise<void> => {
  interface Mapping { dbStatus: string; qualifierFn: (s: any) => string }
  const terminalMap: Record<string, Mapping> = {
    "DEREGISTERED": { dbStatus: "deregistered", qualifierFn: () => "" },
    "REPEAT YEAR":  { dbStatus: "repeat", qualifierFn: (s: any) => {
      const count = ((s.academicHistory || []) as any[]).filter((h: any) => h.isRepeatYear).length + 1;
      return REG_QUALIFIERS.repeatYear(count);
    }},
    "STAYOUT":      { dbStatus: "active",       qualifierFn: () => "" },
    "DISCONTINUED": { dbStatus: "discontinued", qualifierFn: () => "" },
  };

  const entry = terminalMap[engineStatus];
  if (!entry) return;

  const student = await Student.findById(studentId).lean();
  if (!student) return;
  if (entry.dbStatus !== "active" && (student as any).status === entry.dbStatus) return;

  const fromStatus   = (student as any).status;
  const newQualifier = entry.qualifierFn(student);

  const updatePayload: any = {
    $set:  { status: entry.dbStatus, remarks: details },
    $push: {
      statusEvents:  { fromStatus, toStatus: entry.dbStatus, date: new Date(), reason: `Auto-Sync: ${details}`, academicYear },
      statusHistory: { status: entry.dbStatus, previousStatus: fromStatus, date: new Date(), reason: details },
    },
  };
  if (newQualifier) updatePayload.$set.qualifierSuffix = newQualifier;
  await Student.findByIdAndUpdate(studentId, updatePayload);
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StudentStatusResult {
  status:           string;
  variant:          "success" | "warning" | "error" | "info";
  details:          string;
  weightedMean:     string;
  sessionState:     string;
  academicYearName: string;
  summary: { totalExpected: number; passed: number; failed: number; missing: number; isOnLeave?: boolean };
  passedList:    { code: string; mark: number }[];
  failedList:    { displayName: string; attempt: string | number; programUnitId: string }[];
  specialList:   { displayName: string; grounds: string; programUnitId: string }[];
  deferredList:  { displayName: string; programUnitId: string; reason: string }[];
  missingList:   string[];
  incompleteList: string[];
  leaveDetails?: string;
}

// ── calculateStudentStatus ────────────────────────────────────────────────────
export const calculateStudentStatus = async (
  studentId: any, programId: any, academicYearName: string,
  yearOfStudy: number = 1,
  /** `memo`: pass one Map per request (e.g. a promotion analysis) so class-wide look-ups are read once, not once per student. */
  options: {
        forPromotion?: boolean;
        memo?: Map<string, Promise<any>>;
        /** records the caller already loaded for the whole class; skips this student's own queries */
        prefetched?: { student: any; detailed: any[]; direct: any[]; grades: any[] };
      } = {},
 ): Promise<StudentStatusResult> => {
  const memo = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!options.memo) return load();
    if (!options.memo.has(key)) options.memo.set(key, load());
    return options.memo.get(key) as Promise<T>;
  };
 
  const settings = await memo("settings", async () => InstitutionSettings.findOne().lean());
  if (!settings) throw new Error("Institution settings not found.");
  const passMark = (settings as any).passMark || 40;

  // ENG 23(c): absences that trigger deregistration (setting, default 6)
  const maxAbsent = (settings as any).ruleSet?.maxAbsentExams ?? 6;
  // ENG.10(e): a missed exam scores 0 (the unit is failed) instead of being listed as missing. Off by default.
  const enforcePractical = (settings as any).ruleSet?.enforcePracticalPass === true;
  const missedExamZero = (settings as any).ruleSet?.missedExamScoresZero === true;
  const student = options.prefetched?.student ?? await Student.findById(studentId).lean();
  if (!student) throw new Error("Student not found");

  // ── Terminal gate ─────────────────────────────────────────────────────────
  const TERMINAL: Record<string, { label: string; variant: "info"|"error"|"success"|"warning" }> = {
    on_leave:     { label: "ACADEMIC LEAVE", variant: "info"    },
    deferred:     { label: "DEFERMENT",      variant: "info"    },
    discontinued: { label: "DISCONTINUED",   variant: "error"   },
    deregistered: { label: "DEREGISTERED",   variant: "error"   },
    graduated:    { label: "GRADUATED",      variant: "success" },
    graduand:     { label: "GRADUATED",      variant: "success" },
  };

  const terminalEntry = TERMINAL[(student as any).status ?? ""];
  if (terminalEntry) {
    const leaveType = (student as any).academicLeavePeriod?.type || "";
    const rem       = ((student as any).remarks || "").toLowerCase();
    let grounds = "";
    if (leaveType === "financial" || rem.includes("financial"))
      grounds = "FINANCIAL";
    else if (leaveType === "compassionate" || rem.includes("compassionate") || rem.includes("medical"))
      grounds = "COMPASSIONATE";
    else if (leaveType)
      grounds = leaveType.toUpperCase();
    const count = await ProgramUnit.countDocuments({ program: programId, requiredYear: yearOfStudy });
    return {
      status: terminalEntry.label, variant: terminalEntry.variant,
      details: `Student is currently ${terminalEntry.label}.${grounds ? ` Grounds: ${grounds}.` : ""}`,
      weightedMean: "0.00", sessionState: "ORDINARY", academicYearName: academicYearName ?? "",
      summary: { totalExpected: count, passed: 0, failed: 0, missing: 0, isOnLeave: true },
      passedList: [], failedList: [], specialList: [], deferredList: [],
      missingList: [], incompleteList: [], leaveDetails: grounds,
    };
  }

  // ── Academic year ──────────────────────────────────────────────────────────
  let targetYearDoc: any = null;
  if (!academicYearName || academicYearName === "CURRENT" || academicYearName === "undefined") {
    targetYearDoc = (await AcademicYear.findOne({ isCurrent: true }).lean())
      || (await AcademicYear.findOne().sort({ startDate: -1 }).lean());
  } else {
    targetYearDoc = await memo(`year:${academicYearName}`, async () =>
      (await AcademicYear.findOne({ year: academicYearName }).lean())
      || (await AcademicYear.findOne({ year: { $regex: new RegExp(`^${academicYearName.replace("/", "\\/")}$`, "i") } }).lean()));
    if (!targetYearDoc) console.warn(`[StatusEngine] AcademicYear "${academicYearName}" not found.`);
  }

  const resolvedYearName: string = targetYearDoc?.year ?? academicYearName ?? "";

  // ── Curriculum ────────────────────────────────────────────────────────────
  const curriculum = await memo(`curriculum:${programId}:${yearOfStudy}`, async () =>
    ProgramUnit.find({ program: programId, requiredYear: yearOfStudy }).populate("unit").lean()) as any[];
  
  if (!curriculum?.length) {
    return {
      status: "CURRICULUM NOT SET", variant: "info", details: `No units defined for Year ${yearOfStudy}.`,
      weightedMean: "0.00", sessionState: "ORDINARY", academicYearName: resolvedYearName,
      summary: { totalExpected: 0, passed: 0, failed: 0, missing: 0 },
      passedList: [], failedList: [], specialList: [], deferredList: [],
      missingList: [], incompleteList: [],
    };
  }

  const programUnitIds = curriculum.map((pu: any) => pu._id);

  const [detailedMarks, directMarks, finalGrades] = options.prefetched
    ? [options.prefetched.detailed, options.prefetched.direct, options.prefetched.grades]
    : await Promise.all([
    Mark.find({ student: studentId, programUnit: { $in: programUnitIds } }).lean(),
    MarkDirect.find({ student: studentId, programUnit: { $in: programUnitIds } }).lean(),
    FinalGrade.find({ student: studentId, programUnit: { $in: programUnitIds } }).lean(),
  ]);

  // ── marksMap ──────────────────────────────────────────────────────────────
  const marksMap = new Map<string, any>();

  finalGrades.forEach((fg: any) => {
    const key = fg.programUnit?.toString(); if (!key) return;
    const existing = marksMap.get(key);
    if (existing?.source === "finalGrade") {
      const existingIsBetter =
        (existing._fgStatus === "PASS" && fg.status !== "PASS") ||
        (existing._fgStatus === fg.status && (existing.createdAt ?? 0) >= (fg.createdAt ?? 0));
      if (existingIsBetter) return;
    }
    marksMap.set(key, {
      agreedMark:  fg.totalMark ?? 0,
      caTotal30:   fg.caTotal30   != null ? fg.caTotal30   : (fg.totalMark > 0 ? 1 : 0),
      examTotal70: fg.examTotal70 != null ? fg.examTotal70 : (fg.totalMark > 0 ? 1 : 0),
      attempt:     fg.attemptType === "SUPPLEMENTARY" ? "supplementary"
                 : fg.attemptType === "RETAKE"         ? "re-take" : "1st",
      isSpecial:   (fg.isSpecial === true || fg.status === "SPECIAL") && fg.status !== "PASS",
      source:      "finalGrade",
      _fgStatus:   fg.status,
    });
  });

  directMarks.forEach((m: any) => {
    marksMap.set(m.programUnit.toString(), { ...m, source: "direct" });
  });

  detailedMarks.forEach((m: any) => {
    marksMap.set(m.programUnit.toString(), { ...m, source: "detailed" });
  });

  finalGrades.forEach((fg: any) => {
    if (fg.status !== "PASS") return;
    const key = fg.programUnit?.toString(); if (!key) return;
    const current = marksMap.get(key);
    if (!current) return;
    if (current.attempt === "special" || current.isSpecial === true) {
      marksMap.set(key, {
        agreedMark:  fg.totalMark ?? 0,
        caTotal30:   fg.caTotal30   != null ? fg.caTotal30   : (fg.totalMark > 0 ? 1 : 0),
        examTotal70: fg.examTotal70 != null ? fg.examTotal70 : (fg.totalMark > 0 ? 1 : 0),
        attempt: "1st", isSpecial: false,
        source: "finalGrade_pass", _fgStatus: "PASS",
      });
    }
  });

  // ── Unit classification loop ──────────────────────────────────────────────
  const lists = {
    passed:     [] as { code: string; mark: number }[],
    failed:     [] as { displayName: string; attempt: string | number; programUnitId: string }[],
    special:    [] as { displayName: string; grounds: string; programUnitId: string }[],
    missing:    [] as string[],
    incomplete: [] as string[],
  };
  let totalFirstAttemptSum = 0;
  // ENG.23(c): absences are counted per semester.
  const absentBySem = new Map<number, number>();
  const countAbsent = (sem: unknown) => { const k = Number(sem) || 1; absentBySem.set(k, (absentBySem.get(k) || 0) + 1); };

  curriculum.forEach((pUnit: any) => {
    const code          = pUnit.unit?.code?.toUpperCase();
    const displayName   = `${code}: ${pUnit.unit?.name}`;
    const programUnitId = pUnit._id.toString();
    const rawMark       = marksMap.get(programUnitId);

    if (!rawMark) { lists.missing.push(displayName); countAbsent(pUnit.requiredSemester); return; }

    const hasCAT  = (rawMark.caTotal30  || 0) > 0;
    // ENG.10(b): a unit assessed solely by coursework has examMax 0 — no exam is expected.
    const caOnlyUnit = rawMark.examMax === 0;
    const hasExam = caOnlyUnit || (rawMark.examTotal70 || 0) > 0;
    const markVal = rawMark.agreedMark || 0;
    const isSupp  = rawMark.attempt === "supplementary";
    const isSpc   = rawMark.attempt === "special" || rawMark.isSpecial === true;

    const notation = getAttemptLabel({
      markAttempt:      rawMark.attempt,
      studentStatus:    (student as any).status,
      studentQualifier: (student as any).qualifierSuffix,
    });

    if (isSpc) {
      lists.special.push({ displayName, grounds: rawMark.remarks || "Special", programUnitId });
    } else if (!hasCAT && !hasExam) {
      lists.missing.push(`${displayName} (Absent)`);
      countAbsent(pUnit.requiredSemester);
    } else if (!hasCAT && hasExam) {
      if (isSupp) {
        if (markVal >= passMark && !(enforcePractical && rawMark.practicalFailed)) lists.passed.push({ code, mark: markVal });
        else                     lists.failed.push({ displayName, attempt: notation, programUnitId });
        totalFirstAttemptSum += markVal;
      } else {
        lists.incomplete.push(`${displayName} (No CAT)`);
      }
    } else if (!hasExam && hasCAT) {
      countAbsent(pUnit.requiredSemester);
      if (missedExamZero) {
        lists.failed.push({ displayName: `${displayName}`, attempt: notation, programUnitId });
        totalFirstAttemptSum += markVal;
      } else {
        lists.missing.push(`${displayName} (Missing Exam)`);
      }
    } else {
      if (markVal >= passMark && !(enforcePractical && rawMark.practicalFailed)) lists.passed.push({ code, mark: markVal });
      else                     lists.failed.push({ displayName, attempt: notation, programUnitId });
      totalFirstAttemptSum += markVal;
    }
  });

  // ── Deferred-unit suppression (ENG.13b / ENG.18c) ────────────────────────
  // Units the coordinator has deferred to the next ordinary period are removed
  // from the fail/special lists so the status reflects the student's effective
  // standing (i.e. what they still need to resolve THIS year).
  const pendingDeferredUnits: Array<{ displayName: string; programUnitId: string; reason: string }> = [];

  const allPendingDeferred: any[] = ((student as any).deferredSuppUnits || []).filter(
    (u: any) => u.status === "pending",
  );

  if (allPendingDeferred.length > 0) {
    const deferredIds = new Set(allPendingDeferred.map((u: any) => u.programUnitId));

    // Move matching entries out of failed/special into deferredList
    const newFailed:  typeof lists.failed  = [];
    const newSpecial: typeof lists.special = [];

    for (const f of lists.failed) {
      if (deferredIds.has(f.programUnitId)) {
        const entry = allPendingDeferred.find((u: any) => u.programUnitId === f.programUnitId);
        pendingDeferredUnits.push({ displayName: f.displayName, programUnitId: f.programUnitId, reason: entry?.reason || "supp_deferred" });
      } else {
        newFailed.push(f);
      }
    }
    for (const s of lists.special) {
      if (deferredIds.has(s.programUnitId)) {
        const entry = allPendingDeferred.find((u: any) => u.programUnitId === s.programUnitId);
        pendingDeferredUnits.push({ displayName: s.displayName, programUnitId: s.programUnitId, reason: entry?.reason || "special_deferred" });
      } else {
        newSpecial.push(s);
      }
    }

    lists.failed  = newFailed;
    lists.special = newSpecial;

    console.log(`[StatusEngine] deferred suppression: removed ${pendingDeferredUnits.length} unit(s) from fail/special lists`);
  }

  // ── Status decision ───────────────────────────────────────────────────────
  const totalUnits   = curriculum.length;
  const failCount    = lists.failed.length;
  const missingCount = lists.missing.length;
  const specialCount = lists.special.length;
  const incCount     = lists.incomplete.length;
  const officialMean = totalUnits > 0 ? totalFirstAttemptSum / totalUnits : 0;
  const attemptedN   = totalUnits - (specialCount + missingCount + incCount);
  const perfMean     = attemptedN > 0 ? totalFirstAttemptSum / attemptedN : 0;

  const currentYearDoc = targetYearDoc?.isCurrent
    ? targetYearDoc
    : (await AcademicYear.findOne({ isCurrent: true }).lean()) || (await AcademicYear.findOne().sort({ startDate: -1 }).lean());

  const targetSession   = targetYearDoc?.session ?? "ORDINARY";
  const [tStart]        = (resolvedYearName || "0/0").split("/").map(Number);
  const [gStart]        = currentYearDoc?.year ? currentYearDoc.year.split("/").map(Number) : [0];
  const isPastYear      = targetYearDoc && gStart > 0 ? tStart < gStart : false;
  const isSessionClosed = targetSession === "CLOSED" || isPastYear;

  let status  = "PASS";
  let variant: "success" | "warning" | "error" | "info" = "success";
  let details = "Proceed to next year.";

  if (!options.forPromotion && targetSession === "ORDINARY" && !isPastYear) {
    status = "SESSION IN PROGRESS"; variant = "info"; details = "Marks are currently being entered.";
  } else if (Math.max(0, ...absentBySem.values()) >= maxAbsent && isSessionClosed) {
    status = "DEREGISTERED"; variant = "error"; details = `Absent from ${maxAbsent}+ examinations in one semester (ENG 23c).`;
  } else if (specialCount > 0 && failCount < totalUnits / 2) {
    const parts: string[] = [];
    if (failCount > 0)    parts.push(`SUPP ${failCount}`);
    parts.push(`SPEC ${specialCount}`);
    if (incCount > 0)     parts.push(`INC ${incCount}`);
    if (missingCount > 0) parts.push(`MISSING ${missingCount}`);
    status = parts.join("; "); variant = "info"; details = `Awaiting specials. Mean: ${perfMean.toFixed(2)}`;
  } else if (failCount >= totalUnits / 2 || officialMean < 40) {
    status = "REPEAT YEAR"; variant = "error";
    details = `Failed >= 50% (${failCount}/${totalUnits}) or Mean (${officialMean.toFixed(2)}) < 40% (ENG 16).`;
  } else if (failCount > totalUnits / 3) {
    status = "STAYOUT"; variant = "warning";
    details = `Failed > 1/3 (${failCount}/${totalUnits}). Retake in next ordinary period (ENG 15h).`;
  } else if (failCount > 0 || incCount > 0 || missingCount > 0) {
    const parts: string[] = [];
    if (failCount > 0)    parts.push(`SUPP ${failCount}`);
    if (incCount > 0)     parts.push(`INC ${incCount}`);
    if (missingCount > 0) parts.push(`INC ${missingCount}`);
    status = parts.join("; "); variant = "warning"; details = "Eligible for supplementary exams.";
  } else if (pendingDeferredUnits.length > 0 && failCount === 0 && specialCount === 0) {
    // All outstanding units are deferred — student is effectively clear for promotion
    status  = "PASS";
    variant = "success";
    details = `All pending units deferred to next ordinary period (ENG.13b/18c). Eligible for promotion.`;
  }

  return {
    status, variant, details,
    weightedMean:     officialMean.toFixed(2),
    sessionState:     targetSession,
    academicYearName: resolvedYearName,
    summary: { totalExpected: totalUnits, passed: lists.passed.length, failed: failCount, missing: missingCount },
    passedList:    lists.passed,
    failedList:    lists.failed,
    specialList:   lists.special,
    deferredList:  pendingDeferredUnits,
    missingList:   lists.missing,
    incompleteList: lists.incomplete,
  };
};

/**
 * Puts a student on stay-out: remembers the failed units (they drive ENG.22(c)/(e) when the retake
 * is graded) and writes the audit trail. `rule` is the clause shown to the coordinator.
 */
const recordStayout = async (
  student: any, statusResult: StudentStatusResult, currentYear: number, completedYear: string, fromStatus: string,
  rule: string, details: string,
): Promise<void> => {
  const already = new Set((student.stayoutUnits || [])
    .filter((u: any) => u.fromAcademicYear === completedYear).map((u: any) => u.programUnitId));
  const entries = statusResult.failedList
    .filter((f) => !already.has(f.programUnitId))
    .map((f) => ({
      programUnitId: f.programUnitId, unitCode: f.displayName.split(":")[0].trim(),
      fromYear: currentYear, fromAcademicYear: completedYear, addedAt: new Date(), status: "pending" as const,
    }));
  await Student.findByIdAndUpdate(student._id, {
    $set:  { remarks: `${rule}: ${details}` },
    $push: {
      statusEvents: { fromStatus, toStatus: "active", date: new Date(), academicYear: completedYear, reason: `${rule}: ${details}` },
      ...(entries.length ? { stayoutUnits: { $each: entries } } : {}),
    },
  });
};

export const promoteStudent = async (studentId: string): Promise<{
  success:       boolean;
  message:       string;
  isGraduation?: boolean;
  details?:      unknown;
  eng15bBlock?:  boolean;
  blockingUnits?: unknown[];
  yearSummaries?: unknown[];
}> => {
  const student = await Student.findById(studentId).populate("program");
  if (!student) throw new Error("Student not found");
 
  const st          = (student as any).status as string;
  const currentYear = (student as any).currentYearOfStudy || 1;
 
  if (["deregistered","discontinued","graduated","graduand"].includes(st))
    return { success: false, message: `Action blocked: Student is ${st}` };
 
  if (st !== "active" && st !== "repeat")
    return { success: false, message: `Promotion blocked: Student status is ${st}` };
 
  const auditResult = await performAcademicAudit(studentId);
  if (auditResult.discontinued)
    return { success: false, message: `Discontinued: ${auditResult.reason}` };
 
  // ENG.16(b): four failed attempts at a unit — must repeat the unit, cannot progress.
  const rpu = await applyRepeatUnitRule(studentId);
  if (rpu.blocked)
    return { success: false, message: `Promotion blocked: ${rpu.reason}` };
  
  const program  = student.program as any;
  const duration = program.durationYears || 5;
 
  const currentSession  = await AcademicYear.findOne({ isCurrent: true }).lean();
  const completedYear   = currentSession?.year || "N/A";
 
  // ── ENG.15(b): Historical year validation ──────────────────────────────────
  // Runs ONLY when promoting from the penultimate year into the final year.
  // For a 5-year programme: currentYear = 4 (promoting into Y5).
  // For a 4-year programme: currentYear = 3 (promoting into Y4).
  //
  // WHY HERE AND NOT EARLIER:
  // Years 1→2, 2→3, 3→4 don't need historical validation because carry-forwards
  // and supplementaries from prior years are legitimately still in-flight.
  // ENG.15(b) draws a hard line specifically at final year entry.
  if (currentYear === duration - 1) {
    const histCheck = await validateHistoricalYears(
      studentId.toString(),
      (student.program as any)._id.toString(),
      duration - 1,
    );
 
    if (!histCheck.canEnterFinalYear) {
      // Write a statusEvent so the audit trail shows WHY this student was blocked
      await Student.findByIdAndUpdate(studentId, {
        $push: {
          statusEvents: {
            fromStatus:  st,
            toStatus:    st,       // status unchanged — they stay where they are
            date:        new Date(),
            academicYear: completedYear,
            reason:      histCheck.blockReason,
          },
        },
      });
 
      return {
        success:       false,
        message:       histCheck.blockReason,
        eng15bBlock:   true,
        blockingUnits: histCheck.blockingUnits,
        yearSummaries: histCheck.yearSummaries,
      };
    }
    // Historical years are clean — fall through to normal Y(n-1) engine check
  }
 
  // ── Standard current-year status engine (unchanged) ───────────────────────
  const statusResult = await calculateStudentStatus(
    student._id, student.program, completedYear, currentYear, { forPromotion: true },
  );
 
  if (["DEREGISTERED","DISCONTINUED"].includes(statusResult.status)) {
    await syncTerminalStatusToDb(studentId, statusResult.status, statusResult.details, completedYear);
    return { success: false, message: `Promotion Blocked: ${statusResult.status}`, details: statusResult };
  }
 
  if (statusResult.status === "REPEAT YEAR") {
    const repeatCount = ((student as any).academicHistory || [])
      .filter((h: any) => h.isRepeatYear && h.yearOfStudy === currentYear).length + 1;
    const qualifier = REG_QUALIFIERS.repeatYear(repeatCount);
    await Student.findByIdAndUpdate(studentId, {
      $set:  { status: "repeat", qualifierSuffix: qualifier, remarks: statusResult.details },
      $push: {
        statusEvents:   { fromStatus: st, toStatus: "repeat", date: new Date(), academicYear: completedYear, reason: `ENG.16: ${statusResult.details}` },
        statusHistory:  { status: "repeat", previousStatus: st, date: new Date(), reason: statusResult.details },
        academicHistory: { academicYear: completedYear, yearOfStudy: currentYear, annualMeanMark: parseFloat(statusResult.weightedMean), weightedContribution: 0, failedUnitsCount: statusResult.summary.failed, isRepeatYear: true, date: new Date() },
      },
    });
    return { success: false, message: `Repeat year required (${qualifier})`, details: statusResult };
  }
 
  if (statusResult.status === "STAYOUT") {
    await recordStayout(student, statusResult, currentYear, completedYear, st, "ENG.15h", statusResult.details);
    return { success: false, message: "Stay out required (ENG.15h)", details: statusResult };
  }
 
  if (statusResult.specialList.length > 0 && statusResult.failedList.length === 0)
    return { success: false, message: "Special examinations pending", details: statusResult };
 
  const rawMean    = parseFloat(statusResult.weightedMean);
  const yearWeight = getYearWeight(program, (student as any).entryType || "Direct", currentYear);
  const histRecord = {
    academicYear: completedYear, yearOfStudy: currentYear, annualMeanMark: rawMean,
    weightedContribution: rawMean * yearWeight, failedUnitsCount: statusResult.summary.failed,
    isRepeatYear: false, date: new Date(),
  };
 
  const pendingCF = ((student as any).carryForwardUnits || []).filter((u: any) => u.status === "pending").length;
 
  // Graduation path (final year)
  if (currentYear === duration) {

    // ENG.15(f)(g) / ENG.24(a): every unit of the final year must be passed.
    // A failed, missing, incomplete, special or deferred unit blocks graduation.
    const outstanding = [
      ...statusResult.failedList.map((u) => `${u.displayName} (failed)`),
      ...statusResult.specialList.map((u) => `${u.displayName} (special pending)`),
      ...statusResult.deferredList.map((u) => `${u.displayName} (deferred)`),
      ...statusResult.missingList.map((u) => `${u} (missing)`),
      ...statusResult.incompleteList.map((u) => `${u} (incomplete)`),
    ];
    if (outstanding.length > 0)
      return {
        success: false,
        message: `Cannot graduate (ENG.15(f)/24(a)): ${outstanding.length} final-year unit(s) not passed: ${outstanding.join("; ")}`,
        details: statusResult,
      };

    if (pendingCF > 0)
      return { success: false, message: `Cannot graduate: ${pendingCF} carry-forward unit(s) not yet cleared` };
 
    // ENG.24(b),(c): attachments / teaching practicum must be passed (when enforced in settings).
    const missingAtt = await outstandingAttachments(studentId);
    if (missingAtt.length > 0)
      return { success: false, message: `Cannot graduate (ENG.24): ${missingAtt.join("; ")} not passed` };

    const fullHistory = [...((student as any).academicHistory || []), histRecord];
    const finalWAA    = fullHistory.reduce((acc: number, h: any) => acc + (h.weightedContribution || 0), 0);
 
    const classification = classifyWAA(finalWAA);

    await Student.findByIdAndUpdate(studentId, {
      $set:  { status: "graduand", qualifierSuffix: "", finalWeightedAverage: finalWAA.toFixed(2), classification, graduationYear: new Date().getFullYear(), currentYearOfStudy: currentYear + 1 },
      $push: { academicHistory: histRecord },
    });
    return { success: true, message: `Graduated: ${classification}`, isGraduation: true };
  }
 
  // Standard promotion to next year
  const nextYear = currentYear + 1;
  let cfGranted  = false;
  let cfMessage  = "";
 
  if (statusResult.status !== "PASS") {
    const cfResult = await tryAssessAndGrantCarryForward(
      studentId, student.program.toString(), currentYear, completedYear,
    );
    cfGranted = cfResult.granted;
    cfMessage = cfGranted
      ? `Promoted to Year ${nextYear} with carry-forward (${cfResult.qualifier}): ${cfResult.cfUnits.map((u) => u.unitCode).join(", ")}`
      : "";
    if (!cfGranted) {
      // ENG.15(d)/(e): more than two units still failed after the supplementaries — the student
      // does not proceed and retakes the failed units at the next ordinary sitting.
      if (statusResult.failedList.length > 2) {
        const rule = ((program as any).degreeType === "BEd") ? "ENG.15(e)" : "ENG.15(d)";
        await recordStayout(student, statusResult, currentYear, completedYear, st, rule,
          `${statusResult.failedList.length} units failed at supplementary — retake at the next ordinary examinations`);
        return { success: false, message: `Stay out required (${rule}): ${statusResult.failedList.length} units failed at supplementary`, details: statusResult };
      }
      return { success: false, message: `Promotion Blocked: ${cfResult.reason}`, details: statusResult };
    }
  }
 
  await Student.findByIdAndUpdate(studentId, {
    $set: {
      currentYearOfStudy: nextYear, currentSemester: 1,
      ...((!cfGranted && _qualifierShouldClearOnPromotion((student as any).qualifierSuffix || "")) ? { qualifierSuffix: "" } : {}),
    },
    $push: {
      promotionHistory: { from: currentYear, to: nextYear, date: new Date() },
      academicHistory:  histRecord,
      statusHistory:    { status: "active", previousStatus: st, date: new Date(), reason: `Promoted to Year ${nextYear}` },
    },
  });
 
  return { success: true, message: cfGranted ? cfMessage : `Successfully promoted to Year ${nextYear}` };
};

export const previewPromotion = async (
  programId: string,
  yearToPromote: number,
  academicYearName: string,
) => {
  const nextYear = yearToPromote + 1;
  const targetYearDoc = await AcademicYear.findOne({
    year: academicYearName,
  }).lean();
  if (!targetYearDoc) {
    console.warn(
      `[previewPromotion] AcademicYear "${academicYearName}" not found.`,
    );
    return {
      totalProcessed: 0,
      eligibleCount: 0,
      blockedCount: 0,
      eligible: [],
      blocked: [],
    };
  }

  const program = (await (await import("../models/Program")).default
    .findById(programId)
    .lean()) as any;
  const duration = program?.durationYears || 5;

  // Student sets (same as original — unchanged)
  const admissionStudents = await Student.find({
    program: programId,
    currentYearOfStudy: yearToPromote,
    admissionAcademicYear: (targetYearDoc as any)._id,
  }).lean();

  const [m1, m2] = await Promise.all([
    Mark.distinct("student", { academicYear: (targetYearDoc as any)._id }),
    MarkDirect.distinct("student", {
      academicYear: (targetYearDoc as any)._id,
    }),
  ]);

  const markedIds = new Set<string>(
    [...m1, ...m2].map((id: any) => id.toString()),
  );
  const admissionIds = new Set(
    admissionStudents.map((s: any) => s._id.toString()),
  );

  const returningStudents = await Student.find({
    program: programId,
    currentYearOfStudy: yearToPromote,
    _id: { $in: Array.from(markedIds), $nin: Array.from(admissionIds) },
  }).lean();

  const adminStudents = await Student.find({
    program: programId,
    currentYearOfStudy: yearToPromote,
    status: { $in: ["on_leave", "deferred", "deregistered", "discontinued"] },
    $or: [
      { admissionAcademicYear: (targetYearDoc as any)._id },
      { "academicHistory.academicYear": academicYearName },
    ],
    _id: {
      $nin: [
        ...Array.from(admissionIds),
        ...returningStudents.map((s: any) => s._id.toString()),
      ],
    },
  }).lean();

  // Students who were already promoted out of this year (e.g. promoted before the reports were
  // downloaded). They must still appear on the CMS and the pass list for the year they sat.
  const alreadyIds = new Set<string>([
    ...admissionStudents, ...returningStudents, ...adminStudents,
  ].map((s: any) => s._id.toString()));
  const promotedAway = await Student.find({
    program: programId,
    currentYearOfStudy: nextYear,
    status: { $nin: ["graduated", "graduand", "discontinued", "deregistered"] },
    academicHistory: { $elemMatch: { yearOfStudy: yearToPromote, academicYear: academicYearName } },
  }).lean();

  const allStudents = [
    ...admissionStudents,
    ...returningStudents,
    ...adminStudents,
    ...promotedAway.filter((s: any) => !alreadyIds.has(s._id.toString())),
  ];
  const ADMIN_LABELS: Record<string, string> = {
    on_leave: "ACADEMIC LEAVE",
    deferred: "DEFERMENT",
    discontinued: "DISCONTINUED",
    deregistered: "DEREGISTERED",
    graduated: "GRADUATED",
  };

  const eligible: any[] = [];
  const blocked: any[] = [];

  // The per-student engine runs are independent and slow (many DB reads each), so run them a few
  // at a time up front; the loop below keeps the original order and rules.
  const needsEngine = (st: any) => st.currentYearOfStudy !== nextYear && !ADMIN_LABELS[st.status];
  const computed = new Map<string, { hist?: any; sr?: any }>();
  const memo = new Map<string, Promise<any>>(); // class-wide look-ups shared by every student in this analysis
  // Load every needed mark for the whole class in 3 queries (instead of 3 per student).
  const engineStudents = allStudents.filter(needsEngine);
  const classPuIds = (await ProgramUnit.find({ program: programId, requiredYear: yearToPromote }).select("_id").lean())
    .map((pu: any) => pu._id);
  const byStudent = (docs: any[]) => {
    const m = new Map<string, any[]>();
    for (const d of docs) { const k = String(d.student); (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    return m;
  };
  let classMarks: { detailed: Map<string, any[]>; direct: Map<string, any[]>; grades: Map<string, any[]> } | null = null;
  if (engineStudents.length && classPuIds.length) {
    const q = { student: { $in: engineStudents.map((st: any) => st._id) }, programUnit: { $in: classPuIds } };
    const [d1, d2, d3] = await Promise.all([Mark.find(q).lean(), MarkDirect.find(q).lean(), FinalGrade.find(q).lean()]);
    classMarks = { detailed: byStudent(d1 as any[]), direct: byStudent(d2 as any[]), grades: byStudent(d3 as any[]) };
  }

  await mapLimit(engineStudents, 5, async (st: any) => {
    const id = st._id.toString();
    const entry: { hist?: any; sr?: any } = {};
    if (yearToPromote === duration - 1) {
      entry.hist = await validateHistoricalYears(id, programId, duration - 1);
      if (!entry.hist.canEnterFinalYear) { computed.set(id, entry); return; }
    }
    entry.sr = await calculateStudentStatus(st._id, programId, academicYearName, yearToPromote, {
     forPromotion: true, memo,
      prefetched: classMarks ? {
        student: st,
        detailed: classMarks.detailed.get(id) ?? [],
        direct: classMarks.direct.get(id) ?? [],
        grades: classMarks.grades.get(id) ?? [],
      } : undefined,
    });
    computed.set(id, entry);
  });

  for (const student of allStudents) {
    const isAlreadyPromoted = (student as any).currentYearOfStudy === nextYear;
    const adminLabel = ADMIN_LABELS[(student as any).status];

    const baseReport = {
      id: (student as any)._id,
      _id: (student as any)._id,
      regNo: (student as any).regNo,
      name: (student as any).name,
      qualifierSuffix: (student as any).qualifierSuffix || "",
      remarks: (student as any).remarks,
      academicLeavePeriod: (student as any).academicLeavePeriod,
    };

    if (isAlreadyPromoted) {
      eligible.push({
        ...baseReport,
        status: "ALREADY PROMOTED",
        reasons: [],
        summary: { totalExpected: 0, passed: 0, failed: 0, missing: 0 },
        details: "",
      });
      continue;
    }

    if (adminLabel) {
      const leaveType = (
        student as any
      ).academicLeavePeriod?.type?.toUpperCase();
      const adminGrounds =
        [
          (student as any).academicLeavePeriod?.type || "",
          (student as any).remarks || "",
        ]
          .join(" ")
          .trim() || "other";
      blocked.push({
        ...baseReport,
        status: adminLabel,
        reasons: [leaveType ? `${adminLabel} (${leaveType})` : adminLabel],
        specialGrounds: adminGrounds,
        summary: { totalExpected: 0, passed: 0, failed: 0, missing: 0 },
        details: "",
      });
      continue;
    }

    // ── ENG.15(b) CHECK — runs before calculateStudentStatus when entering final year ──
    // This is the KEY addition. Without this, previewPromotion would classify a
    // student with a pending Y2 carry-forward as PASS at Y4 level and show them
    // as eligible for Y5 entry. With this, the coordinator sees the specific
    // blocking units before attempting the promotion.
    if (yearToPromote === duration - 1) {
      const histCheck = computed.get((student as any)._id.toString())!.hist;

      if (!histCheck.canEnterFinalYear) {
        blocked.push({
          ...baseReport,
          status: "ENG.15(b) BLOCK",
          reasons: [histCheck.blockReason],
          specialGrounds: "eng15b",
          summary: {
            totalExpected: 0,
            passed: 0,
            failed: histCheck.blockingUnits.length,
            missing: 0,
          },
          details: histCheck.blockReason,
          eng15bBlock: true,
          blockingUnits: histCheck.blockingUnits,
          yearSummaries: histCheck.yearSummaries,
        });
        continue;
      }
    }

    // Standard engine check (unchanged)
    const sr = computed.get((student as any)._id.toString())!.sr;

    const specialGrounds =
      [
        (sr.specialList || [])
          .map((s: any) => (s.grounds || "").toLowerCase())
          .join(" "),
        ((student as any).remarks || "").toLowerCase(),
        ((student as any).academicLeavePeriod?.type || "").toLowerCase(),
      ]
        .join(" ")
        .trim() || "other";

    const report: any = {
      ...baseReport,
      status: sr.status,
      summary: sr.summary,
      reasons: [],
      details: sr.details,
      specialGrounds,
      isEligibleForSupp:
        !["STAYOUT", "REPEAT YEAR", "DEREGISTERED"].includes(sr.status) &&
        (sr.failedList.length > 0 || sr.specialList.length > 0),
    };

    if (sr.status === "PASS") {
      eligible.push(report);
      continue;
    }
    if (sr.status === "STAYOUT")
      report.reasons.push("ENG 15h: > 1/3 units failed");
    if (sr.status === "REPEAT YEAR")
      report.reasons.push("ENG 16: >= 1/2 units failed or mean < 40%");
    if (sr.failedList?.length)
      report.reasons.push(
        `${sr.failedList.length} unit(s) require supplementary`,
      );
    if (sr.specialList?.length)
      report.reasons.push(
        `${sr.specialList.length} special examination(s) pending`,
      );

    blocked.push(report);
  }

  return {
    totalProcessed: allStudents.length,
    eligibleCount: eligible.length,
    blockedCount: blocked.length,
    eligible,
    blocked,
  };
};

// ── bulkPromoteClass ──────────────────────────────────────────────────────────

export const bulkPromoteClass = async (programId: string, yearToPromote: number, academicYearName: string) => {
  const nextYear = yearToPromote + 1;
  const students = await Student.find({ program: programId, currentYearOfStudy: { $in: [yearToPromote, nextYear] }, status: { $in: ["active", "repeat"] } });
  const results  = { promoted: 0, failed: 0, alreadyPromoted: 0, errors: [] as string[] };

  // Students are independent, so promote a few at a time (the sequential version timed out the screen).
  await mapLimit(students, 4, async (student) => {
    const sid   = (student._id as any).toString();
    const rNo   = (student as any).regNo;
    const curYr = (student as any).currentYearOfStudy;
    try {
      if (curYr >= nextYear) { results.alreadyPromoted++; results.promoted++; return; }
      const res = await promoteStudent(sid);
      if (res.success) results.promoted++; else results.failed++;
    } catch (err: any) {
      results.errors.push(`${rNo}: ${err.message}`);
    }
  });

  return results;
};

/**
 * Runs the status engine for a whole class at once (used by the CMS download).
 * Loads students and marks in a handful of queries and shares look-ups between students,
 * instead of ~6 sequential queries per student. Errors are returned per student, not thrown.
 */
export async function auditClass(
  studentIds: string[], programId: string, academicYearName: string, yearOfStudy: number,
): Promise<Map<string, { audit?: any; error?: string }>> {
  const out = new Map<string, { audit?: any; error?: string }>();
  if (!studentIds.length) return out;
  const students = await Student.find({ _id: { $in: studentIds } }).lean() as any[];
  const puIds = (await ProgramUnit.find({ program: programId, requiredYear: yearOfStudy }).select("_id").lean()).map((p: any) => p._id);
  const group = (docs: any[]) => {
    const m = new Map<string, any[]>();
    for (const d of docs) { const k = String(d.student); (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    return m;
  };
  const q = { student: { $in: students.map((s) => s._id) }, programUnit: { $in: puIds } };
  const [d1, d2, d3] = puIds.length
    ? await Promise.all([Mark.find(q).lean(), MarkDirect.find(q).lean(), FinalGrade.find(q).lean()])
    : [[], [], []];
  const detailed = group(d1 as any[]), direct = group(d2 as any[]), grades = group(d3 as any[]);
  const memo = new Map<string, Promise<any>>();
  await mapLimit(students, 5, async (st: any) => {
    const id = String(st._id);
    try {
      const audit = await calculateStudentStatus(st._id, programId, academicYearName, yearOfStudy, {
        forPromotion: true, memo,
        prefetched: { student: st, detailed: detailed.get(id) ?? [], direct: direct.get(id) ?? [], grades: grades.get(id) ?? [] },
      });
      out.set(id, { audit });
    } catch (e: any) { out.set(id, { error: e?.message ?? "engine error" }); }
  });
  return out;
}