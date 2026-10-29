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




// // Fills marks on DIRECT and DETAILED scoresheets downloaded from Upload Results so every student passes.
// // Detailed sheets: fills CAT/assignment/practical/question columns AND the calculated columns (CA total, exam,
// // internal, agreed) so the file uploads correctly even though it was never opened in Excel.
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

// // ── Detailed (breakdown) scoresheet: inputs E-G CATs, I-K assignments, M practical, O-S exam questions.
// //    Calculated columns are formulas in the template, so we also store their results (same maths as the template).
// function fillDetailed(ws, f, level) {
//   const START = 17;
//   const num = (a) => Number(cellText(ws.getCell(a).value)) || 0;
//   const meta = cellText(ws.getCell("Z1").value);
//   const type = (/TYPE:(theory|lab|workshop)/.exec(meta) || [])[1] || "theory";
//   const mode = (/MODE:(\w+)/.exec(meta) || [])[1] || "standard";
//   const catMax = [num("E16"), num("F16"), num("G16")], assMax = num("I16"), pracMax = num("M16");
//   const caW = num("N16"), exW = num("T16"), q1Max = num("O16");
//   const fct = caW / 30;
//   const w = type === "workshop" ? { practical: caW, assignment: 0, tests: 0 }
//     : type === "lab" ? { practical: 15 * fct, assignment: 5 * fct, tests: 10 * fct }
//     : { practical: 0, assignment: 10 * fct, tests: 20 * fct };
//   const take = mode === "mandatory_q1" ? 2 : 3;
//   const setVal = (addr, v) => { const c = ws.getCell(addr); const cur = c.value; c.value = cur && typeof cur === "object" && cur.formula ? { formula: cur.formula, result: v } : v; };
//   let n = 0;
//   for (let r = START; r <= ws.rowCount; r++) {
//     const reg = cellText(ws.getCell(`B${r}`).value);
//     if (!reg) continue;
//     const lvl = Math.min(0.92, Math.max(0.55, level + (hash(reg + path.basename(f)) - 0.5) * 0.3));
//     const jig = (k) => Math.min(1, Math.max(0.3, lvl + (hash(reg + k) - 0.5) * 0.2));
//     const att = cellText(ws.getCell(`D${r}`).value);
//     const caMult = ["A/S", "SUPP", "A/CF"].includes(att.toUpperCase()) ? 0 : 1;
//     const cats = catMax.map((m, i) => (type === "workshop" ? 0 : Math.round(m * jig("c" + i))));
//     const asg = [0, 1, 2].map((i) => (type === "workshop" ? 0 : Math.round(assMax * jig("a" + i))));
//     const prac = type === "theory" ? 0 : Math.round(pracMax * jig("p"));
//     const q1 = Math.round(q1Max * jig("q1"));
//     const qs = [2, 3, 4, 5].map((i) => Math.round(20 * jig("q" + i)));
//     if (type !== "workshop") {
//       ["E", "F", "G"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = cats[i]));
//       ["I", "J", "K"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = asg[i]));
//     }
//     if (type !== "theory") ws.getCell(`M${r}`).value = prac;
//     ws.getCell(`O${r}`).value = q1;
//     ["P", "Q", "R", "S"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = qs[i]));
//     const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
//     const H = type === "workshop" ? 0 : (avg(cats) / (catMax[0] || 1)) * w.tests;
//     const L = type === "workshop" ? 0 : (avg(asg) / (assMax || 1)) * w.assignment;
//     const P = type === "theory" ? 0 : (prac / (pracMax || 1)) * w.practical;
//     const N = Math.round((H + L + P) * caMult * 100) / 100;
//     const top = [...qs].sort((a, b) => b - a).slice(0, take).reduce((x, y) => x + y, 0);
//     const T = Math.round(((q1 + top) / 70) * exW * 100) / 100;
//     const U = Math.round(N + T);
//     setVal(`H${r}`, H); setVal(`L${r}`, L); setVal(`N${r}`, N); setVal(`T${r}`, T); setVal(`U${r}`, U); setVal(`W${r}`, U);
//     n++;
//   }
//   console.log(`OK   ${path.basename(f)}: ${n} students filled (DETAILED, ${type}, CA/${caW} Exam/${exW}) -> ${path.basename(f).replace(/\.xlsx$/i, "_FILLED.xlsx")}`);
//   return true;
// }

