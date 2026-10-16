// serverside/src/services/curriculumService.ts
//
// Curriculum = the set of ProgramUnit links for a program (unit + year + semester + core/elective).
// This service handles:
//   • reading a curriculum sheet (Excel/CSV) and planning what it would change   (preview)
//   • applying that plan                                                          (commit)
//   • building the downloadable template                                          (prefilled with the current curriculum)
//   • the per-student graduation audit (required vs passed vs missing units)

import ExcelJS from "exceljs";
import * as xlsxLib from "xlsx";
import mongoose from "mongoose";
import Unit from "../models/Unit";
import ProgramUnit from "../models/ProgramUnit";
import Mark from "../models/Mark";
import MarkDirect from "../models/MarkDirect";
import FinalGrade from "../models/FinalGrade";
import Student from "../models/Student";
import { loadInstitutionSettings } from "../utils/loadInstitutionSettings";

export type Sem = 1 | 2 | 3;

export interface ProgramCtx {
  _id: mongoose.Types.ObjectId;
  code: string;
  name: string;
  schoolCode: string;
  departmentCode: string;
  durationYears: number;
}

// ───────────────────────── parsing ─────────────────────────

export interface ParsedRow {
  rowNum: number;
  code: string;
  name: string;
  year: number;
  semester: Sem;
  isElective: boolean;
}
export interface RowError { rowNum: number; code: string; message: string; }

const CODE_RE = /^[A-Z0-9][A-Z0-9 _\-/.]{1,19}$/;

const firstInt = (v: unknown): number | null => {
  const m = String(v ?? "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
};

/** Reads the first sheet; finds the header row by the "Unit Code" heading. */
export function parseCurriculumSheet(
  buffer: Buffer,
  durationYears: number,
): { rows: ParsedRow[]; errors: RowError[] } {
  const wb = xlsxLib.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const all = xlsxLib.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: false });

  const headerIdx = all.findIndex((r) => /unit\s*code/i.test(String(r?.[0] ?? "")));
  if (headerIdx === -1) {
    throw new Error("Header row not found. Download the curriculum template; column A must be headed 'Unit Code'.");
  }

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  const maxYear = Math.min(Math.max(durationYears || 5, 1), 6);

  all.slice(headerIdx + 1).forEach((r, i) => {
    const rowNum = headerIdx + i + 2;
    const code = String(r[0] ?? "").trim().toUpperCase();
    const name = String(r[1] ?? "").trim();
    if (!code && !name && !String(r[2] ?? "").trim()) return; // blank row

    const fail = (message: string) => errors.push({ rowNum, code, message });
    if (!CODE_RE.test(code)) return fail("Missing or invalid unit code.");
    if (seen.has(code)) return fail(`Duplicate of row ${seen.get(code)} — a unit can appear once per programme.`);

    const year = firstInt(r[2]);
    if (!year || year < 1 || year > maxYear) return fail(`Year of study must be 1–${maxYear}.`);
    const semester = firstInt(r[3]);
    if (!semester || semester < 1 || semester > 3) return fail("Semester must be 1, 2 or 3.");

    const type = String(r[4] ?? "").trim().toLowerCase();
    if (type && !/^(core|compulsory|required|elective|optional)/.test(type)) {
      return fail(`Type "${r[4]}" not recognised — use Core or Elective.`);
    }

    seen.set(code, rowNum);
    rows.push({ rowNum, code, name, year, semester: semester as Sem, isElective: /^(elective|optional)/.test(type) });
  });

  return { rows, errors };
}

// ───────────────────────── planning ─────────────────────────

export type PlanAction = "create_unit_and_link" | "link" | "update" | "unchanged";
export interface PlanRow extends ParsedRow {
  action: PlanAction;
  note?: string;
  from?: { year: number; semester: number; isElective: boolean };
}
export interface CurriculumPlan {
  rows: PlanRow[];
  errors: RowError[];
  removable: Array<{ linkId: string; code: string; name: string; year: number; semester: number; hasRecords: boolean }>;
  counts: { newUnits: number; newLinks: number; updated: number; unchanged: number; errors: number; removable: number };
}

interface UnitLean { _id: mongoose.Types.ObjectId; code: string; name: string; departmentCode: string; schoolCode: string; }
interface LinkLean {
  _id: mongoose.Types.ObjectId; unit: mongoose.Types.ObjectId;
  requiredYear: number; requiredSemester: number; isElective: boolean;
}

