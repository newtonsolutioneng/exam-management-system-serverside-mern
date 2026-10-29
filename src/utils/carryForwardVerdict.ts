// serverside/src/utils/carryForwardVerdict.ts
// Pure rule: after the supplementary sitting, does a student with failed units qualify to carry them forward?
// Kept free of database access so the status engine, the reports and the promotion step can all agree and tests can run offline.

import { assessCarryForwardEligibility } from "./academicRules";

export interface FailedUnitInfo {
  code:     string;
  name:     string;
  /** true when the failing mark is a supplementary sitting (the student has already used the supp) */
  suppSat:  boolean;
  /** true when the unit has no coursework mark, ENG.15(a): cannot be carried forward */
  noCA:     boolean;
}

export interface CarryForwardVerdict {
  eligible: boolean;
  units:    { code: string; name: string }[];
  reason:   string;
}

/** Last year a student can carry forward FROM (ENG.14): BSc up to the year before the last, BEd years 1-2 only. */
export function lastCarryForwardFromYear(durationYears: number, degreeType?: string): number {
  const finalYear = durationYears || 5;
  return degreeType === "BEd" ? Math.min(2, finalYear - 1) : finalYear - 1;
}

export function carryForwardVerdict(opts: {
  failed:        FailedUnitInfo[];
  /** units still outstanding in other ways: specials pending, incomplete, missing */
  otherOutstanding: number;
  totalUnits:    number;
  yearOfStudy:   number;
  durationYears: number;
  degreeType?:   string;
}): CarryForwardVerdict {
  const no = (reason: string): CarryForwardVerdict => ({ eligible: false, units: [], reason });
  const { failed, otherOutstanding, totalUnits, yearOfStudy, durationYears, degreeType } = opts;

  if (failed.length === 0) return no("No failed units");
  if (otherOutstanding > 0) return no("Other units are still outstanding");
  if (yearOfStudy > lastCarryForwardFromYear(durationYears, degreeType))
    return no("Carry forward is not allowed from this year of study (ENG.14)");
  const notYetSat = failed.filter((f) => !f.suppSat);
  if (notYetSat.length > 0)
    return no(`Supplementary not yet sat in: ${notYetSat.map((f) => f.code).join(", ")}`);

  const a = assessCarryForwardEligibility(
    failed.map((f) => f.code),
    failed.filter((f) => f.noCA).map((f) => f.code),
    totalUnits,
  );
  if (!a.eligible) return no(a.reason);
  return {
    eligible: true,
    units:    failed.filter((f) => a.units.includes(f.code)).map((f) => ({ code: f.code, name: f.name })),
    reason:   a.reason,
  };
}