// (async () => {
//   let bad = 0;
//   for (const f of todo) {
//     const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
//     const ws = wb.worksheets[0];
//     if (/^cat\s*1/i.test(cellText(ws.getCell("E15").value))) { bad += fillDetailed(ws, f, level) ? 0 : 1; await wb.xlsx.writeFile(f.replace(/\.xlsx$/i, "_FILLED.xlsx")); continue; }
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



// Fills marks on DIRECT and DETAILED scoresheets downloaded from Upload Results so every student passes.
// Detailed sheets: fills CAT/assignment/practical/question columns AND the calculated columns (CA total, exam,
// internal, agreed) so the file uploads correctly even though it was never opened in Excel.
// Writes <name>_FILLED.xlsx next to each input; the originals are untouched.
//   node scripts/fill-scoresheets.js "C:\path\Scoresheet_*.xlsx"      (a folder also works)
//   node scripts/fill-scoresheets.js ./downloads --level 0.72         (average performance, 0.45–0.95)
// Direct sheets only (Test 3):
//   --fail "2003:1,2004:2,2005:3"   student serial : number of units failed. Units are numbered 1,2,3… in the
//                                   alphabetical order of the file names (printed at the start), a student who
//                                   fails 2 fails units 1 and 2.
//   --special "2010:3"              serial : unit number the student does NOT sit (CA kept, exam left at 0)
//   --extras "REG1,REG2,REG3"       reg nos typed into the spare rows at the bottom of every sheet, with marks
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const takeOpt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const level = Number(takeOpt("--level") ?? 0.72);
const pairs = (v) => Object.fromEntries(String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split(":").map((y) => y.trim())));
const failPlan = pairs(takeOpt("--fail"));          // { serial: unitsFailed }
const specialPlan = pairs(takeOpt("--special"));    // { serial: unitNumber }
const extras = String(takeOpt("--extras") ?? "").split(/[\s,;]+/).filter(Boolean);
// --plan plan.json : DETAILED sheets only — who fails which units, who is absent, and extra students to type in.
const planFile = takeOpt("--plan");
const plan = planFile ? JSON.parse(fs.readFileSync(planFile, "utf8")) : {};
const normUnit = (u) => String(u || "").toUpperCase().replace(/\s+/g, " ").trim();
const baseReg = (t) => { const m = /^[^/]*\/\d{4}/.exec(String(t).trim().toUpperCase()); return m ? m[0] : String(t).trim().toUpperCase(); };
const planList = (section, reg, unit) => ((plan[section] || {})[reg] || []).map(normUnit).includes(unit);
const serialOf = (reg) => (/(\d+)\s*\/\s*\d{4}/.exec(reg) || [])[1];
if (!argv.length) { console.error("Give one or more .xlsx files, or a folder."); process.exit(1); }