/** Existing unit for a code: program's department first, then its school, then anything in the institution. */
async function findUnitsByCode(institutionId: unknown, program: ProgramCtx, codes: string[]) {
  const units = await Unit.find({ institution: institutionId, code: { $in: codes } }).lean<UnitLean[]>();
  const rank = (u: UnitLean) => (u.departmentCode === program.departmentCode ? 0 : u.schoolCode === program.schoolCode ? 1 : 2);
  const byCode = new Map<string, UnitLean>();
  for (const u of units) {
    const cur = byCode.get(u.code);
    if (!cur || rank(u) < rank(cur)) byCode.set(u.code, u);
  }
  return byCode;
}

export async function planCurriculum(
  institutionId: unknown,
  program: ProgramCtx,
  parsed: { rows: ParsedRow[]; errors: RowError[] },
): Promise<CurriculumPlan> {
  const unitByCode = await findUnitsByCode(institutionId, program, parsed.rows.map((r) => r.code));
  const links = await ProgramUnit.find({ institution: institutionId, program: program._id }).lean<LinkLean[]>();
  const linkByUnit = new Map(links.map((l) => [l.unit.toString(), l]));

  const errors = [...parsed.errors];
  const rows: PlanRow[] = [];

  for (const r of parsed.rows) {
    const unit = unitByCode.get(r.code);
    if (!unit) {
      if (!r.name) { errors.push({ rowNum: r.rowNum, code: r.code, message: "New unit — a unit name is required." }); continue; }
      rows.push({ ...r, action: "create_unit_and_link" });
      continue;
    }
    const note = r.name && r.name.toLowerCase() !== unit.name.toLowerCase()
      ? `Existing unit name kept: "${unit.name}"` : undefined;
    const link = linkByUnit.get(unit._id.toString());
    if (!link) { rows.push({ ...r, action: "link", note }); continue; }
    const same = link.requiredYear === r.year && link.requiredSemester === r.semester && !!link.isElective === r.isElective;
    rows.push({
      ...r, note,
      action: same ? "unchanged" : "update",
      from: same ? undefined : { year: link.requiredYear, semester: link.requiredSemester, isElective: !!link.isElective },
    });
  }

  // Links the file does not mention
  const inFile = new Set(parsed.rows.map((r) => unitByCode.get(r.code)?._id.toString()).filter(Boolean) as string[]);
  const missingLinks = links.filter((l) => !inFile.has(l.unit.toString()));
  const missingUnits = missingLinks.length
    ? await Unit.find({ _id: { $in: missingLinks.map((l) => l.unit) } }).select("code name").lean<UnitLean[]>()
    : [];
  const mu = new Map(missingUnits.map((u) => [u._id.toString(), u]));
  const removable: CurriculumPlan["removable"] = [];
  for (const l of missingLinks) {
    const [m, d, f] = await Promise.all([
      Mark.countDocuments({ programUnit: l._id, institution: institutionId }),
      MarkDirect.countDocuments({ programUnit: l._id, institution: institutionId }),
      FinalGrade.countDocuments({ programUnit: l._id, institution: institutionId }),
    ]);
    const u = mu.get(l.unit.toString());
    removable.push({
      linkId: l._id.toString(), code: u?.code ?? "?", name: u?.name ?? "?",
      year: l.requiredYear, semester: l.requiredSemester, hasRecords: m + d + f > 0,
    });
  }

  const c = (a: PlanAction) => rows.filter((r) => r.action === a).length;
  return {
    rows, errors, removable,
    counts: {
      newUnits: c("create_unit_and_link"), newLinks: c("link") + c("create_unit_and_link"),
      updated: c("update"), unchanged: c("unchanged"), errors: errors.length, removable: removable.length,
    },
  };
}

export async function applyCurriculumPlan(
  institutionId: unknown,
  program: ProgramCtx,
  plan: CurriculumPlan,
  removeMissing: boolean,
) {
  const toCreate = plan.rows.filter((r) => r.action === "create_unit_and_link");
  const unitByCode = await findUnitsByCode(institutionId, program, plan.rows.map((r) => r.code));

  if (toCreate.length) {
    const created = await Unit.insertMany(
      toCreate.map((r) => ({
        institution: institutionId, code: r.code, name: r.name,
        departmentCode: program.departmentCode, schoolCode: program.schoolCode,
      })),
      { ordered: false },
    );
    for (const u of created) {
      unitByCode.set(u.code, { _id: u._id as mongoose.Types.ObjectId, code: u.code, name: u.name, departmentCode: u.departmentCode, schoolCode: u.schoolCode });
    }
  }

  const ops = plan.rows
    .filter((r) => r.action !== "unchanged")
    .map((r) => ({
      updateOne: {
        filter: { institution: institutionId, program: program._id, unit: unitByCode.get(r.code)!._id },
        update: {
          $set: { requiredYear: r.year, requiredSemester: r.semester, isElective: r.isElective },
          $setOnInsert: { institution: institutionId, program: program._id, unit: unitByCode.get(r.code)!._id },
        },
        upsert: true,
      },
    }));
  if (ops.length) await ProgramUnit.bulkWrite(ops);

  let removed = 0, keptBecauseRecords = 0;
  if (removeMissing) {
    const deletable = plan.removable.filter((r) => !r.hasRecords).map((r) => r.linkId);
    keptBecauseRecords = plan.removable.length - deletable.length;
    if (deletable.length) {
      const res = await ProgramUnit.deleteMany({ _id: { $in: deletable }, institution: institutionId, program: program._id });
      removed = res.deletedCount ?? 0;
    }
  }
  return { ...plan.counts, removed, keptBecauseRecords };
}

