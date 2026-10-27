// // Fills marks on DIRECT scoresheets downloaded from Upload Results so every student passes.
// // Writes <name>_FILLED.xlsx next to each input; the originals are untouched.
// //   node scripts/fill-scoresheets.js "C:\path\Scoresheet_*.xlsx"      (a folder also works)
// //   node scripts/fill-scoresheets.js ./downloads --level 0.72         (average performance, 0.45–0.95)
// const ExcelJS = require("exceljs");
// const fs = require("fs");
// const path = require("path");

// const argv = process.argv.slice(2);
// const li = argv.indexOf("--level");
// const level = li >= 0 ? Number(argv.splice(li, 2)[1]) : 0.72;
// if (!argv.length) { console.error("Give one or more .xlsx files, or a folder."); process.exit(1); }

// const FIRST_DATA_ROW = 16; // the system reads from row 16; B = Reg No, E = CA total, F = Exam total
// const maxOf = (v) => { const m = /\/\s*(\d+)/.exec(String(v ?? "")); return m ? Number(m[1]) : null; };
// const cellText = (v) => String(v && typeof v === "object" ? (v.result ?? v.text ?? "") : (v ?? "")).trim();
// const hash = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 100 / 100; };

// // expand arguments: files, folders, and simple * patterns in the file name
// const files = [];
// for (const a of argv) {
//   if (a.includes("*")) {
//     const dir = path.dirname(a), re = new RegExp("^" + path.basename(a).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
//     fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => re.test(f)).forEach((f) => files.push(path.join(dir, f)));
//   } else if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
//     fs.readdirSync(a).filter((f) => /\.xlsx$/i.test(f)).forEach((f) => files.push(path.join(a, f)));
//   } else files.push(a);
// }
// const todo = [...new Set(files)].filter((f) => /\.xlsx$/i.test(f) && !/_FILLED\.xlsx$/i.test(f) && !path.basename(f).startsWith("~$"));
// if (!todo.length) { console.error("No .xlsx scoresheets found."); process.exit(1); }

// (async () => {
//   let bad = 0;
//   for (const f of todo) {
//     const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
//     const ws = wb.worksheets[0];
//     const caMax = maxOf(ws.getCell("E15").value), exMax = maxOf(ws.getCell("F15").value);
//     if (!caMax || !exMax) { console.log(`SKIP ${path.basename(f)}: not a direct scoresheet (E15/F15 = ${cellText(ws.getCell("E15").value)} / ${cellText(ws.getCell("F15").value)})`); bad++; continue; }
//     let n = 0;
//     for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
//       const reg = cellText(ws.getCell(`B${r}`).value);
//       if (!reg || /^reg\.? ?no\.?$/i.test(reg)) continue;
//       const lvl = Math.min(0.92, Math.max(0.55, level + (hash(reg + path.basename(f)) - 0.5) * 0.3));
//       ws.getCell(`E${r}`).value = Math.round(caMax * lvl);
//       ws.getCell(`F${r}`).value = Math.round(exMax * lvl);
//       n++;
//     }
//     const out = f.replace(/\.xlsx$/i, "_FILLED.xlsx");
//     await wb.xlsx.writeFile(out);
//     console.log(`OK   ${path.basename(f)}: ${n} students filled (CA/${caMax}, Exam/${exMax}) -> ${path.basename(out)}`);
//   }
//   process.exit(bad ? 1 : 0);
// })();


// // node scripts/fill-scoresheets.js "C:\Users\newti\Downloads\Scoresheets\ScoresheetsY1"




// Fills marks on DIRECT and DETAILED scoresheets downloaded from Upload Results so every student passes.
// Detailed sheets: fills CAT/assignment/practical/question columns AND the calculated columns (CA total, exam,
// internal, agreed) so the file uploads correctly even though it was never opened in Excel.
// Writes <name>_FILLED.xlsx next to each input; the originals are untouched.
//   node scripts/fill-scoresheets.js "C:\path\Scoresheet_*.xlsx"      (a folder also works)
//   node scripts/fill-scoresheets.js ./downloads --level 0.72         (average performance, 0.45–0.95)
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const li = argv.indexOf("--level");
const level = li >= 0 ? Number(argv.splice(li, 2)[1]) : 0.72;
if (!argv.length) { console.error("Give one or more .xlsx files, or a folder."); process.exit(1); }

const FIRST_DATA_ROW = 16; // the system reads from row 16; B = Reg No, E = CA total, F = Exam total
const maxOf = (v) => { const m = /\/\s*(\d+)/.exec(String(v ?? "")); return m ? Number(m[1]) : null; };
const cellText = (v) => String(v && typeof v === "object" ? (v.result ?? v.text ?? "") : (v ?? "")).trim();
const hash = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 100 / 100; };

// expand arguments: files, folders, and simple * patterns in the file name
const files = [];
for (const a of argv) {
  if (a.includes("*")) {
    const dir = path.dirname(a), re = new RegExp("^" + path.basename(a).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => re.test(f)).forEach((f) => files.push(path.join(dir, f)));
  } else if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
    fs.readdirSync(a).filter((f) => /\.xlsx$/i.test(f)).forEach((f) => files.push(path.join(a, f)));
  } else files.push(a);
}
const todo = [...new Set(files)].filter((f) => /\.xlsx$/i.test(f) && !/_FILLED\.xlsx$/i.test(f) && !path.basename(f).startsWith("~$"));
if (!todo.length) { console.error("No .xlsx scoresheets found."); process.exit(1); }

