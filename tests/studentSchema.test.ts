// Regression: a nested key called "type" is read by Mongoose as the field's TYPE unless written
// as { type: { type: String } }. The attempt registry broke this way and silently recorded nothing.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Student from "../src/models/Student";

const attempt = { attemptNumber: 1, mark: 66, passed: true, type: "1ST_ATTEMPT", academicYear: "2013/2014" };

test("unitAttemptRegistry keeps attempts and their type", () => {
  const id = new mongoose.Types.ObjectId();
  const doc: any = new Student({ institution: id, regNo: "X", name: "n", program: id, programType: "BSc",
    admissionAcademicYear: id, unitAttemptRegistry: [{ unitId: id, attempts: [attempt] }] });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.unitAttemptRegistry[0].attempts.length, 1);
  assert.equal(doc.unitAttemptRegistry[0].attempts[0].type, "1ST_ATTEMPT");
});

test("$push of a registry entry casts (as attemptRegistry.recordAttempt does)", () => {
  const id = new mongoose.Types.ObjectId();
  const q: any = Student.updateOne({ _id: id }, { $push: { unitAttemptRegistry: { unitId: id, attempts: [attempt] } } });
  assert.doesNotThrow(() => q._castUpdate(q.getUpdate()));
});