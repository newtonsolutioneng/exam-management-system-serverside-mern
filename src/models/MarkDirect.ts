// src/models/MarkDirect.ts
import mongoose, { Schema, Document } from "mongoose";

export interface IMarkDirect extends Document {
  institution: mongoose.Types.ObjectId;
  student: mongoose.Types.ObjectId;
  programUnit: mongoose.Types.ObjectId;
  academicYear: mongoose.Types.ObjectId;
  semester: "SEMESTER 1" | "SEMESTER 2" | "SEMESTER 3";
  batchId: string;

  caTotal30: number;    // Input directly: 0-30
  examTotal70: number;  // Input directly: 0-70
  externalTotal100?: number;  // Calculated: (examTotal70 / 70) * 100
  agreedMark: number;   // Calculated: CA + Exam
  attempt: string;
  caMax?: number;       // distribution this sheet was captured under (absent = 30/70)
  examMax?: number;
  unitType?: "theory" | "lab" | "workshop";
  examMode?: "standard" | "mandatory_q1";

  isSupplementary: boolean; // Derived from attempt field
  isRetake: boolean; // Derived from attempt field
  isSpecial: boolean; // Special exam flag
  isMissingCA: boolean; // Missing CA flag
  remarks?: string; // Any remarks or notes
  
  uploadedBy: mongoose.Types.ObjectId;
  uploadedAt: Date; 
  deletedAt?: Date;
}

const schema = new Schema<IMarkDirect>({
  institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
  programUnit: { type: Schema.Types.ObjectId, ref: "ProgramUnit", required: true },
  academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true },
  semester: { type: String, enum: ["SEMESTER 1", "SEMESTER 2", "SEMESTER 3"], required: true, default: "SEMESTER 1" },
  batchId: { type: String, required: true, index: true },

  // Historical names — CA / exam parts under the unit's distribution (30/70 by default); bounds enforced by importers.
  caTotal30: { type: Number, min: 0, max: 100, required: true },
  examTotal70: { type: Number, min: 0, max: 100, required: true },
  caMax: { type: Number, min: 0, max: 99 },
  examMax: { type: Number, min: 1, max: 100 },
  unitType: { type: String, enum: ["theory", "lab", "workshop"] },
  examMode: { type: String, enum: ["standard", "mandatory_q1"], default: "standard" },
  externalTotal100: { type: Number, min: 0, max: 100, default: null },
  agreedMark: { type: Number, min: 0, max: 100, required: true },
  attempt: { type: String, enum: ["1st", "re-take", "supplementary", "special"], default: "1st" },
  isSupplementary: { type: Boolean, default: false },
  isRetake: { type: Boolean, default: false },
  isSpecial: { type: Boolean, default: false }, // Explicit flag for Special Exams
  remarks: { type: String },
  uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  uploadedAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ student: 1, programUnit: 1, academicYear: 1 }, { unique: true });
schema.index({ student: 1, programUnit: 1, academicYear: 1, deletedAt: 1 });


schema.pre(/^find/, function (this: mongoose.Query<any, any>, next) {
  const query = this.getQuery();
  if (query.deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  next();
});
schema.index({ batchId: 1, institution: 1 });
schema.index({ batchId: 1, deletedAt: 1 });

export default mongoose.model<IMarkDirect>("MarkDirect", schema);