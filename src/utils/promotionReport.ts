
// serverside/src/utils/promotionReport.ts
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, TableLayoutType, AlignmentType, HeadingLevel, BorderStyle, ImageRun, VerticalAlign} from "docx";
import config from "../config/config";
import { AwardListEntry } from "../services/graduationEngine";
import { loadInstitutionSettings } from "./loadInstitutionSettings";
import { loadLogoBuffer } from "./loadLogoBuffer";
import { IDocumentMeta } from "../models/InstitutionSettings";
import { displayRegNo } from "./regNoQualifier";


export interface PromotionData {
  programName: string;  academicYear: string;  yearOfStudy: number;  
  eligible: any[];  blocked: any[];  logoBuffer: Buffer; offeredUnits?: { code: string; name: string }[];
  examType?: "ORDINARY" | "SUPPLEMENTARY"; institutionId: string;
}

const numberToWords = (num: number): string => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  
  if (num === 0) return "Zero";
  if (num < 20) return ones[num];
  const digit = num % 10;
  return tens[Math.floor(num / 10)] + (digit ? "-" + ones[digit] : "");
};

// Helper to convert Year 1 to "First Year", etc.
const getOrdinalYear = (year: number): string => {
  const ordinals = ["", "First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
  return ordinals[year] || `${year}th`;
};

const formatStudentName = (fullName: string): string => {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);

  // If only one name exists, just uppercase it
  if (parts.length <= 1) return fullName.toUpperCase();

  // Remove the last name, uppercase it, then join back
  const lastName = parts.pop()?.toUpperCase();
  return `${parts.join(" ")} ${lastName}`;
};

// Cache meta per function call (loaded once per report generation)
async function getDocContext(data: PromotionData): Promise<{
  meta: IDocumentMeta; logoBuffer: Buffer; }> {
  const [settings, logoBuffer] = await Promise.all([
    loadInstitutionSettings(data.institutionId),
    loadLogoBuffer(data.institutionId),
  ]);
  return { meta: settings.docMeta, logoBuffer };
}

function createDocHeader(
  logo:      Buffer,
  program:   string,
  year:      string,
  ordinal:   string,
  listType:  string,
  meta:      IDocumentMeta,
  examType:  "ORDINARY" | "SUPPLEMENTARY" = "ORDINARY",
): Paragraph[] {
  return [
    ...(logo && logo.length > 0
      ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [
          new ImageRun({ data: logo, transformation: { width: 120, height: 70 }, type: "png" })
        ]})]
      : []
    ),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: meta.universityName.toUpperCase(), bold: true, size: 23 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.schoolName.toUpperCase(), bold: true, size: 23 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.departmentName.toUpperCase(), bold: true, size: 23 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `PROGRAM: ${program.toUpperCase()}`, bold: true, size: 23 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `${year} ACADEMIC YEAR`, bold: true, size: 23 })] }),
    ...(examType !== undefined && !listType.toUpperCase().includes("AWARD LIST")
      ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 },
          children: [new TextRun({
            text: examType === "SUPPLEMENTARY"
              ? "SUPPLEMENTARY AND SPECIAL EXAMINATION RESULTS"
              : "ORDINARY EXAMINATION RESULTS",
            bold: true, size: 24,
          })] })]
      : []
    ),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: `${ordinal} Year`, bold: true, size: 23 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: listType, bold: true, size: 23, underline: {} })] }),
  ];
}

function createDocFooter(meta: IDocumentMeta): Paragraph[] {
  return [
    new Paragraph({ spacing: { before: 900 }, children: [new TextRun({ text: `APPROVED BY THE BOARD OF EXAMINERS, ${meta.schoolName.toUpperCase()}`, bold: true, size: 18 })] }),
    new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: "SIGNED: __________________________\t\tDATE: _______________", bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: `\tDEAN, ${meta.schoolName.toUpperCase()}`, size: 18 })] }),
  ];
}

export const generatePromotionWordDoc = async ( data: PromotionData ): Promise<Buffer> => {
  const { meta, logoBuffer } = await getDocContext(data);
  const { programName, academicYear, yearOfStudy, eligible, blocked, offeredUnits = [] } = data;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);

  const stats: Record<string, number> = {
    "PASS": eligible.length,
    "SUPPLEMENTARY (After Readmission)": blocked.filter(s => s.status === "SUPPLEMENTARY" && s.reasons?.some((r: string) => r.toLowerCase().includes("readmission"))).length,
    "SUPPLEMENTARY (After Stayout)": blocked.filter(s => s.status === "SUPPLEMENTARY" && s.reasons?.some((r: string) => r.toLowerCase().includes("stayout"))).length,
    "SUPPLEMENTARY (After Carry Forward)": blocked.filter(s => s.status === "SUPPLEMENTARY" && s.reasons?.some((r: string) => r.toLowerCase().includes("carry forward"))).length,
    "DEFERMENT": blocked.filter(s => s.status === "DEFERMENT" || s.status === "DEFERRED").length,
    "STAYOUT": blocked.filter(s => s.status === "STAYOUT").length,
    "DISCONTINUATION": blocked.filter(s => s.status === "CRITICAL FAILURE" || s.status === "DISCONTINUED").length,
    "DEREGISTRATION": blocked.filter(s => s.status === "DEREGISTERED").length,
    "REPEAT YEAR": blocked.filter(s => s.status === "REPEAT YEAR").length,
    "INCOMPLETE": blocked.filter(s => s.status.includes("INC") && !s.status.includes("SUPP") && !s.status.includes("SPEC")).length,
    "SUPPLEMENTARY": blocked.filter(s => s.status.includes("SUPP") && !s.status.includes("SPEC")).length,
    "ACADEMIC LEAVE (FINANCIAL)": blocked.filter(s => (s.status === "ACADEMIC LEAVE" || s.status === "ON LEAVE") && (s.academicLeavePeriod?.type === "financial" || s.remarks?.toLowerCase().includes("financial"))).length,
    "ACADEMIC LEAVE (COMPASSIONATE)": blocked.filter(s => (s.status === "ACADEMIC LEAVE" || s.status === "ON LEAVE") && (s.academicLeavePeriod?.type === "compassionate" || s.remarks?.toLowerCase().includes("compassionate"))).length, 
    "SPECIALS (FINANCIAL)": blocked.filter(s => s.status.includes("SPEC") && s.remarks?.toLowerCase().includes("financial")).length,
    "SPECIALS (COMPASSIONATE)": blocked.filter(s => s.status.includes("SPEC") && (s.remarks?.toLowerCase().includes("compassionate") || s.remarks?.toLowerCase().includes("medical"))).length,
    "SPECIALS (OTHER)": blocked.filter(s => s.status.includes("SPEC") && !s.remarks?.toLowerCase().match(/financial|compassionate|medical/)).length,
  };

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          ...createDocHeader(logoBuffer, programName, academicYear, currentYearOrdinal, "SUMMARY", meta, data.examType || "ORDINARY"),
      createSummaryTable(stats),

      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400, after: 100 }, children: [new TextRun({ text: "UNITS OFFERED", bold: true, size: 22, underline: {} })] }),
        createOfferedUnitsTable(offeredUnits),
        ...createDocFooter(meta),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

function createSummaryTable(stats: Record<string, number>) {
  const activeRows = Object.entries(stats).filter(([_, val]) => val > 0);
  const totalCount = Object.values(stats).reduce((a, b) => a + b, 0);
  const cellMargin = { top: 50, bottom: 50, left: 100, right: 100 };

  const rows = [
    ...activeRows.map(([label, val]) => new TableRow({
      children: [
        new TableCell({ 
          margins: cellMargin,
          width: { size: 70, type: WidthType.PERCENTAGE },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun({ text: label.toUpperCase(), size: 20 })] })] 
        }),
        new TableCell({ 
          margins: cellMargin,
          width: { size: 30, type: WidthType.PERCENTAGE },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun({ text: val.toString(), size: 20 })] })] 
        }),
      ]
    })),
    new TableRow({
      children: [
        new TableCell({ 
          margins: cellMargin,
          borders: { top: { style: BorderStyle.SINGLE, size: 1 }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun({ text: "TOTAL", bold: true, size: 20 })] })] 
        }),
        new TableCell({ 
          margins: cellMargin,
          borders: { top: { style: BorderStyle.SINGLE, size: 1 }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun({ text: totalCount.toString(), bold: true, size: 20 })] })] 
        }),
      ]
    })
  ];

  return new Table({ width: { size: 60, type: WidthType.PERCENTAGE }, alignment: AlignmentType.CENTER, rows: rows });
}

