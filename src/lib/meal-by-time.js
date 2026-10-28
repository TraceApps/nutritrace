/**
 * meal-by-time.js (#278): the meal a food most likely belongs to right now,
 * for the Scan Barcode and Log Food shortcuts. The add screen names it and
 * lets the person change it, so a guess only has to be a good start.
 *
 * Each meal gets a time of day:
 *   1. Meal reminders on: the time set for that meal in Settings, Notifications
 *      (the same times, and the same defaults, that screen shows).
 *   2. Otherwise from its name: Breakfast 8:00, a morning snack or brunch
 *      10:30, Lunch 12:30, a snack 15:30, Dinner 18:30, an evening snack 21:00
 *      (English and a few other languages; see RULES).
 *   3. No name recognized at all (Meal 1, Meal 2...): the meals in their
 *      order, spread evenly from 8:00 to 19:00.
 * A meal's turn starts an hour before its time and lasts until the next
 * meal's turn. Before the first turn of the day (from 4:00) the first meal is
 * picked; from midnight to 4:00, a late night, the day's latest meal is (on
 * today's date, as every shortcut is). A meal whose name isn't recognized,
 * next to ones that are, is never guessed (it may be any time); the person
 * picks it.
 */

const H = (h, m = 0) => h * 60 + m;
const DAY_START = H(4);
const EARLY = 60; // a meal's turn starts this many minutes before its time

// First match wins: the snack rules come before the meal words they contain.
const RULES = [
  [/evening snack|night snack|late snack|bedtime|midnight|dessert/, H(21)],
  [/brunch|morning snack|mid-?morning|elevenses|second breakfast|en-?cas|gouter du matin/, H(10, 30)],
  [/breakfast|morning|petit-?dej|desayuno|fruhstuck|colazione|cafe da manha|ontbijt/, H(8)],
  [/lunch|\bnoon|midday|dejeuner|almuerzo|comida|mittag|pranzo|almoco/, H(12, 30)],
  [/dinner|supper|evening|diner|souper|cena|abend|jantar|avondeten/, H(18, 30)],
  [/snack|afternoon|\btea\b|collation|gouter|merienda|spuntino|lanche|tussendoor|zwischen/, H(15, 30)],
];

// Lowercase, without accents, so "Déjeuner" and "Frühstück" read as words.
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The defaults Settings, Notifications shows for a meal's reminder time. */
export function defaultMealTime(i) { return ['08:00', '12:00', '18:00', '15:00', '10:00', '20:00'][i] || '12:00'; }

const parseHm = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return H(+m[1], +m[2]);
};

/** The time of day (minutes after midnight) for each meal, or null where it can't tell. */
export function mealTimes(names, { reminderTimes = null } = {}) {
  const list = Array.isArray(names) ? names : [];
  if (Array.isArray(reminderTimes)) {
    return list.map((_, i) => parseHm(reminderTimes[i]) ?? parseHm(defaultMealTime(i)));
  }
  const byName = list.map(n => {
    const f = fold(n);
    const hit = RULES.find(([re]) => re.test(f));
    return hit ? hit[1] : null;
  });
  if (byName.some(t => t != null)) return byName;
  if (list.length === 1) return [H(12, 30)];
  return list.map((_, i) => Math.round(H(8) + i * (H(19) - H(8)) / (list.length - 1)));
}

/**
 * The index of the meal for this time of day.
 * names: the meal names in order. now: a Date. reminderTimes: the meal
 * reminder times ('HH:MM' per meal) when meal reminders are on, else null.
 */
export function mealForTime(names, { now = new Date(), reminderTimes = null } = {}) {
  const times = mealTimes(names, { reminderTimes });
  const known = times.map((t, i) => ({ t, i })).filter(x => x.t != null);
  if (!known.length) return 0;
  const mins = now.getHours() * 60 + now.getMinutes();
  // Latest time first; a tie keeps the meal listed first.
  const order = [...known].sort((a, b) => b.t - a.t || a.i - b.i);
  if (mins < DAY_START) return order[0].i;
  const started = order.find(x => x.t - EARLY <= mins);
  if (started) return started.i;
  // Before any turn has started: the earliest meal.
  return [...known].sort((a, b) => a.t - b.t || a.i - b.i)[0].i;
}
