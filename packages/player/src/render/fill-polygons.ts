// Crossing contours cannot be passed to Pixi as an outline with interior holes.
// Split their filled spans at every vertex and crossing: within each horizontal
// band the edge order is fixed, and each span is a convex trapezoid.

interface Edge {
  x: number;
  y: number;
  dx: number;
  dy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  contour: number;
  index: number;
  count: number;
  at: number;
}

interface Contour {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  turn: number;
  needed: boolean;
}

// This synchronous numeric helper calls no host code. Scratch never escapes
// into its returned polygons, and an unusually large fill releases its pool.
const MAX_POOLED = 4096;
const pool: Edge[] = [];
const bounds: Contour[] = [];
const edges: Edge[] = [];
const active: Edge[] = [];
const levels: number[] = [];
let levelCount = 0;

// Coincident edges can interpolate a few ulps apart.
const NEAR = 1e-7;

/** Consistent turns and one x-direction cycle exclude both dents and wound stars. */
function convex(points: number[]): number {
  let turn = 0;
  let first = 0;
  let last = 0;
  let changes = 0;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const k = (i + 2) % points.length;
    const dx = points[i] - points[j];
    const dy = points[i + 1] - points[j + 1];
    const nextX = points[k] - points[i];
    const nextY = points[k + 1] - points[i + 1];
    const cross = dx * nextY - dy * nextX;
    if (cross !== 0) {
      const sign = Math.sign(cross);
      if (turn !== 0 && sign !== turn) {
        return 0;
      }

      turn = sign;
    } else if (dx * nextX + dy * nextY < 0) {
      return 0;
    }

    if (dx !== 0) {
      const sign = Math.sign(dx);
      if (first === 0) {
        first = sign;
      } else if (sign !== last) {
        changes++;
      }

      last = sign;
    }
  }

  return changes + Number(last !== first) === 2 ? turn : 0;
}

/** A convex contour holds the whole bounding box strictly inside its edges. */
function containsBox(points: number[], outer: Contour, inner: Contour): boolean {
  if (
    !outer.turn ||
    inner.minX <= outer.minX ||
    inner.minY <= outer.minY ||
    inner.maxX >= outer.maxX ||
    inner.maxY >= outer.maxY
  ) {
    return false;
  }

  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const dx = (points[i] - points[j]) * outer.turn;
    const dy = (points[i + 1] - points[j + 1]) * outer.turn;
    const x = dy > 0 ? inner.maxX : inner.minX;
    const y = dx > 0 ? inner.minY : inner.maxY;
    if (dx * (y - points[j + 1]) - dy * (x - points[j]) <= 0) {
      return false;
    }
  }

  return true;
}

function xAt(edge: Edge, y: number): number {
  if (y === edge.y) {
    return edge.x;
  }

  if (y === edge.y + edge.dy) {
    return edge.x + edge.dx;
  }

  return edge.x + ((y - edge.y) * edge.dx) / edge.dy;
}

/** Which contours can contribute crossings: convex ones cannot cross themselves. */
function prepare(contours: number[][]): boolean {
  let needed = false;
  for (let c = 0; c < contours.length; c++) {
    const points = contours[c];
    let b = bounds[c];
    if (!b) {
      b = { minX: 0, minY: 0, maxX: 0, maxY: 0, turn: 0, needed: false };
      bounds[c] = b;
    }

    b.turn = contours.length === 1 ? 0 : convex(points);
    b.needed = b.turn === 0;
    needed ||= b.needed;
    if (contours.length === 1) {
      return true;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]);
      minY = Math.min(minY, points[i + 1]);
      maxX = Math.max(maxX, points[i]);
      maxY = Math.max(maxY, points[i + 1]);
    }

    b.minX = minX;
    b.minY = minY;
    b.maxX = maxX;
    b.maxY = maxY;
    for (let j = 0; j < c; j++) {
      const a = bounds[j];
      if (
        a.maxX < b.minX ||
        a.minX > b.maxX ||
        a.maxY < b.minY ||
        a.minY > b.maxY ||
        containsBox(contours[j], a, b) ||
        containsBox(points, b, a)
      ) {
        continue;
      }

      a.needed = b.needed = needed = true;
    }
  }

  return needed;
}

