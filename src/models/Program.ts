// // src/models/Program.ts
// import mongoose, { Document, Schema } from "mongoose";
// import { normalizeProgramName } from "../services/programNormalizer";

// export interface IProgram extends Document {
//   institution: mongoose.Types.ObjectId;
//   name: string;
//   cleanName: string; // normalized version
//   code: string;
//   durationYears: number;
//   maxCompletionYears: number; // ENG 19.d/e & 22.f/g
//   schoolType: "ENGINEERING" | "IT" | "MEDICINE" | "GENERAL";
// }

// const schema = new Schema<IProgram>(
//   {
//     institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
//     name: { type: String, required: true, trim: true},
//     cleanName: { type: String, required: false, index: true },
//     code: { type: String, required: true, uppercase: true, trim: true },    
//     durationYears: {type: Number, default: 4, min: 1, max: 8 },
//     maxCompletionYears: { type: Number, default: 8 }, // Default for B.Ed/General
//     schoolType: { type: String, enum: ["ENGINEERING", "IT", "MEDICINE", "GENERAL"], default: "GENERAL" }
//   },
//   { timestamps: true }
// );

// schema.pre("save", function (next) {
//   if (this.isModified("name")) this.cleanName = normalizeProgramName(this.name);  
//   // Auto-set max years based on ENG 19/22
//     if (this.name.includes("Engineering")) this.maxCompletionYears = 10;
//   next();
// });

// // Before updateOne / findOneAndUpdate
// function applyNormalization(this: any, next: any) {
//   const update = this.getUpdate();
//   if (update?.name) update.cleanName = normalizeProgramName(update.name);  
//   if (update?.$set?.name) update.$set.cleanName = normalizeProgramName(update.$set.name);
//   next();
// }

// schema.pre("findOneAndUpdate", applyNormalization);
// schema.pre("updateOne", applyNormalization);

// schema.index({ institution: 1, code: 1 }, { unique: true });
// schema.index({ institution: 1, cleanName: 1 }, { unique: true }); 
// schema.index({ code: 1 });

// export default mongoose.model<IProgram>("Program", schema);









// // serverside/src/models/Program.ts
// import mongoose, { Schema, Document } from "mongoose";

// export interface IProgramRuleOverrides {
//   maxDurationMultiplier?: number;
//   passMark?:              number;
//   suppMarkCap?:           number;
//   maxCarryForwardUnits?:  number;
//   caWeight?:              number;
//   examWeight?:            number;
//   semesterWeights?:       Array<{ year: number; weight: number }>;
// }

// export interface IProgram extends Document {
//   institution:      mongoose.Types.ObjectId;
//   schoolCode:       string;
//   departmentCode:   string;
//   name:             string;
//   code:             string;
//   description?:     string;

//   // ── The authoritative program length ──────────────────────────────────────
//   // ENG.19(d/e): max study years = durationYears × settings.ruleSet.maxDurationMultiplier
//   // Financial Engineering (4yr) × 2 = 8yr max  ← CORRECT, no name-sniffing needed
//   // BSc Civil Engineering (5yr) × 2 = 10yr max  ← CORRECT
//   // BEd Computer Science (4yr) × 2 = 8yr max    ← CORRECT
//   // The cron and status engine ALWAYS use this field — never infer from degreeType or name
//   durationYears:    number;

//   degreeType:       string;  // "BSc" | "BEd" | "BTech" | "BEng" | "BArch" | "MBBS" | "LLB" | "BPharm" | "Other"
//   intakes:          ("JAN" | "MAY" | "SEPT")[];
//   supportedEntryTypes: ("Direct" | "Mid-Entry-Y2" | "Mid-Entry-Y3" | "Mid-Entry-Y4")[];
//   ruleOverrides:    IProgramRuleOverrides;
//   isActive:         boolean;
//   createdAt:        Date;
//   updatedAt:        Date;
// }

// const ProgramRuleOverridesSchema = new Schema<IProgramRuleOverrides>({
//   maxDurationMultiplier: { type: Number, min: 1,   max: 5 },
//   passMark:              { type: Number, min: 0,   max: 100 },
//   suppMarkCap:           { type: Number, min: 0,   max: 100 },
//   maxCarryForwardUnits:  { type: Number, min: 0,   max: 10 },
//   caWeight:              { type: Number, min: 0,   max: 100 },
//   examWeight:            { type: Number, min: 0,   max: 100 },
//   semesterWeights: [{
//     year:   { type: Number, required: true },
//     weight: { type: Number, required: true, min: 0, max: 1 },
//   }],
// }, { _id: false });

