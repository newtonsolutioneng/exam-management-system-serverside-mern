// serverside/src/models/PromotionReportLog.ts
//
// Remembers that the CMS / the summary reports for one class (programme + year of study + academic year)
// were generated, so promoting the class first can warn the coordinator ("you have not downloaded the CMS").

import mongoose, { Schema, Document } from "mongoose";

export interface IPromotionReportLog extends Document {
  institution: mongoose.Types.ObjectId;
  program:     mongoose.Types.ObjectId;
  yearOfStudy: number;
  academicYear: string;               // the year's label, e.g. "2013/2014"
  kind:        "cms" | "reports";
  at:          Date;
  by?:         mongoose.Types.ObjectId;
}

const schema = new Schema<IPromotionReportLog>({
  institution:  { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  program:      { type: Schema.Types.ObjectId, ref: "Program", required: true },
  yearOfStudy:  { type: Number, required: true },
  academicYear: { type: String, required: true },
  kind:         { type: String, enum: ["cms", "reports"], required: true },
  at:           { type: Date, default: Date.now },
  by:           { type: Schema.Types.ObjectId, ref: "User" },
});

schema.index({ program: 1, yearOfStudy: 1, academicYear: 1, kind: 1 }, { unique: true });

export default mongoose.models.PromotionReportLog ||
  mongoose.model<IPromotionReportLog>("PromotionReportLog", schema);