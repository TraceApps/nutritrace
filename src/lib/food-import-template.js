/**
 * Templates for the Bulk Food Import flow.
 *
 * Both shapes are generated programmatically from NUTRIMENTS so that any
 * nutrient added to the catalog automatically appears in the template.
 * Hard-coding the column list would silently drop nutrients added later.
 */
import { NUTRIMENTS } from './nutrition.js';

const FIXED_COLUMNS = ['name', 'brand', 'barcode', 'portion', 'unit', 'category'];

export function buildJsonTemplate() {
  const nutrition = Object.fromEntries(NUTRIMENTS.map(n => [n.id, 0]));
  nutrition.calories = 200;
  nutrition.fat = 8;
  nutrition.carbohydrates = 25;
  nutrition.proteins = 5;
  return {
    foods: [
      {
        name: 'Example Food',
        brand: 'Example Brand',
        barcode: '',
        portion: 100,
        unit: 'g',
        category: '',
        nutrition,
      },
    ],
  };
}

export function buildCsvTemplate() {
  const headers = [...FIXED_COLUMNS, ...NUTRIMENTS.map(n => n.id)];
  const example = [
    'Example Food', 'Example Brand', '', 100, 'g', '',
    ...NUTRIMENTS.map(n => {
      if (n.id === 'calories') return 200;
      if (n.id === 'fat') return 8;
      if (n.id === 'carbohydrates') return 25;
      if (n.id === 'proteins') return 5;
      return '';
    }),
  ];
  return headers.join(',') + '\n' + example.join(',') + '\n';
}

export { FIXED_COLUMNS };