const FIRST_DATA_ROW = 16; // the system reads from row 16; B = Reg No, E = CA total, F = Exam total
const maxOf = (v) => { const m = /\/\s*(\d+)/.exec(String(v ?? "")); return m ? Number(m[1]) : null; };
const cellText = (v) => String(v && typeof v === "object"
  ? (v.richText ? v.richText.map((t) => t.text).join("") : (v.result ?? v.text ?? ""))
  : (v ?? "")).trim();
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
//    A --plan file can make named students fail named units, miss an exam, or add extra students to spare rows.
function fillDetailed(ws, f, level) {
  const START = 17;
  const num = (a) => Number(cellText(ws.getCell(a).value)) || 0;
  const meta = cellText(ws.getCell("Z1").value);
  const type = (/TYPE:(theory|lab|workshop)/.exec(meta) || [])[1] || "theory";
  const mode = (/MODE:(\w+)/.exec(meta) || [])[1] || "standard";
  const unit = normUnit(cellText(ws.getCell("H12").value));
  const catMax = [num("E16"), num("F16"), num("G16")], assMax = num("I16"), pracMax = num("M16");
  const caW = num("N16"), exW = num("T16"), q1Max = num("O16");
  const fct = caW / 30;
  const w = type === "workshop" ? { practical: caW, assignment: 0, tests: 0 }
    : type === "lab" ? { practical: 15 * fct, assignment: 5 * fct, tests: 10 * fct }
    : { practical: 0, assignment: 10 * fct, tests: 20 * fct };
  const take = mode === "mandatory_q1" ? 2 : 3;
  const wf = ws.getCell("W17").value;
  const passCap = Number((/MIN\((\d+)\s*,/.exec((wf && wf.formula) || "") || [])[1]) || 40;
  const setVal = (addr, v) => { const c = ws.getCell(addr); const cur = c.value; c.value = cur && typeof cur === "object" && cur.formula ? { formula: cur.formula, result: v } : v; };
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const st = { rows: 0, failed: 0, absent: 0, extras: 0, supp: 0, special: 0 };

  // Extra students typed into the spare rows under the class list (not generated by the system).
  let spare = START;
  while (spare <= ws.rowCount && cellText(ws.getCell(`B${spare}`).value)) spare++;
  for (const x of plan.extras || []) {
    if (x.units && !x.units.map(normUnit).includes(unit)) continue;
    const typed = (x.regNoTyped || {})[unit] || x.regNo;
    ws.getCell(`B${spare}`).value = typed;
    ws.getCell(`C${spare}`).value = String(x.name || "").toUpperCase();
    spare++; st.extras++;
  }

  for (let r = START; r <= ws.rowCount; r++) {
    const text = cellText(ws.getCell(`B${r}`).value);
    if (!text) continue;
    const reg = baseReg(text);
    const att = cellText(ws.getCell(`D${r}`).value).toUpperCase();
    const isSupp = att === "A/S" || att.startsWith("SUPP");
    const isSpecial = att.startsWith("SPEC");
    const extra = (plan.extras || []).find((x) => baseReg(x.regNo) === reg || Object.values(x.regNoTyped || {}).some((t) => baseReg(t) === reg));
    const baseLevel = (extra && extra.level) || level;
    const lvl0 = Math.min(0.92, Math.max(0.55, baseLevel + (hash(reg + path.basename(f)) - 0.5) * 0.3));
    const failing = !isSpecial && planList(isSupp ? "suppFail" : "ordinaryFail", reg, unit);
    const lvl = failing ? 0.28 + (hash(reg + unit) - 0.5) * 0.1 : lvl0;
    const absent = !isSupp && !isSpecial && planList("absent", reg, unit);
    const jig = (k) => Math.min(1, Math.max(0.15, lvl + (hash(reg + k + unit) - 0.5) * (failing ? 0.1 : 0.2)));
    const caMult = isSupp || att === "A/CF" ? 0 : 1;

    // coursework: kept on special rows (the system pre-fills it), blank on supp rows (ignored), filled otherwise
    let cats, asg, prac;
    const existing = ["E", "F", "G"].map((c) => cellText(ws.getCell(`${c}${r}`).value));
    if (isSpecial && existing.some((v) => v !== "")) {
      cats = ["E", "F", "G"].map((c) => Number(cellText(ws.getCell(`${c}${r}`).value)) || 0);
      asg = ["I", "J", "K"].map((c) => Number(cellText(ws.getCell(`${c}${r}`).value)) || 0);
      prac = Number(cellText(ws.getCell(`M${r}`).value)) || 0;
    } else if (isSupp) {
      cats = [0, 0, 0]; asg = [0, 0, 0]; prac = 0;
    } else {
      cats = catMax.map((m, i) => (type === "workshop" ? 0 : Math.round(m * jig("c" + i))));
      asg = [0, 1, 2].map((i) => (type === "workshop" ? 0 : Math.round(assMax * jig("a" + i))));
      prac = type === "theory" ? 0 : Math.round(pracMax * jig("p"));
      if (type !== "workshop") {
        ["E", "F", "G"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = cats[i]));
        ["I", "J", "K"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = asg[i]));
      }
      if (type !== "theory") ws.getCell(`M${r}`).value = prac;
    }

    // exam: left blank when the student did not sit it; otherwise Q1 + the other questions
    let q1 = 0, qs = [0, 0, 0, 0];
    if (absent) {
      ["O", "P", "Q", "R", "S"].forEach((col) => (ws.getCell(`${col}${r}`).value = null));
      st.absent++;
    } else {
      q1 = Math.round(q1Max * jig("q1"));
      qs = [2, 3, 4, 5].map((i) => Math.round(20 * jig("q" + i)));
      ws.getCell(`O${r}`).value = q1;
      ["P", "Q", "R", "S"].forEach((col, i) => (ws.getCell(`${col}${r}`).value = qs[i]));
    }
    const H = type === "workshop" ? 0 : (avg(cats) / (catMax[0] || 1)) * w.tests;
    const L = type === "workshop" ? 0 : (avg(asg) / (assMax || 1)) * w.assignment;
    const P = type === "theory" ? 0 : (prac / (pracMax || 1)) * w.practical;
    const N = Math.round((H + L + P) * caMult * 100) / 100;
    const top = [...qs].sort((a, b) => b - a).slice(0, take).reduce((x, y) => x + y, 0);
    const T = Math.round(((q1 + top) / 70) * exW * 100) / 100;
    const U = Math.round(N + T);
    const W = isSupp ? Math.min(passCap, U) : U;
    setVal(`H${r}`, H); setVal(`L${r}`, L); setVal(`N${r}`, N); setVal(`T${r}`, T); setVal(`U${r}`, U); setVal(`W${r}`, W);
    st.rows++; if (failing) st.failed++; if (isSupp) st.supp++; if (isSpecial) st.special++;
  }
  const bits = [st.failed && `${st.failed} made to fail`, st.absent && `${st.absent} absent`, st.supp && `${st.supp} supp`, st.special && `${st.special} special`, st.extras && `${st.extras} extra rows typed in`].filter(Boolean).join(", ");
  console.log(`OK   ${path.basename(f)}: ${st.rows} rows (${unit}, ${type}, CA/${caW} Exam/${exW})${bits ? " — " + bits : ""} -> ${path.basename(f).replace(/\.xlsx$/i, "_FILLED.xlsx")}`);
  return true;
}

