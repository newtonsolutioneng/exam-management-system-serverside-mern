// serverside/src/utils/suppScope.ts
// Which students belong on the Supplementary & Special CMS and reports?
//
// Only the candidates that session is about: those who sat a supplementary or special examination this academic
// year, plus those who are still owed one (still SUPP / SPEC / INC after the ordinary results). Students who were
// settled at the ordinary sitting (PASS, STAYOUT, REPEAT YEAR, leave...) were already reported then and are not
// repeated. A student whose specials or supplementaries change their outcome (for example a REPEAT YEAR after six
// specials) is in the group, so the follow-up documents are produced for them.

const SUPP_ATTEMPTS = new Set(["supplementary", "special"]);

/** ids of students holding at least one supplementary/special mark among `marks` (already limited to the year and cohort) */
export function suppCohortFromMarks(marks: any[]): Set<string> {
  const ids = new Set<string>();
  for (const m of marks) {
    const attempt = String(m?.attempt ?? "").toLowerCase();
    if (
      SUPP_ATTEMPTS.has(attempt) ||
      m?.isSpecial === true ||
      m?.isSupplementary === true
    ) {
      const sid = m.student?._id ?? m.student;
      if (sid) ids.add(String(sid));
    }
  }
  return ids;
}

/** true when a preview row / student document belongs in the supplementary & special reports */
export function inSuppCohort(entry: any, markCohort: Set<string>): boolean {
  const id = String(entry?._id ?? entry?.id ?? "");
  if (id && markCohort.has(id)) return true;
  if (entry?.carryForward) return true;
  return /\b(SUPP|SPEC|INC)/i.test(String(entry?.status ?? ""));
}