function createOfferedUnitsTable(units: { code: string; name: string }[]) {
  if (!units || units.length === 0) return new Paragraph("No units recorded.");

  const cellMargin = { top: 50, bottom: 50, left: 100, right: 100 };
  const midPoint = Math.ceil(units.length / 2);
  const leftCol = units.slice(0, midPoint);
  const rightCol = units.slice(midPoint);

  const headerCell = (text: string) => new TableCell({
    margins: cellMargin,
    children: [new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text, bold: true, size: 20 })] })]
  });

  const headerRow = new TableRow({
    children: [
      headerCell("S/NO."), headerCell("CODE"), headerCell("NAME"),
      headerCell("S/NO."), headerCell("CODE"), headerCell("NAME"),
    ]
  });

  const dataRows = [];
  for (let i = 0; i < midPoint; i++) {
    const left = leftCol[i];
    const right = rightCol[i];

    dataRows.push(new TableRow({
      children: [
        new TableCell({ margins: cellMargin, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: (i + 1).toString(), size: 21 })] })] }),
        new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: left.code, size: 20 })] })] }),
        new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: left.name, size: 20 })] })] }),
        new TableCell({ margins: cellMargin, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: right ? (midPoint + i + 1).toString() : "", size: 20 })] })] }),
        new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: right?.code || "", size: 20 })] })] }),
        new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: right?.name || "", size: 20 })] })] }),
      ]
    }));
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows]
  });
}

export const generateEligibleSummaryDoc = async ( data: any ): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, eligible } = data;
  const { meta, logoBuffer } = await getDocContext(data); 
  const candidateCountWords = numberToWords(eligible.length);
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const nextYearOrdinal = getOrdinalYear(yearOfStudy + 1);
  const cellMargin = { top: 0, bottom: 0, left: 100, right: 100 };

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          ...createDocHeader( logoBuffer, programName, academicYear, currentYearOrdinal, "PASS", meta, "ORDINARY" ),

          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { before: 400, after: 300 },
            children: [
              new TextRun({ text: `The following `, size: 22 }),
              new TextRun({ text: `${candidateCountWords} (${eligible.length}) `, bold: true, size: 22  }),
              new TextRun({ text: `candidates satisfied the ${meta.schoolName} Board of Examiners in the `, size: 22   }),
              new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
              new TextRun({ text: `Academic Year, `, size: 22 }),
              new TextRun({ text: `${currentYearOrdinal} Year `, bold: true, size: 22  }),
              new TextRun({ text: `Examinations for the `, size: 22 }),
              new TextRun({ text: `${programName}. `, bold: true, size: 22  }),
              new TextRun({ text: `The ${meta.schoolName} Board of Examiners recommends that they proceed to their `, size: 22 }),         
              new TextRun({ text: `${nextYearOrdinal} Year `, bold: true, size: 22 }),
              new TextRun({ text: `of study.`, size: 22 }),
            ],
          }),

          createPassTable(eligible, cellMargin),
          ...createDocFooter(meta),         
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

function createPassTable(students: any[], cellMargin: any) {
  const headerRow = new TableRow({
    children: [{ text: "S/No.", width: 5 }, { text: "REG. NO.", width: 30 }, { text: "NAME", width: 65 }].map(
      (col) =>
        new TableCell({
          width: { size: col.width, type: WidthType.PERCENTAGE },
          margins: cellMargin,
          children: [ new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: col.text, bold: true, size: 18 })] })],
        }),
    ),
  });

  const dataRows = students.map(
    (s, index) =>
      new TableRow({
        children: [ 
          new TableCell({ margins: cellMargin, children: [ new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: (index + 1).toString(), size: 20 })] })] }),
          new TableCell({ margins: cellMargin, children: [
            new Paragraph({ spacing: { before: 0, after: 0 }, children: [
              new TextRun({ text: s.regNo, size: 20 }),
              ...(s.qualifierSuffix ? [new TextRun({ text: s.qualifierSuffix, size: 16, subScript: true, color: "000000" })] : []),
            ] })
          ] }),
          new TableCell({ margins: cellMargin, children: [ new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: formatStudentName(s.name), size: 20 })]})] })] }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
    },
    rows: [headerRow, ...dataRows],
  });
}

export const generateSpecialExamsDoc = async (
  data:       PromotionData,
  groundType: "Financial" | "Compassionate" | "Other",
): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const getGrounds = (s: any): string => {
    const g  = (s.specialGrounds            || "").toLowerCase();
    const r  = (s.remarks                   || "").toLowerCase();
    const lt = (s.academicLeavePeriod?.type || "").toLowerCase();
    const d  = (s.details                   || "").toLowerCase();
    return `${g} ${r} ${lt} ${d}`;
  };

  const isSpecial = (s: any): boolean => /spec/i.test(s.status);

  const list = blocked.filter((s) => {
    if (!isSpecial(s)) return false;
    const g = getGrounds(s);
    if (groundType === "Financial")      return g.includes("financial");
    if (groundType === "Compassionate")  return /compassionate|medical|sick/.test(g);
    return !g.includes("financial") && !/compassionate|medical|sick/.test(g);
  });

  const count            = list.length;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin       = { top: 100, bottom: 100, left: 100, right: 100 };

  console.log(
    `[generateSpecialExamsDoc] groundType="${groundType}" | found=${count}`,
    list.map((s: any) => ({
      regNo:          s.regNo,
      status:         s.status,
      specialGrounds: s.specialGrounds,
      remarks:        s.remarks,
    })),
  );

  const doc = new Document({
    sections: [
      {
        children: [
          ...createDocHeader(
            logoBuffer,
            programName,
            academicYear,
            currentYearOrdinal,
            `SPECIAL EXAMINATIONS (${groundType.toUpperCase()} GROUNDS)`,
            meta,
            examType || "ORDINARY",
          ),

          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing:   { before: 400, after: 300 },
            children: [
              new TextRun({ text: "The following ",                                          size: 22 }),
              new TextRun({ text: `${numberToWords(count)} (${count}) `,  bold: true,        size: 22 }),
              new TextRun({ text: "candidate(s) have special examinations, on ",             size: 22 }),
              new TextRun({ text: `${groundType} Grounds `,               bold: true,        size: 22 }),
              new TextRun({ text: "in the unit(s) indicated against their names during the ", size: 22 }),
              new TextRun({ text: `${academicYear} `,                     bold: true,        size: 22 }),
              new TextRun({ text: "Academic Year, ",                                        size: 22 }),
              new TextRun({ text: `${currentYearOrdinal} Year `,                            size: 22 }),
              new TextRun({ text: "Examinations for the ",                                  size: 22 }),
              new TextRun({ text: `${programName}. `,                     bold: true,        size: 22 }),
              new TextRun({
                text: `The ${meta.schoolName} Board of Examiners upholds the decision of the Dean's Committee. `,
                size: 22,
              }),
            ],
          }),

          createSpecialUnitDetailTable(list, cellMargin),
          ...createDocFooter(meta),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

function createSpecialUnitDetailTable(students: any[], cellMargin: any): Table {
  const headerRow = new TableRow({
    children: [
      { text: "S/No",      w: 5  },
      { text: "Reg No.",   w: 20 },
      { text: "Name",      w: 25 },
      { text: "Unit Code", w: 15 },
      { text: "Unit Name", w: 35 },
    ].map(
      (h) =>
        new TableCell({
          width:    { size: h.w, type: WidthType.PERCENTAGE },
          margins:  cellMargin,
          children: [
            new Paragraph({
              children: [new TextRun({ text: h.text, bold: true, size: 18 })],
            }),
          ],
        }),
    ),
  });

  const rows: TableRow[] = [headerRow];
  let counter = 1;

  for (const s of students) {
    const specialReasons = (s.reasons || []).filter((r: string) =>
      r.toUpperCase().includes("SPECIAL"),
    );

    if (specialReasons.length > 0) {
      specialReasons.forEach((reason: string, idx: number) => {
        const colonIdx = reason.indexOf(":");
        let uCode = "N/A";
        let uName = "N/A";

        if (colonIdx !== -1) {
          uCode = reason.substring(0, colonIdx).trim();
          uName = reason
            .substring(colonIdx + 1)
            .split("(")[0]
            .trim();
        }

        rows.push(
          new TableRow({
            children: [
              new TableCell({
                margins:  cellMargin,
                children: [new Paragraph({ children: [new TextRun({ text: idx === 0 ? String(counter) : "", size: 18 })] })],
              }),
              new TableCell({
                margins:  cellMargin,
                children: [new Paragraph({ children: [new TextRun({ text: idx === 0 ? displayRegNo(s.regNo, s.qualifierSuffix) : "", size: 18 })] })],
              }),
              new TableCell({
                margins:  cellMargin,
                children: [new Paragraph({ children: [new TextRun({ text: idx === 0 ? (s.name || "").toUpperCase() : "", size: 18 })] })],
              }),
              new TableCell({
                margins:  cellMargin,
                children: [new Paragraph({ children: [new TextRun({ text: uCode, size: 18 })] })],
              }),
              new TableCell({
                margins:  cellMargin,
                children: [new Paragraph({ children: [new TextRun({ text: uName, size: 18 })] })],
              }),
            ],
          }),
        );
      });
      counter++;
    } else {
      console.warn(`[createSpecialUnitDetailTable] Student ${s.regNo} has SPEC status but no special reasons listed.`);
      rows.push(
        new TableRow({
          children: [
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: String(counter), size: 18 })] })] }),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: displayRegNo(s.regNo, s.qualifierSuffix), size: 18 })] })] }),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: (s.name || "").toUpperCase(), size: 18 })] })] }),
            new TableCell({ margins: cellMargin, columnSpan: 2, children: [new Paragraph({ children: [new TextRun({ text: "Special exam — unit details pending confirmation.", size: 18, italics: true })] })] }),
          ],
        }),
      );
      counter++;
    }
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:              { style: BorderStyle.NONE },
      bottom:           { style: BorderStyle.NONE },
      left:             { style: BorderStyle.NONE },
      right:            { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical:   { style: BorderStyle.NONE },
    },
    rows,
  });
}

