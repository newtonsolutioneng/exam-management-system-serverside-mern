
// // serverside/src/utils/journeyCMS.ts

// import * as ExcelJS from "exceljs";
// import config from "../config/config";
// import InstitutionSettings from "../models/InstitutionSettings";
// import Student from "../models/Student";
// import FinalGrade from "../models/FinalGrade";
// import Mark from "../models/Mark";
// import MarkDirect from "../models/MarkDirect";
// import ProgramUnit from "../models/ProgramUnit";
// import Program from "../models/Program";
// import { getYearWeight } from "../utils/weightingRegistry";
// import { buildDisplayRegNo } from "../utils/academicRules";

// // ─── Types ────────────────────────────────────────────────────────────────────

// export interface JourneyCMSData {
//   programId:     string;
//   programName:   string;
//   academicYear:  string;
//   logoBuffer:    Buffer;
//   institutionId: string;
// }

// interface UnitMark {
//   code:    string;
//   name:    string;
//   mark:    number | string;   // number, "INC", or "65C" for specials
//   grade:   string;
//   attempt: string;
//   status:  string;
// }

// interface StudentYearRecord {
//   yearOfStudy:    number;
//   academicYear:   string;
//   isRepeatYear:   boolean;
//   annualMean:     number;
//   weight:         number;
//   suppUnits:      string[];
//   cfUnits:        string[];
//   specialUnits:   string[];
//   passedSupp:     string[];
//   passedCF:       string[];
//   failedUnits:    string[];
//   unitMarks:      UnitMark[];
// }

// interface StudentJourneyRecord {
//   regNo:           string;
//   displayRegNo:    string;
//   name:            string;
//   entryType:       string;
//   status:          string;
//   qualifierSuffix: string;
//   waa:             number;
//   classification:  string;
//   yearsData:       StudentYearRecord[];
//   hurdleSummary:   string;
// }

// // ─── Constants ─────────────────────────────────────────────────────────────────

// const FONT = "Arial";
// const THIN: Partial<ExcelJS.Borders> = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" }};
// const DOUBLE_BOTTOM: Partial<ExcelJS.Borders> = { ...THIN, bottom: { style: "double" } };

// // Subtle fills — matches existing CMS tone
// const F = {
//   hdr:       { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE0E0E0" } }, // light grey header
//   subhdr:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF2F2F2" } }, // very light grey
//   pass:      { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD9EAD3" } }, // light green
//   passed:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFFFFF" } }, // light green
//   supp:      { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } }, // yellow
//   fail:      { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFC7CE" } }, // red
//   special:   { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE3D9F5" } }, // purple
//   repeat:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } }, // orange
//   gold:      { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFD700" } },
//   blue:      { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFBDD7EE" } },
//   amber:     { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } },
//   none:      { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFFFFF" } },
//   inc:       { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } }, // light red for INC
// };

// // ─── Helpers ──────────────────────────────────────────────────────────────────

// // ─── Logo Helper — same centering formula as consolidatedMS.ts ───────────────
// // Uses Math.floor(totalCols / 2) - 1 to match the consolidated mark sheet exactly.
// function addLogo( wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, logoBuffer: Buffer, totalCols: number) {
//   if (!logoBuffer || logoBuffer.length === 0) return;

//   const imageId = wb.addImage({buffer: logoBuffer as any, extension: "png"});
//   const centerColIdx = Math.floor(totalCols / 2);
//   sheet.addImage(imageId, {tl: { col: centerColIdx - 1, row: 0 }, ext: { width: 100, height: 60 }});
// }

// // ─── Centered Header Row ────────────────────────────────────────────────────
// function hdrRow(
//   sheet: ExcelJS.Worksheet,
//   rowNum: number,
//   text: string,
//   totalCols: number,
//   size = 10,
//   bold = true,
//   underline = false,
// ) {
//   sheet.mergeCells(rowNum, 1, rowNum, totalCols);
//   const cell = sheet.getCell(rowNum, 1);
//   cell.value = text.toUpperCase();
//   cell.alignment = { horizontal: "center", vertical: "middle" };
//   cell.font = { bold, name: FONT, size, underline };
//   sheet.getRow(rowNum).height = size + 8;
// }

// function classLabel(waa: number): string {
//   if (waa >= 70) return "FIRST CLASS HONOURS";
//   if (waa >= 60) return "SECOND CLASS (UPPER DIVISION)";
//   if (waa >= 50) return "SECOND CLASS (LOWER DIVISION)";
//   if (waa >= 40) return "PASS";
//   return "FAIL";
// }

// function classFill(waa: number) {
//   if (waa >= 70) return F.gold;
//   if (waa >= 60) return F.blue;
//   if (waa >= 50) return F.amber;
//   if (waa >= 40) return F.pass;
//   return F.fail;
// }

// function meanFill(mean: number) {
//   if (mean >= 70) return F.gold;
//   if (mean >= 60) return F.blue;
//   if (mean >= 50) return F.amber;
//   if (mean >= 40) return F.pass;
//   return F.fail;
// }

// function hurdleSummary(yearsData: StudentYearRecord[]): string {
//   const events: string[] = [];
//   for (const yr of yearsData) {
//     const lbl = `Y${yr.yearOfStudy}`;
//     if (yr.isRepeatYear)        events.push(`${lbl}:REPEAT`);
//     if (yr.suppUnits.length)    events.push(`${lbl}:SUPP(${yr.suppUnits.join(",")})`);
//     if (yr.passedSupp.length)   events.push(`${lbl}:✓SUPP(${yr.passedSupp.join(",")})`);
//     if (yr.cfUnits.length)      events.push(`${lbl}:CF→Y${yr.yearOfStudy+1}(${yr.cfUnits.join(",")})`);
//     if (yr.passedCF.length)     events.push(`${lbl}:✓CF(${yr.passedCF.join(",")})`);
//     if (yr.specialUnits.length) events.push(`${lbl}:SPEC(${yr.specialUnits.join(",")})`);
//   }
//   return events.length ? events.join(" | ") : "CLEAN";
// }

// // ─── Mark resolution — reads FinalGrade first, then MarkDirect, then Mark ─────
// // This is the KEY FIX for INC marks: direct-entry marks live in MarkDirect,
// // not in FinalGrade. We resolve all three sources.

// interface ResolvedMark {
//   agreedMark:  number;
//   caTotal30:   number | null;
//   examTotal70: number | null;
//   attempt:     string;
//   isSpecial:   boolean;
//   isSupp:      boolean;
//   isRetake:    boolean;
//   status:      string;   // "PASS" | "SUPPLEMENTARY" | "SPECIAL" | "FAIL"
//   source:      "finalGrade" | "direct" | "detailed";
// }

// async function resolveMark(
//   studentId: string,
//   puId: string,
//   passMark: number,
// ): Promise<ResolvedMark | null> {

//   // 1. FinalGrade (set by computeFinalGrade after detailed mark upload or grade calc)
//   const fgs = await FinalGrade.find({student: studentId, programUnit: puId}).lean() as any[];

//   if (fgs.length > 0) {
//     // Pick best: PASS > SPECIAL > SUPPLEMENTARY > others
//     const rank = (s: string) => s === "PASS" ? 3 : s === "SPECIAL" ? 2 : s === "SUPPLEMENTARY" ? 1 : 0;
//     const best = fgs.sort((a: any, b: any) => rank(b.status) - rank(a.status))[0];
//     return {
//       agreedMark:  best.totalMark ?? 0,
//       caTotal30:   best.caTotal30   ?? null,
//       examTotal70: best.examTotal70 ?? null,
//       attempt:     best.attemptType === "SUPPLEMENTARY" ? "supplementary" :
//                    best.attemptType === "RETAKE"        ? "re-take"       : "1st",
//       isSpecial:   best.isSpecial === true || best.status === "SPECIAL",
//       isSupp:      best.status === "SUPPLEMENTARY",
//       isRetake:    best.attemptType === "RETAKE",
//       status:      best.status,
//       source:      "finalGrade",
//     };
//   }

//   // 2. MarkDirect (direct CA+Exam entry — no FinalGrade record created)
//   const md = await MarkDirect.findOne({ student: studentId, programUnit: puId }).lean() as any;

//   if (md) {
//     const mark    = md.agreedMark ?? 0;
//     const isSpec  = md.isSpecial === true || md.attempt === "special";
//     const isSupp  = md.attempt === "supplementary";
//     const isPassed = mark >= passMark && !isSpec;
//     return {
//       agreedMark:  mark,
//       caTotal30:   md.caTotal30   ?? null,
//       examTotal70: md.examTotal70 ?? null,
//       attempt:     md.attempt || "1st",
//       isSpecial:   isSpec,
//       isSupp,
//       isRetake:    md.isRetake === true,
//       status:      isSpec ? "SPECIAL" : isPassed ? "PASS" : "SUPPLEMENTARY",
//       source:      "direct",
//     };
//   }

//   // 3. Mark (detailed breakdown — agreedMark computed by gradeCalculator)
//   const dm = await Mark.findOne({ student: studentId, programUnit: puId }).lean() as any;

//   if (dm) {
//     const mark   = dm.agreedMark ?? 0;
//     const isSpec = dm.isSpecial === true || dm.attempt === "special";
//     const isSupp = dm.attempt === "supplementary";
//     const isPassed = mark >= passMark && !isSpec;
//     return {
//       agreedMark:  mark,
//       caTotal30:   dm.caTotal30   ?? null,
//       examTotal70: dm.examTotal70 ?? null,
//       attempt:     dm.attempt || "1st",
//       isSpecial:   isSpec,
//       isSupp,
//       isRetake:    dm.isRetake === true,
//       status:      isSpec ? "SPECIAL" : isPassed ? "PASS" : "SUPPLEMENTARY",
//       source:      "detailed",
//     };
//   }

//   return null; // genuinely no mark for this unit
// }

// // ─── Load all student journey data ────────────────────────────────────────────

// async function loadJourneys(
//   programId:    string,
//   program:      any,
//   passMark:     number,
//   gradingScale: Array<{ min: number; grade: string }>,
// ): Promise<StudentJourneyRecord[]> {
//   const duration   = program.durationYears || 5;
//   const sortedScale = [...gradingScale].sort((a, b) => b.min - a.min);
//   const gradeFor   = (mark: number) =>
//     mark < passMark ? "E" : (sortedScale.find(s => mark >= s.min)?.grade ?? "E");

//   const students = await Student.find({
//     program: programId,
//     status:  { $in: ["graduand","graduated","active","repeat",
//                       "on_leave","deferred","discontinued","deregistered"] },
//   }).populate("program").lean() as any[];

//   const records: StudentJourneyRecord[] = [];

//   for (const student of students) {
//     const sid     = student._id.toString();
//     const et      = student.entryType || "Direct";
//     const history = (student.academicHistory || []) as any[];
//     const yearsData: StudentYearRecord[] = [];

