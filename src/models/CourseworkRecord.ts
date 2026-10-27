// serverside/src/models/CourseworkRecord.ts
//
// Share of a unit's coursework a student has completed (0–100), per semester.
// ENG.23(b): a registered student who completes less than 75% of the coursework is deregistered.

import mongoose, { Schema, Document } from "mongoose";

export interface ICourseworkRecord extends Document {
  institution:      mongoose.Types.ObjectId;
  student:          mongoose.Types.ObjectId;
  programUnit:      mongoose.Types.ObjectId;
  academicYear:     mongoose.Types.ObjectId;
  semester:         1 | 2 | 3;
  completedPercent: number;
  updatedAt:        Date;
}

const schema = new Schema<ICourseworkRecord>({
  institution:      { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student:          { type: Schema.Types.ObjectId, ref: "Student", required: true },
  programUnit:      { type: Schema.Types.ObjectId, ref: "ProgramUnit", required: true },
  academicYear:     { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true },
  semester:         { type: Number, enum: [1, 2, 3], required: true },
  completedPercent: { type: Number, min: 0, max: 100, required: true },
}, { timestamps: { createdAt: false, updatedAt: true } });

schema.index({ student: 1, programUnit: 1, academicYear: 1, semester: 1 }, { unique: true });

export default mongoose.model<ICourseworkRecord>("CourseworkRecord", schema);