/**
 * nutrition.js - Nutriment definitions and calculation utilities
 */
// Ordered to match US Nutrition Facts label for easy manual entry
const NUTRIMENTS = [
  // Energy
  { id: 'calories',      label: 'Calories',      unit: 'kcal', category: 'energy',  default: true },
  { id: 'kilojoules',    label: 'Kilojoules',    unit: 'kJ',   category: 'energy',  default: false },
  // Total Fat
  { id: 'fat',                 label: 'Fat',                 unit: 'g',    category: 'macro',   default: true },
  { id: 'saturated-fat',       label: 'Saturated Fat',       unit: 'g',    category: 'macro',   default: true },
  { id: 'trans-fat',           label: 'Trans Fat',           unit: 'g',    category: 'macro',   default: false },
  { id: 'polyunsaturated-fat', label: 'Polyunsaturated Fat', unit: 'g',    category: 'macro',   default: false },
  { id: 'monounsaturated-fat', label: 'Monounsaturated Fat', unit: 'g',    category: 'macro',   default: false },
  // Cholesterol & Sodium
  { id: 'cholesterol',   label: 'Cholesterol',   unit: 'mg',   category: 'other',   default: false },
  { id: 'sodium',        label: 'Sodium',        unit: 'mg',   category: 'mineral', default: true },
  { id: 'salt',          label: 'Salt',          unit: 'g',    category: 'macro',   default: false },
  // Total Carbohydrate
  { id: 'carbohydrates', label: 'Carbs',         unit: 'g',    category: 'macro',   default: true },
  { id: 'fiber',         label: 'Fiber',         unit: 'g',    category: 'macro',   default: true },
  { id: 'sugars',        label: 'Sugars',        unit: 'g',    category: 'macro',   default: true },
  { id: 'added-sugars',   label: 'Added Sugars',  unit: 'g',    category: 'macro',   default: true },
  // Protein
  { id: 'proteins',      label: 'Protein',       unit: 'g',    category: 'macro',   default: true },
  // Vitamins & Minerals (Nutrition Facts order)
  { id: 'vitamin-d',     label: 'Vitamin D',     unit: 'µg',  category: 'vitamin', default: false },
  { id: 'calcium',       label: 'Calcium',       unit: 'mg',   category: 'mineral', default: false },
  { id: 'iron',          label: 'Iron',          unit: 'mg',   category: 'mineral', default: false },
  { id: 'potassium',     label: 'Potassium',     unit: 'mg',   category: 'mineral', default: false },
  // Additional vitamins
  { id: 'vitamin-a',     label: 'Vitamin A',     unit: 'µg',  category: 'vitamin', default: false },
  { id: 'vitamin-c',     label: 'Vitamin C',     unit: 'mg',   category: 'vitamin', default: false },
  { id: 'vitamin-e',     label: 'Vitamin E',     unit: 'mg',   category: 'vitamin', default: false },
  { id: 'vitamin-k',     label: 'Vitamin K',     unit: 'µg',  category: 'vitamin', default: false },
  { id: 'b1',            label: 'Vitamin B1',    unit: 'mg',   category: 'vitamin', default: false },
  { id: 'b2',            label: 'Vitamin B2',    unit: 'mg',   category: 'vitamin', default: false },
  { id: 'b3',            label: 'Vitamin B3',    unit: 'mg',   category: 'vitamin', default: false },
  { id: 'b6',            label: 'Vitamin B6',    unit: 'mg',   category: 'vitamin', default: false },
  { id: 'b9',            label: 'Folate (B9)',   unit: 'µg',  category: 'vitamin', default: false },
  { id: 'b12',           label: 'Vitamin B12',   unit: 'µg',  category: 'vitamin', default: false },
  { id: 'magnesium',     label: 'Magnesium',     unit: 'mg',   category: 'mineral', default: false },
  { id: 'zinc',          label: 'Zinc',          unit: 'mg',   category: 'mineral', default: false },
  { id: 'phosphorus',    label: 'Phosphorus',    unit: 'mg',   category: 'mineral', default: false },
  // Other
  { id: 'caffeine',      label: 'Caffeine',      unit: 'mg',   category: 'other',   default: false },
  { id: 'alcohol',       label: 'Alcohol',       unit: 'g',    category: 'other',   default: false },
];

