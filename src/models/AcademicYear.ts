// serverside/src/models/AcademicYear.ts
import mongoose, { Schema, Document } from "mongoose";
import { requiredDateField } from "../utils/dateValidation";
import { INTAKE_CODE_REGEX } from "../utils/semesterLabels";

export interface IAcademicYear extends Document {
  institution: mongoose.Types.ObjectId;
  year: string;                   // e.g. "2024/2025"
  intakes: string[];
  // Which semester each intake is (1st / 2nd / 3rd) — drives CMS & Senate captions.
  intakeSemesters: Array<{ intake: string; semester: 1 | 2 | 3 }>;
  // How this year's semesters are shown in the UI: month codes or "1st Semester".
  semesterLabelStyle: "INTAKE" | "SEMESTER";
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  // Session control for ENG 13/18
  session: "ORDINARY" | "SUPPLEMENTARY" | "CLOSED";
  isRegistrationOpen: boolean;    // Unit registration window
  // First day of each semester; ENG.23(a)/(d) deadlines are counted from here.
  semesterStarts?: Array<{ semester: 1 | 2 | 3; startDate: Date }>;
  // ENG.27(ii): when the results were released to students; the ENG.26 appeal window runs from here.
  resultsReleasedAt?: Date | null;
}

const schema = new Schema<IAcademicYear>({
  institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
  year: { type: String, required: true },
  intakes: [{ type: String, match: INTAKE_CODE_REGEX }],
  intakeSemesters: {
    type: [new Schema(
      {
        intake:   { type: String, match: INTAKE_CODE_REGEX, required: true },
        semester: { type: Number, enum: [1, 2, 3], required: true },
      },
      { _id: false },
    )],
    default: [],
  },
  semesterLabelStyle: { type: String, enum: ["INTAKE", "SEMESTER"], default: "INTAKE" },
  // startDate: { type: Date, required: true },
  startDate: requiredDateField("Academic year start date"),
  // endDate: { type: Date, required: true },
  endDate: requiredDateField("Academic year end date"),
  isCurrent: { type: Boolean, default: false },
  session: { 
    type: String, 
    enum: ["ORDINARY", "SUPPLEMENTARY", "CLOSED"], 
    default: "ORDINARY" 
  },
  isRegistrationOpen: { type: Boolean, default: true },
  resultsReleasedAt: { type: Date, default: null },
  semesterStarts: {
    type: [new Schema({ semester: { type: Number, enum: [1, 2, 3], required: true }, startDate: { type: Date, required: true } }, { _id: false })],
    default: [],
  },
});

schema.index({ institution: 1, year: 1 }, { unique: true });

export default mongoose.model<IAcademicYear>("AcademicYear", schema);