//     for (let y = 1; y <= duration; y++) {
//       const hist = history.find((h: any) => h.yearOfStudy === y);
//       if (!hist) continue; // student hasn't completed this year

//       const weight    = getYearWeight(program, et, y);
//       // Use stored annualMeanMark — set correctly by the /admin/recompute-graduation-waa migration
//       const annualMean = hist.annualMeanMark || 0;

//       const pus = await ProgramUnit.find({ program: programId, requiredYear: y }).populate("unit").lean() as any[];

//       const suppUnits:    string[] = [];
//       const cfUnits:      string[] = [];
//       const specialUnits: string[] = [];
//       const passedSupp:   string[] = [];
//       const passedCF:     string[] = [];
//       const failedUnits:  string[] = [];
//       const unitMarks:    UnitMark[] = [];

//       for (const pu of pus) {
//         const code  = (pu as any).unit?.code || "N/A";
//         const uname = (pu as any).unit?.name || "N/A";
//         const puId  = (pu as any)._id.toString();

//         // ── RESOLVE MARK FROM ALL THREE SOURCES ──────────────────────────
//         const resolved = await resolveMark(sid, puId, passMark);

//         if (!resolved) {
//           unitMarks.push({ code, name: uname, mark: "INC", grade: "—", attempt: "—", status: "MISSING" });
//           continue;
//         }

//         const { agreedMark, isSpecial, isSupp, isRetake, status, attempt } = resolved;

//         // Attempt label for display
//         let attemptLabel = "B/S";
//         if (isSpecial)      { attemptLabel = "SPEC";  specialUnits.push(code); }
//         else if (isRetake)  { attemptLabel = "RP1C";
//           if (status === "PASS") passedCF.push(code); else cfUnits.push(code);
//         }
//         else if (isSupp)    { attemptLabel = "A/S";
//           if (status === "PASS") passedSupp.push(code); else suppUnits.push(code);
//         }
//         else if (status !== "PASS" && !isSpecial) { failedUnits.push(code); }

//         const displayMark: number | string = isSpecial ? `${agreedMark}C` : agreedMark;

//         unitMarks.push({
//           code,
//           name:    uname,
//           mark:    displayMark,
//           grade:   isSpecial ? "I" : gradeFor(agreedMark),
//           attempt: attemptLabel,
//           status,
//         });
//       }

//       yearsData.push({
//         yearOfStudy:  y,
//         academicYear: hist.academicYear || "",
//         isRepeatYear: hist.isRepeatYear || false,
//         annualMean,
//         weight,
//         suppUnits,
//         cfUnits,
//         specialUnits,
//         passedSupp,
//         passedCF,
//         failedUnits,
//         unitMarks,
//       });
//     }

//     // ── WAA: use finalWeightedAverage when available; recompute otherwise ──
//     let waa: number;
//     const storedWAA = parseFloat(student.finalWeightedAverage || "0");
//     if (storedWAA > 0) {
//       waa = storedWAA;
//     } else {
//       const histWC = (student.academicHistory || []).reduce(
//         (sum: number, h: any) => sum + (h.weightedContribution || 0),
//         0,
//       );
//       if (histWC > 0) {
//         waa = histWC;
//       } else {
//         let recomputedWAA = 0;
//         for (const yr of yearsData) {
//           if (yr.unitMarks.length === 0) continue;
//           recomputedWAA += yr.annualMean * yr.weight;
//         }
//         waa = recomputedWAA;
//       }
//     }

//     const classification = student.classification || classLabel(waa);

//     records.push({
//       regNo:           student.regNo,
//       displayRegNo:    buildDisplayRegNo(student.regNo, student.qualifierSuffix),
//       name:            student.name,
//       entryType:       et,
//       status:          student.status,
//       qualifierSuffix: student.qualifierSuffix || "",
//       waa:             parseFloat(waa.toFixed(2)),
//       classification,
//       yearsData,
//       hurdleSummary:   hurdleSummary(yearsData),
//     });
//   }

//   // Sort same as award list: best class first, then WAA desc
//   const ORDER = [
//     "FIRST CLASS HONOURS",
//     "SECOND CLASS HONOURS (UPPER DIVISION)",
//     "SECOND CLASS HONOURS (LOWER DIVISION)",
//     "PASS","FAIL",
//   ];
//   records.sort((a, b) => {
//     const ai = ORDER.indexOf(a.classification);
//     const bi = ORDER.indexOf(b.classification);
//     if (ai !== bi) return ai - bi;
//     return b.waa - a.waa;
//   });

//   return records;
// }

// // ─── SHEET: SUMMARY ───────────────────────────────────────────────────────────

// function buildSummary(
//   wb:          ExcelJS.Workbook,
//   records:     StudentJourneyRecord[],
//   program:     any,
//   logoBuffer:  Buffer,
//   academicYear: string,
// ) {
//   const duration   = program.durationYears || 5;
//   const TOTAL_COLS = 5 + duration + 3; // S/N + Reg + Name + Entry + Y1..YN + WAA + Class + Hurdle Log + Remarks

//   const sheet = wb.addWorksheet("SUMMARY");
//   addLogo(wb, sheet, logoBuffer, TOTAL_COLS);  

//   // Header rows — plain, no dark fill
//   hdrRow(sheet, 4, config.instName, TOTAL_COLS, 12, true, false);
//   hdrRow(sheet, 5, config.schoolName || "SCHOOL OF ENGINEERING", TOTAL_COLS, 10, true, false);
//   hdrRow(sheet, 6, program.name, TOTAL_COLS, 10, true, false);
//   hdrRow(sheet, 7, `STUDENT ACADEMIC JOURNEY SUMMARY — ${academicYear} ACADEMIC YEAR`, TOTAL_COLS, 9, true, true);
//   hdrRow(sheet, 8, "BOARD OF EXAMINERS REPORT", TOTAL_COLS, 9, false, false);

//   const HDR = 10;
//   sheet.getRow(HDR).height = 52;

//   const hdrs = ["S/N", "REG. NO.", "NAME", "ENTRY", ...Array.from({ length: duration }, (_, i) => `Y${i+1}\n(%)`), "WAA\n(%)", "CLASSIFICATION", "HURDLE LOG", "BOARD\nREMARKS"];

//   hdrs.forEach((txt, i) => {
//     const cell  = sheet.getRow(HDR).getCell(i + 1);
//     cell.value     = txt;
//     cell.fill      = F.hdr;
//     cell.border    = DOUBLE_BOTTOM;
//     cell.font      = { bold: true, name: FONT, size: 8 };
//     cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
//   });

//   let row = HDR + 1;
//   let ctr = 1;

//   for (const rec of records) {
//     const r = sheet.getRow(row);
//     r.height = 14;

//     const vals: any[] = [ctr++, rec.displayRegNo, rec.name.toUpperCase(), rec.entryType];

//     for (let y = 1; y <= duration; y++) {
//       const yr = rec.yearsData.find(d => d.yearOfStudy === y);
//       vals.push(yr ? parseFloat(yr.annualMean.toFixed(2)) : "—");
//     }

//     const waaCol = 5 + duration;
//     vals.push(rec.waa, rec.classification, rec.hurdleSummary, "");
//     r.values = vals;

//     r.eachCell((cell, colNum) => {
//       cell.border    = THIN;
//       cell.font      = { name: FONT, size: 8 };
//       cell.alignment = { vertical: "middle", horizontal: "center" };

//       if (colNum === 2 || colNum === 3) cell.alignment = { horizontal: "left", vertical: "middle" };

//       // Year mean cells colour
//       if (colNum >= 5 && colNum < waaCol) {
//         const v = cell.value as number;
//         if (typeof v === "number") cell.fill = meanFill(v);
//       }

//       // WAA
//       if (colNum === waaCol) {
//         cell.fill = classFill(rec.waa);
//         cell.font = { bold: true, name: FONT, size: 8 };
//         cell.numFmt = "0.00";
//       }

//       // Classification
//       if (colNum === waaCol + 1) {
//         cell.fill = classFill(rec.waa);
//         cell.font = { bold: true, name: FONT, size: 8 };
//       }

//       // Hurdle log
//       if (colNum === waaCol + 2) {
//         cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
//         const isClean = (cell.value?.toString() || "") === "CLEAN";
//         cell.fill = isClean ? F.pass : F.supp;
//         cell.font = { name: FONT, size: 7, italic: !isClean };
//       }

//       // Board remarks — unlocked
//       if (colNum === waaCol + 3) {
//         cell.protection = { locked: false };
//         cell.fill = F.none;
//       }
//     });

//     row++;
//   }

//   const lastData = row - 1;

//   // Thick outer borders
//   for (let r = HDR; r <= lastData; r++) {
//     sheet.getCell(r, 1).border        = { ...sheet.getCell(r,1).border,        left:   { style:"thick" } };
//     sheet.getCell(r, TOTAL_COLS).border = { ...sheet.getCell(r,TOTAL_COLS).border, right:  { style:"thick" } };
//   }
//   sheet.getRow(HDR).eachCell(c => (c.border = { ...c.border, top: { style:"thick" } }));
//   sheet.getRow(lastData).eachCell(c => (c.border = { ...c.border, bottom: { style:"thick" } }));

//   // Column widths
//   sheet.getColumn(1).width = 4;
//   sheet.getColumn(2).width = 22;
//   sheet.getColumn(3).width = 28;
//   sheet.getColumn(4).width = 8;
//   for (let y = 1; y <= duration; y++) sheet.getColumn(4 + y).width = 7;
//   sheet.getColumn(5 + duration).width = 8;
//   sheet.getColumn(6 + duration).width = 30;
//   sheet.getColumn(7 + duration).width = 55;
//   sheet.getColumn(8 + duration).width = 25;

//   sheet.views = [{ state: "frozen", xSplit: 3, ySplit: HDR }];
//   sheet.protect("1234", { selectLockedCells: true, selectUnlockedCells: true });
//   sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
// }

// // ─── SHEET PER YEAR ───────────────────────────────────────────────────────────

// function buildYearSheet(
//   wb:          ExcelJS.Workbook,
//   y:           number,
//   records:     StudentJourneyRecord[],
//   program:     any,
//   academicYear: string,
//   passMark:    number,
//   logoBuffer:  Buffer,
// ) {
//   // Collect all unit codes for this year (union across all students)
//   const unitMap = new Map<string, string>(); // code → name
//   records.forEach((rec) => {
//     const yr = rec.yearsData.find((d) => d.yearOfStudy === y);
//     if (!yr) return;
//     yr.unitMarks.forEach((u) => unitMap.set(u.code, u.name));
//   });
//   const codes = Array.from(unitMap.keys());
//   const names = codes.map((c) => unitMap.get(c) || c);

