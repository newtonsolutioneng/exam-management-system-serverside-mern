// // src/models/InstitutionSettings.ts 
// import mongoose, { Schema, Document } from "mongoose";

// export interface IInstitutionSettings extends Document {
//   institution: mongoose.Types.ObjectId;
//   cat1Max: number; cat2Max: number; cat3Max: number;
//   assignmentMax: number; practicalMax: number; workshopMax: number;
//   examMax: 70; passMark: number; unitType:string;
//   gradingScale?: Array<{ min: number; grade: string; points?: number }>;
// }
// const schema = new Schema<IInstitutionSettings>(
//   {
//     institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true, unique: true },
//     cat1Max: { type: Number, default: 20 },
//     cat2Max: { type: Number, default: 20 },
//     cat3Max: { type: Number, default: 0 },
//     assignmentMax: { type: Number, default: 10 },
//     practicalMax: { type: Number, default: 10 },
//     workshopMax: { type: Number, default: 100 },
//     examMax: { type: Number, default: 70, enum: [70] },
//     passMark: { type: Number, default: 40 },
//     unitType: { type: String, enum: ["theory", "lab", "workshop"], default: "theory" },
//     gradingScale: [ { min: { type: Number, required: true }, grade: { type: String, required: true }, points: { type: Number }}],
//   },
//   { timestamps: true },
// );
// schema.index({ institution: 1 }, { unique: true });
// export default mongoose.model<IInstitutionSettings>("InstitutionSettings", schema);



// serverside/src/models/InstitutionSettings.ts
import mongoose, { Schema, Document } from "mongoose";
import { INTAKE_CODE_REGEX, type IntakeDefinition } from "../utils/semesterLabels";

// Kenyan universities use A/B/C/D/E letter grades only.
// No GPA points. Classification is determined by WAA ranges.
export interface IGradeEntry {
  min:            number;   // lower bound (inclusive)
  max:            number;   // upper bound (inclusive)
  grade:          string;   // "A" | "B" | "C" | "D" | "E"
  // classification is for the WAA-level degree class, not per-unit
  // Per-unit: A=Excellent, B=Good, C=Satisfactory, D=Pass, E=Fail
  label:          string;   // "Excellent" | "Good" | "Satisfactory" | "Pass" | "Fail"
}

export interface IWAAClassification {
  min:            number;
  max:            number;
  classification: string;   // "First Class Honours", "Second Class Upper", etc.
}

export interface IRegNoPattern {
  prefix:       string;    // "E", "SMS", "BUS", "F", "CE"
  separator:    string;    // "-", "/", "" (empty = no separator)
  yearDigits:   number;    // 2 or 3 digits for year portion
  manualRegex?: string;    // override — raw regex string
  example:      string;    // "E024-0001" shown in UI and error messages
}

export interface IDepartment {
  _id:           mongoose.Types.ObjectId;
  name:          string;   // "Department of Civil Engineering"
  shortName:     string;   // "Civil Eng"
  code:          string;   // "CE", "CS", "ME" — must match Program.departmentCode
  hod?:          string;   // Head of Department name — printed on senate docs
  regNoPatterns: IRegNoPattern[];
}

export interface ISchool {
  _id:         mongoose.Types.ObjectId;
  name:        string;    // "School of Engineering"
  shortName:   string;    // "SoE"
  code:        string;    // "ENG", "MED", "BUS" — must match Program.schoolCode
  dean?:       string;    // Dean name — printed on senate docs
  departments: IDepartment[];
}

export interface IRuleSet {
  supplementaryThreshold: number; // fraction of units — default 1/3
  stayoutThreshold: number; // fraction — default 1/2
  repeatYearMeanThreshold: number; // annual mean below this → repeat — default 40
  passMark: number; // default 40
  maxCarryForwardUnits: number; // ENG.14 — default 2
  carryForwardToFinalYear: boolean; // default false
  // Duration = program.durationYears × this multiplier
  // BSc 5yr × 2 = 10yr max, BEd 4yr × 2 = 8yr max, Financial Eng 4yr × 2 = 8yr max
  maxDurationMultiplier: number; // default 2.0
  maxAttempts: number; // default 5
  caWeight: number; // default 30
  examWeight: number; // default 70
  catMax: number; // default 20
  assignmentMax: number; // default 10
  practicalMax: number; // default 10
  labMax: number; // default 30
  suppMarkCap: number; // ENG.13(f) — default = passMark (40)
  hasLab: boolean;
  hasPractical: boolean;
  hasWorkshop: boolean;
  useSemesterWeighting: boolean;
  minCourseworkAttendance: number; // ENG.23(b) — default 0.75
  maxAbsentExams: number; // ENG.23(c) — default 6
  registrationDeadlineWeeks: number; // ENG.23(a)/(d) — default 4
  enforcePracticalPass:     boolean;  // ENG.10(d) — practicals must be passed (default off)
  /** ENG.22(c)/(e): discontinue a stay-out student who fails the retake ("retake"), or only after the supplementary that follows it ("supplementary", default). */
  stayoutDiscontinuation:   "retake" | "supplementary";
  /** ENG.10(e): a missed examination scores 0 and the unit is failed (default off: it is listed as missing). */
  missedExamScoresZero:     boolean;
  /** ENG.8(d)-(f), 24(b),(c): require attachments / teaching practicum to be passed before the award (default off). */
  enforceAttachments:       boolean;
  gradeAppealWindowDays: number; // ENG.26 — default 28
}

