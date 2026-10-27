// serverside/src/models/AuditedUnit.ts
//
// ENG.9 — audited units. A student may audit at most two units in any year of study.
// Audited units appear on the transcript but never count towards the classification, which is why
// they live outside the curriculum (ProgramUnit) that every average and award is computed from.

import mongoose, { Schema, Document } from "mongoose";

export interface IAuditedUnit extends Document {
  institution:  mongoose.Types.ObjectId;
  student:      mongoose.Types.ObjectId;
  unit:         mongoose.Types.ObjectId;
  academicYear: mongoose.Types.ObjectId;
  yearOfStudy:  number;
  /** optional result shown on the transcript */
  mark?:        number | null;
  grade?:       string;
  recordedBy?:  mongoose.Types.ObjectId;
  recordedAt:   Date;
}

const schema = new Schema<IAuditedUnit>({
  institution:  { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student:      { type: Schema.Types.ObjectId, ref: "Student", required: true },
  unit:         { type: Schema.Types.ObjectId, ref: "Unit", required: true },
  academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true },
  yearOfStudy:  { type: Number, required: true, min: 1 },
  mark:         { type: Number, min: 0, max: 100, default: null },
  grade:        { type: String },
  recordedBy:   { type: Schema.Types.ObjectId, ref: "User" },
  recordedAt:   { type: Date, default: Date.now },
});

schema.index({ student: 1, unit: 1, academicYear: 1 }, { unique: true });

export default mongoose.model<IAuditedUnit>("AuditedUnit", schema);