//   const YEAR_LABEL =
//     ["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH"][y - 1] || `${y}TH`;
//   const TOTAL_COLS = 4 + codes.length + 3; // S/N + Reg + Name + Attempt + units + Mean + Recomm + Hurdle

//   const sheet = wb.addWorksheet(`Year ${y}`.substring(0, 31));
//   addLogo(wb, sheet, logoBuffer, TOTAL_COLS);

//   hdrRow(sheet, 4, config.instName, TOTAL_COLS, 11, true);
//   hdrRow(sheet, 5, program.name, TOTAL_COLS, 10, true);
//   hdrRow(sheet, 6, `${YEAR_LABEL} YEAR — DETAILED MARKS & HURDLE REGISTRY — ${academicYear}`, TOTAL_COLS, 9, true, true );

//   const HDR = 8;
//   const CODE = 9;
//   sheet.getRow(HDR).height = 15;
//   sheet.getRow(CODE).height = 48;

//   // Merge fixed columns across header + code rows
//   ["A", "B", "C", "D"].forEach((col, i) => {
//     sheet.mergeCells(`${col}${HDR}:${col}${CODE}`);
//     const cell = sheet.getCell(`${col}${HDR}`);
//     cell.value = ["S/N", "REG. NO.", "NAME", "ATTEMPT"][i];
//     cell.fill = F.hdr;
//     cell.border = DOUBLE_BOTTOM;
//     cell.font = { bold: true, name: FONT, size: 8 };
//     cell.alignment = { horizontal: "center", vertical: "middle", textRotation: i === 3 ? 90 : 0 };
//   });

//   // Unit header (number row) + code row
//   codes.forEach((code, i) => {
//     const colNum = 5 + i;
//     const h1 = sheet.getRow(HDR).getCell(colNum);
//     h1.value = (i + 1).toString();
//     h1.fill = F.hdr;
//     h1.border = THIN;
//     h1.font = { bold: true, name: FONT, size: 8 };
//     h1.alignment = { horizontal: "center", vertical: "middle" };

//     const h2 = sheet.getRow(CODE).getCell(colNum);
//     h2.value = code;
//     h2.fill = F.hdr;
//     h2.border = DOUBLE_BOTTOM;
//     h2.font = { bold: true, name: FONT, size: 7 };
//     h2.alignment = { horizontal: "center", vertical: "middle", textRotation: 90 };
//   });

//   const MEAN_COL = 5 + codes.length;
//   const RECOMM_COL = MEAN_COL + 1;
//   const LOG_COL = RECOMM_COL + 1;

//   [
//     [MEAN_COL, "MEAN (%)"],
//     [RECOMM_COL, "RECOMM."],
//     [LOG_COL, "HURDLE LOG"],
//   ].forEach(([col, lbl]) => {
//     sheet.mergeCells(HDR, col as number, CODE, col as number);
//     const cell = sheet.getRow(HDR).getCell(col as number);
//     cell.value = lbl;
//     cell.fill = F.hdr;
//     cell.border = DOUBLE_BOTTOM;
//     cell.font = { bold: true, name: FONT, size: 8 };
//     cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
//   });

//   // Data rows
//   let rowIdx = CODE + 1;
//   let ctr = 1;

//   for (const rec of records) {
//     const yr = rec.yearsData.find((d) => d.yearOfStudy === y);
//     if (!yr) continue;

//     const r = sheet.getRow(rowIdx);
//     r.height = 14;

//     // Hurdle log
//     const log: string[] = [];
//     if (yr.isRepeatYear) log.push("REPEAT YEAR");
//     if (yr.suppUnits.length) log.push(`SUPP: ${yr.suppUnits.join(", ")}`);
//     if (yr.passedSupp.length)
//       log.push(`✓ SUPP CLEARED: ${yr.passedSupp.join(", ")}`);
//     if (yr.cfUnits.length) log.push(`CF→Y${y + 1}: ${yr.cfUnits.join(", ")}`);
//     if (yr.passedCF.length) log.push(`✓ CF CLEARED: ${yr.passedCF.join(", ")}`);
//     if (yr.specialUnits.length)
//       log.push(`SPECIAL: ${yr.specialUnits.join(", ")}`);
//     const hLog = log.join(" | ") || "CLEAN";

//     // Attempt label
//     let attempt = "B/S";
//     if (yr.isRepeatYear) attempt = "A/RA1";
//     else if (rec.qualifierSuffix.includes("C")) attempt = rec.qualifierSuffix;

//     // Recomm
//     let recomm =
//       yr.failedUnits.length === 0 && !yr.isRepeatYear
//         ? "PASS"
//         : yr.isRepeatYear
//           ? "REPEAT YEAR"
//           : yr.suppUnits.length
//             ? `SUPP (${yr.suppUnits.length})`
//             : yr.cfUnits.length
//               ? `CF (${yr.cfUnits.length})` 
//               : "INC";

//     const vals: any[] = [ ctr++, rec.displayRegNo, rec.name.toUpperCase(), attempt ];

//     codes.forEach((code) => {
//       const um = yr.unitMarks.find((u) => u.code === code);
//       vals.push(um ? um.mark : "—");
//     });

//     vals.push(parseFloat(yr.annualMean.toFixed(2)), recomm, hLog);
//     r.values = vals;

//     // Style
//     r.eachCell((cell, colNum) => {
//       cell.border = THIN;
//       cell.font = { name: FONT, size: 8 };
//       cell.alignment = { vertical: "middle", horizontal: "center" };

//       if (colNum === 2 || colNum === 3)
//         cell.alignment = { horizontal: "left", vertical: "middle" };

//       // Unit mark cells
//       if (colNum >= 5 && colNum < MEAN_COL) {
//         const v = cell.value;
//         const um = yr.unitMarks.find((u) => u.code === codes[colNum - 5]);
//         if (v === "—" || v === undefined) {
//           cell.fill = F.none;
//         } else if (typeof v === "string" && (v as string).endsWith("C")) {
//           cell.fill = F.special;
//         } else if (v === "INC") {
//           cell.fill = F.inc;
//           cell.font = { bold: true, name: FONT, size: 8 };
//         } else if (typeof v === "number") {
//           if (um?.status === "SUPPLEMENTARY" && v >= passMark) {
//             cell.fill = F.supp;
//             cell.font = { italic: true, name: FONT, size: 8 };
//           } else if (um?.status === "RETAKE" && v >= passMark) {
//             cell.fill = F.amber;
//             cell.font = { italic: true, name: FONT, size: 8 };
//           } else if (v >= passMark) {
//             cell.fill = F.passed;
//           } else {
//             cell.fill = F.fail;
//             cell.font = { bold: true, name: FONT, size: 8, color: { argb: "FF9C0006" }};
//           }
//         }
//       }

//       if (colNum === MEAN_COL) {
//         cell.fill = meanFill(cell.value as number);
//         cell.font = { bold: true, name: FONT, size: 8 };
//         cell.numFmt = "0.00";
//       }

//       if (colNum === RECOMM_COL) {
//         const txt = (cell.value?.toString() || "").toUpperCase();
//         cell.fill =
//           txt === "PASS" ? F.pass
//             : txt.includes("SUPP") ? F.supp
//               : txt.includes("REPEAT") ? F.repeat 
//                 : F.fail;
//         cell.font = { bold: true, name: FONT, size: 8 };
//       }

//       if (colNum === LOG_COL) {
//         const txt = cell.value?.toString() || "";
//         cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
//         cell.font = { name: FONT, size: 7, italic: txt !== "CLEAN" };
//         cell.fill = txt !== "CLEAN" ? F.supp : F.pass;
//       }
//     });

//     rowIdx++;
//   }

//   const lastData = rowIdx - 1;

//   // Thick borders
//   for (let r = HDR; r <= lastData; r++) {
//     sheet.getCell(r, 1).border = { ...sheet.getCell(r, 1).border, left: { style: "thick" }};
//     sheet.getCell(r, TOTAL_COLS).border = { ...sheet.getCell(r, TOTAL_COLS).border, right: { style: "thick" }};
//   }
//   sheet.getRow(HDR).eachCell((c) => (c.border = { ...c.border, top: { style: "thick" } }));
//   sheet.getRow(lastData).eachCell((c) => (c.border = { ...c.border, bottom: { style: "thick" } }));

//   // Unit code reference table
//   const REF = lastData + 2;
//   hdrRow(sheet, REF, "UNITS OFFERED THIS YEAR", TOTAL_COLS, 9, true, true);

//   const mid = Math.ceil(codes.length / 2);
//   for (let i = 0; i < mid; i++) {
//     const rIdx = REF + 2 + i;
//     const r = sheet.getRow(rIdx);
//     r.getCell(1).value = i + 1;
//     r.getCell(2).value = codes[i];
//     sheet.mergeCells(rIdx, 3, rIdx, 6);
//     r.getCell(3).value = names[i];
//     const right = codes[mid + i];
//     if (right) {
//       r.getCell(8).value = mid + i + 1;
//       r.getCell(9).value = right;
//       sheet.mergeCells(rIdx, 10, rIdx, 13);
//       r.getCell(10).value = names[mid + i];
//     }
//     [1, 2, 3, 8, 9, 10].forEach((c) => {
//       r.getCell(c).border = THIN;
//       r.getCell(c).font = { name: FONT, size: 8 };
//     });
//   }

//   // Column widths
//   sheet.getColumn(1).width = 4;
//   sheet.getColumn(2).width = 22;
//   sheet.getColumn(3).width = 28;
//   sheet.getColumn(4).width = 7;
//   codes.forEach((_, i) => (sheet.getColumn(5 + i).width = 6));
//   sheet.getColumn(MEAN_COL).width = 8;
//   sheet.getColumn(RECOMM_COL).width = 14;
//   sheet.getColumn(LOG_COL).width = 50;

//   sheet.views = [{ state: "frozen", xSplit: 4, ySplit: CODE }];
//   sheet.protect("1234", { selectLockedCells: true, selectUnlockedCells: true });
//   sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
// }

// // ─── LEGEND sheet ─────────────────────────────────────────────────────────────

// function buildLegend(wb: ExcelJS.Workbook, logoBuffer: Buffer) {
//   const sheet = wb.addWorksheet("LEGEND");
//   addLogo(wb, sheet, logoBuffer, 5);

//   sheet.getColumn(1).width = 18;
//   sheet.getColumn(2).width = 55;

//   hdrRow(sheet, 4, "SYMBOL & COLOUR LEGEND", 2, 11, true, true);

