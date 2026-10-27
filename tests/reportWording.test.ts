import test from "node:test";
import assert from "node:assert/strict";
import { numberToWords } from "../src/utils/promotionReport";

test("numberToWords handles class sizes in the hundreds and thousands", () => {
  assert.equal(numberToWords(21), "Twenty-One");
  assert.equal(numberToWords(500), "Five Hundred");
  assert.equal(numberToWords(121), "One Hundred and Twenty-One");
  assert.equal(numberToWords(1200), "One Thousand Two Hundred");
  assert.equal(numberToWords(1005), "One Thousand and Five");
  assert.equal(numberToWords(0), "Zero");
});