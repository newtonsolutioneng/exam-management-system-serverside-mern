// serverside/src/utils/markDistribution.ts
//
// Coursework / exam mark distribution of a unit. The common split is 30/70, but
// some units differ (e.g. 40/60 workshops, 50/50 practicals, 20/80).
// ca + exam always equals 100 so the agreed mark stays /100.

export type UnitKind = "theory" | "lab" | "workshop";
export type ExamModeKind = "standard" | "mandatory_q1";

export interface MarkDistribution { ca: number; exam: number }

export const DEFAULT_DISTRIBUTION: MarkDistribution = { ca: 30, exam: 70 };

/** Legacy defaults: workshops were hard-wired 40/60, everything else 30/70. */
export const defaultDistributionFor = (unitType: UnitKind = "theory"): MarkDistribution =>
  unitType === "workshop" ? { ca: 40, exam: 60 } : { ...DEFAULT_DISTRIBUTION };

/**
 * Accepts {ca, exam}, {caMax, examMax} or just one side (the other is derived).
 * Returns an error string for impossible values, `null` distribution when nothing was supplied.
 */
export function parseDistribution(raw: unknown): { distribution: MarkDistribution | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { distribution: null };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const ca = num(r.ca ?? r.caMax);
  const exam = num(r.exam ?? r.examMax);
  if (ca === undefined && exam === undefined) return { distribution: null };
  const c = ca ?? 100 - (exam as number);
  const e = exam ?? 100 - c;
  if (![c, e].every((n) => Number.isFinite(n) && Number.isInteger(n))) {
    return { error: "Mark distribution must be whole numbers, e.g. CA 30 / Exam 70." };
  }
  if (c < 0 || e < 0 || c + e !== 100) {
    return {
      error: `Mark distribution must add up to 100 (got CA ${c} + Exam ${e}).`,
    };
  }
  return { distribution: { ca: c, exam: e } };
}

/** Distribution to use: explicit → unit default → legacy default for the unit type. */
export function resolveDistribution(
  explicit: MarkDistribution | null | undefined,
  unitDefault: Partial<MarkDistribution> | null | undefined,
  unitType: UnitKind = "theory",
): MarkDistribution {
  if (explicit) return explicit;
  if (unitDefault?.ca !== undefined && unitDefault?.exam !== undefined && unitDefault.ca + unitDefault.exam === 100) {
    return { ca: unitDefault.ca, exam: unitDefault.exam };
  }
  return defaultDistributionFor(unitType);
}

/**
 * Component weights (marks out of 100) for a unit type under a distribution.
 * The CA split between tests / assignment / practical keeps its legacy
 * proportions and is scaled to the CA share. Workshops are practical only.
 */
export function unitWeights(unitType: UnitKind, dist: MarkDistribution) {
  if (unitType === "workshop") return { practical: dist.ca, assignment: 0, tests: 0, exam: dist.exam };
  const f = dist.ca / 30;
  return unitType === "lab"
    ? { practical: 15 * f, assignment: 5 * f, tests: 10 * f, exam: dist.exam }
    : { practical: 0, assignment: 10 * f, tests: 20 * f, exam: dist.exam };
}

// ── Sheet metadata (hidden cell Z1) so an uploaded sheet carries its own rules ──

export interface SheetMeta {
  distribution: MarkDistribution;
  unitType: UnitKind;
  examMode: ExamModeKind;
}
export const META_CELL = "Z1";

export const encodeSheetMeta = (m: SheetMeta): string =>
  `DIST:${m.distribution.ca}/${m.distribution.exam}|TYPE:${m.unitType}|MODE:${m.examMode}`;

export function decodeSheetMeta(text: unknown): Partial<SheetMeta> {
  const s = String(text ?? "");
  const out: Partial<SheetMeta> = {};
  const d = /DIST:(\d+)\/(\d+)/.exec(s);
  if (d && Number(d[1]) + Number(d[2]) === 100) out.distribution = { ca: Number(d[1]), exam: Number(d[2]) };
  const t = /TYPE:(theory|lab|workshop)/.exec(s);
  if (t) out.unitType = t[1] as UnitKind;
  const m = /MODE:(standard|mandatory_q1)/.exec(s);
  if (m) out.examMode = m[1] as ExamModeKind;
  return out;
}