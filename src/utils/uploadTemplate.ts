
// serverside/src/utils/uploadTemplate.ts

import * as ExcelJS from "exceljs";
import Program from "../models/Program";
import Unit from "../models/Unit";
import AcademicYear from "../models/AcademicYear";
import { semesterWord } from "./semesterLabels";
import ProgramUnit from "../models/ProgramUnit";
import InstitutionSettings from "../models/InstitutionSettings";
import config from "../config/config";
import mongoose from "mongoose";
import {
  buildRichRegNo,
  buildScoresheetStudentList,
  getExistingMarksForStudents,
  ScoresheetStudent,
} from "./scoresheetStudentList";
import { loadInstitutionSettings } from "./loadInstitutionSettings";
import { MarkDistribution, resolveDistribution, unitWeights, encodeSheetMeta, META_CELL } from "./markDistribution";

export const generateFullScoresheetTemplate = async (
  programId:      mongoose.Types.ObjectId,
  unitId:         mongoose.Types.ObjectId,
  yearOfStudy:    number,
  semester:       number,
  academicYearId: mongoose.Types.ObjectId,
  logoBuffer:     any,
  examMode:       string = "standard",
  unitType:       "theory" | "lab" | "workshop" = "theory",
  distribution:   MarkDistribution | null = null,   // CA/exam split; null = unit default → 30/70 (workshop 40/60)
  extraRegNos:    string[] = [],                    // students outside the main class to add to the sheet
 ): Promise<Buffer> => {

  // ── Metadata ──────────────────────────────────────────────────────────────
  const [program, unit, academicYear] = await Promise.all([
    Program.findById(programId).lean()          as Promise<any>,
    Unit.findById(unitId).lean()                as Promise<any>,
    AcademicYear.findById(academicYearId).lean() as Promise<any>,
  ]);

  if (!academicYear) throw new Error(`Academic Year ${academicYearId} not found.`);

  // const settings = await InstitutionSettings.findOne({
  //   institution: program?.institution,
  // });
  // if (!settings) throw new Error("Institution settings missing.");

  const settings = await loadInstitutionSettings(program?.institution);
  const programUnit = await ProgramUnit.findOne({
    program: programId,
    unit:    unitId,
  }).lean() as any;

  const universityName = settings.docMeta?.universityName ?? 
                       settings.docMeta?.schoolName ?? 
                       "University";

  const session: "ORDINARY" | "SUPPLEMENTARY" | "CLOSED" =
    academicYear.session === "SUPPLEMENTARY" ? "SUPPLEMENTARY" :
    academicYear.session === "CLOSED"        ? "CLOSED"        : "ORDINARY";

  // ── Student pool — single authoritative source ────────────────────────────
  const eligibleStudents: ScoresheetStudent[] = await buildScoresheetStudentList({
    programId,
    programUnitId:  programUnit?._id ?? unitId,
    unitId,
    yearOfStudy,
    academicYearId,
    session,
    passMark: settings.passMark || 40,
    extraRegNos,
    institutionId: program?.institution,
  });

  // ── Pre-existing detailed marks for special CA pre-population ─────────────
  const studentIds = eligibleStudents.map(s => s.studentId);
  const marksMap   = programUnit
    ? await getExistingMarksForStudents(studentIds, programUnit._id)
    : new Map<string, any>();

  // ── Exam mode / unit type weights (ENG.10c) ───────────────────────────────
  const isMandatoryQ1 = examMode === "mandatory_q1";
  const q1Max         = isMandatoryQ1 ? 30 : 10;

  const dist    = resolveDistribution(distribution, unit?.markDistribution, unitType);
  const weights = unitWeights(unitType, dist);
  const caWeightTotal = dist.ca;
   const rawPaperMax   = 70;

  // ── Column headers ────────────────────────────────────────────────────────
  const headers = ["S/N", "REG. NO.", "NAME", "ATTEMPT", "CAT 1", "CAT 2", "CAT 3", "AVG CAT", "ASSGNT 1", "ASSGNT 2", "ASSGNT 3", "AVG ASSGNT", "PRACTICAL", `CA TOTAL (${caWeightTotal}%)`, `Q1 (/${q1Max})`, "Q2", "Q3", "Q4", "Q5", `EXAM (${weights.exam}%)`, "INTERNAL (/100)", "EXTERNAL (/100)", "AGREED (/100)", "GRADE"];

  const dynamicMaxScores = [
    null, null, null, null,
    unitType === "workshop" ? null : settings.cat1Max,
    unitType === "workshop" ? null : settings.cat2Max,
    unitType === "workshop" ? null : settings.cat3Max,
    null,
    unitType === "workshop" ? null : settings.assignmentMax,
    unitType === "workshop" ? null : settings.assignmentMax,
    unitType === "workshop" ? null : settings.assignmentMax,
    null,
    unitType === "theory"   ? null : settings.practicalMax,
    caWeightTotal, q1Max, 20, 20, 20, 20, weights.exam,
    100, 100, 100, null,
  ];

  // ── Workbook setup ────────────────────────────────────────────────────────
  const workbook = new ExcelJS.Workbook();
  const sheet    = workbook.addWorksheet(`${unit?.code || "SCORESHEET"}`.trim().substring(0, 31));

  const fontName   = "Book Antiqua";
  const fontSize   = 9;
  const greyFill   = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE0E0E0" } };
  const pinkColor  = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFA6C9" } };
  const purpleFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFC5A3FF" } };
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin" }, left: { style: "thin" },
    bottom: { style: "thin" }, right: { style: "thin" },
  };

  // ── Logo ──────────────────────────────────────────────────────────────────
  if (logoBuffer?.length > 0) {
    const logoId = workbook.addImage({ buffer: logoBuffer, extension: "png" });
    sheet.addImage(logoId, { tl: { col: 9, row: 0 }, ext: { width: 100, height: 80 } });
  }

  const centerBold = {
    alignment: { horizontal: "center" as const, vertical: "middle" as const },
    font: { bold: true, name: fontName, underline: true },
  };

  // ── Header rows ───────────────────────────────────────────────────────────
  sheet.mergeCells("E6:P6");
  sheet.getCell("E6").value = universityName.toUpperCase();

  // sheet.getCell("E6").value = config.instName.toUpperCase();
  sheet.getCell("E6").style = { ...centerBold, font: { ...centerBold.font, size: 12 } };

  sheet.mergeCells("D7:Q7");
  sheet.getCell("D7").value = `DEGREE: ${program?.name.toUpperCase() || ""}`;
  sheet.getCell("D7").style = centerBold;

  const semTxt = semesterWord(semester);
  const yrTxt  = ["FIRST","SECOND","THIRD","FOURTH","FIFTH"][yearOfStudy - 1] || `${yearOfStudy}TH`;

  sheet.mergeCells("D8:Q8");
  sheet.getCell("D8").value = `${yrTxt} YEAR ${semTxt} SEMESTER ${academicYear?.year || ""} ACADEMIC YEAR`;
  sheet.getCell("D8").style = centerBold;

  sheet.mergeCells("F10:O10");
  sheet.getCell("F10").value = `SCORESHEET FOR ${unit?.code || ""} (${unitType.toUpperCase()})`;
  sheet.getCell("F10").style = centerBold;

  sheet.mergeCells("E12:G12"); sheet.getCell("E12").value = "UNIT CODE:";
  sheet.mergeCells("H12:J12");
  const unitCodeCell = sheet.getCell("H12");
  unitCodeCell.value = unit?.code;
  unitCodeCell.style = {
    alignment: { horizontal: "center", vertical: "middle" },
    font: { bold: true, name: fontName, size: fontSize, underline: true },
  };
  sheet.mergeCells("L12:M12"); sheet.getCell("L12").value = "UNIT TITLE:";
  sheet.getCell("N12").value = unit?.name.toUpperCase();
  sheet.getRow(12).font = { name: fontName, bold: true, size: fontSize };

  // Hidden metadata: the sheet carries its own distribution / unit type / exam mode so the
  // upload never has to guess (read back by marksImporter).
  sheet.getCell(META_CELL).value = encodeSheetMeta({
    distribution: dist, unitType, examMode: isMandatoryQ1 ? "mandatory_q1" : "standard",
  });
  sheet.getColumn("Z").hidden = true;

  // ── Table group headers (row 14) ──────────────────────────────────────────
  sheet.mergeCells("A14:A15"); sheet.mergeCells("B14:B15");
  sheet.mergeCells("C14:C15"); sheet.mergeCells("D14:D15");

  const groupHeaderRow = sheet.getRow(14);
  groupHeaderRow.height = 25;
  sheet.mergeCells("E14:H14"); sheet.getCell("E14").value = "CONTINUOUS ASSESSMENT TESTS";
  sheet.mergeCells("I14:L14"); sheet.getCell("I14").value = "ASSIGNMENTS";
  sheet.mergeCells("O14:T14"); sheet.getCell("O14").value = "END OF SEMESTER EXAMINATION";

  const headerRow = sheet.getRow(15);
  headerRow.height = 47;
  headers.forEach((val, i) => { headerRow.getCell(i + 1).value = val; });

  const scoreRow = sheet.getRow(16);
  dynamicMaxScores.forEach((val, i) => { if (val !== null) scoreRow.getCell(i + 1).value = val; });

  [14, 15, 16].forEach(rowNum => {
    const row = sheet.getRow(rowNum);
    for (let c = 1; c <= 24; c++) {
      const cell = row.getCell(c);
      cell.font      = { name: fontName, bold: true, size: 8 };
      cell.border    = { ...thinBorder, bottom: rowNum === 16 ? { style: "double" } : thinBorder.bottom };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      if (rowNum === 14 && [5, 9, 15].includes(c)) cell.fill = greyFill;
      if ((rowNum === 15 && c >= 4) || (rowNum === 14 && c === 4)) cell.alignment.textRotation = 90;
      if (c <= 3) {
        if (rowNum === 14) cell.border = { ...cell.border, bottom: undefined };
        if (rowNum === 15) cell.border = { ...cell.border, top: undefined };
      }
      if (unitType === "workshop" && c >= 5 && c <= 12) cell.fill = greyFill;
      if (unitType === "theory"   && c === 13)           cell.fill = greyFill;
    }
  });

  // ── Data rows ─────────────────────────────────────────────────────────────
  const startRow = 17;
  const endRow   = startRow + Math.max(eligibleStudents.length + 5, 10);

  const passMark    = settings.passMark || 40;
  const sortedScale = [...(settings.gradingScale || [])].sort((a: any, b: any) => a.min - b.min);

  const applyValidation = (cellAddr: string, maxVal: number) => {
    sheet.getCell(cellAddr).dataValidation = {
      type: "decimal", operator: "between", allowBlank: true,
      formulae: [0, maxVal], showErrorMessage: true,
      errorTitle: "Invalid Score",
      error: `Value must be between 0 and ${maxVal}`,
    };
  };

  for (let r = startRow; r <= endRow; r++) {
    const idx = r - startRow;
    const ss: ScoresheetStudent | undefined = eligibleStudents[idx];
    const row = sheet.getRow(r);
    row.height = 13;
    row.font   = { name: fontName, size: fontSize };

    if (ss) {
      const prevMark = marksMap.get(ss.studentId);

      // ── Col B: displayRegNo (regNo + qualifier) ────────────────────────
      row.getCell(1).value = idx + 1;
      // row.getCell(2).value = ss.displayRegNo;   // ← qualifier appended
      row.getCell(2).value = buildRichRegNo(ss.regNo, ss.qualifierSuffix, "Times New Roman", 10);
      row.getCell(3).value = ss.name.toUpperCase();
      row.getCell(4).value = ss.attemptLabel;   // ← from buildScoresheetStudentList
      row.getCell(3).font  = { name: fontName, size: 8 };

      // ── Pre-populate special CA (ENG.18c) ─────────────────────────────
      
      if ((ss.isSpecial || ss.isCarriedSpecial) && prevMark) {
        // For isCarriedSpecial: prevMark is already set on ss.prevMark by
        // scoresheetStudentList_v3 — it is the FinalGrade/Mark from the prior year.
        // For detailed templates: raw CA scores live on the Mark document.
        // For direct templates: caTotal30 lives on MarkDirect/FinalGrade.
        const caSource = ss.prevMark ?? prevMark;
       
        // Try raw fields first (detailed Mark), then caTotal30 (direct MarkDirect)
        const cat1    = caSource.cat1Raw    ?? (caSource.caTotal30 > 0 ? caSource.caTotal30 / 2 : 0);
        const cat2    = caSource.cat2Raw    ?? 0;
        const cat3    = caSource.cat3Raw    ?? 0;
        const assgnt1 = caSource.assgnt1Raw ?? 0;
        const prac    = caSource.practicalRaw ?? 0;
       
        // Only pre-populate if there is actually CA data
        if ((caSource.caTotal30 ?? 0) > 0 || cat1 > 0) {
          row.getCell(5).value  = cat1;
          row.getCell(6).value  = cat2;
          row.getCell(7).value  = cat3;
          row.getCell(9).value  = assgnt1;
          row.getCell(13).value = prac;
          for (let c = 5; c <= 13; c++) {
            row.getCell(c).fill       = greyFill;
            row.getCell(c).protection = { locked: true };
          }
        }
      }
    }

    const isRowEmpty = `ISBLANK(B${r})`;

    // ── Formulas (identical to original, updated for new attempt labels) ──
    const catDivisor  = settings.cat1Max       || 1;
    const assDivisor  = settings.assignmentMax || 1;
    const pracDivisor = settings.practicalMax  || 1;

    const catFormula  = unitType === "workshop"
      ? "0"
      : `IFERROR((AVERAGE(E${r}:G${r})/${catDivisor})*${weights.tests}, 0)`;
    sheet.getCell(`H${r}`).value = { formula: `IF(${isRowEmpty}, "", ${catFormula})` };

    const assFormula  = unitType === "workshop"
      ? "0"
      : `IFERROR((AVERAGE(I${r}:K${r})/${assDivisor})*${weights.assignment}, 0)`;
    sheet.getCell(`L${r}`).value = { formula: `IF(${isRowEmpty}, "", ${assFormula})` };

    const pracNorm = `IFERROR((M${r}/${pracDivisor})*${weights.practical}, 0)`;

    // CA multiplier: 0 for supp (ENG.13f) — now checks "A/S" label
    // We check both the old "Supp" and the new "A/S" for backward compat
    const caMultiplier = `IF(OR(D${r}="A/S", D${r}="Supp", D${r}="A/CF"), 0, 1)`;
    sheet.getCell(`N${r}`).value = {
      formula: `IF(${isRowEmpty}, "", ROUND((H${r} + L${r} + ${pracNorm})*${caMultiplier}, 2))`,
    };

    const takeCount   = isMandatoryQ1 ? 2 : 3;
    const examFormula = `O${r} + IFERROR(LARGE(P${r}:S${r}, 1), 0) + IFERROR(LARGE(P${r}:S${r}, 2), 0)`
      + (takeCount === 3 ? ` + IFERROR(LARGE(P${r}:S${r}, 3), 0)` : "");
    const normalizedExam = `IFERROR(((${examFormula})/${rawPaperMax})*${weights.exam}, 0)`;
    sheet.getCell(`T${r}`).value = { formula: `IF(${isRowEmpty}, "", ROUND(${normalizedExam}, 2))` };

    sheet.getCell(`U${r}`).value = { formula: `IF(${isRowEmpty}, "", ROUND(N${r}+T${r}, 0))` };

    // Agreed mark: supp capped at passMark (ENG.13f) — checks "A/S" + "Supp"
    sheet.getCell(`W${r}`).value = {
      formula: `IF(${isRowEmpty}, "", IF(OR(D${r}="A/S", D${r}="Supp"), MIN(${passMark}, IF(V${r}<>"", V${r}, U${r})), IF(V${r}<>"", V${r}, U${r})))`,
    };

    // Grade nesting
    let gradeIfs = `"E"`;
    sortedScale.forEach((scale: any) => {
      gradeIfs = `IF(W${r}>=${scale.min}, "${scale.grade}", ${gradeIfs})`;
    });
    sheet.getCell(`X${r}`).value = { formula: `IF(${isRowEmpty}, "", ${gradeIfs})` };

    // ── Cell styling (unchanged from original) ────────────────────────────
    const attemptVal = ss?.attemptLabel || "";
    const isSupp     = ss?.isSupp    ?? false;
    const isSpecial  = ss?.isSpecial ?? false;

    for (let c = 1; c <= 24; c++) {
      const cell = row.getCell(c);
      cell.border    = thinBorder;
      cell.alignment = { vertical: "middle" };

      const isFormulaCol = [8, 12, 14, 20, 21, 23, 24].includes(c);
      const isCAInput    = c >= 5 && c <= 12;
      const isPracInput  = c === 13;

      if (ss && isSupp && (isCAInput || isPracInput)) {
        // Supp: lock all CA inputs (ENG.13f)
        cell.fill       = greyFill;
        cell.protection = { locked: true };
        if (!isFormulaCol) cell.value = 0;
      } else if (unitType === "theory" && isPracInput) {
        cell.fill       = greyFill;
        cell.protection = { locked: true };
      } else if (unitType === "workshop" && isCAInput) {
        cell.fill       = greyFill;
        cell.protection = { locked: true };
      } else if (isFormulaCol) {
        cell.fill       = greyFill;
        cell.protection = { locked: true };
      } else if (ss && (isSpecial || ss.isCarriedSpecial) && (isCAInput || isPracInput)) {
        // Special: CA locked to pre-existing value
        cell.fill       = greyFill;
        cell.protection = { locked: true };
      } else {
        cell.protection = { locked: false };
        if (isPracInput && (unitType === "workshop" || unitType === "lab")) {
          cell.fill = { type: "pattern", pattern: "none" };
        }
        if (c === 8  || c === 12)         cell.fill = pinkColor;
        if (c === 13)                      cell.fill = greyFill;
        if (c >= 14  && c <= 19)          cell.fill = purpleFill;

        // Validation
        if (c === 5)  applyValidation(`E${r}`, settings.cat1Max);
        if (c === 6)  applyValidation(`F${r}`, settings.cat2Max);
        if (c === 7  && settings.cat3Max > 0) applyValidation(`G${r}`, settings.cat3Max);
        if (c === 9  && settings.assignmentMax > 0) applyValidation(`I${r}`, settings.assignmentMax);
        if (c === 13 && settings.practicalMax > 0)  applyValidation(`M${r}`, settings.practicalMax);
        if (c === 15) applyValidation(`O${r}`, q1Max);
        if (c >= 16 && c <= 19) applyValidation(`${sheet.getColumn(c).letter}${r}`, 20);
      }
      if (c >= 15 && c <= 19) cell.fill = purpleFill;
    }
  }

  // ── Conditional formatting (unchanged) ────────────────────────────────────
  let activeColsExpr = "";
  if (unitType === "theory") {
    activeColsExpr = "OR(AND(COLUMN(E17)>=5,COLUMN(E17)<=12),AND(COLUMN(E17)>=15,COLUMN(E17)<=19))";
  } else if (unitType === "lab") {
    activeColsExpr = "OR(AND(COLUMN(E17)>=5,COLUMN(E17)<=13),AND(COLUMN(E17)>=15,COLUMN(E17)<=19))";
  } else {
    activeColsExpr = "OR(COLUMN(E17)=13,AND(COLUMN(E17)>=15,COLUMN(E17)<=19))";
  }
  sheet.addConditionalFormatting({
    ref: `E17:S${endRow}`,
    rules: [{
      priority: 1,
      type: "expression",
      formulae: [`AND(NOT(ISBLANK($B17)), ISBLANK(E17), ${activeColsExpr})`],
      style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFA6C9" } } },
    }],
  });

  // ── Thick outer borders ───────────────────────────────────────────────────
  for (let r = 14; r <= endRow; r++) {
    for (let c = 1; c <= 24; c++) {
      const cell = sheet.getCell(r, c);
      cell.border = {
        ...cell.border,
        left:   c === 1      ? { style: "thick" } : cell.border?.left,
        right:  c === 23     ? { style: "thick" } : cell.border?.right,
        top:    r === 14     ? { style: "thick" } : cell.border?.top,
        bottom: r === endRow ? { style: "thick" } : cell.border?.bottom,
      };
    }
  }

  // ── Column widths ─────────────────────────────────────────────────────────
  sheet.getColumn("A").width = 4;
  sheet.getColumn("B").width = 26;   // wider for qualifier suffix
  sheet.getColumn("C").width = 35;
  sheet.getColumn("D").width = 8;    // wider for "A/SO", "RP1C" etc.
  sheet.getColumn("N").width = 9;
  ["L","M"].forEach(col => (sheet.getColumn(col).width = 8));
  ["T","U","V","W"].forEach(col => (sheet.getColumn(col).width = 7.8));
  ["E","F","G","H","I","J","K","O","P","Q","R","S"].forEach(col =>
    (sheet.getColumn(col).width = 4.5),
  );

  sheet.protect("1234", { selectLockedCells: true, selectUnlockedCells: true });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
};













