// serverside/src/utils/gradingCore.ts

import { unitWeights, defaultDistributionFor } from "./markDistribution";

export interface GradingInput {
  cat1: number; cat2: number; cat3?: number;
  ass1: number; ass2?: number; ass3?: number;
  practical: number;
  examQ1: number; examQ2: number; examQ3: number; examQ4: number; examQ5: number;
  unitType: "theory" | "lab" | "workshop";
  examMode: "standard" | "mandatory_q1";
  attempt: string; // "1st", "supplementary", "special", "re-take"
  /** Unit mark distribution (ca + exam = 100). Omit for legacy behaviour (30/70, workshop 40/60). */
  caMax?: number;
  examMax?: number;
  settings: {
    catMax: number; assMax: number; practicalMax: number; passMark: number;
  };
}

export const calculateFinalResult = (input: GradingInput) => {
  const { cat1, cat2, cat3, ass1, ass2, ass3, practical, examQ1, examQ2, examQ3, examQ4, examQ5, unitType, examMode, attempt, settings } = input;

  // 1. Determine Weights (Mirroring Excel generateFullScoresheetTemplate)
  const weights = unitWeights(
        unitType,
        input.caMax !== undefined && input.examMax !== undefined
          ? { ca: input.caMax, exam: input.examMax }
          : defaultDistributionFor(unitType),
      );

  // 2. CA Calculation
  let caTotal = 0;
  // ENG 13(e): a unit assessed wholly by coursework (examMax 0) is supplemented by extra coursework, so CA counts.
  const isSuppSitting = attempt.toLowerCase() === "supp" || attempt.toLowerCase() === "supplementary";
  const caOnlyUnit = input.examMax === 0;
  if (isSuppSitting && !caOnlyUnit) {
    caTotal = 0; // Rule ENG 13.f: Supps ignore CA
  } else if (unitType !== "workshop") {
    const avgCat = (cat1 + cat2 + (cat3 || 0)) / (cat3 ? 3 : 2);
    const avgAss = (ass1 + (ass2 || 0) + (ass3 || 0)) / ((ass2 ? 1 : 0) + (ass3 ? 1 : 0) + 1);
    
    const catScore = (avgCat / settings.catMax) * weights.tests;
    const assScore = (avgAss / settings.assMax) * weights.assignment;
    const pracScore = (practical / settings.practicalMax) * weights.practical;
    
    caTotal = catScore + assScore + pracScore;
  } else {
    // Workshop CA is just practical weighted to 40%
    caTotal = (practical / settings.practicalMax) * weights.practical;
  }

  // 3. Exam Calculation (Mirroring Excel formula)
  const q1 = examQ1;
  const others = [examQ2, examQ3, examQ4, examQ5].sort((a, b) => b - a);
  const takeCount = examMode === "mandatory_q1" ? 2 : 3;
  const bestOthersSum = others.slice(0, takeCount).reduce((a, b) => a + b, 0);
  
  const rawExamSum = q1 + bestOthersSum;
  const examWeighted = (rawExamSum / 70) * weights.exam;

  // 4. Final Aggregation
  const unroundedTotal = caTotal + examWeighted;
  let finalMark = Math.round(unroundedTotal);

  // 5. Supplementary Capping
  if (isSuppSitting) {
    finalMark = Math.min(settings.passMark, Math.round(caOnlyUnit ? caTotal : examWeighted));
  }

  return {
    caTotal: Number(caTotal.toFixed(2)),
    examTotal: Number(examWeighted.toFixed(2)),
    finalMark,
    isSupp: attempt.toLowerCase().includes("supp")
  };
};
