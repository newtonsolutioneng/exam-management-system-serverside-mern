// serverside/src/utils/semesterLabels.ts
//
// Intake codes ⇄ semester numbers ⇄ display labels.
// DB-free: every function takes the institution's intake definitions as a
// parameter (see utils/intakeDefinitions.ts for loading them). When an
// institution has not configured any, LEGACY_INTAKE_DEFINITIONS applies.

export type IntakeCode = string; // e.g. "SEPT", "JAN", "MAY", or an institution-defined code like "JUL"

export type SemesterNumber = 1 | 2 | 3;
export const SEMESTER_NUMBERS: readonly SemesterNumber[] = [1, 2, 3];

/** "INTAKE" = show the intake label (JAN / MAY / SEPT …).  "SEMESTER" = show 1st / 2nd / 3rd Semester. */
export type SemesterLabelStyle = "INTAKE" | "SEMESTER";

export interface IntakeDefinition {
    code: IntakeCode;
    label: string;                    // human name, e.g. "January"
    defaultSemester: SemesterNumber;  // which semester slot of the academic year it normally is
  }

export interface IntakeSemester {
  intake: IntakeCode;
  semester: SemesterNumber;
}

/** 2-12 chars, starts with a letter, upper-case letters / digits / _ / - */
export const INTAKE_CODE_REGEX = /^[A-Z][A-Z0-9_-]{1,11}$/;

/** What every institution had before intakes became configurable. */
export const LEGACY_INTAKE_DEFINITIONS: IntakeDefinition[] = [
  { code: "SEPT", label: "September", defaultSemester: 1 },
  { code: "JAN",  label: "January",   defaultSemester: 2 },
  { code: "MAY",  label: "May",       defaultSemester: 3 },
];

export const intakeCodesOf = (defs: IntakeDefinition[]): IntakeCode[] => defs.map((d) => d.code);

export const isIntakeCode = (v: unknown, defs: IntakeDefinition[] = LEGACY_INTAKE_DEFINITIONS): boolean =>
    typeof v === "string" && defs.some((d) => d.code === v);
  
  /**
   * Best-effort conversion of a raw value to one of the institution's intake codes.
   * Exact (case-insensitive) match first; then the old fuzzy legacy mapping
   * ("AUG"/"September" → SEPT, "Jan"/"Feb" → JAN …) but only if that code is defined.
   */
export function normalizeIntake(raw: unknown, defs: IntakeDefinition[] = LEGACY_INTAKE_DEFINITIONS): IntakeCode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (!v) return null;
  if (isIntakeCode(v, defs)) return v;
  // institution-defined: match by label ("July") or by a full word starting with the code ("JULY")
  const byLabel = defs.find((d) => d.label.trim().toUpperCase() === v);
  if (byLabel) return byLabel.code;
  const byPrefix = defs.find((d) => d.code.length >= 3 && v.startsWith(d.code));
  if (byPrefix) return byPrefix.code;
  const legacy =
    v.startsWith("SEP") || v.startsWith("AUG") || v.startsWith("OCT") ? "SEPT" :
    v.startsWith("JAN") || v.startsWith("FEB") || v.startsWith("MAR") ? "JAN" :
    v.startsWith("MAY") || v.startsWith("APR") || v.startsWith("JUN") || v.startsWith("JUL") ? "MAY" : null;
  return legacy && isIntakeCode(legacy, defs) ? legacy : null;
}

/** Intake a start date most plausibly belongs to (used only when the client sends no intakes). */
export function intakeFromDate(d: Date, defs: IntakeDefinition[] = LEGACY_INTAKE_DEFINITIONS): IntakeCode {
  const m = d.getMonth(); // 0-11
  const guess = m <= 3 ? "JAN" : m <= 6 ? "MAY" : "SEPT";
  if (isIntakeCode(guess, defs)) return guess;
  return (defs.find((x) => x.defaultSemester === 1) ?? defs[0]).code;
}

export const defaultSemesterFor = (code: IntakeCode, defs: IntakeDefinition[]): SemesterNumber =>
  defs.find((d) => d.code === code)?.defaultSemester ?? 1;

const ORDINAL: Record<SemesterNumber, string> = { 1: "1st", 2: "2nd", 3: "3rd" };
const WORD: Record<SemesterNumber, string> = { 1: "FIRST", 2: "SECOND", 3: "THIRD" };