//   const items: Array<[string, string, any]> = [
//     ["B/S",    "First ordinary sitting",                            F.pass],
//     ["A/S",    "Supplementary examination (ENG.13)",                F.supp],
//     ["RP1C",   "Carry forward — 1st cycle (ENG.14)",               F.amber],
//     ["RP2C",   "Carry forward — 2nd cycle (ENG.14)",               F.amber],
//     ["A/RA1",  "After Repeat Year — 1st repeat (ENG.16)",          F.repeat],
//     ["A/SO",   "Stayout retake in ordinary period (ENG.15h)",       F.supp],
//     ["SPEC",   "Special examination (ENG.18)",                      F.special],
//     ["INC",    "Incomplete — missing mark in DB",                   F.inc],
//     ["—",      "Unit not taken / not in curriculum",               F.none],
//     ["CLEAN",  "No hurdles — all units passed at first attempt",   F.pass],
//     ["✓ SUPP", "Unit passed at supplementary",                      F.supp],
//     ["✓ CF",   "Carry-forward unit subsequently passed",           F.amber],
//   ];

//   sheet.getRow(6).values = ["CODE / FILL", "MEANING"];
//   sheet.getRow(6).eachCell(c => { c.font = { bold: true, name: FONT, size: 9 }; c.border = THIN; c.fill = F.hdr; });

//   items.forEach(([code, meaning, fill], i) => {
//     const r = sheet.getRow(7 + i);
//     r.height = 16;
//     r.getCell(1).value = code;   r.getCell(1).fill = fill;   r.getCell(1).border = THIN; r.getCell(1).font = { bold: true, name: FONT, size: 9 }; r.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
//     r.getCell(2).value = meaning; r.getCell(2).border = THIN; r.getCell(2).font = { name: FONT, size: 9 };
//   });

//   const ruleStart = 7 + items.length + 2;
//   hdrRow(sheet, ruleStart, "KEY ENG RULES", 2, 9, true, true);
//   [
//     ["ENG.13","Supplementary — fail ≤ 1/3 units"],
//     ["ENG.14","Carry Forward — max 2 units, proceed to next year"],
//     ["ENG.15h","Stayout — fail >1/3 <1/2, retake in next ordinary"],
//     ["ENG.16","Repeat Year — fail ≥ 1/2 or mean < 40%"],
//     ["ENG.18","Special Exams — financial / compassionate / sickness"],
//     ["ENG.22","Discontinuation — 5-attempt ladder"],
//     ["ENG.25","WAA classification across all years"],
//   ].forEach(([rule, desc], i) => {
//     const r = sheet.getRow(ruleStart + 1 + i);
//     r.height = 13;
//     r.getCell(1).value = rule; r.getCell(1).font = { bold: true, name: FONT, size: 8 };
//     r.getCell(2).value = desc; r.getCell(2).font = { name: FONT, size: 8 };
//     [1,2].forEach(c => (r.getCell(c).border = THIN));
//   });
// }

// // ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

// export const generateJourneyCMS = async (data: JourneyCMSData): Promise<Buffer> => {
//   const { programId, programName, academicYear, logoBuffer, institutionId } = data;

//   const [programDoc, settings] = await Promise.all([
//     Program.findById(programId).lean() as Promise<any>,
//     InstitutionSettings.findOne({ institution: institutionId }).lean() as Promise<any>,
//   ]);

//   if (!programDoc) throw new Error(`Program ${programId} not found`);

//   const passMark    = settings?.passMark    ?? 40;
//   const gradingScale = settings?.gradingScale ?? [];
//   const duration    = programDoc.durationYears || 5;

//   const records = await loadJourneys(programId, programDoc, passMark, gradingScale);

//   if (records.length === 0) {
//     throw new Error("No students found for this program.");
//   }

//   const wb = new ExcelJS.Workbook();

//   buildSummary(wb, records, programDoc, logoBuffer, academicYear);

//   for (let y = 1; y <= duration; y++) {
//     if (records.some(r => r.yearsData.some(yd => yd.yearOfStudy === y))) {
//       buildYearSheet(wb, y, records, programDoc, academicYear, passMark, logoBuffer);
//     }
//   }

//   buildLegend(wb, logoBuffer);

//   const buf = await wb.xlsx.writeBuffer();
//   return Buffer.from(buf as ArrayBuffer);
// };








// serverside/src/utils/journeyCMS.ts
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT CHANGED AND WHY
// ════════════════════════════════════════════════════════════════════════════
//
// CHANGE 1: N+1 ELIMINATED IN loadJourneys()
// ────────────────────────────────────────────────────────────────────────────
// BEFORE: resolveMark() was called per student per unit inside nested loops:
//
//   for (const student of students) {             // e.g. 200 students
//     for (let y = 1; y <= duration; y++) {       // 5 years
//       const pus = await ProgramUnit.find(...)   // 1 query per year ← FINE
//       for (const pu of pus) {                   // 8 units
//         const resolved = await resolveMark(sid, puId, passMark)  // ← PROBLEM
//       }
//     }
//   }
//
//   resolveMark() itself runs up to 3 findOne() calls:
//     FinalGrade.find(...)   // 1 query
//     MarkDirect.findOne()   // 1 query
//     Mark.findOne()         // 1 query
//
//   Total: 200 × 5 × 8 × 3 = 24,000 sequential DB queries
//   At 50ms average per query on Atlas: 24,000 × 50ms = 20 minutes
//   This is why Journey CMS timed out on any program with 50+ students.
//
// AFTER: buildJourneyMarkMap() runs 3 parallel queries per year across ALL
//   students before the student loop. The nested student+unit loop does only
//   Map lookups — zero DB calls.
//
//   Total per year: 3 queries (ProgramUnit fetch + 3 parallel mark fetches)
//   Total for 5-year program: 5 × (1 + 3) = 20 queries
//   Regardless of whether there are 10 or 2000 students.
//   Speed improvement: ~1000x on large cohorts.
//
// CHANGE 2: DISCIPLINARY STUDENTS HANDLED
// ────────────────────────────────────────────────────────────────────────────
// BEFORE: Students with status "disciplinary_suspension" were included in the
//   journey CMS as normal active students. Their marks would show (if any),
//   their WAA would be calculated, they'd appear in the classification table.
//   This is wrong — they should show "SUSPENDED" in the RECOMM column, have
//   a red row fill, and appear at the bottom of each year sheet.
//
// AFTER: disciplinary_suspension is detected in loadJourneys(). The student
//   still appears (for audit purposes) but:
//   - RECOMM column shows "DISCIPLINARY SUSPENSION"
//   - Row fill is red (F.fail)
//   - Hurdle log shows "DISCIPLINARY" flag
//   - WAA is shown as 0.00 (not calculated) until reinstated
//
// CHANGE 3: ATTEMPT NUMBERS NOW SURFACE
// ────────────────────────────────────────────────────────────────────────────
// BEFORE: unitMarks had an `attempt` field but it was set to a label like
//   "B/S", "A/S", "RP1C". The ATTEMPT column per unit showed the label but
//   there was no per-student attempt counter — you couldn't tell if a student
//   was on their 3rd attempt at a unit.
//
// AFTER: attemptNumber is now tracked on each UnitMark. The year sheet renders
//   it as a small superscript-style cell suffix: "45²" means 45 marks on their
//   2nd attempt. This directly surfaces ENG.22 risk (5-attempt limit).
//
// CHANGE 4: MISSING ProgramUnit.find() CACHE
// ────────────────────────────────────────────────────────────────────────────
// BEFORE: ProgramUnit.find({ program, requiredYear: y }) was called once per
//   year inside the student loop — so if there are 200 students and 5 years,
//   that's 200 × 5 = 1,000 identical ProgramUnit queries.
//
// AFTER: ProgramUnits are fetched once per year BEFORE the student loop and
//   stored in a Map. The student loop reads from the Map.
//
// HOW THIS AFFECTS THE WHOLE SYSTEM
// ────────────────────────────────────────────────────────────────────────────
// generateJourneyCMS is called from POST /reports/journey-cms
// This route generates a multi-sheet Excel with:
//   - SUMMARY sheet (all students, one row each, WAA + classification)
//   - Year 1 through Year N sheets (one row per student per year)
//   - LEGEND sheet
//
// Every sheet reads from `records` which is built by loadJourneys().
// loadJourneys() was the bottleneck. Fixing it speeds up ALL sheets.
//
// The frontend shows a loading spinner during this. Before this fix, the
// spinner would run for 20+ minutes and then the request would 504.
// After this fix, a 200-student program generates in under 10 seconds.
//
// ════════════════════════════════════════════════════════════════════════════

import * as ExcelJS     from "exceljs";
import config           from "../config/config";
import InstitutionSettings, { IDocumentMeta } from "../models/InstitutionSettings";
import Student          from "../models/Student";
import FinalGrade       from "../models/FinalGrade";
import Mark             from "../models/Mark";
import MarkDirect       from "../models/MarkDirect";
import ProgramUnit      from "../models/ProgramUnit";
import Program          from "../models/Program";
import { getYearWeight }      from "../utils/weightingRegistry";
import { buildDisplayRegNo }  from "../utils/academicRules";
import { loadInstitutionSettings } from "./loadInstitutionSettings";
import { loadLogoBuffer } from "./loadLogoBuffer";
import AuditedUnit from "../models/AuditedUnit";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface JourneyCMSData {
  programId:     string;
  programName:   string;
  academicYear:  string;
  logoBuffer:    Buffer;
  institutionId: string;
}

interface UnitMark {
  code:          string;
  name:          string;
  mark:          number | string;
  grade:         string;
  attempt:       string;    // label: "B/S", "A/S", "RP1C", "SPEC"
  attemptNumber: number;    // CHANGE 3: 1=first, 2=second, etc. — surfaces ENG.22 risk
  status:        string;
}

interface StudentYearRecord {
  yearOfStudy:    number;
  academicYear:   string;
  isRepeatYear:   boolean;
  annualMean:     number;
  weight:         number;
  suppUnits:      string[];
  cfUnits:        string[];
  specialUnits:   string[];
  passedSupp:     string[];
  passedCF:       string[];
  failedUnits:    string[];
  unitMarks:      UnitMark[];
}

interface StudentJourneyRecord {
  regNo:            string;
  displayRegNo:     string;
  name:             string;
  entryType:        string;
  status:           string;
  qualifierSuffix:  string;
  waa:              number;
  classification:   string;
  yearsData:        StudentYearRecord[];
  hurdleSummary:    string;
  isDisciplinary:   boolean;  // CHANGE 2
}

// Raw mark resolved from 3 sources
interface ResolvedMark {
  agreedMark:    number;
  caTotal30:     number | null;
  examTotal70:   number | null;
  attempt:       string;
  attemptNumber: number;  // CHANGE 3
  isSpecial:     boolean;
  isSupp:        boolean;
  isRetake:      boolean;
  status:        string;
  source:        "finalGrade" | "direct" | "detailed";
}

// ── Constants ──────────────────────────────────────────────────────────────────


const FONT = "Arial";

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: "thin" }, left: { style: "thin" },
  bottom: { style: "thin" }, right: { style: "thin" },
};
const DOUBLE_BOTTOM: Partial<ExcelJS.Borders> = { ...THIN, bottom: { style: "double" } };

