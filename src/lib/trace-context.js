// Today's diary and water lines for Trace's system prompt. A diary that
// couldn't be read (null) must not read like an empty day, or the model
// answers "nothing logged" without looking (#288).
import { Nutrition } from './nutrition.js';

export const DIARY_UNREADABLE = "Today's diary couldn't be read just now. Call get_diary for today before answering anything about it, and don't say it's empty.";

export function diaryContextText(entry, { mealNames = [], energyUnit = 'kcal' } = {}) {
  if (entry == null) return DIARY_UNREADABLE;
  if (!entry.items?.length) return 'No food logged today yet.';
  const tot = Nutrition.sum(entry.items.map(i => Nutrition.calculate(i)));
  let text = `Totals: ${Math.round(tot.calories||0)} ${energyUnit}, `
           + `${Math.round(tot.proteins||0)}g protein, `
           + `${Math.round(tot.carbohydrates||0)}g carbs, `
           + `${Math.round(tot.fat||0)}g fat.\n`;
  const byMeal = {};
  for (const it of entry.items) {
    const m = it.meal ?? 0;
    (byMeal[m] = byMeal[m] || []).push(it);
  }
  for (const [mIdx, items] of Object.entries(byMeal)) {
    const mName = mealNames[Number(mIdx)] || `Meal ${Number(mIdx)+1}`;
    text += `${mName}: ${items.map(i => `${i.name} (${i.portion||100}${i.unit||'g'})`).join(', ')}\n`;
  }
  return text;
}

export function waterContextText(entry) {
  if (entry == null) return "Unknown (today's diary couldn't be read)";
  const ml = (entry.water || []).reduce((s, l) => s + (l.amount || 0), 0);
  return ml > 0 ? `${(ml / 1000).toFixed(2)} L (${Math.round(ml)} ml)` : 'None logged';
}
