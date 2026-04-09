/** Returns a Material Symbols icon name based on keywords in the meal name */
export function mealIcon(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('breakfast') || n.includes('morning') || n.includes('brunch')) return 'free_breakfast';
  if (n.includes('lunch') || n.includes('noon') || n.includes('midday')) return 'lunch_dining';
  if (n.includes('dinner') || n.includes('supper') || n.includes('evening')) return 'dinner_dining';
  if (n.includes('snack') || n.includes('bite') || n.includes('treat')) return 'cookie';
  if (n.includes('drink') || n.includes('smoothie') || n.includes('shake')) return 'local_cafe';
  return 'restaurant';
}
