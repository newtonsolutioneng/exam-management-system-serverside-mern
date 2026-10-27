// Pure-logic tests: no database, no network. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { classifyWAA, REG_QUALIFIERS } from "../src/utils/academicRules";
import { splitRegNo } from "../src/utils/regNoQualifier";
import { transferFromQualifier } from "../src/services/complianceTracking";
import { requirementsFor } from "../src/services/attachments";

test("ENG 25(a): classification boundaries", () => {
  assert.equal(classifyWAA(70), "FIRST CLASS HONOURS");
  assert.equal(classifyWAA(69.99), "SECOND CLASS HONOURS (UPPER DIVISION)");
  assert.equal(classifyWAA(60), "SECOND CLASS HONOURS (UPPER DIVISION)");
  assert.equal(classifyWAA(50), "SECOND CLASS HONOURS (LOWER DIVISION)");
  assert.equal(classifyWAA(40), "PASS");
  assert.equal(classifyWAA(39.9), "FAIL");
});

test("qualifier builders", () => {
  assert.equal(REG_QUALIFIERS.repeatYear(2), "RP2");
  assert.equal(REG_QUALIFIERS.repeatYear(9), "RP5");
  assert.equal(REG_QUALIFIERS.disciplinaryRepeat(1), "RP1D");
  assert.equal(REG_QUALIFIERS.carryForward(7), "RP3C");
  assert.equal(REG_QUALIFIERS.readmit(2), "RA2");
  assert.equal(REG_QUALIFIERS.readmit(2, true), "RA2S2");
  assert.equal(REG_QUALIFIERS.transfer(3), "TF3");
  assert.equal(REG_QUALIFIERS.transfer(2, true), "TF2S2");
  assert.equal(REG_QUALIFIERS.midEntry(2), "M2");
});

test("reg-no splitting keeps base clean", () => {
  assert.deepEqual(splitRegNo("E024-01-1339/2016RP1"), { base: "E024-01-1339/2016", qualifier: "RP1" });
  assert.deepEqual(splitRegNo("e024-01-1339/2016 rp1d").qualifier, "RP1D");
  assert.deepEqual(splitRegNo("E024-01-1339/2016"), { base: "E024-01-1339/2016", qualifier: "" });
  assert.equal(splitRegNo("E024-01-1339/2016RP1", "RA2").qualifier, "RA2"); // explicit column wins
  assert.equal(splitRegNo("E024-01-1339/2016", "-").qualifier, "");
});

test("transfer qualifier parsing", () => {
  const a = transferFromQualifier("TF2");
  assert.equal(a?.entryYear, 2); assert.equal(a?.secondSemester, false);
  const b = transferFromQualifier("tf3s2");
  assert.equal(b?.entryYear, 3); assert.equal(b?.secondSemester, true);
  assert.equal(transferFromQualifier("RP1"), undefined);
  assert.equal(transferFromQualifier(""), undefined);
});

test("attachment requirements by degree", () => {
  assert.deepEqual(requirementsFor("BEd").map(r => [r.kind, r.yearOfStudy, r.minWeeks]),
    [["attachment", 2, 8], ["practicum", 3, 12], ["attachment", 4, 8]]);
  assert.equal(requirementsFor("BSc").length, 3);
  assert.equal(requirementsFor("Diploma").length, 0);
});