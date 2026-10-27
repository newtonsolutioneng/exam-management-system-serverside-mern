// serverside/src/models/SemesterRegistration.ts
//
// One row per student per semester (kind "semester") or per retake sitting (kind "retake").
// ENG.23(a): a student who has not registered by the end of week 4 is deregistered.
// ENG.23(d): a student required to retake units who has not registered by week 4 is deregistered.

import mongoose, { Schema, Document } from "mongoose";

export interface ISemesterRegistration extends Document {
  institution:  mongoose.Types.ObjectId;
  student:      mongoose.Types.ObjectId;
  academicYear: mongoose.Types.ObjectId;
  semester:     1 | 2 | 3;
  kind:         "semester" | "retake";
  registeredAt: Date;
  recordedBy?:  mongoose.Types.ObjectId;
}

const schema = new Schema<ISemesterRegistration>({
  institution:  { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student:      { type: Schema.Types.ObjectId, ref: "Student", required: true },
  academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true },
  semester:     { type: Number, enum: [1, 2, 3], required: true },
  kind:         { type: String, enum: ["semester", "retake"], default: "semester" },
  registeredAt: { type: Date, default: Date.now },
  recordedBy:   { type: Schema.Types.ObjectId, ref: "User" },
});

schema.index({ student: 1, academicYear: 1, semester: 1, kind: 1 }, { unique: true });

export default mongoose.model<ISemesterRegistration>("SemesterRegistration", schema);