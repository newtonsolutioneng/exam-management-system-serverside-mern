// The batch look-ups used to build a scoresheet must decide exactly like the old per-student ones.
import test from "node:test";
import assert from "node:assert/strict";
import FinalGrade from "../src/models/FinalGrade";
import MarkDirect from "../src/models/MarkDirect";
import Mark from "../src/models/Mark";
import { _prefetchUnit, _statusFrom, _priorSpecialFrom } from "../src/utils/scoresheetStudentList";

const stub = (model: any, docs: any[]) => { model.find = () => ({ lean: async () => docs }); };
const d = (n: number) => new Date(2020, 0, n);

test("status: newest FinalGrade wins, then MarkDirect, then Mark; pass mark and special respected", async () => {
  stub(FinalGrade, [
    { student: "a", status: "SUPPLEMENTARY", createdAt: d(1) },
    { student: "a", status: "PASS", createdAt: d(5) },
  ]);
  stub(MarkDirect, [
    { student: "b", agreedMark: 55, createdAt: d(1) },
    { student: "c", agreedMark: 30, createdAt: d(1) },
    { student: "d", agreedMark: 80, attempt: "special", createdAt: d(1) },
  ]);
  stub(Mark, [{ student: "e", agreedMark: 45, createdAt: d(1) }]);
  const pre = await _prefetchUnit(["a", "b", "c", "d", "e", "f"], "pu1");
  const st = (id: string) => _statusFrom(pre, id, 40).status;
  assert.deepEqual(["a", "b", "c", "d", "e", "f"].map(st), ["PASS", "PASS", "SUPPLEMENTARY", "SPECIAL", "PASS", null]);
});

test("prior special needs a coursework mark above zero", async () => {
  stub(FinalGrade, [{ student: "a", status: "SPECIAL", caTotal30: 20, createdAt: d(1) }, { student: "b", status: "SPECIAL", caTotal30: 0, createdAt: d(1) }]);
  stub(MarkDirect, [{ student: "c", attempt: "special", caTotal30: 18, createdAt: d(1) }]);
  stub(Mark, []);
  const pre = await _prefetchUnit(["a", "b", "c"], "pu1");
  assert.equal(_priorSpecialFrom(pre, "a")?._source, "finalGrade");
  assert.equal(_priorSpecialFrom(pre, "b"), null);
  assert.equal(_priorSpecialFrom(pre, "c")?._source, "direct");
});