// const ProgramSchema = new Schema<IProgram>(
//   {
//     institution:    { type: Schema.Types.ObjectId, ref: "Institution", required: true },
//     schoolCode:     { type: String, required: true, uppercase: true, trim: true },
//     departmentCode: { type: String, required: true, uppercase: true, trim: true },
//     name:           { type: String, required: true, trim: true },
//     code:           { type: String, required: true, uppercase: true, trim: true },
//     description:    { type: String },

//     // ── Program duration — the ONLY source of truth for max study years ──────
//     // Do NOT use degreeType or name to infer duration in any service/cron.
//     // Always: maxYears = program.durationYears × settings.ruleSet.maxDurationMultiplier
//     durationYears: {
//       type:     Number,
//       required: true,
//       min:      1,
//       max:      10,
//       default:  5,
//     },

//     degreeType: {
//       type:     String,
//       required: true,
//       enum:     ["BSc","BEd","BTech","BEng","BArch","MBBS","LLB","BPharm","Other"],
//       default:  "BSc",
//     },
//     intakes: {
//       type:    [String],
//       enum:    ["JAN","MAY","SEPT"],
//       default: ["SEPT"],
//     },
//     supportedEntryTypes: {
//       type:    [String],
//       enum:    ["Direct","Mid-Entry-Y2","Mid-Entry-Y3","Mid-Entry-Y4"],
//       default: ["Direct"],
//     },
//     ruleOverrides: { type: ProgramRuleOverridesSchema, default: () => ({}) },
//     isActive:      { type: Boolean, default: true },
//   },
//   { timestamps: true },
// );

// ProgramSchema.index({ institution: 1, code: 1 }, { unique: true });
// ProgramSchema.index({ institution: 1, schoolCode: 1 });
// ProgramSchema.index({ institution: 1, departmentCode: 1 });
// ProgramSchema.index({ institution: 1, isActive: 1 });
// ProgramSchema.index(
//   { institution: 1, schoolCode: 1, departmentCode: 1, name: 1 },
//   { unique: true, collation: { locale: "en", strength: 2 } }, // case-insensitive
// );

// export default mongoose.model<IProgram>("Program", ProgramSchema);
























// serverside/src/models/Program.ts — COMPLETE, FINAL

import { INTAKE_CODE_REGEX } from "../utils/semesterLabels";
import mongoose, { Schema, Document } from "mongoose";
import { normalizeProgramName } from "../services/programNormalizer";

export interface IProgramRuleOverrides {
  maxDurationMultiplier?: number;
  passMark?:              number;
  suppMarkCap?:           number;
  maxCarryForwardUnits?:  number;
  caWeight?:              number;
  examWeight?:            number;
  semesterWeights?:       Array<{ year: number; weight: number }>;
}

export interface IProgram extends Document {
  institution:         mongoose.Types.ObjectId;
  schoolCode:          string;
  departmentCode:      string;
  name:                string;
  cleanName:           string;   // ← normalized name for dedup (auto-set by pre-save hook)
  code:                string;
  description?:        string;
  durationYears:       number;
  degreeType:          string;
  intakes:             string[];
  supportedEntryTypes: ("Direct" | "Mid-Entry-Y2" | "Mid-Entry-Y3" | "Mid-Entry-Y4")[];
  ruleOverrides:       IProgramRuleOverrides;
  isActive:            boolean;
  createdAt:           Date;
  updatedAt:           Date;
}

const ProgramRuleOverridesSchema = new Schema<IProgramRuleOverrides>({
  maxDurationMultiplier: { type: Number, min: 1,   max: 5  },
  passMark:              { type: Number, min: 0,   max: 100 },
  suppMarkCap:           { type: Number, min: 0,   max: 100 },
  maxCarryForwardUnits:  { type: Number, min: 0,   max: 10  },
  caWeight:              { type: Number, min: 0,   max: 100 },
  examWeight:            { type: Number, min: 0,   max: 100 },
  semesterWeights: [{
    year:   { type: Number, required: true },
    weight: { type: Number, required: true, min: 0, max: 1 },
  }],
}, { _id: false });