export const generateIncompleteListDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);
  const incompleteList = blocked.filter(s => s.status.includes("INC") && !s.status.includes("SPEC"));
  const count = incompleteList.length;
  const candidateCountWords = numberToWords(count);
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };
  
  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, currentYearOrdinal, "INCOMPLETE", meta, data.examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: `The following `, size: 22 }),
            new TextRun({ text: `${candidateCountWords} (${count}) `, bold: true, size: 22 }),
            new TextRun({ text: `candidate(s) have incomplete results in the unit(s) indicated against their names during the `, size: 22 }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year. These results are pending due to missing CATs or Examination marks.`, size: 22 }),
          ],
        }),
        createStandardUnitDetailTable(incompleteList, cellMargin,"INCOMPLETE"),
        ...createDocFooter(meta),
      ],
    }],
  });
  return await Packer.toBuffer(doc);
};

export const generateStayoutExamsDoc = async ( data: PromotionData ): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);
  
  const stayoutList = blocked.filter((s) => s.status === "STAYOUT");
  const count = stayoutList.length;
  const candidateCountWords = numberToWords(count);
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [
      {
        children: [
          ...createDocHeader( logoBuffer, programName, academicYear, currentYearOrdinal, "STAY OUT / RETAKE", meta, data.examType || "ORDINARY" ),

          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { before: 400, after: 300 },
            children: [
              new TextRun({ text: `The following `, size: 22 }),
              new TextRun({ text: `${candidateCountWords} (${count}) `, bold: true, size: 22  }),
              new TextRun({ text: `candidate(s) failed to satisfy the ${meta.schoolName} Board of Examiners in the unit(s) indicated against their names during the `, size: 22   }),
              new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
              new TextRun({ text: `Academic Year, `, size: 22 }),
              new TextRun({ text: `${currentYearOrdinal} Year `, bold: true, size: 22  }),
              new TextRun({ text: `Examinations for the `, size: 22 }),
              new TextRun({ text: `${programName}. `, bold: true, size: 22  }),
              new TextRun({ text: `The ${meta.schoolName} Board of Examiners recommends that they Stay Out according to `, size: 22 }),         
              new TextRun({
                text: `ENG Rule 15 (h) "A candidate who fails more than a third and less than a half of the prescribed units in any year of study shall be required to retake examinations only in the failed units during the ordinary examination period when examinations for the individual units are offered. Such a candidate will not be allowed to retake examinations during the supplementary period immediately following the ordinary examinations period in which he/she failed the units".`,
                size: 20, bold: true, italics: true,
              }),
            ],
          }),

          createStandardUnitDetailTable(stayoutList, cellMargin),

        ...createDocFooter(meta),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

export const generateRepeatYearDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);
  const list = blocked.filter((s) => s.status === "REPEAT YEAR");
  const count = list.length;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, currentYearOrdinal, "REPEAT YEAR", meta, data.examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: `The following `, size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22  }),
            new TextRun({ text: `candidate(s) failed to satisfy the ${meta.schoolName} Board of Examiners in the unit(s) indicated against their names during the `, size: 22   }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, `, size: 22 }),
            new TextRun({ text: `${currentYearOrdinal} Year `, bold: true, size: 22  }),
            new TextRun({ text: `Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22  }),
            new TextRun({ text: `The ${meta.schoolName} Board of Examiners recommends that they Repeat according to `, size: 22 }),         
            new TextRun({
              text: `ENG Rule 16 (c) "A candidate, who attains an average mark of less than 40% in any year of study based on the marks obtained on the 1st attempt for each unit, shall be required to repeat the entire year. Such a candidate will enrol for all the units and sit for all CATs and assignment and the exams will be marked out of 100%. `,
              size: 20, bold: true, italics: true,
            }),
          ],
        }),

        createStandardUnitDetailTable(list, cellMargin),
        
        ...createDocFooter(meta),
      ],
    }],
  });
  return await Packer.toBuffer(doc);
};

export const generateAcademicLeaveDoc = async (
  data: PromotionData, groundType: "Financial" | "Compassionate" | string, type: "ACADEMIC LEAVE" | "DEFERMENT" | string,
): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const safeType = (type || "ACADEMIC LEAVE").toUpperCase();
  const safeGround = (groundType || "General").toUpperCase();

  const list = (blocked || []).filter((s) => {
    const statusStr = (s.status || "").toUpperCase();
    const isTargetStatus = statusStr.includes(safeType) || statusStr === "ON LEAVE";

    const targetGroundLower = safeGround.toLowerCase();
    const leaveTypeLower = (s.academicLeavePeriod?.type || "").toLowerCase();
    const remarksLower = (s.remarks || "").toLowerCase();

    return ( isTargetStatus && (leaveTypeLower === targetGroundLower || remarksLower.includes(targetGroundLower)));
  });

  const formattedList = list.map((s) => ({
    regNo: s.regNo ? displayRegNo(s.regNo, s.qualifierSuffix) : "N/A",
    name: s.name || "N/A",
    effectiveDate: s.academicLeavePeriod?.startDate ? new Date(s.academicLeavePeriod.startDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "N/A",
    remarks: s.remarks?.includes(":") ? s.remarks.split(":")[1].trim() : s.remarks || "Approved",
  }));

  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [
      {
        children: [
          ...createDocHeader( logoBuffer, programName, academicYear, currentYearOrdinal, `${safeType} (${safeGround} GROUNDS)`, meta, data.examType || "ORDINARY" ),
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { before: 400, after: 300 },
            children: [
              new TextRun({ text: `The following candidate(s) have been officially granted `, size: 22 }),
              new TextRun({ text: `${safeType} `, bold: true, size: 22 }),
              new TextRun({ text: `on `, size: 22 }),
              new TextRun({ text: `${safeGround.toLowerCase()} grounds `, bold: true, size: 22 }),
              new TextRun({ text: `for the `, size: 22 }),
              new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
              new TextRun({ text: `Academic Year. They are expected to resume studies at the beginning of the next academic cycle.`, size: 22 }),
            ],
          }),

          createAdministrativeTable(formattedList, cellMargin),
          ...createDocFooter(meta),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

function createAdministrativeTable(students: any[], cellMargin: any) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({
        children: ["S/No", "Reg No.", "Name", "Effective Date", "Remarks"].map(
          (h) =>
            new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] }) ]}),
        ),
      }),
      ...students.map(
        (s, i) =>
          new TableRow({
            children: [
              new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [ new TextRun({ text: (i + 1).toString(), size: 18 }) ] }) ] }),
              new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [new TextRun({ text: displayRegNo(s.regNo, s.qualifierSuffix), size: 18 })] }) ]}),
              new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [new TextRun({ text: s.name, size: 18 })] }) ]}),
              new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [ new TextRun({ text: s.effectiveDate || "N/A", size: 18 })]}) ]}),
              new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [ new TextRun({ text: s.remarks || "Approved", size: 18 })]}) ]}),
            ],
          }),
      ),
    ],
  });
}

