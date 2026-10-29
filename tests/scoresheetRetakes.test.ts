// Repeat-year students are listed on every unit; CF / stay-out retakes carry their first-sitting CA (locked).
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import AcademicYear from "../src/models/AcademicYear";
import ProgramUnit from "../src/models/ProgramUnit";
import Student from "../src/models/Student";
import Mark from "../src/models/Mark";
import MarkDirect from "../src/models/MarkDirect";
import FinalGrade from "../src/models/FinalGrade";
import { buildScoresheetStudentList } from "../src/utils/scoresheetStudentList";

const oid = () => new mongoose.Types.ObjectId();
const pid = oid(), puid = oid(), yid = oid(), uid = oid();
const mk = (regNo: string, extra: any = {}) => ({ _id: oid(), regNo, name: regNo, program: pid, status: "active", currentYearOfStudy: 1, ...extra });
const normal = mk("N1"), passedNormal = mk("P1"), repeater = mk("R1", { status: "repeat" }), stayout = mk("S1"), cf = mk("C1", { currentYearOfStudy: 2 });

const chain = (v: any) => ({ lean: async () => v, sort: () => ({ lean: async () => v }), distinct: async () => [] });

test("repeater is on a unit they already passed; normal passer is not; CF/stay-out carry locked CA", async () => {
  (AcademicYear as any).findById = () => chain({ _id: yid, isCurrent: true });
  (Mark as any).find = () => chain([]);
  (MarkDirect as any).find = () => chain([]);
  (ProgramUnit as any).findById = () => chain(null);
  (Student as any).find = (f: any) => {
    if (f["carryForwardUnits.programUnitId"]) return chain([{ ...cf, carryForwardUnits: [{ programUnitId: String(puid), status: "pending", qualifier: "RP1C" }] }]);
    if (f["deferredSuppUnits.programUnitId"]) return chain([]);
    return chain([normal, passedNormal, repeater, stayout]);
  };
  const g = (sid: any, status: string, ca: number) => ({ student: sid, programUnit: puid, status, caTotal30: ca, createdAt: new Date() });
  (FinalGrade as any).find = () => chain([
    g(passedNormal._id, "PASS", 20), g(repeater._id, "PASS", 22), g(stayout._id, "SUPPLEMENTARY", 0),
    { ...g(cf._id, "SUPPLEMENTARY", 18), createdAt: new Date(0) },
  ]);

  const list = await buildScoresheetStudentList({
    programId: pid, programUnitId: puid, unitId: uid, yearOfStudy: 1, academicYearId: yid, session: "ORDINARY", passMark: 40,
  });
  const by = Object.fromEntries(list.map((s) => [s.regNo, s]));
  assert.ok(by.N1 && !by.N1.isRepeatYear);
  assert.equal(by.P1, undefined, "a normal student who passed is not re-listed");
  assert.ok(by.R1?.isRepeatYear, "repeat-year student is on every unit");
  assert.equal(by.R1.attemptLabel, "Repeat");
  assert.equal(by.R1.lockCA, false, "repeat year sits CATs and exam in full");
  assert.ok(by.C1?.isCarryForward && by.C1.isSupp, "a CF unit is still a supplementary sitting");
  assert.equal(by.C1.attemptLabel, "Supp");
});

import { rowHasNoEntries } from "../src/services/resultRows";
test("an empty sheet row is not applied; typed marks are", () => {
  const blank = ["", "E1", "NAME", "1st", "", "", "", "", "", "", "", "", "", 0, "", "", "", "", "", 0, 0, "", 0, "B"];
  assert.equal(rowHasNoEntries(blank, "detailed"), true);
  assert.equal(rowHasNoEntries(["", "E1", "N", "1st", "", 30], "direct"), false);
  assert.equal(rowHasNoEntries(["", "E1", "N", "Supp", 0, ""], "direct"), true);   // supp row, only the locked CA
  assert.equal(rowHasNoEntries(["", "E1", "N", "Supp", 0, 45], "direct"), false);
  assert.equal(rowHasNoEntries(["", "E1", "N", "1st", 20, ""], "direct"), false);  // CA-only first sitting still applied
});