todo.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
(async () => {
  let bad = 0;
  if (Object.keys(failPlan).length || Object.keys(specialPlan).length || extras.length) {
    console.log("Unit numbers used by --fail / --special:"); todo.forEach((f, i) => console.log(`  unit ${i + 1}: ${path.basename(f)}`));
  }
  for (const [unitNo, f] of todo.map((f, i) => [i + 1, f])) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
    const ws = wb.worksheets[0];
    if (/^cat\s*1/i.test(cellText(ws.getCell("E15").value))) { bad += fillDetailed(ws, f, level) ? 0 : 1; await wb.xlsx.writeFile(f.replace(/\.xlsx$/i, "_FILLED.xlsx")); continue; }
    const caMax = maxOf(ws.getCell("E15").value), exMax = maxOf(ws.getCell("F15").value);
    if (!caMax || !exMax) { console.log(`SKIP ${path.basename(f)}: not a direct scoresheet (E15/F15 = ${cellText(ws.getCell("E15").value)} / ${cellText(ws.getCell("F15").value)})`); bad++; continue; }
    let n = 0, failed = 0, special = 0, added = 0, lastRow = FIRST_DATA_ROW;
    for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
      const reg = cellText(ws.getCell(`B${r}`).value);
      if (!reg || /^reg\.? ?no\.?$/i.test(reg)) continue;
      lastRow = r;
      const serial = serialOf(reg);
      let lvl = Math.min(0.92, Math.max(0.55, level + (hash(reg + path.basename(f)) - 0.5) * 0.3));
      let exam = null;
      if (serial && failPlan[serial] && unitNo <= Number(failPlan[serial])) { lvl = 0.30; failed++; }       // 9 + 21 = 30 → fails
      if (serial && specialPlan[serial] && unitNo === Number(specialPlan[serial])) { exam = 0; special++; }  // did not sit the exam
      // a CA the template already filled in (e.g. a special's carried CA) is left alone
      const ca = ws.getCell(`E${r}`).value;
      if (ca === null || ca === undefined || ca === "") ws.getCell(`E${r}`).value = Math.round(caMax * lvl);
      ws.getCell(`F${r}`).value = exam ?? Math.round(exMax * lvl);
      n++;
    }
    // extra reg nos typed into the first spare rows (they were not on the generated sheet)
    let r = lastRow + 1;
    for (const reg of extras) {
      while (r <= ws.rowCount && cellText(ws.getCell(`B${r}`).value)) r++;
      ws.getCell(`B${r}`).value = reg;
      ws.getCell(`C${r}`).value = "EXTRA STUDENT";
      const lvl = Math.min(0.92, Math.max(0.55, level + (hash(reg + path.basename(f)) - 0.5) * 0.3));
      ws.getCell(`E${r}`).value = Math.round(caMax * lvl);
      ws.getCell(`F${r}`).value = Math.round(exMax * lvl);
      added++; r++;
    }
    const out = f.replace(/\.xlsx$/i, "_FILLED.xlsx");
    await wb.xlsx.writeFile(out);
    console.log(`OK   ${path.basename(f)}: ${n} students filled (CA/${caMax}, Exam/${exMax})${failed ? `, ${failed} set to fail` : ""}${special ? `, ${special} did not sit` : ""}${added ? `, ${added} extra rows added` : ""} -> ${path.basename(out)}`);
  }
  process.exit(bad ? 1 : 0);
})();

// node scripts/fill-scoresheets.js "C:\Users\newti\Downloads\Scoresheets\BST\2018\Y1\ScoresheetsY1\Ordinary" --plan plan_ordinary.json --level 0.65
