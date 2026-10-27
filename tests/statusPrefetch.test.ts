// calculateStudentStatus must give the same answer whether it queries per student or is handed
// class-wide prefetched records (the promotion analysis uses the second to avoid thousands of queries).
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import InstitutionSettings from "../src/models/InstitutionSettings";
import AcademicYear from "../src/models/AcademicYear";
import ProgramUnit from "../src/models/ProgramUnit";
import Student from "../src/models/Student";
import Mark from "../src/models/Mark";
import MarkDirect from "../src/models/MarkDirect";
import FinalGrade from "../src/models/FinalGrade";
import { calculateStudentStatus } from "../src/services/statusEngine";

const oid = () => new mongoose.Types.ObjectId();
const sid = oid(), pid = oid(), yid = oid();
const units = [1, 2, 3, 4].map((n) => ({ _id: oid(), program: pid, requiredYear: 1, requiredSemester: 1, isElective: false,
  unit: { _id: oid(), code: `U${n}`, name: `Unit ${n}` } }));
const lean = (v: any) => ({ lean: async () => v, populate: () => ({ lean: async () => v }), sort: () => ({ lean: async () => v }) });
const stub = (model: any, fn: string, v: any) => { model[fn] = () => lean(v); };

const student = { _id: sid, regNo: "E1", name: "S", program: pid, status: "active", currentYearOfStudy: 1, entryType: "Direct",
  academicHistory: [], carryForwardUnits: [], deferredSuppUnits: [], unitAttemptRegistry: [], statusEvents: [] };
const direct = (u: any, mark: number) => ({ student: sid, programUnit: u._id, academicYear: yid, agreedMark: mark, caTotal30: 20, examTotal70: mark - 20, attempt: "1st", caMax: 30, examMax: 70 });

function setup(marks: number[]) {
  stub(InstitutionSettings, "findOne", { passMark: 40, ruleSet: { passMark: 40 } });
  stub(AcademicYear, "findOne", { _id: yid, year: "2013/2014", isCurrent: true, session: "ORDINARY" });
  stub(ProgramUnit, "find", units);
  stub(ProgramUnit, "countDocuments", units.length);
  stub(Student, "findById", student);
  stub(Mark, "find", []);
  stub(FinalGrade, "find", []);
  const md = units.map((u, i) => direct(u, marks[i]));
  stub(MarkDirect, "find", md);
  return md;
}

for (const [label, marks] of [["all pass", [60, 70, 80, 55]], ["one fail", [60, 30, 80, 55]]] as const) {
  test(`same result with and without prefetched records (${label})`, async () => {
    const md = setup([...marks]);
    const plain = await calculateStudentStatus(sid, pid, "2013/2014", 1, { forPromotion: true });
    const pre = await calculateStudentStatus(sid, pid, "2013/2014", 1, {
      forPromotion: true, memo: new Map(), prefetched: { student, detailed: [], direct: md, grades: [] },
    });
    assert.equal(pre.status, plain.status);
    assert.deepEqual(pre.summary, plain.summary);
    assert.equal(pre.weightedMean, plain.weightedMean);
  });
}

test("expected statuses", async () => {
  setup([60, 70, 80, 55]);
  assert.equal((await calculateStudentStatus(sid, pid, "2013/2014", 1, { forPromotion: true })).status, "PASS");
  setup([60, 30, 80, 55]);
  const r = await calculateStudentStatus(sid, pid, "2013/2014", 1, { forPromotion: true });
  assert.notEqual(r.status, "PASS");
  assert.equal(r.summary.failed, 1);
});