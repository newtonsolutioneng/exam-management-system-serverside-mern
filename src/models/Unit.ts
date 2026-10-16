// // src/models/Unit.ts
// import mongoose, { Schema, Document } from "mongoose";

// export interface IUnit extends Document {
//   institution: mongoose.Types.ObjectId;
//   code: string;
//   name: string;
// }

// const schema = new Schema<IUnit>(
//   {
//     institution: {
//       type: Schema.Types.ObjectId,
//       ref: "Institution",
//       required: true,
//     },
//     code: { type: String, required: true, uppercase: true, trim: true },
//     name: { type: String, required: true, trim: true },
//   },
//   { timestamps: true }
// );

// // Indexes simplified to focus on institution/code uniqueness
// schema.index({ institution: 1, code: 1 }, { unique: true });

// export default mongoose.model<IUnit>("Unit", schema);






// serverside/src/models/Unit.ts

import mongoose, { Schema, Document } from "mongoose";

export interface IUnit extends Document {
  institution: mongoose.Types.ObjectId;
  code: string;
  name: string;
  schoolCode: string;        
  departmentCode: string;
  /** Optional default CA/exam split for this unit (ca + exam = 100). Absent = 30/70 (workshops 40/60). */
  markDistribution?: { ca: number; exam: number };    
}

const schema = new Schema<IUnit>(
  {
    institution: {
      type: Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
    },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    schoolCode:     { type: String, required: true, uppercase: true, trim: true },
    departmentCode: { type: String, required: true, uppercase: true, trim: true },
    markDistribution: { type: new Schema({ ca: { type: Number, min: 0, max: 99 }, exam: { type: Number, min: 1, max: 100 } }, { _id: false }), required: false },
  },
  { timestamps: true }
);

// A unit code is unique within its department (not globally)
schema.index({ institution: 1, departmentCode: 1, code: 1 }, { unique: true });
// For querying all units in a department
// For querying all units in a school
schema.index({ institution: 1, schoolCode: 1 });

export default mongoose.model<IUnit>("Unit", schema);