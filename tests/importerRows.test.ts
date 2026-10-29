import test from "node:test";
import assert from "node:assert/strict";
import { isDataRow } from "../src/services/marksImporter";

test("a row typed into a spare line (no S/N) is still read", () => {
  assert.equal(isDataRow([undefined, "E024-01-2033/2018", "LATE STUDENT"]), true);
  assert.equal(isDataRow(["", "E024-01-2033/2018"]), true);
});
test("numbered class rows are read", () => {
  assert.equal(isDataRow([1, "E024-01-2001/2018", "NAME"]), true);
});
test("blank rows and headers are skipped", () => {
  assert.equal(isDataRow([undefined, undefined]), false);
  assert.equal(isDataRow([7, ""]), false);
  assert.equal(isDataRow(["S/N", "REG. NO.", "NAME"]), false);
});