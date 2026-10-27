// serverside/src/models/GradeAppeal.ts — ENG.26: appeal for remarking within four weeks of the release of results.

import mongoose, { Schema, Document } from "mongoose";

export interface IGradeAppeal extends Document {
  institution:  mongoose.Types.ObjectId;
  student:      mongoose.Types.ObjectId;
  programUnit:  mongoose.Types.ObjectId;
  academicYear: mongoose.Types.ObjectId;
  filedAt:      Date;
  filedBy?:     mongoose.Types.ObjectId;
  grounds:      string;
  /** filed after the window, accepted by the coordinator with a reason */
  late:         boolean;
  lateReason?:  string;
  markAtFiling: number;
  status:       "open" | "upheld" | "dismissed";
  newMark?:     number | null;
  decidedAt?:   Date;
  decidedBy?:   mongoose.Types.ObjectId;
  note?:        string;
}

const schema = new Schema<IGradeAppeal>({
  institution:  { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student:      { type: Schema.Types.ObjectId, ref: "Student", required: true },
  programUnit:  { type: Schema.Types.ObjectId, ref: "ProgramUnit", required: true },
  academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true },
  filedAt:      { type: Date, default: Date.now },
  filedBy:      { type: Schema.Types.ObjectId, ref: "User" },
  grounds:      { type: String, required: true },
  late:         { type: Boolean, default: false },
  lateReason:   String,
  markAtFiling: { type: Number, default: 0 },
  status:       { type: String, enum: ["open", "upheld", "dismissed"], default: "open" },
  newMark:      { type: Number, min: 0, max: 100, default: null },
  decidedAt:    Date,
  decidedBy:    { type: Schema.Types.ObjectId, ref: "User" },
  note:         String,
});

schema.index({ student: 1, programUnit: 1, academicYear: 1 });

export default mongoose.model<IGradeAppeal>("GradeAppeal", schema);