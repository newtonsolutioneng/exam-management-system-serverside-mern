// serverside/src/services/marksImporter.ts — detailed-breakdown scoresheet upload
//
// Sheet-level problems (no unit code, unknown academic year) still stop the upload.
// Row-level problems (student not registered, unit not linked, impossible marks) no longer
// produce errors: they are parked on the coordinator's action list (see resultUpload.ts).

import { randomUUID } from "node:crypto";
 import xlsx from "xlsx";
 import AcademicYear from "../models/AcademicYear";
 import type { AuthenticatedRequest } from "../middleware/auth";
import { applyRows, ImportResult } from "./resultUpload";
import type { RowContext } from "./resultRows";
import { META_CELL, decodeSheetMeta, defaultDistributionFor, UnitKind } from "../utils/markDistribution";
import { cleanRegNo } from "../utils/regNoQualifier";
 

export type { ImportResult };

export async function importMarksFromBuffer(
  buffer: Buffer,
  filename: string,
  req: AuthenticatedRequest,
): Promise<ImportResult> {
  const institutionId = req.user.institution;
  if (!institutionId) throw new Error("Coordinator not linked to institution");

  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Rules the sheet was generated with (hidden cell Z1). Older sheets: fall back to what the
  // title says ("SCORESHEET FOR XXX101 (LAB)"), the Q1 maximum, and 30/70.
  const meta = decodeSheetMeta(sheet[META_CELL]?.v);
  const title = String(sheet["F10"]?.v ?? "").toUpperCase();
  const unitType: UnitKind =
    meta.unitType ?? (title.includes("(WORKSHOP)") ? "workshop" : title.includes("(LAB)") ? "lab" : "theory");
  const examMode = meta.examMode ?? (Number(sheet["O16"]?.v) === 30 ? "mandatory_q1" : "standard");
  const distribution = meta.distribution ?? defaultDistributionFor(unitType);

  const unitCode = sheet["H12"]?.v?.toString().trim().toUpperCase();
  const yearMatch = (sheet["D8"]?.v?.toString() ?? "").match(/\d{4}\/\d{4}/);
  const academicYearStr = yearMatch ? yearMatch[0] : null;

  if (!unitCode || !academicYearStr) {
    throw new Error(
      `Invalid Template: Missing Unit Code (H12) or Academic Year (D8). Found Unit: ${unitCode}, Year: ${academicYearStr}`,
    );
  }

  const academicYearDoc = (await AcademicYear.findOne({
     year: { $regex: new RegExp(`^${academicYearStr}$`, "i") },
     institution: institutionId,
    }).lean()) as { _id: unknown } | null;
      if (!academicYearDoc) throw new Error(`Academic Year '${academicYearStr}' not found.`);
    
      const rawRows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: 16 });
      const rows: Array<{ row: unknown[]; rowNum: number }> = [];
      rawRows.forEach((row, index) => {
        const r = row as unknown[];
        if (!cleanRegNo(r[1]) || r[0] === "" || r[0] === undefined) return;
        rows.push({ row: r, rowNum: index + 17 });
      });
    
      const ctx: RowContext = {
        institutionId, userId: req.user._id, batchId: randomUUID(), templateType: "detailed",
        unitCode, academicYearId: academicYearDoc._id, distribution, unitType, examMode,
      };
      return applyRows(ctx, rows, { filename, academicYearLabel: academicYearStr });
}