export interface IBrandingAssets {
  // ONE logo per institution — used in all senate documents and CMS exports
  universityLogoPath?: string;   // "uploads/logos/uon-logo.png"
  // Report document styling
  reportHeaderText?:   string;   // custom header override for Word docs
  reportFooterText?:   string;
  cmsHeaderColor?:     string;   // hex — Excel CMS header row fill, default "#1F4E79"
  cmsAccentColor?:     string;   // hex — Excel CMS borders, default "#D4AF37"
  wordDocFontFamily?:  string;   // default "Times New Roman"
  wordDocFontSize?:    number;   // default 12
  useLetterhead?:      boolean;  // include logo image in senate docs
}

export interface ISemesterWeightMap {
  year:   number;
  weight: number;  // fraction — must sum to 1.0 across all years
}

// Stamped on every generated senate document and CMS
export interface IDocumentMeta {
  universityName:   string;   // "University of Nairobi"
  universityAbbr:   string;   // "UoN"
  schoolName:       string;   // "School of Engineering" — used in senate doc headers
  departmentName:   string;   // "Department of Civil Engineering" — default dept
  registrar:        string;   // "Academic Registrar"
  postalAddress:    string;
  telephone:        string;
  email:            string;
  website:          string;
  country:          string;
  city:             string;
}

export interface IInstitutionSettings extends Document {
  institution:        mongoose.Types.ObjectId;
  docMeta:            IDocumentMeta;
  schools:            ISchool[];
  ruleSet:            IRuleSet;
  semesterWeights:    ISemesterWeightMap[];
  // Letter grade scale — A/B/C/D/E only, no GPA points
  gradingScale:       IGradeEntry[];
  // WAA-based degree classification — separate from per-unit grading
  waaClassification:  IWAAClassification[];
  branding:           IBrandingAssets;
  supportedIntakes:   string[];
  intakeDefinitions:  IntakeDefinition[];
  enforceRegNoPattern: boolean;
  createdAt:          Date;
  updatedAt:          Date;
}

// ── Defaults ──────────────────────────────────────────────────────────────────
export const DEFAULT_GRADING_SCALE: IGradeEntry[] = [
  { min: 70, max: 100, grade: "A", label: "Excellent" },
  { min: 60, max: 69,  grade: "B", label: "Good" },
  { min: 50, max: 59,  grade: "C", label: "Satisfactory" },
  { min: 40, max: 49,  grade: "D", label: "Pass" },
  { min: 0,  max: 39,  grade: "E", label: "Fail" },
];

export const DEFAULT_WAA_CLASSIFICATION: IWAAClassification[] = [
  { min: 70, max: 100, classification: "First Class Honours" },
  { min: 60, max: 69,  classification: "Second Class Honours (Upper Division)" },
  { min: 50, max: 59,  classification: "Second Class Honours (Lower Division)" },
  { min: 40, max: 49,  classification: "Pass" },
  { min: 0,  max: 39,  classification: "Fail" },
];

export const DEKUT_DEFAULT_WEIGHTS: ISemesterWeightMap[] = [
  { year: 1, weight: 0.15 },
  { year: 2, weight: 0.15 },
  { year: 3, weight: 0.20 },
  { year: 4, weight: 0.25 },
  { year: 5, weight: 0.25 },
];

// ── Schemas ───────────────────────────────────────────────────────────────────
const GradeEntrySchema = new Schema<IGradeEntry>({
  min:   { type: Number, required: true },
  max:   { type: Number, required: true },
  grade: { type: String, required: true, enum: ["A","B","C","D","E"] },
  label: { type: String, required: true },
}, { _id: false });

const WAAClassificationSchema = new Schema<IWAAClassification>({
  min:            { type: Number, required: true },
  max:            { type: Number, required: true },
  classification: { type: String, required: true },
}, { _id: false });

const RegNoPatternSchema = new Schema<IRegNoPattern>({
  prefix:      { type: String, required: true },
  separator:   { type: String, default: "" },
  yearDigits:  { type: Number, default: 3 },
  manualRegex: { type: String },
  example:     { type: String, required: true },
}, { _id: false });

const DepartmentSchema = new Schema<IDepartment>({
  name:          { type: String, required: true },
  shortName:     { type: String, required: true },
  code:          { type: String, required: true, uppercase: true, trim: true },
  hod:           { type: String },
  regNoPatterns: { type: [RegNoPatternSchema], default: [] },
});

const SchoolSchema = new Schema<ISchool>({
  name:        { type: String, required: true },
  shortName:   { type: String, required: true },
  code:        { type: String, required: true, uppercase: true, trim: true },
  dean:        { type: String },
  departments: { type: [DepartmentSchema], default: [] },
});