function loadEdges(contours: number[][], all: boolean): void {
  let count = 0;
  for (let c = 0; c < contours.length; c++) {
    if (!all && !bounds[c].needed) {
      continue;
    }

    const points = contours[c];
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const x = points[j];
      const y = points[j + 1];
      const dx = points[i] - x;
      const dy = points[i + 1] - y;
      if (dx === 0 && dy === 0) {
        continue;
      }

      let e = pool[count];
      if (!e) {
        e = {
          x: 0,
          y: 0,
          dx: 0,
          dy: 0,
          minX: 0,
          maxX: 0,
          minY: 0,
          maxY: 0,
          contour: 0,
          index: 0,
          count: 0,
          at: 0,
        };
        pool[count] = e;
      }

      e.x = x;
      e.y = y;
      e.dx = dx;
      e.dy = dy;
      e.minX = Math.min(x, x + dx);
      e.maxX = Math.max(x, x + dx);
      e.minY = Math.min(y, y + dy);
      e.maxY = Math.max(y, y + dy);
      e.contour = c;
      e.index = i / 2;
      e.count = points.length / 2;
      edges[count++] = e;
    }
  }

  edges.length = count;
  edges.sort(byX);
}

const byX = (a: Edge, b: Edge) => a.minX - b.minX;
const byY = (a: Edge, b: Edge) => a.minY - b.minY;
const byAt = (a: Edge, b: Edge) => a.at - b.at;
const ascending = (a: number, b: number) => a - b;

