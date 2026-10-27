import test from "node:test";
import assert from "node:assert/strict";
import { describeShape, matchesPattern, stripQualifier, legacyFieldsFromExample } from "../src/utils/regNoShape";

const ex = { example: "E024-01-1339/2016" };

test("describes the format in plain words", () => {
  assert.equal(describeShape("E024-01-1339/2016"), "Letter E, 3 digits, dash, 2 digits, dash, 4 digits, slash, 4 digits");
  assert.equal(describeShape("SMS/12/2024"), "Letters SMS, slash, 2 digits, slash, 4 digits");
  assert.equal(describeShape("abc"), "");
});
test("matches same-shaped numbers, ignores qualifier and spacing/case", () => {
  assert.ok(matchesPattern("E023-02-0007/2015", ex));
  assert.ok(matchesPattern("e024-01-1339/2016rp1", ex));
  assert.ok(matchesPattern("E024-01-1339/2016 TF2S2", ex));
  assert.ok(matchesPattern("E024-01-1339/2016RPU4", ex));
});
test("rejects wrong shapes", () => {
  assert.ok(!matchesPattern("E24-01-1339/2016", ex));
  assert.ok(!matchesPattern("F024-01-1339/2016", ex));
  assert.ok(!matchesPattern("E024-01-1339", ex));
  assert.ok(!matchesPattern("E024-0001", ex));
});
test("the E024-0001 style from the old help text now works", () => {
  assert.ok(matchesPattern("E024-0001", { example: "E024-0001" }));
  assert.ok(matchesPattern("E024-0001", { prefix: "E", separator: "-", yearDigits: 3, example: "" }));
  assert.ok(matchesPattern("E-024-0001", { prefix: "E", separator: "-", yearDigits: 3, example: "" }));
});
test("advanced regex wins; bad regex falls back to the example", () => {
  assert.ok(matchesPattern("X1", { manualRegex: "^X\\d$", example: "E024-0001" }));
  assert.ok(matchesPattern("E024-0002", { manualRegex: "([", example: "E024-0001" }));
});
test("qualifier stripping keeps real numbers intact", () => {
  assert.equal(stripQualifier("M2"), "M2");
  assert.equal(stripQualifier("E024-01-1339/2016RP1"), "E024-01-1339/2016");
});
test("legacy fields derived from example", () => {
  assert.deepEqual(legacyFieldsFromExample("E024-0001"), { prefix: "E", separator: "-", yearDigits: 3 });
});