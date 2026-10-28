// The food editor's link toggle: a serving-size change rescales every
// nutrient by the same ratio, from a baseline of the form's values.
import { parseDecimal } from './decimal-input.js';

export function snapshotOf(food, nutrients) {
  const snap = { portion: parseDecimal(food.portion) || 0 };
  for (const n of nutrients) snap[n.id] = parseDecimal(food[n.id]) || 0;
  return snap;
}

// The food with every nutrient but `changedId` (and `keepId`, a field the
// person is typing in) scaled by newVal / the baseline's value; null when
// there is nothing to scale from.
export function scaledFood(food, snap, changedId, newVal, nutrients, keepId = null) {
  const origVal = changedId === '__portion__' ? snap.portion : snap[changedId];
  if (!origVal || origVal <= 0 || newVal <= 0) return null;
  const ratio = newVal / origVal;
  const next = { ...food };
  for (const n of nutrients) {
    if (n.id === changedId || n.id === keepId) continue;
    const v = snap[n.id];
    if (v > 0) next[n.id] = Math.round(v * ratio * 10000) / 10000;
  }
  if (changedId !== '__portion__' && snap.portion > 0) {
    next.portion = Math.round(snap.portion * ratio * 100) / 100;
  }
  return next;
}