const RuleSetSchema = new Schema<IRuleSet>(
  {
    supplementaryThreshold: { type: Number, default: 1 / 3, min: 0.1, max: 0.49 },
    stayoutThreshold: { type: Number, default: 0.5, min: 0.1, max: 0.9 },
    repeatYearMeanThreshold: { type: Number, default: 40, min: 0, max: 60 },
    passMark: { type: Number, default: 40, min: 0, max: 60 },
    maxCarryForwardUnits: { type: Number, default: 2, min: 0, max: 10 },
    carryForwardToFinalYear: { type: Boolean, default: false },
    maxDurationMultiplier: { type: Number, default: 2.0, min: 1, max: 5 },
    maxAttempts: { type: Number, default: 5, min: 1, max: 20 },
    caWeight: { type: Number, default: 30, min: 0, max: 100 },
    examWeight: { type: Number, default: 70, min: 0, max: 100 },
    catMax: { type: Number, default: 20, min: 1 },
    assignmentMax: { type: Number, default: 10, min: 1 },
    practicalMax: { type: Number, default: 10, min: 0 },
    labMax: { type: Number, default: 30, min: 0 },
    suppMarkCap: { type: Number, default: 40, min: 0, max: 100 },
    hasLab: { type: Boolean, default: true },
    hasPractical: { type: Boolean, default: true },
    hasWorkshop: { type: Boolean, default: false },
    useSemesterWeighting: { type: Boolean, default: true },
    minCourseworkAttendance: { type: Number, default: 0.75, min: 0, max: 1 },
    maxAbsentExams: { type: Number, default: 6, min: 1 },
    registrationDeadlineWeeks: { type: Number, default: 4, min: 1, max: 20 },
    enforcePracticalPass:    { type: Boolean, default: false },
    stayoutDiscontinuation:  { type: String, enum: ["retake", "supplementary"], default: "supplementary" },
    missedExamScoresZero:    { type: Boolean, default: false },
    enforceAttachments:      { type: Boolean, default: false },
    gradeAppealWindowDays: { type: Number, default: 28, min: 1 },
  },
  { _id: false },
);

const SemesterWeightSchema = new Schema<ISemesterWeightMap>({
  year:   { type: Number, required: true },
  weight: { type: Number, required: true, min: 0, max: 1 },
}, { _id: false });

const BrandingSchema = new Schema<IBrandingAssets>({
  universityLogoPath: { type: String },
  reportHeaderText:   { type: String },
  reportFooterText:   { type: String },
  cmsHeaderColor:     { type: String, default: "#1F4E79" },
  cmsAccentColor:     { type: String, default: "#D4AF37" },
  wordDocFontFamily:  { type: String, default: "Times New Roman" },
  wordDocFontSize:    { type: Number, default: 12 },
  useLetterhead:      { type: Boolean, default: true },
}, { _id: false });

const DocumentMetaSchema = new Schema<IDocumentMeta>({
  universityName:  { type: String, required: true },
  universityAbbr:  { type: String, required: true },
  schoolName:      { type: String, required: true },
  departmentName:  { type: String, required: true },
  registrar:       { type: String, default: "Academic Registrar" },
  postalAddress:   { type: String, default: "" },
  telephone:       { type: String, default: "" },
  email:           { type: String, default: "" },
  website:         { type: String, default: "" },
  country:         { type: String, default: "Kenya" },
  city:            { type: String, default: "" },
}, { _id: false });

const InstitutionSettingsSchema = new Schema<IInstitutionSettings>(
  {
    institution:        { type: Schema.Types.ObjectId, ref: "Institution", required: true, unique: true },
    docMeta:            { type: DocumentMetaSchema, required: true },
    schools:            { type: [SchoolSchema], default: [] },
    ruleSet:            { type: RuleSetSchema, default: () => ({}) },
    semesterWeights:    { type: [SemesterWeightSchema], default: [] },
    gradingScale:       { type: [GradeEntrySchema], default: [] },
    waaClassification:  { type: [WAAClassificationSchema], default: [] },
    branding:           { type: BrandingSchema, default: () => ({}) },
    supportedIntakes: {
      type:    [{ type: String, match: INTAKE_CODE_REGEX }],
       default: ["SEPT"],
     },
    intakeDefinitions: {
      type: [new Schema(
        {
          code:            { type: String, required: true, uppercase: true, trim: true, match: INTAKE_CODE_REGEX },
          label:           { type: String, required: true, trim: true, maxlength: 40 },
          defaultSemester: { type: Number, enum: [1, 2, 3], required: true, default: 1 },
        },
        { _id: false },
      )],
      default: [],
    },
    enforceRegNoPattern: { type: Boolean, default: false },
  },
  { timestamps: true },
);

InstitutionSettingsSchema.index({ "schools.code": 1 });
InstitutionSettingsSchema.index({ "schools.departments.code": 1 });

export default mongoose.model<IInstitutionSettings>(
  "InstitutionSettings",
  InstitutionSettingsSchema,
);