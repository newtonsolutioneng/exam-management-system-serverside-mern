// resolveAgreedMarksBatch must give the same answers as the one-unit-at-a-time resolver:
// FinalGrade (best status) -> MarkDirect -> Mark -> 0.
import test from "node:test";
import assert from "node:assert/strict";
import FinalGrade from "../src/models/FinalGrade";
import MarkDirect from "../src/models/MarkDirect";
import Mark from "../src/models/Mark";
import { resolveAgreedMarksBatch } from "../src/services/graduationEngine";

const stub = (model: any, docs: any[]) => { model.find = () => ({ lean: async () => docs }); };

test("priority and fallbacks per programme unit", async () => {
  stub(FinalGrade, [
    { programUnit: "u1", status: "SUPPLEMENTARY", totalMark: 40 },
    { programUnit: "u1", status: "PASS", totalMark: 72 },     // best status wins
    { programUnit: "u2", status: "PASS", totalMark: 0 },      // zero -> falls through
  ]);
  stub(MarkDirect, [{ programUnit: "u2", agreedMark: 65 }]);
  stub(Mark, [{ programUnit: "u3", agreedMark: 58 }]);
  const m = await resolveAgreedMarksBatch("s1", ["u1", "u2", "u3", "u4"]);
  assert.deepEqual([...m.entries()], [["u1", 72], ["u2", 65], ["u3", 58], ["u4", 0]]);
});

test("empty input does no queries", async () => {
  stub(FinalGrade, [{ programUnit: "x", totalMark: 1 }]);
  assert.equal((await resolveAgreedMarksBatch("s1", [])).size, 0);
});