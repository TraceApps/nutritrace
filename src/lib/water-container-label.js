import { tr } from './i18n-label.js';

const defaults = {
  'Small Bottle': 'small_bottle',
  'Standard Bottle': 'standard_bottle',
  'Large Bottle': 'large_bottle',
  'Gallon Jug': 'gallon_jug',
  'Small Glass': 'small_glass',
  '1 Gallon': 'one_gallon',
};

export function waterContainerLabel(name, localeTick) {
  const key = defaults[name];
  return key ? tr('water_container', key, name, localeTick) : name;
}
