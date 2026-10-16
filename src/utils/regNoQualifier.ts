// serverside/src/utils/regNoQualifier.ts
//
// Registration-number ⇄ qualifier handling (DB-free except findStudentByRegNo).
//
// A student's identity is the BASE reg no (E024-01-1339/2016). The qualifier
// (RP1, M2, TF3S2 …) describes the student's situation and is stored separately
// in Student.qualifierSuffix; documents print base + qualifier.
// "E024-01-1339/2016" and "E024-01-1339/2016RP1" are therefore the SAME student.

import type { Model } from "mongoose";

/** Known qualifiers (see REG_QUALIFIERS in academicRules.ts), longest alternatives first. */
const KNOWN_QUALIFIER = /^(.*\d)(RPU\d|RP\d[DC]?|RA\d(?:S2)?|M[234]|TF[23](?:S2)?)$/;

/** Legacy importer behaviour: anything alphabetic stuck on after "/YYYY". */
const LOOSE_QUALIFIER = /^(.*\/\d{4})([A-Z][A-Z0-9]*)$/;

export interface SplitRegNo {
  /** Upper-cased, whitespace-free registration number without qualifier. */
  base: string;
  /** Qualifier ("" when none). */
  qualifier: string;
}

/** Upper-case + remove all whitespace. */
export const cleanRegNo = (raw: unknown): string =>
  String(raw ?? "").toUpperCase().replace(/\s+/g, "");

/** Qualifier from its own column: tolerate "RP1", " rp 1 ", "(RP1)", "-". Returns "" for blank markers. */
export function cleanQualifier(raw: unknown): string {
  const q = cleanRegNo(raw).replace(/[()[\]]/g, "");
  return q === "-" || q === "—" || q === "N/A" || q === "NA" || q === "NONE" ? "" : q;
}

/**
 * Splits "E024-01-1339/2016RP1" into base + qualifier.
 * If `explicitQualifier` (the optional Qualifier column) is given it wins over
 * whatever is glued to the reg no; either way the base never carries a qualifier.
 */
export function splitRegNo(raw: unknown, explicitQualifier?: unknown): SplitRegNo {
  const cleaned = cleanRegNo(raw);
  let base = cleaned;
  let embedded = "";
  const m = KNOWN_QUALIFIER.exec(cleaned) ?? LOOSE_QUALIFIER.exec(cleaned);
  if (m) { base = m[1]; embedded = m[2]; }
  const explicit = cleanQualifier(explicitQualifier);
  return { base, qualifier: explicit || embedded };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex matching the base reg no with or without a trailing qualifier (legacy rows stored it inside regNo). */
export const regNoAnyQualifierRegex = (base: string): RegExp =>
  new RegExp(`^${escapeRe(base)}(?:[A-Z][A-Z0-9]*)?$`, "i");

/**
 * Finds a student by base reg no, whether or not the stored regNo carries a qualifier.
 * Exact match first (uses the index); anchored regex only as a fallback.
 */
export async function findStudentByRegNo<T = unknown>(
  StudentModel: Model<any>,
  rawRegNo: unknown,
  institution: unknown,
  select?: string,
): Promise<(T & { _id: unknown }) | null> {
  const { base } = splitRegNo(rawRegNo);
  if (!base) return null;
  const run = (regNo: unknown) => {
    const q = StudentModel.findOne({ regNo, institution });
    return (select ? q.select(select) : q).lean() as unknown as Promise<(T & { _id: unknown }) | null>;
  };
  return (await run(base)) ?? (await run({ $regex: regNoAnyQualifierRegex(base) }));
}

/** Display reg no for documents: base + stored qualifier, never doubled. */
export function displayRegNo(regNo: string, qualifier?: string | null): string {
  const { base, qualifier: embedded } = splitRegNo(regNo);
  const q = (qualifier ?? "").trim().toUpperCase() || embedded;
  return q ? `${base}${q}` : base;
}

export interface ExistingByBase {
  _id: unknown;
  regNo: string;
  qualifierSuffix: string;
}

/**
 * Batch duplicate check keyed on the BASE reg no.
 * Finds students stored plainly ("…/2016"), with the qualifier in the stored
 * regNo (legacy rows: "…/2016RP1") or with it in qualifierSuffix.
 */
export async function loadExistingByBase(
  StudentModel: Model<any>,
  institution: unknown,
  bases: string[],
): Promise<Map<string, ExistingByBase>> {
  const out = new Map<string, ExistingByBase>();
  const unique = [...new Set(bases.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const rx = new RegExp(`^(?:${chunk.map(escapeRe).join("|")})(?:[A-Z][A-Z0-9]*)?$`, "i");
    const docs = (await StudentModel.find({ institution, regNo: { $regex: rx } })
      .select("regNo qualifierSuffix")
      .lean()) as unknown as Array<{ _id: unknown; regNo: string; qualifierSuffix?: string }>;
    for (const d of docs) {
      const sp = splitRegNo(d.regNo);
      if (!out.has(sp.base)) {
        out.set(sp.base, { _id: d._id, regNo: d.regNo, qualifierSuffix: d.qualifierSuffix || sp.qualifier });
      }
    }
  }
  return out;
}