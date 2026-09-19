/**
 * OFF name-search ordering (#213, #192). Runs the ranker over real
 * search.openfoodfacts.org responses captured in fixtures/off-search-213.json.
 *
 * #213: quality signals (photo, completeness, Nutri-Score) used to reorder the
 * whole page, so a product OFF ranked first by a wide margin sank to #38.
 * They now only reorder results whose OFF relevance scores are close.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankOFFResults, hasNutriScore, OFF_RELEVANCE_BAND } from '../src/lib/off-rank.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/off-search-213.json', import.meta.url), 'utf8'));
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The fields _mapOFFProduct carries that the ranker reads.
const toEntries = (hits, { withScore = true } = {}) => hits.map((h) => ({
  food: {
    name: h.product_name,
    barcode: h.code,
    imgUrl: h.has_image ? `https://images.example/${h.code}.jpg` : '',
    completeness: typeof h.completeness === 'number' ? h.completeness : null,
    nutriscore: (h.nutriscore_grade || '').toLowerCase() || null,
  },
  score: withScore ? h._score : undefined,
}));
const position = (foods, code) => foods.findIndex((f) => f.barcode === code) + 1;

test('the #213 example stays where OFF ranks it', () => {
  const { hits } = fixture['Blue Label Marie Biscuits'];
  assert.equal(hits[0].code, '6009704170273', 'fixture: OFF ranks the product first');
  assert.ok(hits[0]._score > hits[1]._score * 3, 'fixture: by a wide margin');
  assert.equal(hits[0].has_image, false);
  assert.ok(hits[0].completeness < 0.5);

  const ranked = rankOFFResults(toEntries(hits));
  assert.equal(position(ranked, '6009704170273'), 1);
  assert.equal(ranked.length, hits.length, 'nothing dropped');
});

test('the old whole-page ordering is what buried it (regression guard)', () => {
  // Without scores the ranker falls back to quality only, as before #213.
  const { hits } = fixture['Blue Label Marie Biscuits'];
  const qualityOnly = rankOFFResults(toEntries(hits, { withScore: false }));
  assert.ok(position(qualityOnly, '6009704170273') > 20);
});

test('within a tied group, the best-documented entry comes first', () => {
  // OFF gives most "nutella" results one identical score; quality decides there.
  const { hits } = fixture.nutella;
  const counts = new Map();
  for (const h of hits) counts.set(h._score, (counts.get(h._score) || 0) + 1);
  const [tiedScore, tiedCount] = [...counts].sort((x, y) => y[1] - x[1])[0];
  assert.ok(tiedCount >= 5, 'fixture: a large tie exists');

  const tiedCodes = new Set(hits.filter((h) => h._score === tiedScore).map((h) => h.code));
  const tied = rankOFFResults(toEntries(hits)).filter((f) => tiedCodes.has(f.barcode));
  for (let k = 1; k < tied.length; k++) {
    const a = tied[k - 1], b = tied[k];
    const photo = (a.imgUrl ? 1 : 0) - (b.imgUrl ? 1 : 0);
    assert.ok(photo > 0 || (photo === 0 && (a.completeness ?? 0) >= (b.completeness ?? 0)),
      `"${a.name}" (${a.completeness}) should not sort above "${b.name}" (${b.completeness})`);
  }
  // And it really is reordered, not left in OFF's order.
  const offOrder = hits.filter((h) => tiedCodes.has(h.code)).map((h) => h.code);
  assert.notDeepEqual(tied.map((f) => f.barcode), offOrder);
});

test('a clearly better match is never moved below a weaker one', () => {
  for (const q of ['Blue Label Marie Biscuits', 'nutella', 'yogurt', 'coca cola']) {
    const { hits } = fixture[q];
    const score = new Map(hits.map((h) => [h.code, h._score]));
    const ranked = rankOFFResults(toEntries(hits));
    // Anything shown above an entry scores at least 90% of it.
    for (let k = 1; k < ranked.length; k++) {
      const below = score.get(ranked[k].barcode);
      for (let m = 0; m < k; m++) {
        const above = score.get(ranked[m].barcode);
        assert.ok(above >= below * OFF_RELEVANCE_BAND,
          `${q}: "${ranked[m].name}" (${above}) sits above "${ranked[k].name}" (${below})`);
      }
    }
  }
});

test('groups keep OFF order between them even if a page arrives unsorted', () => {
  const entries = [
    { food: { name: 'weak but polished', barcode: 'b', imgUrl: 'x', completeness: 1, nutriscore: 'a' }, score: 10 },
    { food: { name: 'strong but bare', barcode: 'a', imgUrl: '', completeness: 0.1, nutriscore: null }, score: 50 },
  ];
  assert.deepEqual(rankOFFResults(entries).map((f) => f.barcode), ['a', 'b']);
});

test('close scores are ordered by photo, then completeness, then Nutri-Score', () => {
  const e = (barcode, score, imgUrl, completeness, nutriscore) => ({ food: { barcode, imgUrl, completeness, nutriscore }, score });
  const ranked = rankOFFResults([
    e('bare', 20, '', 0.9, 'a'),
    e('photo-thin', 19.5, 'x', 0.2, null),
    e('photo-full-unknown', 19, 'x', 0.8, 'unknown'),
    e('photo-full-graded', 18.5, 'x', 0.8, 'c'),
  ]);
  assert.deepEqual(ranked.map((f) => f.barcode), ['photo-full-graded', 'photo-full-unknown', 'photo-thin', 'bare']);
});

test('"unknown" and "not-applicable" do not count as having a Nutri-Score', () => {
  assert.equal(hasNutriScore({ nutriscore: 'b' }), true);
  assert.equal(hasNutriScore({ nutriscore: 'unknown' }), false);
  assert.equal(hasNutriScore({ nutriscore: 'not-applicable' }), false);
  assert.equal(hasNutriScore({ nutriscore: null }), false);
});

test('local mirror results (no scores) keep completeness-first without the photo tier (#192)', () => {
  const e = (barcode, imgUrl, completeness) => ({ food: { barcode, imgUrl, completeness, nutriscore: null } });
  const ranked = rankOFFResults([e('photo-thin', 'x', 0.2), e('curated', '', 0.9)], { fromMirror: true });
  assert.deepEqual(ranked.map((f) => f.barcode), ['curated', 'photo-thin']);
  // A scoreless public envelope still puts photos first, as before.
  const legacy = rankOFFResults([e('curated', '', 0.9), e('photo-thin', 'x', 0.2)], { fromMirror: false });
  assert.deepEqual(legacy.map((f) => f.barcode), ['photo-thin', 'curated']);
});

test('empty and single results pass through', () => {
  assert.deepEqual(rankOFFResults([]), []);
  assert.deepEqual(rankOFFResults(null), []);
  assert.deepEqual(rankOFFResults([{ food: { barcode: 'x' }, score: 3 }]).map((f) => f.barcode), ['x']);
});

test('api.js passes each hit\'s score beside its food, not on it', () => {
  const api = read('../src/lib/api.js');
  assert.match(api, /import \{ rankOFFResults \} from '\.\/off-rank\.js';/);
  assert.match(api, /map\(p => \(\{ food: this\._mapOFFProduct\(p\), score: p \? p\._score : undefined \}\)\)/);
  assert.equal((api.match(/rankOFFResults\(entries, \{ fromMirror \}\)|rankOFFResults\(this\._offSearchEntries\(data\), \{ fromMirror \}\)/g) || []).length, 2,
    'both name-search paths use the ranker');
  assert.doesNotMatch(api, /_rankOFFResults/);
});
