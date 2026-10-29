// serverside/src/utils/directTemplate.ts
import { lapTimer } from "./perfLog";
import * as ExcelJS from "exceljs";
import Program from "../models/Program";
import Unit from "../models/Unit";
import AcademicYear from "../models/AcademicYear";
import { semesterWord } from "./semesterLabels";
import ProgramUnit from "../models/ProgramUnit";
import InstitutionSettings from "../models/InstitutionSettings";
import config from "../config/config";
import mongoose from "mongoose";
import { MarkDistribution, resolveDistribution, encodeSheetMeta, META_CELL } from "./markDistribution";
import { buildRichRegNo, buildScoresheetStudentList, getExistingMarksForStudents, ScoresheetStudent } from "./scoresheetStudentList";
import { loadInstitutionSettings } from "./loadInstitutionSettings";

export const generateDirectScoresheetTemplate = async (
  programId:      mongoose.Types.ObjectId,
  unitId:         mongoose.Types.ObjectId,
  yearOfStudy:    number,
  semester:       number,
  academicYearId: mongoose.Types.ObjectId,
  logoBuffer:     any,
  distribution:   MarkDistribution | null = null,   // CA/exam split; null = unit default → 30/70
  extraRegNos:    string[] = [],                    // students outside the main class to add to the sheet
  unitType:       "theory" | "lab" | "workshop" = "theory",
  examMode:       "standard" | "mandatory_q1" = "standard",
): Promise<Buffer> => {
  const lap = lapTimer("direct scoresheet");
  const [program, unit, academicYear] = await Promise.all([
    Program.findById(programId).lean()           as Promise<any>,
    Unit.findById(unitId).lean()                 as Promise<any>,
    AcademicYear.findById(academicYearId).lean() as Promise<any>,
  ]);

  // const settings = await InstitutionSettings.findOne({ institution: program?.institution }).lean() as any;
  lap("program/unit/year");
  const settings = await loadInstitutionSettings(program?.institution);
  lap("settings");
  // if (!settings)     throw new Error("Institution settings not found.");
  if (!academicYear) throw new Error("Academic Year not found.");
  if (!unit)         throw new Error("Unit not found.");

  const programUnitDoc = await ProgramUnit.findOne({ program: programId, unit: unitId }).lean() as any;
  const passMark       = settings.passMark || 40;

  const universityName =
    settings.docMeta?.universityName ??
    settings.docMeta?.schoolName ??
    "University";

  const session: "ORDINARY" | "SUPPLEMENTARY" | "CLOSED" =
    academicYear.session === "SUPPLEMENTARY" ? "SUPPLEMENTARY" :
    academicYear.session === "CLOSED"        ? "CLOSED"        : "ORDINARY";

  lap("programUnit");
  const eligibleStudents: ScoresheetStudent[] = await buildScoresheetStudentList({
    programId, programUnitId: programUnitDoc?._id ?? unitId,
    unitId, yearOfStudy, academicYearId, session, passMark,
    extraRegNos, institutionId: program?.institution,
  });

  lap("student list");
  const dist = resolveDistribution(distribution, unit?.markDistribution, unitType);

  const studentIds = eligibleStudents.map((s) => s.studentId);
  const marksMap   = programUnitDoc
    ? await getExistingMarksForStudents(studentIds, programUnitDoc._id)
    : new Map<string, any>();

  lap("existing marks");
  const workbook   = new ExcelJS.Workbook();
  const sheet      = workbook.addWorksheet(`${unit.code}`.trim().substring(0, 31));
  const fontName   = "Book Antiqua";
  const greyFill:   ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
  const pinkFill:   ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFA6C9" } };
  const purpleFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC5A3FF" } };
  const thin: Partial<ExcelJS.Borders> = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
  const doubleBtm: Partial<ExcelJS.Borders> = { ...thin, bottom: { style: "double" } };

  const examLabel = session === "SUPPLEMENTARY" ? "SUPPLEMENTARY AND SPECIAL EXAMINATION" : "EXAMINATION";

  if (logoBuffer?.length > 0) {
    const logoId = workbook.addImage({ buffer: logoBuffer, extension: "png" });
    sheet.addImage(logoId, { tl: { col: 3, row: 0 }, ext: { width: 100, height: 80 } });
  }

  const cb = { alignment: { horizontal: "center" as const, vertical: "middle" as const }, font: { bold: true, name: fontName, underline: true } };
  const yrTxt  = ["FIRST","SECOND","THIRD","FOURTH","FIFTH"][yearOfStudy - 1] ?? `${yearOfStudy}TH`;
  const semTxt = semesterWord(semester);

  sheet.mergeCells("C6:G6"); sheet.getCell("C6").value = universityName.toUpperCase();
  sheet.getCell("C6").style = { ...cb, font: { ...cb.font, size: 12 } };
  sheet.mergeCells("C7:G7"); sheet.getCell("C7").value = `DEGREE: ${(program?.name || "").toUpperCase()}`; sheet.getCell("C7").style = cb;
  sheet.mergeCells("C8:G8"); sheet.getCell("C8").value = `${yrTxt} YEAR | ${semTxt} SEMESTER | ${academicYear.year} ACADEMIC YEAR`; sheet.getCell("C8").style = cb;
  sheet.mergeCells("C10:G10"); sheet.getCell("C10").value = `SCORESHEET FOR: ${unit.code.toUpperCase()} — ${examLabel}`; sheet.getCell("C10").style = { ...cb, font: { ...cb.font, size: 10 } };
  sheet.getCell("B12").value = "UNIT TITLE:"; sheet.getCell("C12").value = unit.name.toUpperCase();
  sheet.getCell("E12").value = "UNIT CODE:";  sheet.getCell("F12").value = unit.code;
  sheet.getRow(12).font = { name: fontName, bold: true, size: 9 };

  // Hidden metadata so the uploaded sheet carries its own distribution / unit type / exam mode
  sheet.getCell(META_CELL).value = encodeSheetMeta({ distribution: dist, unitType, examMode });
  sheet.getColumn("Z").hidden = true;

  ["A","B","C","D","J"].forEach((col) => sheet.mergeCells(`${col}15:${col}16`));

  const hRow = sheet.getRow(15); hRow.height = 47;
  ["S/N","REG. NO.","NAME",null,`CA TOTAL (/${dist.ca})`,`EXAM TOTAL (/${dist.exam})`,"INTERNAL (/100)","EXTERNAL (/100)","AGREED (/100)",null].forEach((h, i) => {
    const cell = hRow.getCell(i + 1);
    cell.value = h; cell.font = { bold: true, name: fontName, size: 9 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; cell.border = thin;
    if (i >= 3) cell.alignment.textRotation = 90;
  });

  const sRow = sheet.getRow(16);
  [null,null,null,"ATTEMPT",dist.ca,dist.exam,100,100,100,"GRADE"].forEach((v, i) => {
    const cell = sRow.getCell(i + 1);
    cell.value = v; cell.font = { bold: true, name: fontName, size: 8 };
    cell.alignment = { vertical: "middle", horizontal: "center" }; cell.border = doubleBtm;
    if (i >= 4 && i <= 8) cell.fill = greyFill;
    if (i === 3 || i === 9) cell.alignment.textRotation = 90;
  });

  const startRow  = 17;
  const endRow    = startRow + eligibleStudents.length + 15;
  const sortedScale = [...(settings.gradingScale || [])].sort((a: any, b: any) => a.min - b.min);

  for (let r = startRow; r <= endRow; r++) {
    const idx = r - startRow;
    const ss: ScoresheetStudent | undefined = eligibleStudents[idx];
    const row = sheet.getRow(r); row.height = 13;

    if (ss) {
      const prevMark = ss.prevMark ?? marksMap.get(ss.studentId);
      row.getCell(1).value = idx + 1;
      // row.getCell(2).value = ss.displayRegNo;   // qualifier appended
      row.getCell(2).value = buildRichRegNo(ss.regNo, ss.qualifierSuffix, "Times New Roman",10);
      row.getCell(3).value = ss.name.toUpperCase();
      row.getCell(4).value = ss.attemptLabel;
      row.getCell(3).font  = { name: fontName, size: 8 };
      const shouldPrePopulateCA = (ss.isSpecial || ss.isCarriedSpecial || ss.lockCA) &&
                               prevMark &&
                               (prevMark.caTotal30 ?? 0) > 0;
 
      if (shouldPrePopulateCA) {
        row.getCell(5).value = prevMark.caTotal30;
      }
    }

    const empty    = `ISBLANK(B${r})`;
    const caRef    = ss?.isSupp ? "0" : `E${r}`;
    row.getCell(7).value = { formula: `IF(${empty}, "", ROUND(${caRef} + F${r}, 0))` };

    // ENG.13f: supp capped at passMark
    const effective   = `IF(H${r}<>"", H${r}, G${r})`;
    const finalAgreed = `IF(OR(D${r}="A/S",D${r}="Supp"), MIN(${passMark}, ${effective}), ${effective})`;
    row.getCell(9).value = { formula: `IF(${empty}, "", ${finalAgreed})` };

    let gradeF = `"E"`;
    sortedScale.forEach((s: any) => { gradeF = `IF(I${r}>=${s.min}, "${s.grade}", ${gradeF})`; });
    row.getCell(10).value = { formula: `IF(${empty}, "", ${gradeF})` };

    for (let c = 1; c <= 10; c++) {
      const cell = row.getCell(c);
      cell.border = thin; cell.font = { name: fontName, size: 8 }; cell.alignment = { vertical: "middle" };
      // Reg no / name / attempt stay editable so students outside the class can be typed into spare rows
      if (c >= 2 && c <= 4) cell.protection = { locked: false };

      if (c === 5) {
        if (ss?.isSupp) {
          cell.fill       = greyFill;
          cell.protection = { locked: true };
          cell.value = 0;  // force to 0, never user-editable
        }
        // ENG.18c: Special/deferred-special students — CA pre-populated and locked
        else if (ss?.isSpecial || ss?.isCarriedSpecial || (ss?.lockCA && (ss.prevMark?.caTotal30 ?? 0) > 0)) {
          cell.fill       = greyFill;
          cell.protection = { locked: true };
          // Value already set above in the pre-population block
        }
        // Normal first sitting / retake / repeat — CA is editable
        else {
          cell.fill = pinkFill;
          cell.protection = { locked: false };
          cell.dataValidation = { type: "decimal", operator: "between", formulae: [0, dist.ca], allowBlank: true, showErrorMessage: true, errorTitle: "Invalid CA", error: `0–${dist.ca}`};
        }
      } else if (c === 6) {
        cell.fill = purpleFill; cell.protection = { locked: false };
        cell.dataValidation = { type: "decimal", operator: "between", formulae: [0, dist.exam], allowBlank: true, showErrorMessage: true, errorTitle: "Invalid Exam", error: `0–${dist.exam}` };
      } else if (c === 8) {
        cell.protection = { locked: false };
        cell.dataValidation = { type: "decimal", operator: "between", formulae: [0, 100], allowBlank: true };
      } else if (c >= 7) { cell.fill = greyFill; cell.protection = { locked: true }; }
    }
  }

  for (let r = 15; r <= endRow; r++) {
    for (let c = 1; c <= 10; c++) {
      const cell = sheet.getCell(r, c);
      cell.border = { ...cell.border, left: c === 1 ? { style: "thick" } : cell.border?.left, right: c === 9 ? { style: "thick" } : cell.border?.right, top: r === 15 ? { style: "thick" } : cell.border?.top, bottom: r === endRow ? { style: "thick" } : cell.border?.bottom };
    }
  }

  sheet.getColumn(1).width = 4; sheet.getColumn(2).width = 26; sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 8; sheet.getColumn(10).width = 6;
  [5,6,7,8,9].forEach((c) => (sheet.getColumn(c).width = 12));

  sheet.views = [{ state: "frozen", xSplit: 4, ySplit: 16 }];
  sheet.protect("1234", { selectLockedCells: true, selectUnlockedCells: true });

  lap("build sheet");
  const buf = await workbook.xlsx.writeBuffer();
  lap("write file"); lap.done();
  return Buffer.from(buf as ArrayBuffer);
};