const ProgramSchema = new Schema<IProgram>(
  {
    institution:    { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    schoolCode:     { type: String, required: true, uppercase: true, trim: true },
    departmentCode: { type: String, required: true, uppercase: true, trim: true },
    name:           { type: String, required: true, trim: true },

    // ── cleanName ─────────────────────────────────────────────────────────────
    // Auto-populated from name by the pre-save hook.
    // Used only to prevent exact duplicate program names within the same department.
    // "BSc Civil Engineering" and "bsc civil engineering" produce the same cleanName
    // and are blocked. "BSc Civil Engineering" and "BSc Marine Engineering" are fine.
    cleanName: {
      type:     String,
      trim:     true,
      // Not required here — the pre-save hook always sets it before validation
    },

    code: { type: String, required: true, uppercase: true, trim: true },
    description: { type: String },

    durationYears: { type: Number, required: true, min: 1, max: 10, default:  5 },
    degreeType: { type: String, required: true, enum: ["BSc","BEd","BTech","BEng","BArch","MBBS","LLB","BPharm","Other"], default:  "BSc" },
    intakes: { type: [{ type: String, match: INTAKE_CODE_REGEX }], default: ["SEPT"]},
    supportedEntryTypes: { type: [String], enum: ["Direct","Mid-Entry-Y2","Mid-Entry-Y3","Mid-Entry-Y4"], default: ["Direct"]},
    ruleOverrides: { type: ProgramRuleOverridesSchema, default: () => ({}) },
    isActive:      { type: Boolean, default: true },
  },
  { timestamps: true },
);

// ── Pre-save hook: auto-populate cleanName from name ─────────────────────────
// Runs on every new document and whenever name changes.
// This ensures cleanName is NEVER null — fixing the original bug.
ProgramSchema.pre("save", function (next) {
  if (this.isModified("name") || !this.cleanName) {
    this.cleanName = normalizeProgramName(this.name);
  }
  next();
});

// ── Pre-update hooks: keep cleanName in sync ──────────────────────────────────
function applyCleanNameNormalization(this: mongoose.Query<unknown, IProgram>, next: () => void) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) { next(); return; }

  // Handle { name: "..." } directly
  if (typeof (update as Record<string, unknown>).name === "string") {
    (update as Record<string, unknown>).cleanName =
      normalizeProgramName((update as Record<string, unknown>).name as string);
  }
  // Handle { $set: { name: "..." } }
  const set = (update as Record<string, Record<string, unknown>>).$set;
  if (set && typeof set.name === "string") {
    set.cleanName = normalizeProgramName(set.name as string);
  }

  next();
}

ProgramSchema.pre("findOneAndUpdate", applyCleanNameNormalization);
ProgramSchema.pre("updateOne",        applyCleanNameNormalization);
ProgramSchema.pre("updateMany",       applyCleanNameNormalization);

// ── Indexes ───────────────────────────────────────────────────────────────────
//
// IMPORTANT — index design decisions:
//
// 1. { institution, code } UNIQUE
//    Program codes must be unique per institution.
//    BSME and BSCE can both exist, but you can't have two BSCE programs.
//
// 2. { institution, departmentCode, cleanName } UNIQUE (case-insensitive)
//    Prevents duplicate program names WITHIN the same department.
//    "BSc Civil Engineering" and "bsc civil engineering" are the same → blocked.
//    "BSc Civil Engineering" (CE) and "BSc Civil Engineering" (ME) → allowed
//    because they're in different departments.
//
//    ⚠ This replaces the old { institution, cleanName } UNIQUE index which was
//    institution-wide and incorrectly blocked all programs after the first one
//    when cleanName was null.
//
// 3. { institution, schoolCode } — non-unique, for query performance
// 4. { institution, departmentCode } — non-unique, for query performance
// 5. { institution, isActive } — non-unique, for active-program queries

// Unique: one program code per institution
ProgramSchema.index({ institution: 1, code: 1 }, { unique: true });

// Unique: no duplicate program names within the same department (case-insensitive)
// Multiple programs CAN share the same name if they are in different departments.
ProgramSchema.index(
  { institution: 1, departmentCode: 1, cleanName: 1 },
  {
    unique:    true,
    collation: { locale: "en", strength: 2 },  // strength 2 = case-insensitive
    name:      "institution_1_departmentCode_1_cleanName_1",
  },
);

// Performance indexes
ProgramSchema.index({ institution: 1, schoolCode: 1 });
ProgramSchema.index({ institution: 1, departmentCode: 1 });
ProgramSchema.index({ institution: 1, isActive: 1 });

export default mongoose.model<IProgram>("Program", ProgramSchema);