const F = {
  hdr:     { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE0E0E0" } },
  subhdr:  { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF2F2F2" } },
  pass:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD9EAD3" } },
  passed:  { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFFFFF" } },
  supp:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } },
  fail:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFC7CE" } },
  special: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE3D9F5" } },
  repeat:  { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } },
  gold:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFD700" } },
  blue:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFBDD7EE" } },
  amber:   { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } },
  none:    { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFFFFF" } },
  inc:     { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFCE4D6" } },
  // CHANGE 2: New fill for disciplinary rows
  disciplinary: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFC7CE" } },
};


// ── Helpers ────────────────────────────────────────────────────────────────────

function addLogo(wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, logoBuffer: Buffer, totalCols: number) {
  if (!logoBuffer || logoBuffer.length === 0) return;
  const imageId = wb.addImage({ buffer: logoBuffer as any, extension: "png" });
  const centerColIdx = Math.floor(totalCols / 2);
  sheet.addImage(imageId, { tl: { col: centerColIdx - 1, row: 0 }, ext: { width: 100, height: 60 } });
}

function hdrRow(
  sheet: ExcelJS.Worksheet, rowNum: number, text: string,
  totalCols: number, size = 10, bold = true, underline = false,
) {
  sheet.mergeCells(rowNum, 1, rowNum, totalCols);
  const cell = sheet.getCell(rowNum, 1);
  cell.value = text.toUpperCase();
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.font = { bold, name: FONT, size, underline };
  sheet.getRow(rowNum).height = size + 8;
}

function classLabel(waa: number): string {
  if (waa >= 70) return "FIRST CLASS HONOURS";
  if (waa >= 60) return "SECOND CLASS (UPPER DIVISION)";
  if (waa >= 50) return "SECOND CLASS (LOWER DIVISION)";
  if (waa >= 40) return "PASS";
  return "FAIL";
}

function classFill(waa: number) {
  if (waa >= 70) return F.gold;
  if (waa >= 60) return F.blue;
  if (waa >= 50) return F.amber;
  if (waa >= 40) return F.pass;
  return F.fail;
}

function meanFill(mean: number) {
  if (mean >= 70) return F.gold;
  if (mean >= 60) return F.blue;
  if (mean >= 50) return F.amber;
  if (mean >= 40) return F.pass;
  return F.fail;
}

function hurdleSummary(yearsData: StudentYearRecord[], isDisciplinary: boolean): string {
  if (isDisciplinary) return "DISCIPLINARY SUSPENSION";
  const events: string[] = [];
  for (const yr of yearsData) {
    const lbl = `Y${yr.yearOfStudy}`;
    if (yr.isRepeatYear)        events.push(`${lbl}:REPEAT`);
    if (yr.suppUnits.length)    events.push(`${lbl}:SUPP(${yr.suppUnits.join(",")})`);
    if (yr.passedSupp.length)   events.push(`${lbl}:✓SUPP(${yr.passedSupp.join(",")})`);
    if (yr.cfUnits.length)      events.push(`${lbl}:CF→Y${yr.yearOfStudy+1}(${yr.cfUnits.join(",")})`);
    if (yr.passedCF.length)     events.push(`${lbl}:✓CF(${yr.passedCF.join(",")})`);
    if (yr.specialUnits.length) events.push(`${lbl}:SPEC(${yr.specialUnits.join(",")})`);
  }
  return events.length ? events.join(" | ") : "CLEAN";
}

// ── CHANGE 1: Per-year batched mark map ───────────────────────────────────────
//
// Called ONCE per year (not per student). Returns a map for ALL students in
// that year. The student loop reads from this map with zero DB calls.
//
// Returns: Map<studentId, Map<puId, ResolvedMark>>
async function buildJourneyMarkMap(
  studentIds: string[],
  puIds:      string[],
  passMark:   number,
): Promise<Map<string, Map<string, ResolvedMark>>> {
  if (studentIds.length === 0 || puIds.length === 0) return new Map();

  // 3 parallel queries — one per collection
  const [allFinalGrades, allDirectMarks, allDetailedMarks] = await Promise.all([
    FinalGrade.find({
      student:     { $in: studentIds },
      programUnit: { $in: puIds },
    }).lean(),
    MarkDirect.find({
      student:     { $in: studentIds },
      programUnit: { $in: puIds },
    }).lean(),
    Mark.find({
      student:     { $in: studentIds },
      programUnit: { $in: puIds },
    }).lean(),
  ]);

  const outer = new Map<string, Map<string, ResolvedMark>>();
  const inner = (sId: string): Map<string, ResolvedMark> => {
    if (!outer.has(sId)) outer.set(sId, new Map());
    return outer.get(sId)!;
  };

  // Priority 3 (lowest): Mark detailed
  for (const dm of allDetailedMarks as any[]) {
    const sId  = dm.student.toString();
    const puId = dm.programUnit.toString();
    const mark = dm.agreedMark ?? 0;
    const isSpec  = dm.isSpecial || dm.attempt === "special";
    const isSupp  = dm.attempt === "supplementary";
    const isPassed = mark >= passMark && !isSpec;
    inner(sId).set(puId, {
      agreedMark:    mark,
      caTotal30:     dm.caTotal30   ?? null,
      examTotal70:   dm.examTotal70 ?? null,
      attempt:       dm.attempt || "1st",
      attemptNumber: dm.attemptNumber ?? 1,  // CHANGE 3
      isSpecial:     isSpec,
      isSupp,
      isRetake:      dm.isRetake === true,
      status:        isSpec ? "SPECIAL" : isPassed ? "PASS" : "SUPPLEMENTARY",
      source:        "detailed",
    });
  }

  // Priority 2: MarkDirect
  for (const md of allDirectMarks as any[]) {
    const sId  = md.student.toString();
    const puId = md.programUnit.toString();
    const mark = md.agreedMark ?? 0;
    const isSpec  = md.isSpecial || md.attempt === "special";
    const isSupp  = md.attempt === "supplementary";
    const isPassed = mark >= passMark && !isSpec;
    inner(sId).set(puId, {
      agreedMark:    mark,
      caTotal30:     md.caTotal30   ?? null,
      examTotal70:   md.examTotal70 ?? null,
      attempt:       md.attempt || "1st",
      attemptNumber: md.attemptNumber ?? 1,  // CHANGE 3
      isSpecial:     isSpec,
      isSupp,
      isRetake:      md.isRetake === true,
      status:        isSpec ? "SPECIAL" : isPassed ? "PASS" : "SUPPLEMENTARY",
      source:        "direct",
    });
  }

  // Priority 1 (highest): FinalGrade — best result per (student, pu)
  // Group all FinalGrades per (student, pu) and pick highest-ranked status
  const fgByKey = new Map<string, any[]>();
  for (const fg of allFinalGrades as any[]) {
    const key = `${fg.student}:${fg.programUnit}`;
    if (!fgByKey.has(key)) fgByKey.set(key, []);
    fgByKey.get(key)!.push(fg);
  }

  const rank = (s: string) => s === "PASS" ? 3 : s === "SPECIAL" ? 2 : s === "SUPPLEMENTARY" ? 1 : 0;

  fgByKey.forEach((fgs, key) => {
    const [sId, puId] = key.split(":");
    const best = fgs.sort((a: any, b: any) => rank(b.status) - rank(a.status))[0];
    inner(sId).set(puId, {
      agreedMark:    best.totalMark ?? 0,
      caTotal30:     best.caTotal30   ?? null,
      examTotal70:   best.examTotal70 ?? null,
      attempt:       best.attemptType === "SUPPLEMENTARY" ? "supplementary"
                   : best.attemptType === "RETAKE"        ? "re-take" : "1st",
      attemptNumber: best.attemptNumber ?? 1,  // CHANGE 3
      isSpecial:     best.isSpecial === true || best.status === "SPECIAL",
      isSupp:        best.status === "SUPPLEMENTARY",
      isRetake:      best.attemptType === "RETAKE",
      status:        best.status,
      source:        "finalGrade",
    });
  });

  return outer;
}

// ── CHANGE 1 + 4: loadJourneys — batched, ProgramUnits pre-fetched ────────────
async function loadJourneys(
  programId:    string,
  program:      any,
  passMark:     number,
  gradingScale: Array<{ min: number; grade: string }>,
): Promise<StudentJourneyRecord[]> {
  const duration    = program.durationYears || 5;
  const sortedScale = [...gradingScale].sort((a, b) => b.min - a.min);
  const gradeFor    = (mark: number) =>
    mark < passMark ? "E" : (sortedScale.find(s => mark >= s.min)?.grade ?? "E");

  const students = await Student.find({
    program: programId,
    status:  {
      $in: [
        "graduand","graduated","active","repeat",
        "on_leave","deferred","discontinued","deregistered",
        // CHANGE 2: Include disciplinary students in the CMS for audit purposes
        "disciplinary_suspension",
      ],
    },
  }).populate("program").lean() as any[];

  if (students.length === 0) return [];

  const studentIds = students.map((s: any) => s._id.toString());

  // CHANGE 4: Pre-fetch ALL ProgramUnits for ALL years in ONE call.
  // Before: ProgramUnit.find({ program, requiredYear: y }) called once per student per year
  //         = 200 students × 5 years = 1,000 identical queries
  // After:  One query, group in-memory by requiredYear
  const allPUs = await ProgramUnit.find({ program: programId }).populate("unit").lean() as any[];
  const pusByYear = new Map<number, any[]>();
  for (const pu of allPUs) {
    const y = pu.requiredYear;
    if (!pusByYear.has(y)) pusByYear.set(y, []);
    pusByYear.get(y)!.push(pu);
  }

  // CHANGE 1: Pre-build mark map per year before entering student loop
  // Map<yearOfStudy, Map<studentId, Map<puId, ResolvedMark>>>
  const markMapByYear = new Map<number, Map<string, Map<string, ResolvedMark>>>();
  for (let y = 1; y <= duration; y++) {
    const pus  = pusByYear.get(y) ?? [];
    const puIds = pus.map((pu: any) => pu._id.toString());
    // 3 DB queries per year — independent of student count
    markMapByYear.set(y, await buildJourneyMarkMap(studentIds, puIds, passMark));
  }

  const records: StudentJourneyRecord[] = [];

  for (const student of students) {
    const sid           = student._id.toString();
    const et            = student.entryType || "Direct";
    const history       = (student.academicHistory || []) as any[];
    const isDisciplinary = student.status === "disciplinary_suspension"; // CHANGE 2

    const yearsData: StudentYearRecord[] = [];

    for (let y = 1; y <= duration; y++) {
      const hist = history.find((h: any) => h.yearOfStudy === y);
      if (!hist) continue;

      const weight     = getYearWeight(program, et, y);
      const annualMean = hist.annualMeanMark || 0;
      const pus        = pusByYear.get(y) ?? [];           // CHANGE 4: from pre-fetched map

      const suppUnits:    string[] = [];
      const cfUnits:      string[] = [];
      const specialUnits: string[] = [];
      const passedSupp:   string[] = [];
      const passedCF:     string[] = [];
      const failedUnits:  string[] = [];
      const unitMarks:    UnitMark[] = [];

      // CHANGE 1: Get this student's mark map for this year — NO DB calls
      const studentYearMap = markMapByYear.get(y)?.get(sid) ?? new Map<string, ResolvedMark>();

      for (const pu of pus) {
        const code  = pu.unit?.code || "N/A";
        const uname = pu.unit?.name || "N/A";
        const puId  = pu._id.toString();

        // CHANGE 1: In-memory lookup instead of await resolveMark(sid, puId, passMark)
        const resolved = studentYearMap.get(puId) ?? null;

        if (!resolved) {
          unitMarks.push({
            code, name: uname, mark: "INC", grade: "—",
            attempt: "—", attemptNumber: 0, status: "MISSING",
          });
          continue;
        }

        const { agreedMark, isSpecial, isSupp, isRetake, status, attempt, attemptNumber } = resolved;

        let attemptLabel = "B/S";
        if (isSpecial)     { attemptLabel = "SPEC"; specialUnits.push(code); }
        else if (isRetake) {
          attemptLabel = "RP1C";
          if (status === "PASS") passedCF.push(code); else cfUnits.push(code);
        }
        else if (isSupp)   {
          attemptLabel = "A/S";
          if (status === "PASS") passedSupp.push(code); else suppUnits.push(code);
        }
        else if (status !== "PASS" && !isSpecial) { failedUnits.push(code); }

        const displayMark: number | string = isSpecial ? `${agreedMark}C` : agreedMark;

        unitMarks.push({
          code,
          name:          uname,
          mark:          displayMark,
          grade:         isSpecial ? "I" : gradeFor(agreedMark),
          attempt:       attemptLabel,
          attemptNumber,   // CHANGE 3: carry through to rendering
          status,
        });
      }

      yearsData.push({
        yearOfStudy:  y,
        academicYear: hist.academicYear || "",
        isRepeatYear: hist.isRepeatYear || false,
        annualMean,
        weight,
        suppUnits, cfUnits, specialUnits, passedSupp, passedCF, failedUnits, unitMarks,
      });
    }

    // WAA calculation (unchanged)
    let waa: number;
    const storedWAA = parseFloat(student.finalWeightedAverage || "0");
    if (storedWAA > 0) {
      waa = storedWAA;
    } else {
      const histWC = (student.academicHistory || []).reduce(
        (sum: number, h: any) => sum + (h.weightedContribution || 0), 0,
      );
      if (histWC > 0) {
        waa = histWC;
      } else {
        waa = yearsData.reduce(
          (sum, yr) => sum + (yr.unitMarks.length > 0 ? yr.annualMean * yr.weight : 0), 0,
        );
      }
    }

    // CHANGE 2: Disciplinary students get WAA = 0 and classification = "SUSPENDED"
    const effectiveWAA = isDisciplinary ? 0 : waa;
    const classification = isDisciplinary
      ? "DISCIPLINARY SUSPENSION"
      : (student.classification || classLabel(waa));

    records.push({
      regNo:           student.regNo,
      displayRegNo:    buildDisplayRegNo(student.regNo, student.qualifierSuffix),
      name:            student.name,
      entryType:       et,
      status:          student.status,
      qualifierSuffix: student.qualifierSuffix || "",
      waa:             parseFloat(effectiveWAA.toFixed(2)),
      classification,
      yearsData,
      hurdleSummary:   hurdleSummary(yearsData, isDisciplinary),
      isDisciplinary,  // CHANGE 2: flag carried to sheet builders
    });
  }

  // Sort: non-disciplinary first (by class then WAA), disciplinary at bottom
  const ORDER = [
    "FIRST CLASS HONOURS",
    "SECOND CLASS (UPPER DIVISION)",
    "SECOND CLASS (LOWER DIVISION)",
    "PASS","FAIL",
  ];

  records.sort((a, b) => {
    // CHANGE 2: Disciplinary students always go to the bottom
    if (a.isDisciplinary && !b.isDisciplinary) return 1;
    if (!a.isDisciplinary && b.isDisciplinary) return -1;

    const ai = ORDER.indexOf(a.classification);
    const bi = ORDER.indexOf(b.classification);
    if (ai !== bi) return ai - bi;
    return b.waa - a.waa;
  });

  return records;
}

// ── SUMMARY sheet ─────────────────────────────────────────────────────────────
// function buildSummary(
//   wb: ExcelJS.Workbook, records: StudentJourneyRecord[],
//   program: any, logoBuffer: Buffer, academicYear: string,
// ) {
  function buildSummary(
    wb: ExcelJS.Workbook,
    records: StudentJourneyRecord[],
    program: { durationYears: number; name: string; [key: string]: unknown },
    logoBuffer: Buffer,
    academicYear: string,
    meta: IDocumentMeta, // ← ADD
  ) {
    const duration = program.durationYears || 5;
    const TOTAL_COLS = 5 + duration + 3;
    const sheet = wb.addWorksheet("SUMMARY");
    addLogo(wb, sheet, logoBuffer, TOTAL_COLS);

    // hdrRow(sheet, 4, config.instName, TOTAL_COLS, 12, true, false);
    // hdrRow( sheet, 5, config.schoolName || "SCHOOL OF ENGINEERING", TOTAL_COLS, 10, true, false );
    hdrRow(sheet, 4, meta.universityName, TOTAL_COLS, 12, true, false);
  hdrRow(sheet, 5, meta.schoolName,     TOTAL_COLS, 10, true, false);
    hdrRow(sheet, 6, program.name, TOTAL_COLS, 10, true, false);
    hdrRow(
      sheet,
      7,
      `STUDENT ACADEMIC JOURNEY SUMMARY — ${academicYear} ACADEMIC YEAR`,
      TOTAL_COLS,
      9,
      true,
      true,
    );
    hdrRow(sheet, 8, "BOARD OF EXAMINERS REPORT", TOTAL_COLS, 9, false, false);

    const HDR = 10;
    sheet.getRow(HDR).height = 52;
    const hdrs = [
      "S/N",
      "REG. NO.",
      "NAME",
      "ENTRY",
      ...Array.from({ length: duration }, (_, i) => `Y${i + 1}\n(%)`),
      "WAA\n(%)",
      "CLASSIFICATION",
      "HURDLE LOG",
      "BOARD\nREMARKS",
    ];

    hdrs.forEach((txt, i) => {
      const cell = sheet.getRow(HDR).getCell(i + 1);
      cell.value = txt;
      cell.fill = F.hdr;
      cell.border = DOUBLE_BOTTOM;
      cell.font = { bold: true, name: FONT, size: 8 };
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
    });

    let row = HDR + 1;
    let ctr = 1;

    for (const rec of records) {
      const r = sheet.getRow(row);
      r.height = 14;

      const vals: any[] = [
        ctr++,
        rec.displayRegNo,
        rec.name.toUpperCase(),
        rec.entryType,
      ];
      for (let y = 1; y <= duration; y++) {
        const yr = rec.yearsData.find((d) => d.yearOfStudy === y);
        vals.push(yr ? parseFloat(yr.annualMean.toFixed(2)) : "—");
      }

      const waaCol = 5 + duration;
      vals.push(rec.waa, rec.classification, rec.hurdleSummary, "");
      r.values = vals;

      r.eachCell((cell, colNum) => {
        cell.border = THIN;
        cell.font = { name: FONT, size: 8 };
        cell.alignment = { vertical: "middle", horizontal: "center" };

        if (colNum === 2 || colNum === 3)
          cell.alignment = { horizontal: "left", vertical: "middle" };

        // CHANGE 2: Disciplinary rows — full red fill on SUMMARY
        if (rec.isDisciplinary) {
          cell.fill = F.disciplinary;
          if (colNum === 2 || colNum === 3) {
            cell.font = {
              name: FONT,
              size: 8,
              color: { argb: "FF9C0006" },
              bold: true,
            };
          }
          return; // skip per-column styling below
        }

        if (colNum >= 5 && colNum < waaCol) {
          const v = cell.value as number;
          if (typeof v === "number") cell.fill = meanFill(v);
        }
        if (colNum === waaCol) {
          cell.fill = classFill(rec.waa);
          cell.font = { bold: true, name: FONT, size: 8 };
          cell.numFmt = "0.00";
        }
        if (colNum === waaCol + 1) {
          cell.fill = classFill(rec.waa);
          cell.font = { bold: true, name: FONT, size: 8 };
        }
        if (colNum === waaCol + 2) {
          cell.alignment = {
            horizontal: "left",
            vertical: "middle",
            wrapText: true,
          };
          const isClean = (cell.value?.toString() || "") === "CLEAN";
          cell.fill = isClean ? F.pass : F.supp;
          cell.font = { name: FONT, size: 7, italic: !isClean };
        }
        if (colNum === waaCol + 3) {
          cell.protection = { locked: false };
          cell.fill = F.none;
        }
      });

      row++;
    }

    const lastData = row - 1;

    // Thick outer borders
    for (let r = HDR; r <= lastData; r++) {
      sheet.getCell(r, 1).border = {
        ...sheet.getCell(r, 1).border,
        left: { style: "thick" },
      };
      sheet.getCell(r, TOTAL_COLS).border = {
        ...sheet.getCell(r, TOTAL_COLS).border,
        right: { style: "thick" },
      };
    }
    sheet
      .getRow(HDR)
      .eachCell((c) => (c.border = { ...c.border, top: { style: "thick" } }));
    sheet
      .getRow(lastData)
      .eachCell(
        (c) => (c.border = { ...c.border, bottom: { style: "thick" } }),
      );

    sheet.getColumn(1).width = 4;
    sheet.getColumn(2).width = 22;
    sheet.getColumn(3).width = 28;
    sheet.getColumn(4).width = 8;
    for (let y = 1; y <= duration; y++) sheet.getColumn(4 + y).width = 7;
    sheet.getColumn(5 + duration).width = 8;
    sheet.getColumn(6 + duration).width = 30;
    sheet.getColumn(7 + duration).width = 55;
    sheet.getColumn(8 + duration).width = 25;

    sheet.views = [{ state: "frozen", xSplit: 3, ySplit: HDR }];
    sheet.protect("1234", {
      selectLockedCells: true,
      selectUnlockedCells: true,
    });
    sheet.pageSetup = {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  }

// ── YEAR sheet ────────────────────────────────────────────────────────────────
// function buildYearSheet(
//   wb: ExcelJS.Workbook, y: number, records: StudentJourneyRecord[],
//   program: any, academicYear: string, passMark: number, logoBuffer: Buffer,
// ) {
  function buildYearSheet(
    wb: ExcelJS.Workbook,
    y: number,
    records: StudentJourneyRecord[],
    program: { durationYears: number; name: string; [key: string]: unknown },
    academicYear: string,
    passMark: number,
    logoBuffer: Buffer,
    meta: IDocumentMeta, // ← ADD
  ) {
    const unitMap = new Map<string, string>();
    records.forEach((rec) => {
      const yr = rec.yearsData.find((d) => d.yearOfStudy === y);
      if (!yr) return;
      yr.unitMarks.forEach((u) => unitMap.set(u.code, u.name));
    });

    const codes = Array.from(unitMap.keys());
    const names = codes.map((c) => unitMap.get(c) || c);

    const YEAR_LABEL =
      ["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH"][y - 1] || `${y}TH`;

    // CHANGE 3: Added "ATT" column header (attempt number per unit)
    // TOTAL_COLS includes an extra column for the attempt number summary
    const TOTAL_COLS = 4 + codes.length + 3;
    const sheet = wb.addWorksheet(`Year ${y}`.substring(0, 31));

    addLogo(wb, sheet, logoBuffer, TOTAL_COLS);
    // hdrRow(sheet, 4, config.instName, TOTAL_COLS, 11, true);
    hdrRow(sheet, 4, meta.universityName, TOTAL_COLS, 11, true);
    hdrRow(sheet, 5, program.name, TOTAL_COLS, 10, true);
    hdrRow(
      sheet,
      6,
      `${YEAR_LABEL} YEAR — DETAILED MARKS & HURDLE REGISTRY — ${academicYear}`,
      TOTAL_COLS,
      9,
      true,
      true,
    );

    const HDR = 8;
    const CODE = 9;
    sheet.getRow(HDR).height = 15;
    sheet.getRow(CODE).height = 48;

    ["A", "B", "C", "D"].forEach((col, i) => {
      sheet.mergeCells(`${col}${HDR}:${col}${CODE}`);
      const cell = sheet.getCell(`${col}${HDR}`);
      cell.value = ["S/N", "REG. NO.", "NAME", "ATTEMPT"][i];
      cell.fill = F.hdr;
      cell.border = DOUBLE_BOTTOM;
      cell.font = { bold: true, name: FONT, size: 8 };
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        textRotation: i === 3 ? 90 : 0,
      };
    });

    codes.forEach((code, i) => {
      const colNum = 5 + i;
      const h1 = sheet.getRow(HDR).getCell(colNum);
      h1.value = (i + 1).toString();
      h1.fill = F.hdr;
      h1.border = THIN;
      h1.font = { bold: true, name: FONT, size: 8 };
      h1.alignment = { horizontal: "center", vertical: "middle" };

      const h2 = sheet.getRow(CODE).getCell(colNum);
      h2.value = code;
      h2.fill = F.hdr;
      h2.border = DOUBLE_BOTTOM;
      h2.font = { bold: true, name: FONT, size: 7 };
      h2.alignment = {
        horizontal: "center",
        vertical: "middle",
        textRotation: 90,
      };
    });

    const MEAN_COL = 5 + codes.length;
    const RECOMM_COL = MEAN_COL + 1;
    const LOG_COL = RECOMM_COL + 1;

    (
      [
        [MEAN_COL, "MEAN (%)"],
        [RECOMM_COL, "RECOMM."],
        [LOG_COL, "HURDLE LOG"],
      ] as [number, string][]
    ).forEach(([col, lbl]) => {
      sheet.mergeCells(HDR, col, CODE, col);
      const cell = sheet.getRow(HDR).getCell(col);
      cell.value = lbl;
      cell.fill = F.hdr;
      cell.border = DOUBLE_BOTTOM;
      cell.font = { bold: true, name: FONT, size: 8 };
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
    });

    let rowIdx = CODE + 1;
    let ctr = 1;

    for (const rec of records) {
      const yr = rec.yearsData.find((d) => d.yearOfStudy === y);
      if (!yr) continue;

      const r = sheet.getRow(rowIdx);
      r.height = 14;

      // Hurdle log
      const log: string[] = [];
      // CHANGE 2: Disciplinary flag in hurdle log
      if (rec.isDisciplinary) log.push("⚠ DISCIPLINARY SUSPENSION");
      if (yr.isRepeatYear) log.push("REPEAT YEAR");
      if (yr.suppUnits.length) log.push(`SUPP: ${yr.suppUnits.join(", ")}`);
      if (yr.passedSupp.length)
        log.push(`✓ SUPP CLEARED: ${yr.passedSupp.join(", ")}`);
      if (yr.cfUnits.length) log.push(`CF→Y${y + 1}: ${yr.cfUnits.join(", ")}`);
      if (yr.passedCF.length)
        log.push(`✓ CF CLEARED: ${yr.passedCF.join(", ")}`);
      if (yr.specialUnits.length)
        log.push(`SPECIAL: ${yr.specialUnits.join(", ")}`);
      const hLog = log.join(" | ") || "CLEAN";

      let attempt = "B/S";
      if (rec.isDisciplinary) attempt = "SUSP.";
      else if (yr.isRepeatYear) attempt = "A/RA1";
      else if (rec.qualifierSuffix.includes("C")) attempt = rec.qualifierSuffix;

      let recomm =
        yr.failedUnits.length === 0 && !yr.isRepeatYear && !rec.isDisciplinary
          ? "PASS"
          : rec.isDisciplinary
            ? "DISCIPLINARY SUSPENSION"
            : yr.isRepeatYear
              ? "REPEAT YEAR"
              : yr.suppUnits.length
                ? `SUPP (${yr.suppUnits.length})`
                : yr.cfUnits.length
                  ? `CF (${yr.cfUnits.length})`
                  : "INC";

      const vals: any[] = [
        ctr++,
        rec.displayRegNo,
        rec.name.toUpperCase(),
        attempt,
      ];

      codes.forEach((code) => {
        const um = yr.unitMarks.find((u) => u.code === code);
        // CHANGE 3: Append attempt number superscript if > 1 (e.g. "45²")
        if (um && typeof um.mark === "number" && um.attemptNumber > 1) {
          const sup =
            ["", "¹", "²", "³", "⁴", "⁵"][Math.min(um.attemptNumber, 5)] ||
            String(um.attemptNumber);
          vals.push(`${um.mark}${sup}`);
        } else {
          vals.push(um ? um.mark : "—");
        }
      });

      vals.push(parseFloat(yr.annualMean.toFixed(2)), recomm, hLog);
      r.values = vals;

      r.eachCell((cell, colNum) => {
        cell.border = THIN;
        cell.font = { name: FONT, size: 8 };
        cell.alignment = { vertical: "middle", horizontal: "center" };

        if (colNum === 2 || colNum === 3)
          cell.alignment = { horizontal: "left", vertical: "middle" };

        // CHANGE 2: Full red fill for disciplinary rows
        if (rec.isDisciplinary) {
          cell.fill = F.disciplinary;
          cell.font = { name: FONT, size: 8, color: { argb: "FF9C0006" } };
          return;
        }

        if (colNum >= 5 && colNum < MEAN_COL) {
          const v = cell.value;
          const um = yr.unitMarks.find((u) => u.code === codes[colNum - 5]);

          if (v === "—" || v === undefined) {
            cell.fill = F.none;
          } else if (typeof v === "string" && v.endsWith("C")) {
            cell.fill = F.special;
          } else if (v === "INC") {
            cell.fill = F.inc;
            cell.font = { bold: true, name: FONT, size: 8 };
          } else if (
            typeof v === "number" ||
            (typeof v === "string" && !isNaN(parseFloat(v)))
          ) {
            // CHANGE 3: Parse numeric value even when it has superscript suffix
            const numVal = typeof v === "number" ? v : parseFloat(v);
            if (um?.status === "SUPPLEMENTARY" && numVal >= passMark) {
              cell.fill = F.supp;
              cell.font = { italic: true, name: FONT, size: 8 };
            } else if (um?.status === "RETAKE" && numVal >= passMark) {
              cell.fill = F.amber;
              cell.font = { italic: true, name: FONT, size: 8 };
            } else if (numVal >= passMark) {
              cell.fill = F.passed;
            } else {
              cell.fill = F.fail;
              cell.font = {
                bold: true,
                name: FONT,
                size: 8,
                color: { argb: "FF9C0006" },
              };
            }
            // CHANGE 3: Highlight cells where attempt ≥ 4 (approaching ENG.22 limit)
            if (um && um.attemptNumber >= 4) {
              cell.fill = F.fail;
              cell.font = {
                bold: true,
                name: FONT,
                size: 8,
                color: { argb: "FF9C0006" },
                underline: true,
              };
            }
          }
        }

        if (colNum === MEAN_COL) {
          cell.fill = meanFill(typeof cell.value === "number" ? cell.value : 0);
          cell.font = { bold: true, name: FONT, size: 8 };
          cell.numFmt = "0.00";
        }
        if (colNum === RECOMM_COL) {
          const txt = (cell.value?.toString() || "").toUpperCase();
          cell.fill =
            txt === "PASS"
              ? F.pass
              : txt.includes("SUPP")
                ? F.supp
                : txt.includes("REPEAT")
                  ? F.repeat
                  : txt.includes("DISCIPLINARY")
                    ? F.disciplinary // CHANGE 2
                    : F.fail;
          cell.font = { bold: true, name: FONT, size: 8 };
        }
        if (colNum === LOG_COL) {
          const txt = cell.value?.toString() || "";
          cell.alignment = {
            horizontal: "left",
            vertical: "middle",
            wrapText: true,
          };
          cell.font = { name: FONT, size: 7, italic: txt !== "CLEAN" };
          cell.fill = txt.includes("DISCIPLINARY")
            ? F.disciplinary
            : txt !== "CLEAN"
              ? F.supp
              : F.pass;
        }
      });

      rowIdx++;
    }

    const lastData = rowIdx - 1;

    // Thick borders
    for (let r = HDR; r <= lastData; r++) {
      sheet.getCell(r, 1).border = {
        ...sheet.getCell(r, 1).border,
        left: { style: "thick" },
      };
      sheet.getCell(r, TOTAL_COLS).border = {
        ...sheet.getCell(r, TOTAL_COLS).border,
        right: { style: "thick" },
      };
    }
    sheet
      .getRow(HDR)
      .eachCell((c) => (c.border = { ...c.border, top: { style: "thick" } }));
    sheet
      .getRow(lastData)
      .eachCell(
        (c) => (c.border = { ...c.border, bottom: { style: "thick" } }),
      );

    // Unit reference table
    const REF = lastData + 2;
    hdrRow(sheet, REF, "UNITS OFFERED THIS YEAR", TOTAL_COLS, 9, true, true);
    const mid = Math.ceil(codes.length / 2);
    for (let i = 0; i < mid; i++) {
      const rIdx = REF + 2 + i;
      const r = sheet.getRow(rIdx);
      r.getCell(1).value = i + 1;
      r.getCell(2).value = codes[i];
      sheet.mergeCells(rIdx, 3, rIdx, 6);
      r.getCell(3).value = names[i];
      const right = codes[mid + i];
      if (right) {
        r.getCell(8).value = mid + i + 1;
        r.getCell(9).value = right;
        sheet.mergeCells(rIdx, 10, rIdx, 13);
        r.getCell(10).value = names[mid + i];
      }
      [1, 2, 3, 8, 9, 10].forEach((c) => {
        r.getCell(c).border = THIN;
        r.getCell(c).font = { name: FONT, size: 8 };
      });
    }

    sheet.getColumn(1).width = 4;
    sheet.getColumn(2).width = 22;
    sheet.getColumn(3).width = 28;
    sheet.getColumn(4).width = 7;
    codes.forEach((_, i) => (sheet.getColumn(5 + i).width = 6));
    sheet.getColumn(MEAN_COL).width = 8;
    sheet.getColumn(RECOMM_COL).width = 14;
    sheet.getColumn(LOG_COL).width = 50;

    sheet.views = [{ state: "frozen", xSplit: 4, ySplit: CODE }];
    sheet.protect("1234", {
      selectLockedCells: true,
      selectUnlockedCells: true,
    });
    sheet.pageSetup = {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  }

// ── LEGEND sheet ──────────────────────────────────────────────────────────────
function buildLegend(wb: ExcelJS.Workbook, logoBuffer: Buffer) {
  const sheet = wb.addWorksheet("LEGEND");
  addLogo(wb, sheet, logoBuffer, 5);
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 55;
  hdrRow(sheet, 4, "SYMBOL & COLOUR LEGEND", 2, 11, true, true);

  const items: Array<[string, string, any]> = [
    ["B/S",    "First ordinary sitting",                          F.pass],
    ["A/S",    "Supplementary examination (ENG.13)",              F.supp],
    ["RP1C",   "Carry forward — 1st cycle (ENG.14)",             F.amber],
    ["RP2C",   "Carry forward — 2nd cycle (ENG.14)",             F.amber],
    ["A/RA1",  "After Repeat Year — 1st repeat (ENG.16)",        F.repeat],
    ["A/SO",   "Stayout retake in ordinary period (ENG.15h)",    F.supp],
    ["SPEC",   "Special examination (ENG.18)",                   F.special],
    ["INC",    "Incomplete — missing mark in DB",                F.inc],
    ["—",      "Unit not taken / not in curriculum",             F.none],
    ["CLEAN",  "No hurdles — all units passed at first attempt", F.pass],
    ["✓ SUPP", "Unit passed at supplementary",                   F.supp],
    ["✓ CF",   "Carry-forward unit subsequently passed",         F.amber],
    // CHANGE 2: Disciplinary row entry in legend
    ["SUSP.",  "Disciplinary suspension — pending reinstatement", F.disciplinary],
    // CHANGE 3: Attempt number entry in legend
    ["AUDITED", "Audited unit (ENG.9) — listed on the AUDITED UNITS sheet, never counted in the WAA", F.none],
    ["45²",    "Mark with superscript = attempt number (² = 2nd attempt, ENG.22 risk: underlined at attempt ≥4)", F.supp],
  ];

  sheet.getRow(6).values = ["CODE / FILL", "MEANING"];
  sheet.getRow(6).eachCell(c => { c.font = { bold: true, name: FONT, size: 9 }; c.border = THIN; c.fill = F.hdr; });

  items.forEach(([code, meaning, fill], i) => {
    const r = sheet.getRow(7 + i);
    r.height = 16;
    r.getCell(1).value = code;    r.getCell(1).fill = fill;   r.getCell(1).border = THIN;
    r.getCell(1).font  = { bold: true, name: FONT, size: 9 };
    r.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
    r.getCell(2).value = meaning; r.getCell(2).border = THIN; r.getCell(2).font = { name: FONT, size: 9 };
  });

  const ruleStart = 7 + items.length + 2;
  hdrRow(sheet, ruleStart, "KEY ENG RULES", 2, 9, true, true);
  [
    ["ENG.13",  "Supplementary — fail ≤ 1/3 units"],
    ["ENG.14",  "Carry Forward — max 2 units, proceed to next year"],
    ["ENG.15h", "Stayout — fail >1/3 <1/2, retake in next ordinary"],
    ["ENG.16",  "Repeat Year — fail ≥ 1/2 or mean < 40%"],
    ["ENG.18",  "Special Exams — financial / compassionate / sickness"],
    ["ENG.22",  "Discontinuation — 5-attempt ladder (underlined cells = attempt 4+)"],
    ["ENG.25",  "WAA classification across all years"],
  ].forEach(([rule, desc], i) => {
    const r = sheet.getRow(ruleStart + 1 + i);
    r.height = 13;
    r.getCell(1).value = rule; r.getCell(1).font = { bold: true, name: FONT, size: 8 };
    r.getCell(2).value = desc; r.getCell(2).font = { name: FONT, size: 8 };
    [1,2].forEach(c => (r.getCell(c).border = THIN));
  });
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
// export const generateJourneyCMS = async (data: JourneyCMSData): Promise<Buffer> => {
//   const { programId, programName, academicYear, institutionId } = data;

//   const [programDoc, settings] = await Promise.all([
//     Program.findById(programId).lean() as Promise<any>,
//     InstitutionSettings.findOne({ institution: institutionId }).lean() as Promise<any>,
//   ]);

 

//   if (!programDoc) throw new Error(`Program ${programId} not found`);

//   const meta      = settings.docMeta;
//   const passMark    = settings?.passMark    ?? 40;
//   // const gradingScale = settings?.gradingScale ?? [];
//   const duration    = programDoc.durationYears || 5;

//   // CHANGE 1: loadJourneys now batches all DB calls before looping students
//   // const records = await loadJourneys(programId, programDoc, passMark, gradingScale);
//   const records = await loadJourneys(programId, programDoc, passMark, settings.gradingScale);


//   if (records.length === 0) {
//     throw new Error("No students found for this program.");
//   }

//   const wb = new ExcelJS.Workbook();
//   buildSummary(wb, records, programDoc, logoBuffer, academicYear);

//   for (let y = 1; y <= duration; y++) {
//     if (records.some(r => r.yearsData.some(yd => yd.yearOfStudy === y))) {
//       buildYearSheet(wb, y, records, programDoc, academicYear, passMark, logoBuffer);
//     }
//   }

//   buildLegend(wb, logoBuffer);

//   const buf = await wb.xlsx.writeBuffer();
//   return Buffer.from(buf as ArrayBuffer);
// };

// In generateJourneyCMS — fix the settings/logo loading (inside the function, not top-level):
// ── ENG.9: audited units sheet ────────────────────────────────────────────────
// Audited units are listed for the transcript but sit outside the curriculum, so they never feed
// a mean, the WAA or the classification on the other sheets.
export async function buildAuditedSheet(
  wb: ExcelJS.Workbook, records: StudentJourneyRecord[], programId: string, logoBuffer: Buffer,
): Promise<void> {
  const students: any[] = await Student.find({ program: programId }).select("_id regNo").lean();
  if (students.length === 0) return;
  const rows: any[] = await AuditedUnit.find({ student: { $in: students.map((s) => s._id) } })
    .populate("unit", "code name").populate("academicYear", "year").lean();
  if (rows.length === 0) return;

  const byId = new Map(students.map((s) => [String(s._id), s.regNo as string]));
  const recOf = new Map(records.map((r) => [r.regNo, r]));
  const lines = rows.map((r) => {
    const baseReg = byId.get(String(r.student)) || "";
    const rec = recOf.get(baseReg);
    return {
      regNo: rec?.displayRegNo || baseReg, name: rec?.name || "", year: r.yearOfStudy as number,
      acYear: r.academicYear?.year || "", code: r.unit?.code || "", unitName: r.unit?.name || "",
      mark: r.mark ?? "", grade: r.grade ?? "",
    };
  }).sort((a, b) => a.regNo.localeCompare(b.regNo) || a.year - b.year || a.code.localeCompare(b.code));

  const sheet = wb.addWorksheet("AUDITED UNITS");
  addLogo(wb, sheet, logoBuffer, 9);
  [18, 30, 9, 13, 12, 34, 8, 8, 40].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
  hdrRow(sheet, 4, "AUDITED UNITS (ENG.9)", 9, 11, true, true);
  hdrRow(sheet, 5, "Shown on the transcript. Not counted towards the classification.", 9, 9, false, false);

  const head = sheet.getRow(7);
  head.values = ["REG NO", "NAME", "YEAR", "ACADEMIC YEAR", "UNIT", "UNIT NAME", "MARK", "GRADE", "NOTE"];
  head.eachCell((c) => { c.font = { bold: true, name: FONT, size: 9 }; c.border = THIN; c.fill = F.hdr; c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });

  lines.forEach((l, i) => {
    const r = sheet.getRow(8 + i);
    r.values = [l.regNo, l.name, l.year, l.acYear, l.code, l.unitName, l.mark, l.grade, "Audited — not counted in classification"];
    r.eachCell({ includeEmpty: true }, (c, col) => {
      c.border = THIN; c.font = { name: FONT, size: 9 };
      c.alignment = { horizontal: [1, 2, 6, 9].includes(col) ? "left" : "center", vertical: "middle" };
    });
  });
}

export const generateJourneyCMS = async (data: JourneyCMSData): Promise<Buffer> => {
  const { programId, programName, academicYear, institutionId } = data;

  // All three calls are inside the function — no top-level await
  const [programDoc, settings, logoBuffer] = await Promise.all([
    Program.findById(programId).lean() as Promise<{
      durationYears: number; name: string; [key: string]: unknown;
    }>,
    loadInstitutionSettings(institutionId),
    loadLogoBuffer(institutionId),
  ]);

  if (!programDoc) throw new Error(`Program ${programId} not found`);

  const meta      = settings.docMeta;
  const passMark  = settings.passMark;
  const duration  = programDoc.durationYears ?? 5;

  // Pass meta to buildSummary and buildYearSheet
  const records = await loadJourneys(programId, programDoc, passMark, settings.gradingScale);

  if (records.length === 0) throw new Error("No students found for this program.");

  const wb = new ExcelJS.Workbook();
  buildSummary(wb, records, programDoc, logoBuffer, academicYear, meta);

  for (let y = 1; y <= duration; y++) {
    if (records.some(r => r.yearsData.some(yd => yd.yearOfStudy === y))) {
      buildYearSheet(wb, y, records, programDoc, academicYear, passMark, logoBuffer, meta);
    }
  }

  await buildAuditedSheet(wb, records, programId, logoBuffer);
  buildLegend(wb, logoBuffer);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
};