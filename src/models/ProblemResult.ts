// serverside/src/models/ProblemResult.ts
//
// A scoresheet row that could not be applied (student not registered, unit not linked to the
// student's curriculum, impossible mark …). Instead of failing the upload with an error message,
// the row is kept here with an action for the coordinator. Rows are re-applied with "Retry"
// once the cause is fixed, and the CMS warns while any are still OPEN.
//
import mongoose, { Schema, Document } from "mongoose";

export type ProblemCode = "STUDENT_NOT_FOUND" | "UNIT_NOT_LINKED" | "INVALID_MARK" | "SAVE_FAILED";
export type ProblemStatus = "OPEN" | "RESOLVED" | "DISMISSED";

export interface IProblemResult extends Document {
  institution: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  batchId: string;
  filename: string;
  templateType: "detailed" | "direct";
  unitCode: string;
  academicYear: mongoose.Types.ObjectId;
  academicYearLabel: string;
  rowNumber: number;
  regNo: string;            // base reg no (qualifier removed)
  rawRegNo: string;         // as typed on the sheet
  studentName?: string;
  program?: mongoose.Types.ObjectId; // known once the student was found
  code: ProblemCode;
  message: string;
  action: string;           // what the coordinator should do
  /** Everything needed to re-apply the row: the raw cells + the sheet's rules. */
  payload: {
    row: unknown[];
    distribution: { ca: number; exam: number };
    unitType: "theory" | "lab" | "workshop";
    examMode: "standard" | "mandatory_q1";
  };
  status: ProblemStatus;
  resolvedAt?: Date;
  resolvedBy?: mongoose.Types.ObjectId;
  resolution?: string;
}

const schema = new Schema<IProblemResult>(
  {
    institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    batchId: { type: String, required: true },
    filename: { type: String, default: "" },
    templateType: { type: String, enum: ["detailed", "direct"], required: true },
    unitCode: { type: String, required: true, uppercase: true },
    academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true },
    academicYearLabel: { type: String, default: "" },
    rowNumber: { type: Number, default: 0 },
    regNo: { type: String, required: true, uppercase: true },
    rawRegNo: { type: String, default: "" },
    studentName: { type: String },
    program: { type: Schema.Types.ObjectId, ref: "Program" },
    code: { type: String, enum: ["STUDENT_NOT_FOUND", "UNIT_NOT_LINKED", "INVALID_MARK", "SAVE_FAILED"], required: true },
    message: { type: String, required: true },
    action: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["OPEN", "RESOLVED", "DISMISSED"], default: "OPEN" },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String },
  },
  { timestamps: true },
);

schema.index({ institution: 1, status: 1, academicYear: 1 });
schema.index({ institution: 1, status: 1, unitCode: 1, academicYear: 1, regNo: 1 });

export default mongoose.model<IProblemResult>("ProblemResult", schema);