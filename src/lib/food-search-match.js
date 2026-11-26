/**
 * The Foods tab's search over your own and shared foods: a substring, every
 * word somewhere, or each word within one typo. Both sides are folded, so
 * "champinon" finds "Champiñón" (#346).
 */
import { foldText } from './search-text.js';

function editDist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

export function fuzzyMatchFood(food, q) {
  // Folded on both sides, so "champinon" finds "Champiñón" (#346).
  const name  = foldText(food.name);
  const brand = foldText(food.brand);
  const combined = name + (brand ? ' ' + brand : '');
  const qLow = foldText(q).trim();
  if (!qLow) return true;
  // 1. Exact substring (current behavior)
  if (combined.includes(qLow)) return true;
  // 2. All query words appear somewhere
  const qWords = qLow.split(/\s+/);
  if (qWords.length > 1 && qWords.every(w => combined.includes(w))) return true;
  // 3. Fuzzy per-word: each query word matches a target word within edit distance 1
  const tWords = combined.split(/\s+/);
  return qWords.every(qw =>
    qw.length >= 4 && tWords.some(tw => tw.length >= 3 && editDist(qw, tw) <= 1)
  );
}
