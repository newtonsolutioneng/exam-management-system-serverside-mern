// src/models/Mark.ts
import mongoose, { Schema, Document, Query } from "mongoose";

export interface IMark extends Document {
  institution: mongoose.Types.ObjectId;
  student: mongoose.Types.ObjectId;
  programUnit: mongoose.Types.ObjectId; // Links to the unit's curriculum config
  academicYear: mongoose.Types.ObjectId;
  semester: "SEMESTER 1" | "SEMESTER 2" | "SEMESTER 3";
  batchId: string;

  // --- RAW CONTINUOUS ASSESSMENT SCORES ---
  // Based on the scoresheet breakdown: CATs out of 20, Assignments out of 10
  cat1Raw: number; // Raw score for CAT 1 (max 20)
  cat2Raw: number; // Raw score for CAT 2 (max 20)
  cat3Raw?: number; // Raw score for CAT 3 (max 20)
  assgnt1Raw: number; // Raw score for Assignment 1 (max 10)
  assgnt2Raw?: number; // Raw score for Assignment 2 (max 10)
  assgnt3Raw?: number; // Raw score for Assignment 3 (max 10)
  practicalRaw?: number; // If practical/lab mark is separate from the above

  // --- RAW EXAM QUESTION BREAKDOWN ---
  // Based on the scoresheet breakdown (Total 70)
  examQ1Raw: number; // Raw score for Exam Q1 (max 10)
  examQ2Raw: number; // Raw score for Exam Q2 (max 20)
  examQ3Raw: number; // Raw score for Exam Q3 (max 20)
  examQ4Raw: number; // Raw score for Exam Q4 (max 20)
  examQ5Raw?: number; // Raw score for Exam Q5 (max 20 - used if multiple questions were available)

  // --- FINAL MARKS (For Audit/Verification) ---
  // These fields match the totals in the spreadsheet and should be verified against calculation
  caTotal30: number; // The "CATs + LABS + ASSIGNMENTS GRAND TOTAL out of 30"
  examTotal70: number; // The "TOTAL EXAM OUT OF 70"
  internalExaminerMark: number; // The "INTERNAL EXAMINER MARKS /100"
  agreedMark: number; // The "AGREED MARKS /100" (The final score used for grading)
  attempt: string; // "1st", "re-take", "supplementary"
  examMode: "standard" | "mandatory_q1";
  unitType?: "theory" | "lab" | "workshop";
  /** Mark distribution this sheet was captured under (ca + exam = 100). Absent on legacy rows = 30/70. */
  caMax?: number;
  examMax?: number;

  // --- METADATA ---
  isSupplementary: boolean; // Derived from attempt field
  isRetake: boolean; // Derived from attempt field
  isSpecial: boolean; // Special exam flag
  isMissingCA: boolean; // Missing CA flag
  remarks?: string; // Any remarks or notes

  uploadedBy: mongoose.Types.ObjectId; // coordinator who entered
  uploadedAt: Date; 
  deletedAt?:    Date;
}

const schema = new Schema<IMark>(
  {
    institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true, },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    programUnit: { type: Schema.Types.ObjectId, ref: "ProgramUnit", required: true, }, // IMPORTANT
    academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true, },
    semester: { type: String, enum: ["SEMESTER 1", "SEMESTER 2", "SEMESTER 3"], required: true, default: "SEMESTER 1" },
    batchId: { type: String, required: true, index: true },

    // RAW CA SCORES (The system will derive the final CA/30 from these)
    cat1Raw: { type: Number, min: 0,  default: 0 },
    cat2Raw: { type: Number, min: 0,  default: 0 },
    cat3Raw: { type: Number, min: 0 },
    assgnt1Raw: { type: Number, min: 0, max: 10, default: 0 },
    assgnt2Raw: { type: Number, min: 0, max: 10 },
    assgnt3Raw: { type: Number, min: 0, max: 10 },
    practicalRaw: { type: Number, min: 0, max: 100 }, // Assume flexible scale if not explicitly 20/10

    // RAW EXAM SCORES
    examQ1Raw: { type: Number, min: 0,  default: 0 },
    examQ2Raw: { type: Number, min: 0, max: 20, default: 0 },
    examQ3Raw: { type: Number, min: 0, max: 20, default: 0 },
    examQ4Raw: { type: Number, min: 0, max: 20, default: 0 },
    examQ5Raw: { type: Number, min: 0, max: 20 },

    // FINAL AUDIT FIELDS (Filled with scoresheet data)
    // Field names are historical: they hold the CA / exam parts under the unit's distribution (30/70 by default).
    // The upper bounds (caMax / examMax) are enforced by the importers, not hard-coded here.
    caTotal30: { type: Number, min: 0, max: 100, required: true },
    examTotal70: { type: Number, min: 0, max: 100, required: true },
    caMax: { type: Number, min: 0, max: 99 },
    examMax: { type: Number, min: 1, max: 100 },
    unitType: { type: String, enum: ["theory", "lab", "workshop"] },
    internalExaminerMark: { type: Number, min: 0, max: 100, required: false },
    agreedMark: { type: Number, min: 0, max: 100, required: true },
    attempt: { type: String, enum: ["1st", "re-take", "supplementary", "special"], default: "1st", },
    examMode: { type: String, enum: ["standard", "mandatory_q1"], default: "standard"},

    // METADATA
    isSupplementary: { type: Boolean, default: false },
    isRetake: { type: Boolean, default: false },
    isSpecial: { type: Boolean, default: false }, // Explicit flag for Special Exams
    remarks: { type: String },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: null },
    
  },
  { timestamps: true }
);

// Unique index must be on the combination of Student, ProgramUnit, and AcademicYear
schema.index({ student: 1, programUnit: 1, academicYear: 1 }, { unique: true });


schema.pre(/^find/, function (this: mongoose.Query<any, any>, next) {
  const query = this.getQuery();
  if (query.deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  next();
});
schema.index({ student: 1, academicYear: 1, programUnit: 1, deletedAt: 1 });
schema.index({ institution: 1, student: 1, deletedAt: 1 });
schema.index({ institution: 1, uploadedAt: -1 });
schema.index({ student: 1, programUnit: 1, deletedAt: 1 });
schema.index({ batchId: 1, institution: 1 });
schema.index({ batchId: 1, deletedAt: 1 });

export default mongoose.model<IMark>("Mark", schema);