export const generateCarryForwardDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, eligible, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);
  const carryForwardList = eligible.filter((s) => s.reasons?.length > 0 && s.status !== "ALREADY PROMOTED"  );
  const count = carryForwardList.length;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const nextYearOrdinal = getOrdinalYear(yearOfStudy + 1);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, currentYearOrdinal, "CARRY FORWARD", meta, data.examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: `The following `, size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({ text: `candidate(s) satisfied the Board of Examiners in at least two-thirds of the units. In accordance with `, size: 22 }),
            new TextRun({ text: `ENG Rule 13 (e)`, bold: true, size: 22 }),
            new TextRun({ text: `, they are allowed to proceed to `, size: 22 }),
            new TextRun({ text: `${nextYearOrdinal} Year `, bold: true, size: 22 }),
            new TextRun({ text: `but MUST carry forward the failed units indicated against their names to be taken when next offered.`, size: 22 }),
          ],
        }),

        createStandardUnitDetailTable(carryForwardList, cellMargin),
        ...createDocFooter(meta),
      ],
    }],
  });

  return await Packer.toBuffer(doc);
};

export const generateDiscontinuationDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);
  const list = blocked.filter(s => s.status === "CRITICAL FAILURE" || s.status === "DISCONTINUED");
  const count = list.length;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, currentYearOrdinal, "DISCONTINUATION", meta, data.examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({ text: `candidate(s) failed to satisfy the ${meta.schoolName} Board of Examiners in the unit(s) indicated against their names during the `, size: 22   }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, `, size: 22 }),
            new TextRun({ text: `${currentYearOrdinal} Year `, bold: true, size: 22  }),
            new TextRun({ text: `Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22  }),
            new TextRun({ text: `The ${meta.schoolName} Board of Examiners recommends that they be `, size: 22 }),         
            new TextRun({ text: `Discontinued  `, bold:true,  size: 22 }),         
            new TextRun({ text: `according to `, size: 22 }),         
            new TextRun({
              text: `ENG Rule 23 (c) "A candidate who fails third but less than half units of a year of study after the first attempt and subsequently fails the same units after retaking the examinations shall be discontinued."  `,
              size: 20, bold: true, italics: true,
            }),
          ],
        }),
        createStandardUnitDetailTable(list, cellMargin),
        ...createDocFooter(meta),
      ]
    }]
  });
  return await Packer.toBuffer(doc);
};

export const generateDeregistrationDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);
  const list = blocked.filter(s => s.status === "DEREGISTERED");
  const count = list.length;
  const candidateCountWords = numberToWords(count);
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, getOrdinalYear(yearOfStudy), "DEREGISTRATION", meta, data.examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: `The following `, size: 22 }),
            new TextRun({ text: `${candidateCountWords} (${count}) `, bold: true, size: 22  }),
            new TextRun({ text: `candidate(s) failed to satisfy the ${meta.schoolName} Board of Examiners in the unit(s) indicated against their names during the `, size: 22   }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, `, size: 22 }),
            new TextRun({ text: `${currentYearOrdinal} Year `, bold: true, size: 22  }),
            new TextRun({ text: `Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22  }),
            new TextRun({ text: `The ${meta.schoolName} Board of Examiners recommends that they be `, size: 22 }),         
            new TextRun({ text: `Deregistered `, bold:true,  size: 22 }),         
            new TextRun({ text: `according to `, size: 22 }),         
            new TextRun({
              text: `ENG 23 (e) "A candidate who absents himself/herself from all the Special Examinations which he/she was required to sit, or fails to undertake all extra assignments for continuous assessment without good cause, shall be assumed to have deserted the degree course, and shall be deregistered forthwith.  `,
              size: 20, bold: true, italics: true,
            }),
          ],
        }),

        createStandardUnitDetailTable(list, cellMargin),
        ...createDocFooter(meta),
      ]
    }]
  });
  return await Packer.toBuffer(doc);
};

function createStandardUnitDetailTable(students: any[], cellMargin: any, filterKeyword?: string) {
  const headerRow = new TableRow({
    children: [
      { text: "S/No", w: 5 }, { text: "Reg No.", w: 20 }, { text: "Name", w: 25 },
      { text: "Unit Code", w: 15 }, { text: "Unit Name", w: 35 }
    ].map(h => new TableCell({
      width: { size: h.w, type: WidthType.PERCENTAGE },
      margins: cellMargin,
      children: [new Paragraph({ children: [new TextRun({ text: h.text, bold: true, size: 18 })] })]
    }))
  });

  const rows: TableRow[] = [headerRow];
  let studentCounter = 1;

  students.forEach((s) => {
    const relevantReasons = s.reasons?.filter((r: string) => {
      const lowerR = r.toLowerCase();

      const isRuleTag = lowerR.startsWith("eng") || lowerR.includes("failures >") || lowerR.includes("failures >=") || lowerR.includes("mean <");
      if (isRuleTag) return false;

      if (filterKeyword) return lowerR.includes(filterKeyword.toLowerCase());
      return !lowerR.includes("special") && !lowerR.includes("leave");
    }) || [];

    if (relevantReasons.length > 0) {
      relevantReasons.forEach((rawReason: string, index: number) => {
        const isFirstUnit = index === 0;
        let uCode = "N/A";
        let uName = "N/A";

        const colonIndex = rawReason.indexOf(":");
        if (colonIndex !== -1) {
          uCode = rawReason.substring(0, colonIndex).trim();
          const afterColon = rawReason.substring(colonIndex + 1);
          uName = afterColon.split("(")[0].trim();
        }

        rows.push(new TableRow({
          children: [
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: isFirstUnit ? studentCounter.toString() : "", size: 18 })] })] }),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [
              new TextRun({ text: isFirstUnit ? s.regNo : "", size: 18 }),
              ...(isFirstUnit && s.qualifierSuffix ? [new TextRun({ text: s.qualifierSuffix, size: 14, subScript: true })] : []),
            ] })] }),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: isFirstUnit ? s.name : "", size: 18 })] })] }),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: uCode, size: 18 })] })] }),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: uName, size: 18 })] })] }),
          ]
        }));
      });
      studentCounter++;
    } else {
      rows.push(new TableRow({
        children: [
          new TableCell({ margins: cellMargin, children: [new Paragraph({ text: studentCounter.toString() })] }),
          new TableCell({ margins: cellMargin, children: [new Paragraph({ text: displayRegNo(s.regNo, s.qualifierSuffix) })] }),
          new TableCell({ margins: cellMargin, children: [new Paragraph({ text: s.name })] }),
          new TableCell({ margins: cellMargin, columnSpan: 2, children: [new Paragraph({ text: "Refer to individual transcript for unit details." })] }),
        ]
      }));
      studentCounter++;
    }
  });

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
    }, rows });
}

