// One rule for every side (#277): when no id names an item's food, meal or
// recipe and several of the same name have a photo, the diary shows the
// newest one's: the highest server id, and on a phone a row that hasn't
// reached the server yet is newer still (it gets the next id there). The
// server looks at the reader's own rows before ones shared with them; a
// phone only has the reader's own. Used by scripts/android-sync-server.test.js
// (the server and Yesterday's Meals) and scripts/android-sync.test.js (the
// phone).

/** The newest of `rows` ({ order }: when each was made, oldest first). */
export const newest = rows => rows.reduce((a, b) => (b.order > a.order ? b : a));

// Rows, oldest first. `key` names the photo (/same/<key>.jpg).
export const ROWS = {
  foods: [
    { key: 'pear1', name: 'Twin Pear' },
    { key: 'milk0', name: 'Twin Milk' },
    { key: 'pear2', name: 'Twin Pear ' },
    { key: 'milk1', name: 'Twin Milk', brand: 'Co' },
    { key: 'pear3', name: 'twin pear' },
    { key: 'milk2', name: 'Twin Milk', brand: 'Co' },
  ].map((r, order) => ({ ...r, order, img: `/same/${r.key}.jpg` })),
  meals: [
    { key: 'oats1', name: 'Twin Oats' },
    { key: 'oats2', name: 'Twin Oats' },
  ].map((r, order) => ({ ...r, order, img: `/same/${r.key}.jpg` })),
};

// Items no id names (none, or one of a row that's gone), and the rows of
// the same name each could show.
export const ITEMS = [
  { item: { name: 'Twin Pear' }, from: ['pear1', 'pear2', 'pear3'] },
  { item: { name: ' TWIN PEAR ' }, from: ['pear1', 'pear2', 'pear3'] },
  { item: { food_server_id: 987001, name: 'Twin Pear' }, from: ['pear1', 'pear2', 'pear3'] },
  { item: { name: 'Twin Milk', brand: 'co' }, from: ['milk1', 'milk2'] },
  { item: { name: 'Twin Milk', brand: 'Another' }, from: ['milk0', 'milk1', 'milk2'] },
  { item: { name: 'Twin Milk' }, from: ['milk0'] },
  { item: { name: 'twin oats', is_recipe: 1 }, from: ['oats1', 'oats2'], recipe: true },
];

/** The photo each item should show, by the rule above. */
export function expectedPhotos() {
  return ITEMS.map(({ from, recipe }) => {
    const pool = recipe ? ROWS.meals : ROWS.foods;
    return newest(pool.filter(r => from.includes(r.key))).img;
  });
}
