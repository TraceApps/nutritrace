/**
 * Recommended daily targets from a person's profile.
 *
 * - Protein: per kg of goal weight, by the activity level from setup: 0.8 g
 *   (the RDA) for Sedentary or none saved, up to 1.8 g for Extremely Active,
 *   inside the 1.2-2.0 g range sports-nutrition guidance gives people who train.
 * - Fat: 30% of the calorie goal. Carbs: what calories are left after protein and fat.
 * - Saturated fat and added sugar: under 10% of the calorie goal.
 * - Sodium 2,300 mg and cholesterol 300 mg: upper limits (Dietary Guidelines for Americans).
 * - Fiber and vitamins and minerals: Dietary Reference Intakes (National Academies):
 *   RDA where one is set, otherwise AI (adequate intake). Values depend on sex and age.
 *
 * Returns { [nutrientId]: { value, kind } } with kind 'min' (at least),
 * 'max' (at most) or 'target' (a split to aim for). A nutrient without a
 * target is absent. A goal the user sets in Goals always wins (see Diary).
 */

export const PROTEIN_G_PER_KG = { sedentary: 0.8, light: 1.0, moderate: 1.2, active: 1.6, very_active: 1.8 };
export const proteinPerKg = (activity) => PROTEIN_G_PER_KG[activity] ?? PROTEIN_G_PER_KG.sedentary;
export const FAT_PCT_OF_CALORIES = 30;
export const LIMIT_PCT_OF_CALORIES = 10;
export const SODIUM_MG_LIMIT = 2300;
export const CHOLESTEROL_MG_LIMIT = 300;

// Age bands for DRI tables: under 31, 31-50, 51-70, 71+.
const BAND_UPPER_AGES = [30, 50, 70, Infinity];
const bandOf = (age) => BAND_UPPER_AGES.findIndex(max => age <= max);

// [male, female] per band. Sources: NASEM DRI tables for adults 19+.
const MICRONUTRIENTS = {
  'vitamin-d':  { unit: 'mcg', male: [15, 15, 15, 20],    female: [15, 15, 15, 20] },
  'calcium':    { unit: 'mg',  male: [1000, 1000, 1000, 1200], female: [1000, 1000, 1200, 1200] },
  'iron':       { unit: 'mg',  male: [8, 8, 8, 8],        female: [18, 18, 8, 8] },
  'potassium':  { unit: 'mg',  male: [3400, 3400, 3400, 3400], female: [2600, 2600, 2600, 2600] },
  'magnesium':  { unit: 'mg',  male: [400, 420, 420, 420], female: [310, 320, 320, 320] },
  'zinc':       { unit: 'mg',  male: [11, 11, 11, 11],    female: [8, 8, 8, 8] },
  'vitamin-c':  { unit: 'mg',  male: [90, 90, 90, 90],    female: [75, 75, 75, 75] },
  'vitamin-a':  { unit: 'mcg', male: [900, 900, 900, 900], female: [700, 700, 700, 700] },
  'vitamin-e':  { unit: 'mg',  male: [15, 15, 15, 15],    female: [15, 15, 15, 15] },
  'vitamin-k':  { unit: 'mcg', male: [120, 120, 120, 120], female: [90, 90, 90, 90] },
  'b1':         { unit: 'mg',  male: [1.2, 1.2, 1.2, 1.2], female: [1.1, 1.1, 1.1, 1.1] },
  'b2':         { unit: 'mg',  male: [1.3, 1.3, 1.3, 1.3], female: [1.1, 1.1, 1.1, 1.1] },
  'b3':         { unit: 'mg',  male: [16, 16, 16, 16],    female: [14, 14, 14, 14] },
  'b6':         { unit: 'mg',  male: [1.3, 1.3, 1.7, 1.7], female: [1.3, 1.3, 1.5, 1.5] },
  'b9':         { unit: 'mcg', male: [400, 400, 400, 400], female: [400, 400, 400, 400] },
  'b12':        { unit: 'mcg', male: [2.4, 2.4, 2.4, 2.4], female: [2.4, 2.4, 2.4, 2.4] },
};

export function ageOn(dob, now = new Date()) {
  if (!dob) return null;
  const d = new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

export function bmrMifflinStJeor({ gender, age, height_cm, weight_kg }) {
  const h = Number(height_cm), w = Number(weight_kg), a = Number(age);
  if (!(h > 0 && w > 0 && a > 0)) return null;
  if (gender === 'male') return 10 * w + 6.25 * h - 5 * a + 5;
  if (gender === 'female') return 10 * w + 6.25 * h - 5 * a - 161;
  return null;
}

export function recommendedTargets(profile = {}, calorieGoal = null, now = new Date()) {
  const out = {};
  const age = ageOn(profile.dob, now);
  const sex = profile.gender === 'male' || profile.gender === 'female' ? profile.gender : null;
  const cal = Number(calorieGoal) > 0 ? Number(calorieGoal) : null;

  if (cal) {
    const weightKg = Number(profile.target_weight) > 0 ? Number(profile.target_weight) : Number(profile.weight_kg);
    const protein = weightKg > 0 ? Math.round(proteinPerKg(profile.activity) * weightKg) : null;
    const fat = Math.round((cal * FAT_PCT_OF_CALORIES / 100) / 9);
    if (protein != null) {
      out.proteins = { value: protein, kind: 'min' };
      out.carbohydrates = { value: Math.max(0, Math.round((cal - protein * 4 - fat * 9) / 4)), kind: 'target' };
    }
    out.fat = { value: fat, kind: 'target' };
    out['saturated-fat'] = { value: Math.round((cal * LIMIT_PCT_OF_CALORIES / 100) / 9), kind: 'max' };
    out['added-sugars'] = { value: Math.round((cal * LIMIT_PCT_OF_CALORIES / 100) / 4), kind: 'max' };
  }

  out.sodium = { value: SODIUM_MG_LIMIT, kind: 'max' };
  out.cholesterol = { value: CHOLESTEROL_MG_LIMIT, kind: 'max' };

  if (sex && age != null && age >= 19) {
    const band = bandOf(age);
    out.fiber = { value: sex === 'male' ? (band <= 1 ? 38 : 30) : (band <= 1 ? 25 : 21), kind: 'min' };
    for (const [id, row] of Object.entries(MICRONUTRIENTS)) {
      out[id] = { value: row[sex][band], kind: 'min' };
    }
  }
  return out;
}
