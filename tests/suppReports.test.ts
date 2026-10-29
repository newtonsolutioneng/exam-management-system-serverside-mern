import test from "node:test";
import assert from "node:assert/strict";
import { carryForwardVerdict, lastCarryForwardFromYear } from "../src/utils/carryForwardVerdict";
import { suppCohortFromMarks, inSuppCohort } from "../src/utils/suppScope";
import { classifyRecommendation, SUMMARY_LABELS } from "../src/utils/consolidatedMS";
import { unitsForStudent } from "../src/utils/promotionReport";

const f = (code: string, suppSat = true, noCA = false) => ({ code, name: `${code} name`, suppSat, noCA });
const base = { otherOutstanding: 0, totalUnits: 7, yearOfStudy: 1, durationYears: 4 };

test("carry forward: one unit failed at supplementary is carried forward", () => {
  const v = carryForwardVerdict({ ...base, failed: [f("TST 1206")] });
  assert.equal(v.eligible, true);
  assert.deepEqual(v.units.map((u) => u.code), ["TST 1206"]);
});

test("carry forward: not before the supplementary has been sat", () => {
  assert.equal(carryForwardVerdict({ ...base, failed: [f("TST 1103", false)] }).eligible, false);
});

test("carry forward: three units, final year, other outstanding, or missing coursework are refused", () => {
  assert.equal(carryForwardVerdict({ ...base, failed: [f("A"), f("B"), f("C")] }).eligible, false);
  assert.equal(carryForwardVerdict({ ...base, yearOfStudy: 4, failed: [f("A")] }).eligible, false);
  assert.equal(carryForwardVerdict({ ...base, otherOutstanding: 1, failed: [f("A")] }).eligible, false);
  assert.equal(carryForwardVerdict({ ...base, failed: [f("A", true, true)] }).eligible, false);
});

test("carry forward: BEd only from years 1 and 2", () => {
  assert.equal(lastCarryForwardFromYear(5, "BEd"), 2);
  assert.equal(lastCarryForwardFromYear(4, "BSc"), 3);
  assert.equal(carryForwardVerdict({ ...base, durationYears: 5, degreeType: "BEd", yearOfStudy: 3, failed: [f("A")] }).eligible, false);
});

test("summary: every recommendation lands in a row, including STAYOUT", () => {
  assert.equal(classifyRecommendation("PASS"), "PASS");
  assert.equal(classifyRecommendation("STAYOUT"), "STAY OUT");
  assert.equal(classifyRecommendation("REPEAT YEAR"), "REPEAT YEAR");
  assert.equal(classifyRecommendation("SUPP 2"), "SUPPLEMENTARY");
  assert.equal(classifyRecommendation("SUPP 1; SPEC 1"), "SUPPLEMENTARY");
  assert.equal(classifyRecommendation("SPEC 2"), "SPECIAL");
  assert.equal(classifyRecommendation("CARRY FORWARD"), "CARRY FORWARD");
  assert.equal(classifyRecommendation("DISCIPLINARY SUSPENSION"), "DISCIPLINARY SUSPENSION");
  assert.equal(classifyRecommendation("DEREGISTERED"), "DEREGISTERED/DISC");
  assert.equal(classifyRecommendation("INC 1"), "INCOMPLETE");
 assert.equal(classifyRecommendation("SOMETHING NEW"), "OTHER");
  for (const l of SUMMARY_LABELS) assert.ok(typeof l === "string");
});

test("supp scope: only candidates who sat, or are still owed, a supp/special", () => {
  const marks = [
    { student: "a", attempt: "supplementary" },
    { student: "b", attempt: "special" },
    { student: "c", attempt: "1st" },
  ];
  const cohort = suppCohortFromMarks(marks);
 assert.ok(inSuppCohort({ id: "a", status: "PASS" }, cohort));
  assert.ok(inSuppCohort({ id: "b", status: "REPEAT YEAR" }, cohort));   // six specials, now repeats
  assert.ok(inSuppCohort({ id: "d", status: "SUPP 1" }, cohort));        // still owed a supp
  assert.ok(!inSuppCohort({ id: "c", status: "PASS" }, cohort));         // settled at the ordinary sitting
  assert.ok(!inSuppCohort({ id: "e", status: "STAYOUT" }, cohort));
  assert.ok(!inSuppCohort({ id: "f", status: "ALREADY PROMOTED" }, new Set()));
});

test("report units: structured details first, absent units for deregistration", () => {
  assert.deepEqual(unitsForStudent({ failedUnits: [{ code: "TST 1101", name: "Maths" }] }),
    [{ code: "TST 1101", name: "Maths" }]);
  assert.deepEqual(unitsForStudent({ failedUnits: [], missingUnits: ["TST 1102: Physics (Absent)"] }),
    [{ code: "TST 1102", name: "Physics (Absent)" }]);
  assert.deepEqual(unitsForStudent({ specialUnits: [{ code: "TST 1206", name: "Lab" }] }, "special"),
    [{ code: "TST 1206", name: "Lab" }]);
});