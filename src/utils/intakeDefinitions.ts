// serverside/src/utils/intakeDefinitions.ts
//
// Loads an institution's intake definitions (falls back to the legacy
// SEPT / JAN / MAY list) and checks a student's intake at admission.

import InstitutionSettings from "../models/InstitutionSettings";
import { cached } from "./cache";
import {
  LEGACY_INTAKE_DEFINITIONS,
  intakeCodesOf,
  normalizeIntake,
  type IntakeDefinition,
} from "./semesterLabels";

export async function getIntakeDefinitions(institutionId: unknown): Promise<IntakeDefinition[]> {
  // Same key + fetcher as GET /institution-settings, so one cache entry serves both.
  const settings = await cached(
    `settings:${institutionId}`,
    () => InstitutionSettings.findOne({ institution: institutionId }).lean(),
    300,
  ) as { intakeDefinitions?: IntakeDefinition[] } | null;
  const defs = settings?.intakeDefinitions;
  return defs && defs.length > 0 ? defs : LEGACY_INTAKE_DEFINITIONS;
}

/**
 * Admission check for one student row.
 *  - `intakeRaw` blank → defaults to the program's first intake
 *  - must be a defined intake, offered by the program, and (when the academic
 *    year has intakes configured) offered by that year
 * Returns the resolved intake code, or an error message.
 */
export function resolveAdmissionIntake(opts: {
  intakeRaw: unknown;
  defs: IntakeDefinition[];
  programName: string;
  programIntakes?: string[];
  yearLabel?: string;
  yearConfiguredIntakes?: string[] | null; // null/empty = year not configured → skip year check
}): { intake: string } | { error: string } {
  const { defs, programName, yearLabel } = opts;
  const programIntakes = opts.programIntakes?.length ? opts.programIntakes : [defs[0].code];
  const raw = String(opts.intakeRaw ?? "").trim();

  const intake = raw ? normalizeIntake(raw, defs) : programIntakes[0];
  if (!intake) {
    return { error: `Unknown intake "${raw}". Defined intakes: ${intakeCodesOf(defs).join(", ")}.` };
  }
  if (!programIntakes.includes(intake)) {
    return {
      error: `${programName} does not admit the ${intake} intake (it admits: ${programIntakes.join(", ")}). Ask an admin to add ${intake} to the program's intakes.`,
    };
  }
  const yc = opts.yearConfiguredIntakes;
  if (yc && yc.length > 0 && !yc.includes(intake)) {
    return {
      error: `Academic year ${yearLabel ?? ""} does not run the ${intake} intake (it runs: ${yc.join(", ")}). Add ${intake} to that year on the Academic Years page.`.replace("  ", " "),
    };
  }
  return { intake };
}