// Measures how fast your MongoDB really is. Run from serverside/:  node scripts/db-probe.js
require("dotenv").config();
const mongoose = require("mongoose");
const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const host = uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@?/, "").split(/[/?]/)[0];
const t = async (label, fn) => { const s = Date.now(); const r = await fn(); console.log(`${label.padEnd(44)} ${String(Date.now() - s).padStart(6)} ms`); return r; };
(async () => {
  console.log("Database host:", host, uri.includes("+srv") || uri.includes("mongodb.net") ? "(hosted / Atlas)" : "");
  await t("connect", () => mongoose.connect(uri));
  const db = mongoose.connection.db;
  for (let i = 0; i < 5; i++) await t(`ping #${i + 1}`, () => db.command({ ping: 1 }));
  const students = db.collection("students");
  const n = await t("count students", () => students.countDocuments());
  const docs = await t("read 500 student docs", () => students.find({}).limit(500).toArray());
  const avg = docs.length ? Math.round(docs.reduce((a, d) => a + Buffer.byteLength(JSON.stringify(d)), 0) / docs.length) : 0;
  console.log(`students: ${n}; average document size ${avg} bytes (${(avg * Math.min(500, n) / 1e6).toFixed(1)} MB per 500)`);
  const ids = docs.map((d) => d._id);
  await t("read 500 students by _id list", () => students.find({ _id: { $in: ids } }).toArray());
  for (const c of ["marks", "markdirects", "finalgrades"]) {
    const k = await t(`count ${c}`, () => db.collection(c).countDocuments());
    await t(`read 500 ${c}`, () => db.collection(c).find({}).limit(500).toArray());
    console.log(`   (${c}: ${k} documents)`);
  }
  await mongoose.disconnect();

  // Same read again with wire compression on, to see whether it helps on this connection.
  console.log("\n--- with compression (zlib) ---");
  await mongoose.connect(uri, { compressors: ["zlib"] });
  const st2 = mongoose.connection.db.collection("students");
  await t("read 500 student docs (compressed)", () => st2.find({}).limit(500).toArray());
  await t("read 500 markdirects (compressed)", () => mongoose.connection.db.collection("markdirects").find({}).limit(500).toArray());
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });