// serverside/src/models/Nullification.ts
//
// ENG.17 — nullification of examination results. One record per action, kept for the
// disciplinary file. The marks themselves are soft-deleted (deletedAt + nullificationId) and the
// final grades removed; lifting the nullification restores them.

import mongoose, { Schema, Document } from "mongoose";

export interface INullification extends Document {
  institution:  mongoose.Types.ObjectId;
  student:      mongoose.Types.ObjectId;
  /** year  = every result of a year of study (ENG.17(a)); unit = one unit's results (ENG.17(b)) */
  scope:        "year" | "unit";
  ground:       "illegal_promotion" | "no_exam_card";
  yearOfStudy?: number;
  programUnit?: mongoose.Types.ObjectId;
  academicYear?: mongoose.Types.ObjectId;
  reason:       string;
  /** what was nullified, for the record */
  affected:     Array<{ source: "detailed" | "direct"; markId: mongoose.Types.ObjectId; programUnit: mongoose.Types.ObjectId; agreedMark: number }>;
  nullifiedBy:  mongoose.Types.ObjectId;
  nullifiedAt:  Date;
  liftedAt?:    Date | null;
  liftedBy?:    mongoose.Types.ObjectId;
  liftReason?:  string;
}

const schema = new Schema<INullification>({
  institution:  { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student:      { type: Schema.Types.ObjectId, ref: "Student", required: true },
  scope:        { type: String, enum: ["year", "unit"], required: true },
  ground:       { type: String, enum: ["illegal_promotion", "no_exam_card"], required: true },
  yearOfStudy:  Number,
  programUnit:  { type: Schema.Types.ObjectId, ref: "ProgramUnit" },
  academicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear" },
  reason:       { type: String, required: true },
  affected: [{
    _id: false,
    source:      { type: String, enum: ["detailed", "direct"] },
    markId:      { type: Schema.Types.ObjectId },
    programUnit: { type: Schema.Types.ObjectId },
    agreedMark:  Number,
  }],
  nullifiedBy:  { type: Schema.Types.ObjectId, ref: "User", required: true },
  nullifiedAt:  { type: Date, default: Date.now },
  liftedAt:     { type: Date, default: null },
  liftedBy:     { type: Schema.Types.ObjectId, ref: "User" },
  liftReason:   String,
});

schema.index({ student: 1, nullifiedAt: -1 });

export default mongoose.model<INullification>("Nullification", schema);