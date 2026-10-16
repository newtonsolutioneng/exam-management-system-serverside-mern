// src/models/ProgramUnit.ts
import mongoose, { Schema, Document } from "mongoose";

export interface IProgramUnit extends Document {
  institution: mongoose.Types.ObjectId;
  program: mongoose.Types.ObjectId; // Reference to Program
  unit: mongoose.Types.ObjectId;     // Reference to Unit
  academicYear: string;         // Academic Year (e.g., "2023/2024")
  requiredYear: number;           // The year this unit is taken in the Program (e.g., 1st Year)
  requiredSemester: 1 | 2 | 3;    // The semester this unit is taken in the Program (3 = trimester / extended programs)
  isElective: boolean;            // Is this unit compulsory or optional for the Program?
}

const schema = new Schema<IProgramUnit>(
  {
    institution: { type: Schema.Types.ObjectId, ref: "Institution", required: true },
    program: { type: Schema.Types.ObjectId, ref: "Program", required: true },
    unit: { type: Schema.Types.ObjectId, ref: "Unit", required: true },
    academicYear: { type: String},
    requiredYear: { type: Number, required: true, min: 1, max: 6 },
    requiredSemester: { type: Number, required: true, enum: [1, 2, 3] },
    isElective: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Index: A Unit should be defined once per Program/Year/Semester
schema.index({ program: 1, unit: 1, academicYear: 1 }, { unique: true });
schema.index({ program: 1, requiredYear: 1, requiredSemester: 1 });
schema.index({ program: 1, requiredYear: 1, requiredSemester: 1, institution: 1 });

export default mongoose.model<IProgramUnit>("ProgramUnit", schema);