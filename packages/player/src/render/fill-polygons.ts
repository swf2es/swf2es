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
}

// Coincident edges can interpolate a few ulps apart.
const NEAR = 1e-7;

/** Consistent turns and one x-direction cycle exclude both dents and wound stars. */
function convex(points: number[]): boolean {
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
        return false;
      }

      turn = sign;
    } else if (dx * nextX + dy * nextY < 0) {
      return false;
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

  return turn !== 0 && changes + Number(last !== first) === 2;
}

function separateConvex(contours: number[][]): boolean {
  const bounds: number[][] = [];
  for (const points of contours) {
    if (!convex(points)) {
      return false;
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

    for (const b of bounds) {
      if (minX <= b[2] && minY <= b[3] && maxX >= b[0] && maxY >= b[1]) {
        return false;
      }
    }

    bounds.push([minX, minY, maxX, maxY]);
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

/** The fill as disjoint polygons, or null when its contours do not cross or touch. */
export function crossingFill(contours: number[][], nonZero: boolean): number[][] | null {
  if (contours.length === 1 ? convex(contours[0]) : separateConvex(contours)) {
    return null;
  }

  const edges: Edge[] = [];
  const levels: number[] = [];
  for (let contour = 0; contour < contours.length; contour++) {
    const points = contours[contour];
    const count = points.length / 2;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const x = points[j];
      const y = points[j + 1];
      const dx = points[i] - x;
      const dy = points[i + 1] - y;
      if (dx === 0 && dy === 0) {
        continue;
      }

      edges.push({
        x,
        y,
        dx,
        dy,
        minX: Math.min(x, x + dx),
        maxX: Math.max(x, x + dx),
        minY: Math.min(y, y + dy),
        maxY: Math.max(y, y + dy),
        contour,
        index: i / 2,
        count,
      });
      levels.push(y);
    }
  }

  // Most fills take only this sweep, then use the ordinary containment tree.
  edges.sort((a, b) => a.minX - b.minX);
  let active: Edge[] = [];
  let crossing = false;
  for (const edge of edges) {
    let kept = 0;
    for (const other of active) {
      if (other.maxX < edge.minX) {
        continue;
      }

      active[kept++] = other;
      if (other.maxY < edge.minY || other.minY > edge.maxY) {
        continue;
      }

      const adjacent =
        edge.contour === other.contour &&
        (Math.abs(edge.index - other.index) === 1 ||
          Math.abs(edge.index - other.index) === edge.count - 1);
      const dx = other.x - edge.x;
      const dy = other.y - edge.y;
      const denominator = edge.dx * other.dy - edge.dy * other.dx;
      if (denominator === 0) {
        if (dx * edge.dy - dy * edge.dx !== 0) {
          continue;
        }

        // Adjacent edges can meet, but retraced edges still change the winding.
        if (
          adjacent &&
          Math.min(edge.maxX, other.maxX) === Math.max(edge.minX, other.minX) &&
          Math.min(edge.maxY, other.maxY) === Math.max(edge.minY, other.minY)
        ) {
          continue;
        }

        crossing = true;
        continue;
      }

      const t = (dx * other.dy - dy * other.dx) / denominator;
      const u = (dx * edge.dy - dy * edge.dx) / denominator;
      if (
        t < 0 ||
        t > 1 ||
        u < 0 ||
        u > 1 ||
        (adjacent && (t === 0 || t === 1) && (u === 0 || u === 1))
      ) {
        continue;
      }

      crossing = true;
      levels.push(edge.y + t * edge.dy);
    }

    active.length = kept;
    active.push(edge);
  }

  if (!crossing) {
    return null;
  }

  levels.sort((a, b) => a - b);
  // Keep even nearly equal levels: dropping a vertex just above a crossing
  // would leave its edges inactive for the whole following band.
  const bands = levels.filter((y, i) => i === 0 || y !== levels[i - 1]);
  const rising = edges.filter((edge) => edge.dy !== 0).sort((a, b) => a.minY - b.minY);
  const polygons: number[][] = [];
  active = [];
  let next = 0;
  for (let i = 1; i < bands.length; i++) {
    const top = bands[i - 1];
    const bottom = bands[i];
    const middle = (top + bottom) / 2;
    let kept = 0;
    for (const edge of active) {
      if (edge.maxY > top) {
        active[kept++] = edge;
      }
    }

    active.length = kept;
    while (next < rising.length && rising[next].minY <= top) {
      if (rising[next].maxY > top) {
        active.push(rising[next]);
      }

      next++;
    }

    active.sort((a, b) => xAt(a, middle) - xAt(b, middle));
    let winding = 0;
    let left: Edge | null = null;
    for (let j = 0; j < active.length; ) {
      const edge = active[j];
      const x = xAt(edge, middle);
      const before = nonZero ? winding !== 0 : winding % 2 !== 0;
      do {
        winding += active[j].dy > 0 ? 1 : -1;
        j++;
      } while (j < active.length && Math.abs(xAt(active[j], middle) - x) <= NEAR);

      const after = nonZero ? winding !== 0 : winding % 2 !== 0;
      if (!before && after) {
        left = edge;
      } else if (before && !after && left) {
        polygons.push([
          xAt(left, top),
          top,
          xAt(edge, top),
          top,
          xAt(edge, bottom),
          bottom,
          xAt(left, bottom),
          bottom,
        ]);
      }
    }
  }

  return polygons;
}
