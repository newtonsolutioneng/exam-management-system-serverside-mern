// Every Word report must read as plain text: no leaked code, a proper footer, the right board for the session.
import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import InstitutionSettings from "../src/models/InstitutionSettings";
import * as R from "../src/utils/promotionReport";

const text = (b: Buffer) => new AdmZip(b).readAsText("word/document.xml").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const mk = (examType: "ORDINARY" | "SUPPLEMENTARY", degreeType = "BSc"): any => ({
  programName: "BSC-TEST", academicYear: "2018/2019", yearOfStudy: 1, totalYears: 4, institutionId: "", logoBuffer: Buffer.alloc(0), examType, degreeType,
  eligible: [{ regNo: "E1", name: "Ann Bee", status: "PASS", reasons: [] },
    { regNo: "E2", name: "Cy Dee", status: "CARRY FORWARD", carryForward: true, cfUnits: [{ code: "U6", name: "Lab" }], failedUnits: [{ code: "U6", name: "Lab" }], reasons: ["Carry forward: U6: Lab"] }],
  blocked: [
    { regNo: "E3", name: "Eve Fox", status: "STAYOUT", reasons: [], failedUnits: [{ code: "U1", name: "Maths" }, { code: "U2", name: "Physics" }] },
    { regNo: "E4", name: "Gus Hay", status: "REPEAT YEAR", reasons: [], failedUnits: [{ code: "U1", name: "Maths" }] },
    { regNo: "E5", name: "Ivy Jay", status: "SUPP 1", reasons: [], failedUnits: [{ code: "U3", name: "Chem" }] },
  ],
});

test("reports contain no leaked code and name the right board", async () => {
  (InstitutionSettings as any).findOne = () => ({ lean: async () => null });
  for (const examType of ["ORDINARY", "SUPPLEMENTARY"] as const) {
    const d = mk(examType);
    const docs = [R.generateEligibleSummaryDoc, R.generateStayoutExamsDoc, R.generateRepeatYearDoc, R.generateSupplementaryExamsDoc, R.generateCarryForwardDoc, R.generatePromotionWordDoc];
    for (const g of docs) {
      const t = text(await (g as (x: unknown) => Promise<Buffer>)(d));
      assert.ok(!t.includes("=>") && !t.includes("${") && !t.includes("undefined"), `${g.name}: leaked code in "${t.slice(-200)}"`);
      assert.match(t, /APPROVED BY THE BOARD OF EXAMINERS( FOR SPECIALS AND SUPPLEMENTARIES)?, /);
      assert.equal(/specials and supplementaries/i.test(t), examType === "SUPPLEMENTARY", `${g.name} board wording for ${examType}`);
    }
  }
});

test("pass list: asterisk and a note, but no unit list; supp stay-out cites 15(d), BEd 15(e)", async () => {
  (InstitutionSettings as any).findOne = () => ({ lean: async () => null });
  const pass = text(await R.generateEligibleSummaryDoc(mk("SUPPLEMENTARY")));
  assert.match(pass, /Cy DEE \*/);
  assert.ok(!pass.includes("Lab"));
  const so = text(await R.generateStayoutExamsDoc(mk("SUPPLEMENTARY")));
  assert.match(so, /Rule 15 \(d\)/);
  assert.ok(!so.includes("15 (h)"));
  assert.match(text(await R.generateStayoutExamsDoc(mk("SUPPLEMENTARY", "BEd"))), /Rule 15 \(e\)/);
  assert.match(text(await R.generateStayoutExamsDoc(mk("ORDINARY"))), /15 \(h\)/);
  assert.match(so, /U1 Maths U2 Physics/);
});