export const generateAwardListDoc = async (data: {
  programName: string;
  academicYear: string;
  yearOfStudy: number;
  logoBuffer: Buffer;
  awardList: AwardListEntry[];
  institutionId: string;
}): Promise<Buffer> => {
  const { programName, academicYear, logoBuffer, awardList, institutionId } =
    data;
  const { meta } = await getDocContext({ institutionId } as PromotionData);

  if (awardList.length === 0) {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: `No eligible graduates found for ${programName} — ${academicYear}.`,
                  bold: true,
                  size: 24,
                }),
              ],
            }),
          ],
        },
      ],
    });
    return Packer.toBuffer(doc);
  }

  const cellMargin = { top: 60, bottom: 60, left: 100, right: 100 };

  const classOrder = [
    "FIRST CLASS HONOURS",
    "SECOND CLASS HONOURS (UPPER DIVISION)",
    "SECOND CLASS HONOURS (LOWER DIVISION)",
    "PASS",
  ];

  const byClass = new Map<string, AwardListEntry[]>();
  classOrder.forEach((c) => byClass.set(c, []));
  awardList.forEach((s) => {
    const key = classOrder.includes(s.classification)
      ? s.classification
      : "PASS";
    byClass.get(key)!.push(s);
  });

  const sections: any[] = [
    ...createDocHeader(
      logoBuffer,
      programName,
      academicYear,
      "Final Year",
      "AWARD LIST", 
      meta,
      "ORDINARY"
    ),

    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 300, after: 400 },
      children: [
        new TextRun({
          text: `The following ${awardList.length} candidate(s) have satisfied the Board of Examiners in all prescribed units. The Board of Examiners recommends that they be `,
          size: 22,
        }),
        new TextRun({
          text: `AWARDED THE DEGREE OF ${programName.toUpperCase()}.`,
          bold: true,
          size: 22,
        }),
      ],
    }),
  ];

  let globalCounter = 1;

  for (const cls of classOrder) {
    const group = byClass.get(cls) || [];
    if (group.length === 0) continue;

    sections.push(
      new Paragraph({
        spacing: { before: 400, after: 150 },
        children: [
          new TextRun({ text: cls, bold: true, size: 24, underline: {} }),
        ],
      }),
    );

    const headerRow = new TableRow({
      children: ["S/No.", "Reg. No.", "Name", "WAA (%)"].map(
        (h) =>
          new TableCell({
            margins: cellMargin,
            children: [
              new Paragraph({
                children: [new TextRun({ text: h, bold: true, size: 20 })],
              }),
            ],
          }),
      ),
    });

    const dataRows = group.map(
      (s) =>
        new TableRow({
          children: [
            new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [new TextRun({ text: String(globalCounter++), size: 20 }) ]}) ]}),
            new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.regNo, size: 20 })] }) ] }),
            new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [new TextRun({ text: formatStudentName(s.name), size: 20 })] })] }),
            new TableCell({ margins: cellMargin, children: [ new Paragraph({ children: [new TextRun({ text: s.waa.toFixed(2), size: 20 })]}) ]}),
          ],
        }),
    );

    sections.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE },
          bottom: { style: BorderStyle.NONE },
          left: { style: BorderStyle.NONE },
          right: { style: BorderStyle.NONE },
          insideHorizontal: { style: BorderStyle.NONE },
          insideVertical: { style: BorderStyle.NONE },
        },
        rows: [headerRow, ...dataRows],
      }),
    );
  }

  sections.push(
    new Paragraph({
      spacing: { before: 500 },
      children: [
        new TextRun({
          text: `TOTAL: ${awardList.length} CANDIDATES`,
          bold: true,
          size: 22,
        }),
      ],
    }),
    ...createDocFooter(meta),
  );

  const doc = new Document({ sections: [{ children: sections }] });
  return Packer.toBuffer(doc);
};

export const generateDefermentDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const list = blocked.filter((s) => s.status === "DEFERMENT");
  const count = list.length;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const formattedList = list.map((s) => ({
    regNo: s.regNo ? displayRegNo(s.regNo, s.qualifierSuffix) : "N/A", name:  s.name  || "N/A",
    effectiveDate: s.academicLeavePeriod?.startDate ? new Date(s.academicLeavePeriod.startDate).toLocaleDateString("en-GB", {day: "2-digit", month: "short", year: "numeric"}) : "N/A",
    endDate: s.academicLeavePeriod?.endDate ? new Date(s.academicLeavePeriod.endDate).toLocaleDateString("en-GB", {day: "2-digit", month: "short", year: "numeric"}) : "N/A",
    remarks: s.remarks?.includes(":") ? s.remarks.split(":")[1].trim() : s.remarks || "Approved",
  }));

  const doc = new Document({
    sections: [
      {
        children: [
          ...createDocHeader( logoBuffer, programName, academicYear, currentYearOrdinal, "DEFERMENT OF ADMISSION", meta, data.examType || "ORDINARY" ),

          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { before: 400, after: 300 },
            children: [
              new TextRun({ text: `The following `, size: 22 }),
              new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
              new TextRun({ text: `candidate(s) have been granted deferment of admission in accordance with `, size: 22 }),
              new TextRun({ text: `ENG Rule 20 `, bold: true, size: 22 }),
              new TextRun({ text: `and are expected to register at the commencement of the academic year following the end of their deferment period.`, size: 22 }),
            ],
          }),

          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
            },
            rows: [
              new TableRow({
                children: ["S/No", "Reg No.", "Name", "From", "To", "Reason"].map(
                  (h) =>
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] })] })
                ),
              }),
              ...formattedList.map((s, i) =>
                new TableRow({
                  children: [
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: (i + 1).toString(), size: 18 })] })] }),
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.regNo, size: 18 })] })] }),
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.name, size: 18 })] })] }),
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.effectiveDate, size: 18 })] })] }),
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.endDate, size: 18 })] })] }),
                    new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.remarks, size: 18 })] })] }),
                  ],
                })
              ),
            ],
          }),

          ...createDocFooter(meta),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

export const generateSupplementaryExamsDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const suppCandidates = blocked.filter(
    (s) =>
      s.status.includes("SUPP") &&
      !s.reasons?.some((r: string) =>
        /stayout|a\/so|repeat\s+year|a\/ra|readmission|readmit|carry\s*forward|a\/cf/i.test(r),
      ),
  );

  const count              = suppCandidates.length;
  const currentYearOrdinal = getOrdinalYear(yearOfStudy);
  const cellMargin         = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, currentYearOrdinal,
          "SUPPLEMENTARY", meta, examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({ text: `candidate(s) failed to satisfy the ${meta.schoolName} Board of Examiners in the unit(s) indicated against their names during the `, size: 22 }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: "Academic Year, ", size: 22 }),
            new TextRun({ text: `${currentYearOrdinal} Year `, bold: true, size: 22 }),
            new TextRun({ text: "Examinations for the ", size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22 }),
            new TextRun({ text: `The ${meta.schoolName} Board of Examiners recommends that they sit for the supplementary exams when next offered. `, size: 22 }),
          ],
        }),
        createStandardUnitDetailTable(suppCandidates, cellMargin, "FAIL"),
        ...createDocFooter(meta),
      ],
    }],
  });

  return Packer.toBuffer(doc);
};

export const generateCarryForwardSuppDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const list = blocked.filter(
    (s) =>
      s.status.includes("SUPP") &&
      s.reasons?.some((r: string) => /carry\s*forward|a\/cf/i.test(r)),
  );

  const count      = list.length;
  const ordinal    = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, ordinal,
          "SUPPLEMENTARY (After Carry Forward)", meta, examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({
              text: `candidate(s) failed their carry-forward supplementary examinations (A/CFS) in the unit(s) indicated against their names during the `,
              size: 22,
            }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, ${ordinal} Year Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22 }),
            new TextRun({
              text: `The ${meta.schoolName} Board of Examiners recommends that they sit for supplementary examinations when next offered.`,
              size: 22,
            }),
          ],
        }),
        createStandardUnitDetailTable(list, cellMargin, "FAIL"),
        ...createDocFooter(meta),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};

export const generateStayoutSuppDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const list = blocked.filter(
    (s) =>
      s.status.includes("SUPP") &&
      s.reasons?.some((r: string) => /stayout|a\/so/i.test(r)),
  );

  const count      = list.length;
  const ordinal    = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, ordinal,
          "SUPPLEMENTARY (After Stayout)", meta, examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({
              text: `candidate(s) were required to stay out and retake examinations. ` +
                `Having now sat for the failed units, they have not fully satisfied the ${meta.schoolName} ` +
                `Board of Examiners in the unit(s) indicated against their names during the `,
              size: 22,
            }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, ${ordinal} Year Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22 }),
            new TextRun({
              text: `The ${meta.schoolName} Board of Examiners recommends that they sit for supplementary examinations (A/SOS) when next offered.`,
              size: 22,
            }),
          ],
        }),
        createStandardUnitDetailTable(list, cellMargin, "FAIL"),
        ...createDocFooter(meta),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};

