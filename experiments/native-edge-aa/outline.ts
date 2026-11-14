import type { GeometryData } from "@swf2es/render";

/** One bounded, single-colour manifold boundary, with no holes or islands. */
export function outlineOf(data: GeometryData): number[] | null {
  const { positions: p, indices, colors } = data;
  if (
    data.texels ||
    data.depths ||
    data.glyphs ||
    p.length < 6 ||
    p.length > 256 ||
    indices.length > 384 ||
    indices.length % 3 ||
    colors.length !== p.length / 2
  ) {
    return null;
  }
  const color = colors[0];
  if (color >>> 24 !== 255 || !colors.every((c) => c === color) || !p.every(Number.isFinite)) {
    return null;
  }
  const ids = new Map<string, number>();
  const points: number[] = [];
  const remap: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    const key = `${p[i]},${p[i + 1]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = points.length / 2;
      ids.set(key, id);
      points.push(p[i], p[i + 1]);
    }
    remap.push(id);
  }
  const edges = new Map<number, [number, number]>();
  const counts = new Map<number, number>();
  let trianglesArea = 0;
  for (let i = 0; i < indices.length; i += 3) {
    let a = remap[indices[i]],
      b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a === undefined || b === undefined || c === undefined) {
      return null;
    }
    const area =
      (points[b * 2] - points[a * 2]) * (points[c * 2 + 1] - points[a * 2 + 1]) -
      (points[b * 2 + 1] - points[a * 2 + 1]) * (points[c * 2] - points[a * 2]);
    if (Math.abs(area) < 1e-10) {
      continue;
    }
    trianglesArea += Math.abs(area);
    if (area < 0) {
      [a, b] = [b, a];
    }
    const triangle = [a, b, c];
    for (let j = 0; j < 3; j++) {
      const from = triangle[j],
        to = triangle[(j + 1) % 3];
      const key = Math.min(from, to) * 128 + Math.max(from, to);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > 2) {
        return null;
      }
      const previous = edges.get(key);
      if (previous) {
        if (previous[0] !== to || previous[1] !== from) {
          return null;
        }
        edges.delete(key);
      } else {
        edges.set(key, [from, to]);
      }
    }
  }
  if (edges.size < 3 || edges.size > 128) {
    return null;
  }
  const next = new Map<number, number>();
  for (const [a, b] of edges.values()) {
    if (next.has(a)) {
      return null;
    }
    next.set(a, b);
  }
  const start = next.keys().next().value;
  if (start === undefined) {
    return null;
  }
  let at = start;
  const contour: number[] = [];
  do {
    const to = next.get(at);
    if (to === undefined) {
      return null;
    }
    contour.push(points[at * 2], points[at * 2 + 1]);
    next.delete(at);
    at = to;
  } while (at !== start);
  if (next.size) {
    return null;
  }
  let boundaryArea = 0;
  for (let i = 0; i < contour.length; i += 2) {
    const j = (i + 2) % contour.length;
    boundaryArea += contour[i] * contour[j + 1] - contour[i + 1] * contour[j];
  }
  if (Math.abs(Math.abs(boundaryArea) - trianglesArea) > Math.max(1e-6, trianglesArea * 1e-6)) {
    return null;
  }
  return contour;
}
