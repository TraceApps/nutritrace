const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function centeredSquareCrop(width, height, coverage = 0.8) {
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const safeCoverage = clamp(Number(coverage) || 0.8, 0.1, 1);
  const size = Math.round(Math.min(safeWidth, safeHeight) * safeCoverage);

  return {
    x: Math.round((safeWidth - size) / 2),
    y: Math.round((safeHeight - size) / 2),
    size,
  };
}

export function moveSquareCrop(crop, deltaX, deltaY, width, height) {
  return {
    ...crop,
    x: clamp(crop.x + deltaX, 0, Math.max(0, width - crop.size)),
    y: clamp(crop.y + deltaY, 0, Math.max(0, height - crop.size)),
  };
}

export function resizeSquareCrop(crop, deltaX, deltaY, width, height, minSize = 48) {
  const dominantDelta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
  const maxSize = Math.max(0, Math.min(width - crop.x, height - crop.y));
  const effectiveMin = Math.min(Math.max(1, minSize), maxSize);

  return {
    ...crop,
    size: clamp(crop.size + dominantDelta, effectiveMin, maxSize),
  };
}