// ── Detailed (breakdown) scoresheet: inputs E-G CATs, I-K assignments, M practical, O-S exam questions.
//    Calculated columns are formulas in the template, so we also store their results (same maths as the template).
function fillDetailed(ws, f, level) {
  const START = 17;
  const num = (a) => Number(cellText(ws.getCell(a).value)) || 0;
  const meta = cellText(ws.getCell("Z1").value);
  const type = (/TYPE:(theory|lab|workshop)/.exec(meta) || [])[1] || "theory";
  const mode = (/MODE:(\w+)/.exec(meta) || [])[1] || "standard";
  const catMax = [num("E16"), num("F16"), num("G16")], assMax = num("I16"), pracMax = num("M16");
  const caW = num("N16"), exW = num("T16"), q1Max = num("O16");
  const fct = caW / 30;
  const w = type === "workshop" ? { practical: caW, assignment: 0, tests: 0 }
    : type === "lab" ? { practical: 15 * fct, assignment: 5 * fct, tests: 10 * fct }
    : { practical: 0, assignment: 10 * fct, tests: 20 * fct };
  const take = mode === "mandatory_q1" ? 2 : 3;
  const setVal = (addr, v) => { const c = ws.getCell(addr); const cur = c.value; c.value = cur && typeof cur === "object" && cur.formula ? { formula: cur.formula, result: v } : v; };
  let n = 0;
  for (let r = START; r <= ws.rowCount; r++) {
    const reg = cellText(ws.getCell(`B${r}`).value);
    if (!reg) continue;
    const lvl = Math.min(0.92, Math.max(0.55, level + (hash(reg + path.basename(f)) - 0.5) * 0.3));
    const jig = (k) => Math.min(1, Math.max(0.3, lvl + (hash(reg + k) - 0.5) * 0.2));
    const att = cellText(ws.getCell(`D${r}`).value);
    const caMult = ["A/S", "SUPP", "A/CF"].includes(att.toUpperCase()) ? 0 : 1;
    const cats = catMax.map((m, i) => (type === "workshop" ? 0 : Math.round(m * jig("c" + i))));
    const asg = [0, 1, 2].map((i) => (type === "workshop" ? 0 : Math.round(assMax * jig("a" + i))));
    const prac = type === "theory" ? 0 : Math.round(pracMax * jig("p"));
    const q1 = Math.round(q1Max * jig("q1"));
    const qs = [2, 3, 4, 5].map((i) => Math.round(20 * jig("q" + i)));
    if (type !== "workshop") {
      ["E", "F", "G"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = cats[i]));
      ["I", "J", "K"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = asg[i]));
    }
    if (type !== "theory") ws.getCell(`M${r}`).value = prac;
    ws.getCell(`O${r}`).value = q1;
    ["P", "Q", "R", "S"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = qs[i]));
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const H = type === "workshop" ? 0 : (avg(cats) / (catMax[0] || 1)) * w.tests;
    const L = type === "workshop" ? 0 : (avg(asg) / (assMax || 1)) * w.assignment;
    const P = type === "theory" ? 0 : (prac / (pracMax || 1)) * w.practical;
    const N = Math.round((H + L + P) * caMult * 100) / 100;
    const top = [...qs].sort((a, b) => b - a).slice(0, take).reduce((x, y) => x + y, 0);
    const T = Math.round(((q1 + top) / 70) * exW * 100) / 100;
    const U = Math.round(N + T);
    setVal(`H${r}`, H); setVal(`L${r}`, L); setVal(`N${r}`, N); setVal(`T${r}`, T); setVal(`U${r}`, U); setVal(`W${r}`, U);
    n++;
  }
  console.log(`OK   ${path.basename(f)}: ${n} students filled (DETAILED, ${type}, CA/${caW} Exam/${exW}) -> ${path.basename(f).replace(/\.xlsx$/i, "_FILLED.xlsx")}`);
  return true;
}

(async () => {
  let bad = 0;
  for (const f of todo) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
    const ws = wb.worksheets[0];
    if (/^cat\s*1/i.test(cellText(ws.getCell("E15").value))) { bad += fillDetailed(ws, f, level) ? 0 : 1; await wb.xlsx.writeFile(f.replace(/\.xlsx$/i, "_FILLED.xlsx")); continue; }
    const caMax = maxOf(ws.getCell("E15").value), exMax = maxOf(ws.getCell("F15").value);
    if (!caMax || !exMax) { console.log(`SKIP ${path.basename(f)}: not a direct scoresheet (E15/F15 = ${cellText(ws.getCell("E15").value)} / ${cellText(ws.getCell("F15").value)})`); bad++; continue; }
    let n = 0;
    for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
      const reg = cellText(ws.getCell(`B${r}`).value);
      if (!reg || /^reg\.? ?no\.?$/i.test(reg)) continue;
      const lvl = Math.min(0.92, Math.max(0.55, level + (hash(reg + path.basename(f)) - 0.5) * 0.3));
      ws.getCell(`E${r}`).value = Math.round(caMax * lvl);
      ws.getCell(`F${r}`).value = Math.round(exMax * lvl);
      n++;
    }
    const out = f.replace(/\.xlsx$/i, "_FILLED.xlsx");
    await wb.xlsx.writeFile(out);
    console.log(`OK   ${path.basename(f)}: ${n} students filled (CA/${caMax}, Exam/${exMax}) -> ${path.basename(out)}`);
  }
  process.exit(bad ? 1 : 0);
})();