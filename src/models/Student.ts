// src/models/Student.ts
import mongoose, { Schema, Document } from "mongoose";
import { INTAKE_CODE_REGEX } from "../utils/semesterLabels";
import type { CarryForwardUnit } from "../services/carryForwardTypes";

export interface IStudent extends Document {
  institution:           mongoose.Types.ObjectId;
  regNo:                 string;
  name:                  string;
  program:               mongoose.Types.ObjectId;
  programType:           string;
  entryType:             "Direct" | "Mid-Entry-Y2" | "Mid-Entry-Y3" | "Mid-Entry-Y4";
  currentYearOfStudy:    number;
  currentSemester:       number;
  remarks?:              string;
  status:                "active" | "graduated" | "discontinued" | "deregistered" | "repeat" | "on_leave" | "deferred" | "graduand" | "disciplinary_suspension";
  admissionAcademicYear: mongoose.Types.ObjectId;
  intake:                string;
  qualifierSuffix:       string;
  /** Transfer from another university (qualifiers doc: TF2/TF3, TF2S2/TF3S2). */
  transfer?:             { fromInstitution?: string; entryYear: 2 | 3; secondSemester: boolean; recordedAt: Date; };
  carryForwardUnits:     CarryForwardUnit[];
  /** ENG.15(h): units failed in a stay-out year, to be retaken at the next ordinary sitting (drives ENG.22(c)/(e)). */
  stayoutUnits?: Array<{ programUnitId: string; unitCode: string; fromYear: number; fromAcademicYear: string; addedAt: Date; status: "pending" | "passed" | "discontinued"; }>;
  deferredSuppUnits: Array<{ programUnitId: string; unitCode: string; unitName: string; fromYear: number; fromAcademicYear: string; reason: "supp_deferred" | "special_deferred"; addedAt: Date; status: "pending" | "passed" | "failed"; }>;
  academicLeavePeriod?:  { startDate: Date; endDate: Date; reason: string; type: "compassionate" | "financial" | "other"; };
  totalTimeOutYears:     number;
  unitAttemptRegistry:   Array<{ unitId: mongoose.Types.ObjectId; attempts: Array<{ attemptNumber: number; mark: number; passed: boolean; type: string; academicYear?: string; }>; }>;
  academicHistory:       Array<{ academicYear: string; yearOfStudy: number; annualMeanMark: number; weightedContribution: number; failedUnitsCount: number; isRepeatYear?: boolean; date?: Date; }>;
  statusHistory:         Array<{ status: string; previousStatus: string; date: Date; reason: string; }>;
  statusEvents:          Array<{ fromStatus: string; toStatus: string; date: Date; academicYear: string; reason: string; }>;
}

const schema = new Schema<IStudent>(
  {
    institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    regNo: { type: String, required: true, uppercase: true },
    name: { type: String, required: true },
    program: { type: Schema.Types.ObjectId, ref: "Program", required: true },
    programType: { type: String, required: true },
    entryType: { type: String, default: "Direct" },
    currentYearOfStudy: { type: Number, default: 1 },
    currentSemester: { type: Number, default: 1 },
    remarks: { type: String },
    admissionAcademicYear: { type: Schema.Types.ObjectId, ref: "AcademicYear", required: true},
    intake: { type: String, required: true, match: INTAKE_CODE_REGEX, uppercase: true, default: "SEPT" },
    status: { type: String, default: "active" },
    qualifierSuffix: { type: String, default: "" },
    transfer: { type: new Schema( { fromInstitution: String, entryYear: { type: Number, enum: [2, 3], required: true }, secondSemester: { type: Boolean, default: false }, recordedAt: { type: Date, default: Date.now }}, { _id: false }, ), default: undefined },

    carryForwardUnits: [{
        programUnitId: { type: String, required: true },
        unitCode: { type: String, required: true },
        unitName: { type: String, required: true },
        fromYear: { type: Number, required: true },
        fromAcademicYear: { type: String, required: true },
        attemptNumber: { type: Number, default: 3 },
        qualifier: { type: String, default: "RP1C" },
        addedAt: { type: Date, default: Date.now },
        status: { type: String, enum: ["pending", "passed", "failed", "escalated_to_rpu"], default: "pending" },
      }],

    stayoutUnits: [{
      programUnitId:    { type: String, required: true },
      unitCode:         { type: String, required: true },
      fromYear:         { type: Number, required: true },
      fromAcademicYear: { type: String, required: true },
      addedAt:          { type: Date, default: Date.now },
      status:           { type: String, enum: ["pending", "passed", "discontinued"], default: "pending" },
    }],

    deferredSuppUnits: [{
        programUnitId: { type: String, required: true },
        unitCode: { type: String, required: true },
        unitName: { type: String, required: true },
        fromYear: { type: Number, required: true },
        fromAcademicYear: { type: String, required: true },
        // "supp_deferred"    = student skipped supp period, sitting in next ordinary
        // "special_deferred" = student's special exam deferred to next ordinary
        reason: { type: String, enum: ["supp_deferred", "special_deferred"], default: "supp_deferred"},
        addedAt: { type: Date, default: Date.now },
        status: { type: String, enum: ["pending", "passed", "failed"], default: "pending" },
      }],

    academicLeavePeriod: { startDate: Date, endDate: Date, reason: String, type: { type: String, enum: ["compassionate", "financial", "other"] }},
    totalTimeOutYears: { type: Number, default: 0 },

    unitAttemptRegistry: [{ unitId: { type: Schema.Types.ObjectId, ref: "Unit" }, attempts: [{ attemptNumber: Number, mark: Number, passed: Boolean, type: { type: String }, academicYear: String }] }],
    academicHistory: [{ academicYear: String, yearOfStudy: Number, annualMeanMark: Number, weightedContribution: Number, failedUnitsCount: Number, isRepeatYear: Boolean, date: Date }],
    statusHistory: [{ status: String, previousStatus: String, date: { type: Date, default: Date.now }, reason: String }],
    statusEvents: [{ fromStatus: String, toStatus: String, date: { type: Date, default: Date.now }, academicYear: String, reason: String, }],
  },
  { timestamps: true },
);

// All indexes declared here only — no field-level index:true to avoid duplicate index warnings
schema.index({ institution: 1, regNo: 1 }, { unique: true });
schema.index({ institution: 1, program: 1, admissionAcademicYear: 1 });
schema.index({ institution: 1, intake: 1 });
schema.index({ institution: 1, status: 1, currentYearOfStudy: 1 });
schema.index({ institution: 1, program: 1, currentYearOfStudy: 1, status: 1 });
schema.index({ institution: 1, admissionAcademicYear: 1, intake: 1 });
schema.index({ "statusEvents.toStatus": 1, "statusEvents.academicYear": 1 });
schema.index({ qualifierSuffix: 1 });
schema.index({ "carryForwardUnits.programUnitId": 1 });
schema.index({ "deferredSuppUnits.programUnitId": 1 });
schema.index({ institution: 1, regNo: 1, status: 1 });
export default mongoose.model<IStudent>("Student", schema);