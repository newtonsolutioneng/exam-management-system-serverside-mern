
// serverside/src/services/directMarksImporter.ts — direct-entry scoresheet upload (CA + exam totals)
//
// Same rules as the detailed importer: sheet-level problems stop the upload, row-level problems
// go to the coordinator's action list. The unit is resolved through the student's own programme
// (program + unit code), so equal unit codes in different departments cannot be mixed up.

import { randomUUID } from "node:crypto";
 import xlsx from "xlsx";
 import AcademicYear from "../models/AcademicYear";
 import type { AuthenticatedRequest } from "../middleware/auth";
import { applyRows, ImportResult } from "./resultUpload";
import type { RowContext } from "./resultRows";
import { META_CELL, decodeSheetMeta, defaultDistributionFor } from "../utils/markDistribution";
import { cleanRegNo } from "../utils/regNoQualifier";
 
export type { ImportResult };

export async function importDirectMarksFromBuffer(
  buffer: Buffer,
  filename: string,
  req: AuthenticatedRequest,
): Promise<ImportResult> {
  const institutionId = req.user.institution;
  if (!institutionId) throw new Error("Coordinator not linked to institution");

  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const meta = decodeSheetMeta(sheet[META_CELL]?.v);
  const unitType = meta.unitType ?? "theory";
  const examMode = meta.examMode ?? "standard";
  // Older sheets: read the split from the column headers "CA TOTAL (/30)" / "EXAM TOTAL (/70)", else 30/70.
  let distribution = meta.distribution;
  if (!distribution) {
    const ca = Number(/\/(\d+)/.exec(String(sheet["E15"]?.v ?? ""))?.[1]);
    const exam = Number(/\/(\d+)/.exec(String(sheet["F15"]?.v ?? ""))?.[1]);
    distribution = ca + exam === 100 ? { ca, exam } : defaultDistributionFor(unitType);
  }

  const unitCode = sheet["F12"]?.v?.toString().trim().toUpperCase();
  const yearMatch = (sheet["C8"]?.v?.toString() ?? "").match(/\d{4}\/\d{4}/);
  const academicYearStr = yearMatch ? yearMatch[0] : null;

  if (!unitCode || !academicYearStr) {
    throw new Error(
      `Metadata missing. Unit code at F12: "${unitCode}", Academic year at C8: "${academicYearStr}". Check cells F12 and C8.`,
    );
  }

  const academicYearDoc = (await AcademicYear.findOne({
        year: { $regex: new RegExp(`^${academicYearStr.replace("/", "\\/")}$`, "i") },
        institution: institutionId,
    }).lean()) as { _id: unknown } | null;
    
    if (!academicYearDoc) throw new Error(`Academic Year "${academicYearStr}" not found for this institution.`);
    
      const rawRows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: 15 });
      const rows: Array<{ row: unknown[]; rowNum: number }> = [];
      rawRows.forEach((row, index) => {
        const r = row as unknown[];
        const cellText = String(r[1] ?? "").trim().toUpperCase();
        if (!cellText || cellText === "REG. NO." || cellText === "REG NO" || !cleanRegNo(cellText)) return;
        rows.push({ row: r, rowNum: index + 16 });
      });
    
      const ctx: RowContext = {
        institutionId, userId: req.user._id, batchId: randomUUID(), templateType: "direct",
        unitCode, academicYearId: academicYearDoc._id, distribution, unitType, examMode,
      };
      return applyRows(ctx, rows, { filename, academicYearLabel: academicYearStr });
}