/** The parameter of a crossing, Infinity for collinear overlap, or -1. */
function intersection(edge: Edge, other: Edge): number {
  const same = edge.contour === other.contour;
  if (same && bounds[edge.contour].turn !== 0) {
    return -1;
  }

  const adjacent =
    same &&
    (Math.abs(edge.index - other.index) === 1 ||
      Math.abs(edge.index - other.index) === edge.count - 1);
  const dx = other.x - edge.x;
  const dy = other.y - edge.y;
  const denominator = edge.dx * other.dy - edge.dy * other.dx;
  if (denominator === 0) {
    if (dx * edge.dy - dy * edge.dx !== 0) {
      return -1;
    }

    if (
      adjacent &&
      Math.min(edge.maxX, other.maxX) === Math.max(edge.minX, other.minX) &&
      Math.min(edge.maxY, other.maxY) === Math.max(edge.minY, other.minY)
    ) {
      return -1;
    }

    return Infinity;
  }

  // Nonparallel adjacent edges meet only at their shared vertex. Testing
  // that through computed parameters can misclassify it after rounding.
  if (adjacent) {
    return -1;
  }

  const t = (dx * other.dy - dy * other.dx) / denominator;
  const u = (dx * edge.dy - dy * edge.dx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Stop at the first crossing, or collect all crossing levels after detection succeeded. */
function sweep(collect: boolean): boolean {
  let activeCount = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    let kept = 0;
    for (let j = 0; j < activeCount; j++) {
      const other = active[j];
      if (other.maxX < edge.minX) {
        continue;
      }

      active[kept++] = other;
      if (other.maxY < edge.minY || other.minY > edge.maxY) {
        continue;
      }

      const t = intersection(edge, other);
      if (t >= 0) {
        if (!collect) {
          return true;
        }

        if (t <= 1) {
          levels[levelCount++] = edge.y + t * edge.dy;
        }
      }
    }

    active[kept++] = edge;
    activeCount = kept;
  }

  return false;
}

function tessellate(nonZero: boolean): number[][] {
  levels.length = levelCount;
  levels.sort(ascending);
  // Keep even nearly equal levels: dropping a vertex just above a crossing
  // would leave its edges inactive for the whole following band.
  let bands = 0;
  for (let i = 0; i < levels.length; i++) {
    if (i === 0 || levels[i] !== levels[i - 1]) {
      levels[bands++] = levels[i];
    }
  }

  edges.sort(byY);
  const polygons: number[][] = [];
  const spans = new Map<Edge, { right: Edge; band: number; points: number[] }>();
  let activeCount = 0;
  let next = 0;
  for (let i = 1; i < bands; i++) {
    const top = levels[i - 1];
    const bottom = levels[i];
    const middle = (top + bottom) / 2;
    let kept = 0;
    for (let j = 0; j < activeCount; j++) {
      const edge = active[j];
      if (edge.maxY > top) {
        active[kept++] = edge;
      }
    }

    activeCount = kept;
    while (next < edges.length && edges[next].minY <= top) {
      const edge = edges[next++];
      if (edge.dy !== 0 && edge.maxY > top) {
        active[activeCount++] = edge;
      }
    }

    // Small bands need no sort workspace; dense bands keep O(n log n)
    // sorting. Both compute each interpolated x only once.
    if (activeCount > 32) {
      for (let j = 0; j < activeCount; j++) {
        active[j].at = xAt(active[j], middle);
      }

      active.length = activeCount;
      active.sort(byAt);
    } else {
      for (let j = 0; j < activeCount; j++) {
        const edge = active[j];
        edge.at = xAt(edge, middle);
        let k = j;
        while (k > 0 && active[k - 1].at > edge.at) {
          active[k] = active[k - 1];
          k--;
        }

        active[k] = edge;
      }
    }

    let winding = 0;
    let left: Edge | null = null;
    for (let j = 0; j < activeCount; ) {
      const edge = active[j];
      const x = edge.at;
      const before = nonZero ? winding !== 0 : winding % 2 !== 0;
      do {
        winding += active[j].dy > 0 ? 1 : -1;
        j++;
      } while (j < activeCount && Math.abs(active[j].at - x) <= NEAR);

      const after = nonZero ? winding !== 0 : winding % 2 !== 0;
      if (!before && after) {
        left = edge;
      } else if (before && !after && left) {
        const prior = spans.get(left);
        if (prior?.right === edge && prior.band === i - 1) {
          // Unrelated vertices need not split a span with the same straight sides.
          prior.points[4] = xAt(edge, bottom);
          prior.points[5] = bottom;
          prior.points[6] = xAt(left, bottom);
          prior.points[7] = bottom;
          prior.band = i;
          continue;
        }

        const points = [
          xAt(left, top),
          top,
          xAt(edge, top),
          top,
          xAt(edge, bottom),
          bottom,
          xAt(left, bottom),
          bottom,
        ];
        polygons.push(points);
        spans.set(left, { right: edge, band: i, points });
      }
    }
  }

  return polygons;
}

/** The fill as disjoint polygons, or null when its contours do not cross or touch. */
export function crossingFill(contours: number[][], nonZero: boolean): number[][] | null {
  if (contours.length === 0 || (contours.length === 1 && convex(contours[0]))) {
    return null;
  }

  try {
    if (!prepare(contours)) {
      return null;
    }

    loadEdges(contours, false);
    if (!sweep(false)) {
      return null;
    }

    // Include even contours omitted by the detector: they still contribute
    // winding when another contour crosses itself inside them.
    loadEdges(contours, true);
    levelCount = 0;
    for (let i = 0; i < edges.length; i++) {
      levels[levelCount++] = edges[i].y;
    }

    sweep(true);
    return tessellate(nonZero);
  } finally {
    if (pool.length > MAX_POOLED || bounds.length > MAX_POOLED || levels.length > MAX_POOLED) {
      pool.length = bounds.length = edges.length = active.length = levels.length = 0;
    }
  }
}