export const generateRepeatSuppDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const list = blocked.filter(
    (s) =>
      s.status.includes("SUPP") &&
      s.reasons?.some((r: string) => /repeat\s+year|a\/ra/i.test(r)),
  );

  const count      = list.length;
  const ordinal    = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, ordinal,
          "SUPPLEMENTARY (After Repeat Year)", meta, examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({
              text: `candidate(s) were required to repeat the academic year. ` +
                `After repeating, they have not fully satisfied the ${meta.schoolName} Board of Examiners ` +
                `in the unit(s) indicated against their names during the `,
              size: 22,
            }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, ${ordinal} Year Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22 }),
            new TextRun({
              text: `The ${meta.schoolName} Board of Examiners recommends that they sit for supplementary examinations when next offered.`,
              size: 22,
            }),
          ],
        }),
        createStandardUnitDetailTable(list, cellMargin, "FAIL"),
        ...createDocFooter(meta),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};

export const generateReadmissionSuppDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const list = blocked.filter(
    (s) =>
      s.status.includes("SUPP") &&
      s.reasons?.some((r: string) => /readmission|readmit/i.test(r)),
  );

  const count      = list.length;
  const ordinal    = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, ordinal,
          "SUPPLEMENTARY (After Readmission)", meta, examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({
              text: `candidate(s) have been formally readmitted to the programme and have outstanding ` +
                `supplementary examinations in the unit(s) indicated against their names during the `,
              size: 22,
            }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, ${ordinal} Year Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22 }),
            new TextRun({
              text: `The ${meta.schoolName} Board of Examiners recommends that they sit for supplementary examinations when next offered.`,
              size: 22,
            }),
          ],
        }),
        createStandardUnitDetailTable(list, cellMargin, "FAIL"),
        ...createDocFooter(meta),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};

export const generateAcademicLeaveSuppDoc = async (data: PromotionData): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, blocked, institutionId, examType } = data;
  const { meta, logoBuffer } = await getDocContext(data);

  const list = blocked.filter(
    (s) =>
      s.status.includes("SUPP") &&
      s.reasons?.some((r: string) =>
        /academic\s*leave|on\s*leave|a\/sp/i.test(r),
      ),
  );

  const count      = list.length;
  const ordinal    = getOrdinalYear(yearOfStudy);
  const cellMargin = { top: 100, bottom: 100, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, ordinal,
          "SUPPLEMENTARY (After Academic Leave)", meta, examType || "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(count)} (${count}) `, bold: true, size: 22 }),
            new TextRun({
              text: `candidate(s) have resumed studies after academic leave and have outstanding supplementary ` +
                `examinations in the unit(s) indicated against their names during the `,
              size: 22,
            }),
            new TextRun({ text: `${academicYear} `, bold: true, size: 22 }),
            new TextRun({ text: `Academic Year, ${ordinal} Year Examinations for the `, size: 22 }),
            new TextRun({ text: `${programName}. `, bold: true, size: 22 }),
            new TextRun({
              text: `The ${meta.schoolName} Board of Examiners recommends that they sit for supplementary examinations when next offered.`,
              size: 22,
            }),
          ],
        }),
        createStandardUnitDetailTable(list, cellMargin, "FAIL"),
        ...createDocFooter(meta),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};


export const generateSimpleAwardListDoc = async (data: {
  programName:  string;
  academicYear: string;
  yearOfStudy:  number;
  logoBuffer:   Buffer;
  awardList:    AwardListEntry[];
  institutionId: string;
}): Promise<Buffer> => {
  const { programName, academicYear, awardList, institutionId } = data;
  const { meta, logoBuffer } = await getDocContext({ institutionId } as PromotionData);
  const cellMargin = { top: 50, bottom: 50, left: 100, right: 100 };

  const doc = new Document({
    sections: [{
      children: [
        ...createDocHeader(logoBuffer, programName, academicYear, "Final Year", "AWARD LIST", meta, "ORDINARY"),
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 400, after: 300 },
          children: [
            new TextRun({ text: "The following ", size: 22 }),
            new TextRun({ text: `${numberToWords(awardList.length)} (${awardList.length}) `, bold: true, size: 22 }),
            new TextRun({ text: "candidate(s) have satisfied the Board of Examiners in all prescribed units. The Board recommends they be ", size: 22 }),
            new TextRun({ text: `AWARDED THE DEGREE OF ${programName.toUpperCase()}.`, bold: true, size: 22 }),
          ],
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
            left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
            insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
          },
          rows: [
            new TableRow({
              children: [
                new TableCell({ width: { size: 8,  type: WidthType.PERCENTAGE }, margins: cellMargin,
                  children: [new Paragraph({ children: [new TextRun({ text: "S/No.",    bold: true, size: 20 })] })] }),
                new TableCell({ width: { size: 27, type: WidthType.PERCENTAGE }, margins: cellMargin,
                  children: [new Paragraph({ children: [new TextRun({ text: "Reg. No.", bold: true, size: 20 })] })] }),
                new TableCell({ width: { size: 65, type: WidthType.PERCENTAGE }, margins: cellMargin,
                  children: [new Paragraph({ children: [new TextRun({ text: "Name",     bold: true, size: 20 })] })] }),
              ],
            }),
            ...awardList.map((s, i) =>
              new TableRow({
                children: [
                  new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: String(i + 1), size: 20 })] })] }),
                  new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: s.regNo, size: 20 })] })] }),
                  new TableCell({ margins: cellMargin, children: [new Paragraph({ children: [new TextRun({ text: formatStudentName(s.name), size: 20 })] })] }),
                ],
              })
            ),
          ],
        }),
        ...createDocFooter(meta),
      ],
    }],
  });

  return Packer.toBuffer(doc);
};























// New function for individual ineligibility notice
interface IneligibilityNoticeData {
  programName: string;
  academicYear: string;
  yearOfStudy: number;
  logoBuffer: Buffer;
}

