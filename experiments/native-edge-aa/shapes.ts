export function rectangle(width: number, height: number): number[] {
  return [
    -width / 2,
    -height / 2,
    width / 2,
    -height / 2,
    width / 2,
    height / 2,
    -width / 2,
    height / 2,
  ];
}

/** Fixed, twip-representable outlines for the Flash and browser captures. */
export function fixture(diagonal = false): number[][] {
  const polygons: number[][] = [];
  for (let i = 0; i < 12; i++) {
    const width = diagonal ? 96 : 170;
    const height = diagonal ? [2, 4, 8][i % 3] : [1, 2, 4, 8][i % 4];
    const angle = diagonal ? 0.35 + i * 0.11 : [0.02, 0.07, 0.15][Math.floor(i / 4)];
    const x = diagonal ? 64 + (i % 4) * 128 : 118 + Math.floor(i / 6) * 256;
    const y = diagonal ? 54 + Math.floor(i / 4) * 104 : 30 + (i % 6) * 48;
    const points = rectangle(width, height);
    for (let k = 0; k < points.length; k += 2) {
      const px = points[k];
      const py = points[k + 1];
      points[k] = Math.round((x + Math.cos(angle) * px - Math.sin(angle) * py) * 20) / 20;
      points[k + 1] = Math.round((y + Math.sin(angle) * px + Math.cos(angle) * py) * 20) / 20;
    }
    polygons.push(points);
  }
  return polygons;
}