/** 1 → "1st" */
export const semesterOrdinal = (n: number): string =>
  ORDINAL[n as SemesterNumber] ?? `${n}th`;

/** 1 → "FIRST" (for document captions: "FIRST YEAR FIRST SEMESTER …") */
export const semesterWord = (n: number): string =>
  WORD[n as SemesterNumber] ?? `${n}TH`;

/**
 * Cleans an incoming/stored intake list and its semester mapping:
 *  - rejects intakes the institution has not defined, drops duplicates
 *  - gives every intake a semester (supplied → its default → first free slot)
 *  - guarantees no two intakes share a semester number
 * Returns an error string instead of throwing so routes can answer 400.
*/
export function buildIntakeConfig(
  intakes: unknown,
  intakeSemesters?: unknown,
  defs: IntakeDefinition[] = LEGACY_INTAKE_DEFINITIONS,
): { intakes: IntakeCode[]; intakeSemesters: IntakeSemester[] } | { error: string } {
  const list = Array.isArray(intakes) ? intakes : [];
  const clean: IntakeCode[] = [];
  for (const raw of list) {
    const code = normalizeIntake(raw, defs);
    if (!code) return { error: `Invalid intake "${String(raw)}". Allowed: ${intakeCodesOf(defs).join(", ")}.` };
    if (!clean.includes(code)) clean.push(code);
  }
  if (clean.length === 0) return { error: "Select at least one intake." };

  const supplied = new Map<IntakeCode, SemesterNumber>();
  if (Array.isArray(intakeSemesters)) {
    for (const row of intakeSemesters as Array<{ intake?: unknown; semester?: unknown }>) {
       const code = normalizeIntake(row?.intake, defs);
      const sem = Number(row?.semester);
      if (code && (SEMESTER_NUMBERS as readonly number[]).includes(sem)) {
        supplied.set(code, sem as SemesterNumber);
      }
    }
  }

  // explicit choices first (clashes between them are the caller's error)
  const used = new Set<number>();
  const mapping: IntakeSemester[] = [];
  for (const intake of clean) {
    const sem = supplied.get(intake);
    if (sem === undefined) continue;
    if (used.has(sem)) return { error: `More than one intake is mapped to the ${semesterOrdinal(sem)} semester.` };
    used.add(sem);
    mapping.push({ intake, semester: sem });
  }
  // then the rest: default slot if free, otherwise first free slot
  for (const intake of clean) {
    if (supplied.has(intake)) continue;
    const pref = defaultSemesterFor(intake, defs);
    const sem = !used.has(pref) ? pref : SEMESTER_NUMBERS.find((s) => !used.has(s));
    if (sem === undefined) return { error: "An academic year supports at most 3 intakes (one per semester)." };
    used.add(sem);
    mapping.push({ intake, semester: sem });
  }

  mapping.sort((a, b) => a.semester - b.semester);
  return { intakes: mapping.map((m) => m.intake), intakeSemesters: mapping };
}

/**
 * Validates the institution's own list of intake definitions (settings screen).
 */
export function validateIntakeDefinitions(
  raw: unknown,
): { definitions: IntakeDefinition[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Define at least one intake." };
  if (raw.length > 12) return { error: "At most 12 intakes can be defined." };
  const seen = new Set<string>();
  const out: IntakeDefinition[] = [];
  for (const r of raw as Array<{ code?: unknown; label?: unknown; defaultSemester?: unknown }>) {
    const code = String(r?.code ?? "").trim().toUpperCase();
    if (!INTAKE_CODE_REGEX.test(code)) {
      return { error: `Invalid intake code "${code}". Use 2-12 letters/digits, starting with a letter (e.g. SEPT, JAN, JUL).` };
    }
    if (seen.has(code)) return { error: `Intake code "${code}" is listed twice.` };
    seen.add(code);
    const sem = Number(r?.defaultSemester ?? 1);
    if (!(SEMESTER_NUMBERS as readonly number[]).includes(sem)) {
      return { error: `Intake ${code}: semester must be 1, 2 or 3.` };
    }
    const label = String(r?.label ?? "").trim().slice(0, 40) || code;
    out.push({ code, label, defaultSemester: sem as SemesterNumber });
  }
  return { definitions: out };
}