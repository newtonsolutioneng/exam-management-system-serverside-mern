// serverside/src/services/resultUpload.ts
//
// Applies the rows of an uploaded scoresheet. Rows that cannot be applied become ProblemResults
// (an action list for the coordinator) instead of errors; rows that succeed auto-resolve any
// earlier open problem for the same student/unit/year; overwrites of existing marks are reported.

import Student from "../models/Student";
import ProblemResult, { ProblemCode } from "../models/ProblemResult";
import { processResultRow, loadProgramUnitMap, RowContext, RowOutcome } from "./resultRows";
import { splitRegNo } from "../utils/regNoQualifier";

export interface ProblemItem {
  rowNum: number; regNo: string; code: ProblemCode; message: string; action: string;
}
export interface ReplacedItem { regNo: string; unitCode: string; previous: number; next: number }

export interface ImportResult {
  total: number;
  success: number;
  created: number;
  updated: number;          // existing marks (same student + unit + year) that were overwritten
  errors: string[];         // fatal / sheet-level only
  warnings: string[];
  problems: number;         // rows parked on the action list
  problemItems: ProblemItem[];
  replaced: ReplacedItem[];
}

export const emptyResult = (): ImportResult => ({
  total: 0, success: 0, created: 0, updated: 0, errors: [], warnings: [], problems: 0, problemItems: [], replaced: [],
});

const CAP = 100;

export async function applyRows(
  ctx: RowContext,
  rows: Array<{ row: unknown[]; rowNum: number }>,
  meta: { filename: string; academicYearLabel: string },
): Promise<ImportResult> {
  const result = emptyResult();
  const programUnits = await loadProgramUnitMap(ctx.institutionId);
  const okRegNos: string[] = [];

  // one query for the whole sheet instead of one per row
  const bases = [
    ...new Set(rows.map(({ row }) => splitRegNo(row[1]).base).filter(Boolean)),
  ];
  if (bases.length) {
    const found = await Student.find({
      institution: ctx.institutionId,
      regNo: { $in: bases },
    }).lean();
    ctx.students = new Map(
      (found as any[]).map((st) => [String(st.regNo), st]),
    );
  }

  // Rows are applied a few at a time (different students are independent), then folded into the
  // result in sheet order. A reg no that appears twice is never in the same batch, so the later row wins.
  const CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY) || 16; // database waits dominate, so more rows in flight at once
  const batches: Array<Array<{ row: unknown[]; rowNum: number }>> = [];
  let current: Array<{ row: unknown[]; rowNum: number }> = [];
  let inCurrent = new Set<string>();
  for (const item of rows) {
    const key = splitRegNo(item.row[1]).base;
    if (inCurrent.has(key) || current.length >= CONCURRENCY) {
      batches.push(current);
      current = [];
      inCurrent = new Set();
    }
    current.push(item);
    inCurrent.add(key);
  }
  if (current.length) batches.push(current);

  for (const batch of batches) {
    const outcomes = await Promise.all(
      batch.map(({ row }) => {
        const sparse = Array.from(row, (v) => v ?? "");
        return processResultRow(ctx, programUnits, sparse);
      }),
    );
    for (let i = 0; i < batch.length; i++) {
      const { row, rowNum } = batch[i];
      const outcome: RowOutcome = outcomes[i];
      const sparse = Array.from(row, (v) => v ?? "");
      result.total++;
      if (outcome.ok) {
        result.success++;
        okRegNos.push(outcome.regNo);
        if (outcome.created) result.created++;
        else {
          result.updated++;
          if (result.replaced.length < CAP) {
            result.replaced.push({
              regNo: outcome.regNo,
              unitCode: ctx.unitCode,
              previous: outcome.previousMark ?? 0,
              next: outcome.newMark ?? 0,
            });
          }
        }
        continue;
      }

      result.problems++;
      if (result.problemItems.length < CAP) {
        result.problemItems.push({
          rowNum,
          regNo: outcome.regNo,
          code: outcome.code,
          message: outcome.message,
          action: outcome.action,
        });
      }
      const rawRegNo = String(sparse[1] ?? "").trim();
      await ProblemResult.findOneAndUpdate(
        {
          institution: ctx.institutionId,
          status: "OPEN",
          unitCode: ctx.unitCode,
          academicYear: ctx.academicYearId,
          regNo: outcome.regNo,
        },
        {
          $set: {
            uploadedBy: ctx.userId,
            batchId: ctx.batchId,
            filename: meta.filename,
            templateType: ctx.templateType,
            academicYearLabel: meta.academicYearLabel,
            rowNumber: rowNum,
            rawRegNo,
            studentName: String(sparse[2] ?? "").trim(),
            program: outcome.programId,
            code: outcome.code,
            message: outcome.message,
            action: outcome.action,
            payload: {
              row: sparse,
              distribution: ctx.distribution,
              unitType: ctx.unitType,
              examMode: ctx.examMode,
            },
          },
        },
        { upsert: true },
      );
    }
  }

  // earlier problems for rows that have now gone through are done
  if (okRegNos.length) {
    await ProblemResult.updateMany(
      {
        institution: ctx.institutionId,
        status: "OPEN",
        unitCode: ctx.unitCode,
        academicYear: ctx.academicYearId,
        regNo: { $in: okRegNos },
      },
      {
        $set: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolvedBy: ctx.userId,
          resolution: "Uploaded successfully",
        },
      },
    );
  }

  if (result.updated > 0) {
    result.warnings.push(
      `${result.updated} existing mark(s) for ${ctx.unitCode} were replaced by this upload (same student, unit and academic year). Other units are not affected.`,
    );
  }
  if (result.problems > 0) {
    result.warnings.push(
      `${result.problems} row(s) could not be applied and were added to the action list.`,
    );
  }
  return result;
}

/** Re-apply open problems (all, or the given ids). `override` fixes the reg no of a single row. */
export async function retryProblems(opts: {
  institutionId: any; userId: any; ids?: string[]; override?: { regNo?: string };
}) {
  const { randomUUID } = await import("node:crypto");
  const filter: Record<string, unknown> = { institution: opts.institutionId, status: "OPEN" };
  if (opts.ids?.length) filter._id = { $in: opts.ids };
  const problems = await ProblemResult.find(filter);
  const programUnits = await loadProgramUnitMap(opts.institutionId);
  const batches = new Map<string, string>();

  let resolved = 0, stillOpen = 0;
  for (const p of problems) {
    const groupKey = `${p.templateType}|${p.unitCode}|${p.academicYear}`;
    if (!batches.has(groupKey)) batches.set(groupKey, randomUUID());
    const ctx: RowContext = {
      institutionId: opts.institutionId, userId: opts.userId, batchId: batches.get(groupKey)!,
      templateType: p.templateType, unitCode: p.unitCode, academicYearId: p.academicYear,
      distribution: p.payload.distribution, unitType: p.payload.unitType, examMode: p.payload.examMode,
    };
    const regNoOverride = opts.override?.regNo ? splitRegNo(opts.override.regNo).base : undefined;
    const out = await processResultRow(ctx, programUnits, p.payload.row, regNoOverride);
    if (out.ok) {
      p.status = "RESOLVED";
      p.resolvedAt = new Date();
      p.resolvedBy = opts.userId;
      p.resolution = regNoOverride ? `Applied with reg no corrected to ${out.regNo}` : "Applied on retry";
      resolved++;
    } else {
      p.code = out.code; p.message = out.message; p.action = out.action;
      stillOpen++;
    }
    await p.save();
  }
  return { attempted: problems.length, resolved, stillOpen };
}