const Nutrition = {
  calculate(item) {
    if (!item) return {};
    const quantity = parseFloat(item.quantity) || 1;
    const factor = quantity; // nutrition values are per serving; quantity = number of servings
    const result = {};
    if (item.nutrition && typeof item.nutrition === 'object' && Object.keys(item.nutrition).length > 0) {
      // Nested structure (API foods and properly-saved FoodEditor items)
      for (const [key, val] of Object.entries(item.nutrition)) {
        result[key] = (parseFloat(val) || 0) * factor;
      }
    } else {
      // Flat structure (legacy locally-created items)
      for (const n of NUTRIMENTS) {
        const v = item[n.id];
        if (v !== undefined && v !== '' && v !== null) {
          result[n.id] = (parseFloat(v) || 0) * factor;
        }
      }
      // Handle calories_kcal alias from old save format
      if (item.calories_kcal !== undefined && result.calories === undefined) {
        result.calories = (parseFloat(item.calories_kcal) || 0) * factor;
      }
    }
    return result;
  },

  sum(nutritionArray) {
    const result = {};
    for (const n of nutritionArray) {
      if (!n) continue;
      for (const [key, val] of Object.entries(n)) {
        result[key] = (result[key] || 0) + (parseFloat(val) || 0);
      }
    }
    return result;
  },

  macroPercents(nutrition) {
    if (!nutrition) return { fat: 0, carbs: 0, protein: 0 };
    const fatKcal = (nutrition.fat || 0) * 9;
    const carbKcal = (nutrition.carbohydrates || 0) * 4;
    const protKcal = (nutrition.proteins || 0) * 4;
    const total = fatKcal + carbKcal + protKcal;
    if (total === 0) return { fat: 0, carbs: 0, protein: 0 };
    return {
      fat: Math.round((fatKcal / total) * 100),
      carbs: Math.round((carbKcal / total) * 100),
      protein: Math.round((protKcal / total) * 100)
    };
  },

  kcalToKj(kcal) { return (parseFloat(kcal) || 0) * 4.184; },
  kjToKcal(kj)   { return (parseFloat(kj) || 0) / 4.184; },

  calculateTDEE({ gender, age, height_cm, weight_kg, activity }) {
    const h = parseFloat(height_cm) || 170;
    const wt = parseFloat(weight_kg) || 70;
    const a = parseInt(age) || 30;
    const bmr = (h * 6.25) + (wt * 9.99) - (a * 4.92) + (gender === 'male' ? 5 : -161);
    const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 }[activity] || 1.2;
    return Math.round(bmr * mult);
  },

  getAll() {
    const custom = DB.getSetting('customNutriments', []);
    return [...NUTRIMENTS, ...custom];
  },

  getVisible() {
    const hidden = DB.getSetting('hiddenNutriments', []);
    const custom = DB.getSetting('customNutriments', []);
    return [...NUTRIMENTS, ...custom].filter(n => !hidden.includes(n.id));
  },

  getById(id) {
    const custom = DB.getSetting('customNutriments', []);
    return [...NUTRIMENTS, ...custom].find(n => n.id === id) || null;
  },

  format(value, decimals) {
    const v = parseFloat(value) || 0;
    const d = decimals !== undefined ? decimals : (v < 10 ? 1 : 0);
    return v.toFixed(d);
  },

  parseExpression(expr) {
    try {
      const clean = String(expr).replace(/[^0-9+\-*/.()]/g, '');
      // eslint-disable-next-line no-new-func
      const result = Function('"use strict"; return (' + clean + ')')();
      return isFinite(result) ? result : 0;
    } catch(e) {
      return parseFloat(expr) || 0;
    }
  }
};

export { NUTRIMENTS, Nutrition };
