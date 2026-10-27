// Reg-no format learned from ONE real example, e.g. "E024-01-1339/2016".
// Letters stay literal, every run of digits becomes "exactly that many digits", other
// characters (- / .) stay as typed. A trailing qualifier (RP1, TF2 ...) is ignored.
// Pure and dependency-free: the same file is copied to clientside/src/utils/regNoShape.ts.

export interface ShapePart { kind: "letters" | "digits" | "sep"; text: string }

const QUALIFIER = /(RPU?\d+[DC]?|RA\d+(?:S2)?|TF[23](?:S2)?|M[234])$/i;
const SEP_WORDS: Record<string, string> = { "-": "dash", "/": "slash", ".": "dot", "_": "underscore" };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export const cleanRegNoText = (s: string) => String(s ?? "").toUpperCase().replace(/\s+/g, "");

/** Remove a trailing qualifier, but only when something precedes it and it follows a digit. */
export const stripQualifier = (s: string) => {
  const c = cleanRegNoText(s);
  const m = QUALIFIER.exec(c);
  return m && m.index > 0 && /\d$/.test(c.slice(0, m.index)) ? c.slice(0, m.index) : c;
};

export function parseShape(example: string): ShapePart[] {
  const base = stripQualifier(example);
  return (base.match(/[A-Z]+|\d+|[^A-Z\d]/g) ?? []).map((t) => ({
    kind: /^[A-Z]+$/.test(t) ? "letters" : /^\d+$/.test(t) ? "digits" : "sep",
    text: t,
  }));
}

export function shapeRegex(example: string): RegExp | null {
  const parts = parseShape(example);
  if (!parts.some((p) => p.kind === "digits")) return null;
  return new RegExp("^" + parts.map((p) => (p.kind === "digits" ? `\\d{${p.text.length}}` : esc(p.text))).join("") + "$", "i");
}

/** Plain-words description, e.g. "Letter E, 3 digits, dash, 2 digits, dash, 4 digits, slash, 4 digits". */
export function describeShape(example: string): string {
  const parts = parseShape(example);
  if (!parts.some((p) => p.kind === "digits")) return "";
  return parts.map((p) =>
    p.kind === "letters" ? `${p.text.length === 1 ? "letter" : "letters"} ${p.text}`
    : p.kind === "digits" ? `${p.text.length} digit${p.text.length === 1 ? "" : "s"}`
    : SEP_WORDS[p.text] ?? `"${p.text}"`,
  ).join(", ").replace(/^./, (c) => c.toUpperCase());
}

export interface RegNoPatternLike { prefix?: string; separator?: string; yearDigits?: number; example?: string; manualRegex?: string }

/** Does `regNo` match this pattern? Order: advanced regex, then the example's shape, then the old prefix fields. */
export function matchesPattern(regNo: string, p: RegNoPatternLike): boolean {
  const base = stripQualifier(regNo);
  if (p.manualRegex?.trim()) {
    try { return new RegExp(p.manualRegex.trim(), "i").test(base); } catch { /* fall through */ }
  }
  const re = p.example ? shapeRegex(p.example) : null;
  if (re) return re.test(base);
  if (p.prefix) {
    // Legacy prefix fields: separator is optional anywhere, so both E024-0001 and E-024-0001 pass.
    const sep = p.separator ? `${esc(p.separator)}?` : "";
    return new RegExp(`^${esc(p.prefix.toUpperCase())}${sep}\\d{${p.yearDigits ?? 3}}(?:${sep}\\d+)+`, "i").test(base);
  }
  return true;
}

/** Fill the old fields from the example so previously saved data stays well-formed. */
export function legacyFieldsFromExample(example: string) {
  const parts = parseShape(example);
  const first = parts.find((p) => p.kind === "digits");
  return {
    prefix: parts[0]?.kind === "letters" ? parts[0].text : "",
    separator: parts.find((p) => p.kind === "sep")?.text ?? "",
    yearDigits: first && first.text.length === 2 ? 2 : 3,
  };
}