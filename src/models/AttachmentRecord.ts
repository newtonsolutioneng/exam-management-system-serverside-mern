// serverside/src/models/AttachmentRecord.ts
//
// ENG.8(d)-(f), ENG.12, ENG.24(b),(c): practical attachments and (B.Ed) teaching practicum are
// pass/fail and must be passed before the degree is awarded.

import mongoose, { Schema, Document } from "mongoose";

export interface IAttachmentRecord extends Document {
  institution: mongoose.Types.ObjectId;
  student:     mongoose.Types.ObjectId;
  kind:        "attachment" | "practicum";
  yearOfStudy: number;
  weeks:       number;
  status:      "pending" | "passed" | "failed";
  recordedBy?: mongoose.Types.ObjectId;
  recordedAt:  Date;
}

const schema = new Schema<IAttachmentRecord>({
  institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  student:     { type: Schema.Types.ObjectId, ref: "Student", required: true },
  kind:        { type: String, enum: ["attachment", "practicum"], required: true },
  yearOfStudy: { type: Number, required: true, min: 1 },
  weeks:       { type: Number, required: true, min: 0 },
  status:      { type: String, enum: ["pending", "passed", "failed"], default: "pending" },
  recordedBy:  { type: Schema.Types.ObjectId, ref: "User" },
  recordedAt:  { type: Date, default: Date.now },
});

schema.index({ student: 1, kind: 1, yearOfStudy: 1 }, { unique: true });

export default mongoose.model<IAttachmentRecord>("AttachmentRecord", schema);