// ───────────────────────── template ─────────────────────────

export async function buildCurriculumTemplate(
  institutionId: unknown,
  program: ProgramCtx,
): Promise<Buffer> {
  const links = await ProgramUnit.find({ institution: institutionId, program: program._id })
    .populate("unit", "code name").lean<Array<LinkLean & { unit: { code: string; name: string } | null }>>();
  const existing = links
    .filter((l) => l.unit)
    .sort((a, b) => a.requiredYear - b.requiredYear || a.requiredSemester - b.requiredSemester || a.unit!.code.localeCompare(b.unit!.code));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Curriculum");
  ws.mergeCells("A1:E1"); ws.getCell("A1").value = `CURRICULUM — ${program.name.toUpperCase()} (${program.code})`;
  ws.getCell("A1").font = { bold: true, size: 13 };
  ws.mergeCells("A2:E2");
  ws.getCell("A2").value = existing.length
    ? "Prefilled with the current curriculum. Edit, add or reorder rows, then upload."
    : "One row per unit. Year = year of study; Semester = 1, 2 or 3; Type = Core or Elective.";
  ws.getCell("A2").font = { italic: true, color: { argb: "FF64748B" } };

  const header = ws.getRow(4);
  ["Unit Code", "Unit Name", "Year of Study", "Semester", "Type"].forEach((h, i) => {
    const c = header.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
    c.alignment = { horizontal: "center" };
  });
  ws.columns = [{ width: 16 }, { width: 52 }, { width: 14 }, { width: 12 }, { width: 12 }];

  const maxYear = Math.min(Math.max(program.durationYears || 5, 1), 6);
  const rowsToWrite = existing.length
    ? existing.map((l) => [l.unit!.code, l.unit!.name, l.requiredYear, l.requiredSemester, l.isElective ? "Elective" : "Core"])
    : [["EXAMPLE 101", "Example Unit Title (delete this row)", 1, 1, "Core"]];
  rowsToWrite.forEach((vals, i) => ws.getRow(5 + i).values = vals as ExcelJS.CellValue[]);

  const last = 5 + Math.max(rowsToWrite.length, 1) + 200; // room for additions
  for (let r = 5; r <= last; r++) {
    ws.getCell(`C${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`"${Array.from({ length: maxYear }, (_, i) => i + 1).join(",")}"`] };
    ws.getCell(`D${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"1,2,3"'] };
    ws.getCell(`E${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Core,Elective"'] };
  }
  ws.views = [{ state: "frozen", ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────── graduation audit ─────────────────────────

export type AuditStatus = "PASSED" | "SUPPLEMENTARY" | "RETAKE" | "SPECIAL" | "INCOMPLETE" | "NOT_TAKEN" | "EXEMPT";

export interface AuditUnit {
  linkId: string; code: string; name: string;
  year: number; semester: number; isElective: boolean;
  status: AuditStatus; mark?: number; grade?: string; academicYear?: string;
}
export interface GraduationAudit {
  student: { _id: string; regNo: string; name: string; status: string; entryType: string; currentYearOfStudy: number };
  program: { _id: string; code: string; name: string; durationYears: number };
  hasCurriculum: boolean;
  units: AuditUnit[];
  summary: {
    required: number; passed: number; exempt: number; outstanding: number; notTaken: number;
    electivesPassed: number; electivesTotal: number;
    eligibleToGraduate: boolean;
  };
}

const entryYear = (t: string) => (t === "Mid-Entry-Y2" ? 2 : t === "Mid-Entry-Y3" ? 3 : t === "Mid-Entry-Y4" ? 4 : 1);

export async function buildGraduationAudit(institutionId: unknown, studentId: string): Promise<GraduationAudit | null> {
  const student = await Student.findOne({ _id: studentId, institution: institutionId })
    .populate("program", "code name durationYears").lean<any>();
  if (!student) return null;
  const program = student.program;

  const links = await ProgramUnit.find({ institution: institutionId, program: program._id })
    .populate("unit", "code name").lean<Array<LinkLean & { unit: { code: string; name: string } | null }>>();
  const linkIds = links.map((l) => l._id);

  const [grades, directs, settings] = await Promise.all([
    FinalGrade.find({ student: student._id, programUnit: { $in: linkIds } })
      .populate("academicYear", "year").sort({ createdAt: 1 }).lean<any[]>(),
    MarkDirect.find({ student: student._id, programUnit: { $in: linkIds } })
      .populate("academicYear", "year").sort({ createdAt: 1 }).lean<any[]>(),
    loadInstitutionSettings(String(institutionId), String(program._id)),
  ]);
  const passMark = (settings as any)?.rules?.passMark ?? 40;

  // Best result per unit: a PASS beats everything; otherwise the latest record wins.
  const best = new Map<string, { status: AuditStatus; mark?: number; grade?: string; academicYear?: string }>();
  const consider = (key: string, cand: { status: AuditStatus; mark?: number; grade?: string; academicYear?: string }) => {
    const cur = best.get(key);
    if (cur?.status === "PASSED" && cand.status !== "PASSED") return;
    best.set(key, cand);
  };
  const gradeStatus = (s: string): AuditStatus =>
    s === "PASS" ? "PASSED" : s === "SUPPLEMENTARY" ? "SUPPLEMENTARY" : s === "RETAKE" ? "RETAKE" : s === "SPECIAL" ? "SPECIAL" : "INCOMPLETE";

  const graded = new Set<string>();
  for (const g of grades) {
    const key = g.programUnit.toString();
    graded.add(key);
    consider(key, { status: gradeStatus(g.status), mark: g.totalMark, grade: g.grade, academicYear: g.academicYear?.year });
  }
  for (const d of directs) {
    const key = d.programUnit.toString();
    if (graded.has(key)) continue; // final grade is authoritative
    const att = String(d.attempt ?? "");
    const status: AuditStatus =
      att === "special" ? "SPECIAL" : att === "supplementary" ? "SUPPLEMENTARY" : att === "re-take" ? "RETAKE"
      : d.agreedMark >= passMark ? "PASSED" : "SUPPLEMENTARY";
    consider(key, { status, mark: d.agreedMark, academicYear: d.academicYear?.year });
  }

  const startYear = entryYear(student.entryType ?? "Direct");
  const units: AuditUnit[] = links
    .filter((l) => l.unit && l.requiredYear <= (program.durationYears || 6))
    .map((l) => {
      const res = best.get(l._id.toString());
      const exempt = !l.isElective && l.requiredYear < startYear && !res; // mid-entry credit transfer
      return {
        linkId: l._id.toString(), code: l.unit!.code, name: l.unit!.name,
        year: l.requiredYear, semester: l.requiredSemester, isElective: !!l.isElective,
        status: exempt ? "EXEMPT" : res?.status ?? "NOT_TAKEN",
        mark: res?.mark, grade: res?.grade, academicYear: res?.academicYear,
      } as AuditUnit;
    })
    .sort((a, b) => a.year - b.year || a.semester - b.semester || a.code.localeCompare(b.code));

  const core = units.filter((u) => !u.isElective);
  const electives = units.filter((u) => u.isElective);
  const passed = core.filter((u) => u.status === "PASSED").length;
  const exempt = core.filter((u) => u.status === "EXEMPT").length;
  const outstanding = core.filter((u) => ["SUPPLEMENTARY", "RETAKE", "SPECIAL", "INCOMPLETE"].includes(u.status)).length;
  const notTaken = core.filter((u) => u.status === "NOT_TAKEN").length;

  return {
    student: { _id: String(student._id), regNo: student.regNo, name: student.name, status: student.status, entryType: student.entryType ?? "Direct", currentYearOfStudy: student.currentYearOfStudy },
    program: { _id: String(program._id), code: program.code, name: program.name, durationYears: program.durationYears },
    hasCurriculum: units.length > 0,
    units,
    summary: {
      required: core.length, passed, exempt, outstanding, notTaken,
      electivesPassed: electives.filter((u) => u.status === "PASSED").length, electivesTotal: electives.length,
      eligibleToGraduate: core.length > 0 && outstanding === 0 && notTaken === 0,
    },
  };
}