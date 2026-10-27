// Builds the two Excel files for Test 1 (run from the serverside folder):
//   node scripts/make-test-files.js --program "BSC-CE"
// --program  programme CODE or NAME exactly as in the system (required)
// Optional: --count 21 --first-serial 1337 --intake-year 2013 --intake "" --unit-prefix TST --units-per-year 7,9,11,9,7 --out ./testkit
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1] ?? ""]] : acc), []));
if (!args.program) { console.error('Missing --program. Example: node scripts/make-test-files.js --program "BSC-CE"'); process.exit(1); }
const count = Number(args.count || 21), first = Number(args["first-serial"] || 1337), iy = args["intake-year"] || "2013";
const prefix = args["unit-prefix"] || "TST", perYear = (args["units-per-year"] || "7,9,11,9,7").split(",").map(Number);
const out = args.out || "./testkit"; fs.mkdirSync(out, { recursive: true });

const head = (ws, row, labels) => {
  const r = ws.getRow(row);
  labels.forEach((h, i) => {
    const c = r.getCell(i + 1); c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
    c.alignment = { horizontal: "center" };
  });
};

(async () => {
  // students
  let wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Registration Template");
  ws.getCell("A1").value = "TEST 1 — 21 STUDENTS";
  head(ws, 4, ["Reg No", "Full Name", "Program", "Year of Study", "Intake", "Qualifier (optional)"]);
  for (let n = 0; n < count; n++)
    ws.getRow(5 + n).values = [`E024-01-${first + n}/${iy}`, `Test Student ${String(n + 1).padStart(2, "0")}`, args.program, 1, args.intake || "", ""];
  ws.columns = [24, 24, 28, 14, 10, 20].map((width) => ({ width }));
  await wb.xlsx.writeFile(path.join(out, "test1_students.xlsx"));

  // curriculum
  wb = new ExcelJS.Workbook(); ws = wb.addWorksheet("Curriculum");
  ws.getCell("A1").value = "CURRICULUM — TEST 1";
  head(ws, 4, ["Unit Code", "Unit Name", "Year of Study", "Semester", "Type"]);
  let row = 5;
  perYear.forEach((n, yi) => {
    const y = yi + 1, sem1 = Math.ceil(n / 2);
    for (let k = 1; k <= n; k++) {
      const sem = k <= sem1 ? 1 : 2;
      ws.getRow(row++).values = [`${prefix} ${y}${sem}${String(k).padStart(2, "0")}`, `Test Unit Y${y} S${sem} No.${k}`, y, sem, "Core"];
    }
  });
  ws.columns = [16, 40, 14, 10, 10].map((width) => ({ width }));
  await wb.xlsx.writeFile(path.join(out, "test1_curriculum.xlsx"));
  console.log(`students: ${count} | units: ${row - 5} (${perYear.join("+")}) -> ${path.resolve(out)}`);
})();


// node scripts/make-test-files.js --program "YOUR-PROGRAMME" --count 700
 