export const generateIneligibilityNotice = async (
  student: any,
  data: IneligibilityNoticeData,
): Promise<Buffer> => {
  const { programName, academicYear, yearOfStudy, logoBuffer } = data;

  const capitalizedStudentName = formatStudentName(student.name).toUpperCase();
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // 1. LOGO
          ...(logoBuffer.length > 0
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new ImageRun({
                      data: logoBuffer,
                      transformation: { width: 150, height: 80 },
                      type: "png",
                    }),
                  ],
                }),
              ]
            : []),

          // 2. HEADERS (Consistent with Pass List)
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 100 },
            children: [
              new TextRun({
                text: config.instName.toUpperCase(),
                bold: true,
                size: 24,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: config.schoolName.toUpperCase(),
                bold: true,
                size: 20,
              }),
            ],
          }),

          // 3. INTERNAL MEMO STYLE ADDRESSING
          new Paragraph({
            spacing: { before: 400 },
            children: [
              new TextRun({ text: "TO: ", bold: true }),
              new TextRun({ text: capitalizedStudentName }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "REG NO: ", bold: true }),
              new TextRun({ text: student.regNo }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "PROGRAM: ", bold: true }),
              new TextRun({ text: programName.toUpperCase() }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "ACADEMIC YEAR: ", bold: true }),
              new TextRun({ text: academicYear }),
            ],
          }),

          // 4. SUBJECT LINE
          new Paragraph({
            spacing: { before: 400, after: 400 },
            children: [
              new TextRun({
                text: `RE: INELIGIBILITY FOR PROMOTION TO YEAR ${yearOfStudy + 1}`,
                bold: true,
                size: 22,
                underline: {},
              }),
            ],
          }),

          // 5. BODY TEXT
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: "Following the School Board of Examiners meeting, it was noted that you did not satisfy the examiners in the following units during the current academic year:",
                size: 20,
              }),
            ],
          }),

          // 6. UNIT LIST (Dynamically rendered from student.reasons)
          ...student.reasons.map(
            (unitString: string) =>
              new Paragraph({
                bullet: { level: 0 },
                spacing: { before: 150 },
                children: [
                  new TextRun({
                    text: unitString,
                    bold: true,
                    size: 19,
                  }),
                ],
              }),
          ),

          new Paragraph({
            spacing: { before: 300, after: 200 },
            children: [
              new TextRun({
                text: "Consequently, you are not eligible for promotion. You are advised to prepare for Supplementary Examinations or register for Retakes as per the University Examination Regulations.",
                size: 20,
              }),
            ],
          }),

          new Paragraph({
            spacing: { after: 400 },
            children: [
              new TextRun({
                text: `Please contact the Office of the Dean, ${config.schoolName}, for the schedule of supplementary examinations.`,
                size: 20,
              }),
            ],
          }),

          // 7. SIGNATORY
          new Paragraph({
            spacing: { before: 600, after: 400 },
            children: [
              new TextRun({
                text: `APPROVED BY THE BOARD OF EXAMINERS, ${config.schoolName.toUpperCase()}`,
                bold: true,
                size: 18,
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 400 },
            children: [
              new TextRun({
                text: "SIGNED: __________________________\t\tDATE: _______________",
                bold: true,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `\tDEAN, ${config.schoolName.toUpperCase()}`,
                size: 18,
              }),
            ],
          }),

          new Paragraph({
            spacing: { before: 400 },
            children: [
              new TextRun({
                text: "Cc: Registrar (Academic Affairs)\n    ",
                size: 16,
              }),
            ],
          }),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

// New function for Special Exam Notice
export const generateSpecialExamNotice = async (
  student: any,
  data: any,
): Promise<Buffer> => {
  const { programName, academicYear, logoBuffer } = data;
  const capitalizedStudentName = formatStudentName(student.name).toUpperCase();

  const specialUnits = student.reasons
    .filter((r: string) => r.toUpperCase().includes("SPECIAL"))
    .map((r: string) =>
      r.replace("- SPECIAL", "").replace("SPECIAL", "").trim(),
    );

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // 1. LOGO
          ...(logoBuffer.length > 0
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new ImageRun({
                      data: logoBuffer,
                      transformation: { width: 150, height: 80 },
                      type: "png",
                    }),
                  ],
                }),
              ]
            : []),

          // 2. HEADERS
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: config.instName.toUpperCase(),
                bold: true,
                size: 24,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: config.schoolName.toUpperCase(),
                bold: true,
                size: 20,
              }),
            ],
          }),

          // 3. ADDRESSING
          new Paragraph({
            spacing: { before: 400 },
            children: [
              new TextRun({ text: "TO: ", bold: true }),
              new TextRun({ text: capitalizedStudentName }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "REG NO: ", bold: true }),
              new TextRun({ text: student.regNo }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "PROGRAM: ", bold: true }),
              new TextRun({ text: programName.toUpperCase() }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "ACADEMIC YEAR: ", bold: true }),
              new TextRun({ text: academicYear }),
            ],
          }),

          // 4. SUBJECT
          new Paragraph({
            spacing: { before: 400, after: 400 },
            children: [
              new TextRun({
                text: "RE: APPROVAL TO SIT FOR SPECIAL EXAMINATIONS",
                bold: true,
                size: 22,
                underline: { type: BorderStyle.SINGLE },
              }),
            ],
          }),

          // 5. BODY
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: `This is to inform you that the College Board of Examiners has approved your request to sit for Special Examinations in the following unit(s) during the ${academicYear} academic cycle:`,
                size: 20,
              }),
            ],
          }),

          // DYNAMIC UNIT LIST
          ...specialUnits.map(
            (unitName: string) =>
              new Paragraph({
                bullet: { level: 0 },
                spacing: { before: 100 },
                children: [
                  new TextRun({ text: unitName, bold: true, size: 20 }),
                ],
              }),
          ),

          new Paragraph({
            spacing: { before: 300, after: 200 },
            children: [
              new TextRun({
                text: "Please note that a Special Examination is treated as a first attempt. Failure to sit for these exams will result in the units being graded as 'Incomplete'.",
                size: 20,
              }),
            ],
          }),

          new Paragraph({
            spacing: { after: 400 },
            children: [
              new TextRun({
                text: "Check the departmental notice board for the scheduled dates and venues.",
                size: 20,
              }),
            ],
          }),

          // 7. SIGNATORY
          new Paragraph({
            spacing: { before: 800 },
            children: [
              new TextRun({
                text: "SIGNED: __________________________\t\tDATE: _______________",
                bold: true,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `\tDEAN, ${config.schoolName.toUpperCase()}`,
                size: 18,
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 400 },
            children: [new TextRun({ text: "Cc: Exam Coordinator", size: 16 })],
          }),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

export const generateStudentTranscript = async (
  student: any,
  results: any[],
  data: any,
): Promise<Buffer> => {
  const { programName, academicYear, logoBuffer, status } = data;

  // Use the value passed from the controller, falling back to student record if needed
  const displayYear =
    data.yearToPromote ||
    data.yearOfStudy ||
    student.currentYearOfStudy ||
    "N/A";

  const cellMargin = { top: 80, bottom: 80, left: 100, right: 100 };

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // 1. LOGO (Same 80x80 size as Summary)
          ...(logoBuffer.length > 0
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new ImageRun({
                      data: logoBuffer,
                      transformation: { width: 150, height: 80 },
                      type: "png",
                    }),
                  ],
                }),
              ]
            : []),

          // 2. INSTITUTIONAL HEADERS
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 50, after: 100 },
            children: [
              new TextRun({
                text: config.instName.toUpperCase(),
                bold: true,
                size: 24,
              }),
            ],
          }),

          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 50 },
            children: [
              new TextRun({
                text: config.postalAddress,

                size: 18,
              }),
            ],
          }),

          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 50 },
            children: [
              new TextRun({
                text: "Cell Phone",

                size: 18,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 50 },
            children: [
              new TextRun({
                text: config.cellPhone,

                size: 18,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 },
            children: [
              new TextRun({
                text: `Email: ${config.schoolEmail}`,

                size: 18,
              }),
            ],
          }),

          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: "UNDERGRADUATE ACADEMIC TRANSCRIPT",
                bold: true,
                size: 20,
                underline: {},
              }),
            ],
          }),

          // 3. STUDENT PROFILE BOX
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              // top: { style: BorderStyle.NONE },
              top: {
                style: BorderStyle.SINGLE,
                size: 16, // 2pt thickness
                color: "000000", // Optional: black
              },
              bottom: { style: BorderStyle.NONE },
              left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE },
              insideHorizontal: { style: BorderStyle.NONE },
              insideVertical: { style: BorderStyle.NONE },
            },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: "NAME: ",
                            bold: true,
                            size: 20,
                          }),
                          new TextRun({
                            text: formatStudentName(student.name).toUpperCase(),
                            bold: false,
                            size: 20,
                          }),
                        ],
                      }),
                    ],
                  }),
                  new TableCell({
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [
                          new TextRun({
                            text: "REG NO: ",
                            bold: true,
                            size: 20,
                          }),
                          new TextRun({
                            text: student.regNo,
                            bold: false,
                            size: 20,
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 100 },
            children: [
              new TextRun({
                text: "SCHOOL: ",
                bold: true,
                size: 18,
              }),
              new TextRun({
                text: config.schoolName.toUpperCase(),
                bold: false,
                size: 18,
              }),
            ],
          }),

          // 5. Programme name
          new Paragraph({
            spacing: { before: 100 },
            children: [
              new TextRun({
                text: "PROGRAM: ",
                bold: true,
                size: 18,
              }),
              new TextRun({
                text: `${programName.toUpperCase()}`,
                size: 18,
              }),
            ],
          }),

          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE },
              bottom: { style: BorderStyle.NONE },
              left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE },
              insideHorizontal: { style: BorderStyle.NONE },
              insideVertical: { style: BorderStyle.NONE },
            },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    width: { size: 70, type: WidthType.PERCENTAGE },
                    children: [
                      new Paragraph({
                        spacing: { before: 100, after: 300 },
                        children: [
                          new TextRun({
                            text: "ACADEMIC YEAR: ",
                            bold: true,
                            size: 20,
                          }),
                          new TextRun({
                            text: academicYear || "N/A",
                            bold: false,
                            size: 20,
                          }),
                        ],
                      }),
                    ],
                  }),
                  new TableCell({
                    width: { size: 30, type: WidthType.PERCENTAGE },
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [
                          new TextRun({
                            text: "YEAR OF STUDY: ",
                            bold: true,
                            size: 20,
                          }),
                          new TextRun({
                            text: `${displayYear}`,
                            bold: false,
                            size: 20,
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),

          //  STATUS SUMMARY
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: "RESULT:  PASS",
                bold: true,
                size: 20,
                underline: {},
              }),
            ],
          }),

          // 4. RESULTS TABLE (Units & Grades)
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            borders: {
              top: { style: BorderStyle.SINGLE, size: 2 },
              bottom: { style: BorderStyle.SINGLE, size: 2 },
              left: { style: BorderStyle.SINGLE, size: 2 },
              right: { style: BorderStyle.SINGLE, size: 2 },
              insideVertical: { style: BorderStyle.SINGLE, size: 2 },
              insideHorizontal: { style: BorderStyle.NIL },
            },
            rows: [
              // Header Row
              new TableRow({
                tableHeader: true,
                children: [
                  new TableCell({
                    width: { size: 15, type: WidthType.PERCENTAGE }, // Narrower Code
                    margins: cellMargin,
                    verticalAlign: VerticalAlign.CENTER,
                    borders: {
                      bottom: { style: BorderStyle.SINGLE, size: 2 },
                      top: { style: BorderStyle.SINGLE, size: 2 },
                    },
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({ text: "CODE", bold: true, size: 18 }),
                        ],
                      }),
                    ],
                  }),
                  new TableCell({
                    width: { size: 70, type: WidthType.PERCENTAGE }, // Larger Title
                    margins: cellMargin,
                    verticalAlign: VerticalAlign.CENTER,
                    borders: {
                      bottom: { style: BorderStyle.SINGLE, size: 2 },
                      top: { style: BorderStyle.SINGLE, size: 2 },
                    },
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: "COURSE UNIT TITLE",
                            bold: true,
                            size: 18,
                          }),
                        ],
                      }),
                    ],
                  }),
                  new TableCell({
                    width: { size: 15, type: WidthType.PERCENTAGE }, // Narrower Grade
                    margins: cellMargin,
                    verticalAlign: VerticalAlign.CENTER,
                    borders: {
                      bottom: { style: BorderStyle.SINGLE, size: 2 },
                      top: { style: BorderStyle.SINGLE, size: 2 },
                    },
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [
                          new TextRun({ text: "GRADE", bold: true, size: 18 }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              // Data Rows
              ...results.map((r: any, index: number) => {
                const unitCode = String(r?.code ?? "N/A").toUpperCase();
                const unitName = String(
                  r?.name ?? "COURSE TITLE MISSING",
                ).toUpperCase();
                const unitGrade = String(r?.grade ?? "-");

                const isLastRow = index === results.length - 1;
                const bottomBorderStyle = isLastRow
                  ? BorderStyle.SINGLE
                  : BorderStyle.NIL;
                const bottomBorderSize = isLastRow ? 2 : 0;

                return new TableRow({
                  children: [
                    new TableCell({
                      width: { size: 15, type: WidthType.PERCENTAGE },
                      margins: cellMargin,
                      verticalAlign: VerticalAlign.CENTER,
                      borders: {
                        bottom: {
                          style: bottomBorderStyle,
                          size: bottomBorderSize,
                        },
                      },
                      children: [
                        new Paragraph({
                          spacing: { after: 10 },
                          children: [new TextRun({ text: unitCode, size: 18 })],
                        }),
                      ],
                    }),
                    new TableCell({
                      width: { size: 70, type: WidthType.PERCENTAGE },
                      margins: cellMargin,
                      verticalAlign: VerticalAlign.CENTER,
                      borders: {
                        bottom: {
                          style: bottomBorderStyle,
                          size: bottomBorderSize,
                        },
                      },
                      children: [
                        new Paragraph({
                          spacing: { after: 10 },
                          children: [new TextRun({ text: unitName, size: 18 })],
                        }),
                      ],
                    }),
                    new TableCell({
                      width: { size: 15, type: WidthType.PERCENTAGE },
                      margins: cellMargin,
                      verticalAlign: VerticalAlign.CENTER,
                      borders: {
                        bottom: {
                          style: bottomBorderStyle,
                          size: bottomBorderSize,
                        },
                      },
                      children: [
                        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 10 }, children: [ new TextRun({ text: unitGrade, bold: true, size: 18 }) ]    }),
                      ],
                    }),
                  ],
                });
              }),
            ],
          }),

        new Paragraph({ alignment: AlignmentType.CENTER, spacing: {  before: 200 }, children: [ ] }),

          // 6. GRADING KEY (Formal Table Structure)
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
            },
            rows: [
              new TableRow({
                children: [
                  // LEFT CELL: The Grading Key Table
                  new TableCell({
                    width: { size: 40, type: WidthType.PERCENTAGE },
                    children: [
                      new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        borders: {
                          top: { style: BorderStyle.SINGLE, size: 1 }, bottom: { style: BorderStyle.SINGLE, size: 1 }, left: { style: BorderStyle.SINGLE, size: 1 },
                          right: { style: BorderStyle.SINGLE, size: 1 }, insideVertical: { style: BorderStyle.SINGLE, size: 1 }, insideHorizontal: { style: BorderStyle.NONE },
                        },
                        rows: [
                          // Header Row
                          new TableRow({
                            tableHeader: true,
                            children: [["GRADE", 20], ["RANGE", 30], ["DESCRIPTION", 50]].map(
                              ([text, width]) =>
                                new TableCell({
                                  width: { size: width as number, type: WidthType.PERCENTAGE },
                                  shading: { fill: "F2F2F2" },
                                  children: [ new Paragraph({ alignment: AlignmentType.CENTER, children: [ new TextRun({ text: text as string, bold: true, size: 16 })] })],
                                }),
                            ),
                          }),
                          // Data Rows
                          ...[{ g: "A", r: "70 - 100%", d: "EXCELLENT" }, { g: "B", r: "60 - 69%", d: "GOOD" }, { g: "C", r: "50 - 59%", d: "SATISFACTORY" }, { g: "D", r: "40 - 49%", d: "PASS" }, { g: "E", r: "0 - 39%", d: "FAIL" }].map(
                            (item) =>
                              new TableRow({
                                children: [
                                  new TableCell({ children: [ new Paragraph({ alignment: AlignmentType.CENTER, children: [ new TextRun({ text: item.g, size: 16 })]}) ] }),
                                  new TableCell({ children: [ new Paragraph({ alignment: AlignmentType.CENTER, children: [  new TextRun({ text: item.r, size: 16 }) ]}) ]}),
                                  new TableCell({ children: [ new Paragraph({ alignment: AlignmentType.CENTER, children: [ new TextRun({ text: item.d, size: 16 })] }) ] }),
                                ],
                              }),
                          ),
                        ],
                      }),
                    ],
                  }),
                  // RIGHT CELL: Registration Number
                  new TableCell({
                    width: { size: 30, type: WidthType.PERCENTAGE },
                    verticalAlign: VerticalAlign.BOTTOM, 
                    children: [
                      new Paragraph({ alignment: AlignmentType.RIGHT, children: [ new TextRun({ text: "NB: ", bold: true, size: 20 }) ]}),
                      new Paragraph({ alignment: AlignmentType.RIGHT, children: [ new TextRun({ text: "1 unit consists of 35 lecture hours or equivalent (3 Practical hours of two tutorial hours are equivalent to 0ne lecture hour ) ", bold: false, size: 16 }) ]}),
                    ],
                  }),
                ],
              }),
            ],
          }),

          // 7. FOOTER & SIGNATORIES
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
            },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [
                      new Paragraph({ spacing: { before: 800 }, children: [ new TextRun({ text: "SIGNED: __________________________________________", bold: true }) ]}),
                      new Paragraph({ children: [ new TextRun({ text: `DEAN, ${config.schoolName.toUpperCase()}`, bold: true, size: 18 }) ]}),
                    ],
                  }),
                  new TableCell({
                    children: [
                      new Paragraph({ spacing: { before: 800 }, children: [ new TextRun({ text: "SIGNED: __________________________________________", bold: true }) ]}),
                      new Paragraph({ children: [ new TextRun({ text: `REGISTRAR, ${config.registrar.toUpperCase()}`, bold: true, size: 18 }) ] }),
                    ]
                  }),
                ],
              }),
            ],
          }),

          new Paragraph({ spacing: { before: 100 }, children: [ new TextRun({ text: `DATE OF ISSUE: ${new Date().toLocaleDateString()}`, size: 14, italics: true }) ]}),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400 }, children: [ new TextRun({ text: "--- This result slip is issued without any erasures or alterations ---", italics: true, size: 14 }) ]}),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
};

