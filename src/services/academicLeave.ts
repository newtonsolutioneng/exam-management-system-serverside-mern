// serverside/src/services/academicLeave.ts
import Student from "../models/Student";
import { differenceInYears, format, } from "date-fns";
import { REG_QUALIFIERS } from "../utils/academicRules";
import { loadInstitutionSettings } from "../utils/loadInstitutionSettings";
 
// --- IMPLEMENTING ACADEMIC LEAVE (ENG. 19) ---
export const grantAcademicLeave = async ( 
  studentId: string, startDate: Date, endDate: Date, reason: string, leaveType: "compassionate" | "financial" | "other") => {
  const student = await Student.findById(studentId).populate("program");
  if (!student) throw new Error("Student not found");

  // Calculate duration to check max stay-out (fractions of a year count)
  const yearsRequested = Math.max(0, Math.round(((endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 3600 * 1000)) * 100) / 100);

  // ENG 19(d)/(e): max stay-out = programme length x multiplier (5 yrs -> 10, 4 yrs -> 8), the same
  // rule the daily compliance job uses. Never inferred from the programme's name.
  const program = student.program as any;
  const settings = await loadInstitutionSettings(String((student as any).institution)).catch(() => null);
  const maxStayOut = Math.round((program.durationYears ?? 5) * (settings?.rules.maxDurationMultiplier ?? 2));

  if ((student.totalTimeOutYears || 0) + yearsRequested > maxStayOut) {
    throw new Error(`Leave denied: Exceeds max stay-out period of ${maxStayOut} years.`);
  }

  const dateRange = `${format(startDate, "MMM yyyy")} - ${format(endDate, "MMM yyyy")}`;
  // We determine the current academic year string for the ledger
  const currentAY = student.academicHistory?.slice(-1)[0]?.academicYear || "Current";

  // Update student status and track time
  return await Student.findByIdAndUpdate(studentId, {
      $set: {
        status: "on_leave",
        remarks: `Academic Leave: ${reason} (${dateRange})`,
        academicLeavePeriod: { startDate, endDate, reason, type: leaveType },
        totalTimeOutYears: (student.totalTimeOutYears || 0) + yearsRequested,
      },
      $push: {
        statusEvents: {
          fromStatus: student.status,
          toStatus: "on_leave",
          date: new Date(),
          academicYear: currentAY,
          reason: `${leaveType.toUpperCase()}: ${reason}`
        },
        promotionHistory: {
          from: student.currentYearOfStudy,
          to: student.currentYearOfStudy, // Stay in same year
          date: new Date(),
          remarks: `GRANTED ACADEMIC LEAVE: ${reason}`
        }
      }
    },
    { new: true },
  );
};

// --- IMPLEMENTING DEFERMENT (ENG. 20) ---
export const deferAdmission = async (studentId: string, academicYearsToDefer: 1 | 2) => {
  const student = await Student.findById(studentId);
  if (!student || student.currentYearOfStudy !== 1) throw new Error("Only new students can defer admission.");  

  // ENG 20.a: Senate approval check (usually via UI workflow)
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + academicYearsToDefer);

  return await Student.findByIdAndUpdate(
    studentId,
    {
      $set: {
        status: "deferred",
        remarks: `Deferred for ${academicYearsToDefer} year(s).`,
        // Set end date based on academic year
        academicLeavePeriod: { startDate: new Date(), endDate: endDate, reason: "Admission Deferral", type: "other" },
      },
      $push: {
        statusEvents: {
          fromStatus: "new_admission",
          toStatus: "deferred",
          date: new Date(),
          academicYear: "Admission Year",
          reason: `Deferred admission for ${academicYearsToDefer} year(s)`
        },
        promotionHistory: {
          from: 0, // 0 indicates pre-admission/entry
          to: 1,
          date: new Date(),
          remarks: `ADMISSION DEFERRED: ${academicYearsToDefer} Year(s)`
        }
      }
    },
    { new: true },
  );
};

// --- UNDO/REVERT STATUS (For both Leave/Defer) ---
export const revertStatusToActive = async (studentId: string) => {
  const now = new Date();
  const student = await Student.findById(studentId);
  if (!student) throw new Error("Student not found");

  const previousStatus = student.status.toUpperCase();
  const currentAY = student.academicHistory?.slice(-1)[0]?.academicYear || "Current";

  return await Student.findByIdAndUpdate(studentId, {
    $set: { 
      status: "active", 
      remarks: `Status manually reverted to active from ${previousStatus} on ${now.toDateString()}.` 
    },
    $push: {
      statusEvents: {
        fromStatus: previousStatus,
        toStatus: "active",
        date: now,
        academicYear: currentAY,
        reason: "REINSTATEMENT: Student resumed studies."
      },
      promotionHistory: {
        from: student.currentYearOfStudy,
        to: student.currentYearOfStudy,
        date: now,
        remarks: `MANUAL: RETURNED FROM ${previousStatus}`
      }
    },
    $unset: { academicLeavePeriod: 1 }
  }, { new: true });
};

// --- IMPLEMENTING READMISSION (ENG. 23 / 24) ---
export const readmitStudent = async (studentId: string, remarks: string, secondSemester = false) => {
  const student = await Student.findById(studentId);
  if (!student) throw new Error("Student not found");

  // Only allow readmission for terminal or inactive statuses
  const terminalStatuses = ["deregistered", "discontinued", "on_leave", "deferred"];
  if (!terminalStatuses.includes(student.status)) throw new Error(`Readmission denied: Student is currently ${student.status.toUpperCase()}.`);

  const previousStatus = student.status.toUpperCase();
  const now = new Date();
  
  // Determine the academic year context
  const lastHistory = student.academicHistory?.slice(-1)[0];
  const currentAY = lastHistory?.academicYear || "NEW CYCLE";

  // ENG.21 / qualifiers doc: RA{n} (n = readmissions so far, max 5); RA{n}S2 when the
  // student re-enters at the second semester (first semester of the year already completed).
  const priorReadmissions = ((student as any).statusEvents || []).filter(
    (e: any) => typeof e?.reason === "string" && e.reason.startsWith("OFFICIAL READMISSION"),
  ).length;
  const raQualifier = REG_QUALIFIERS.readmit(priorReadmissions + 1, secondSemester);

  return await Student.findByIdAndUpdate(
    studentId,
    {
      $set: { status: "active", qualifierSuffix: raQualifier, remarks: `READMITTED: ${remarks} (Prev: ${previousStatus}) ${raQualifier}`},
       $push: {        
        statusEvents: { fromStatus: previousStatus, toStatus: "active", date: now, academicYear: currentAY, reason: `OFFICIAL READMISSION: ${remarks}`},
        // 2. Track the return in Promotion History
        promotionHistory: { from: student.currentYearOfStudy, to: student.currentYearOfStudy, date: now, remarks: `READMISSION FROM ${previousStatus}`}
      },
      // Clear any pending leave periods
      $unset: { academicLeavePeriod: 1 }
    },
    { new: true }
  );
};
