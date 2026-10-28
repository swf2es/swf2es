// How fine a filtered branch's content is, for whether its filter layer may
// be drawn coarser than its target at high quality (render/filters.ts,
// layerFor). A layer drawn coarser places each edge to its own few samples:
// a lone edge comes out near enough under a wide blur, but thin geometry
// repeated under one blur box (stripes, hatching, a glyph's strokes) adds up
// those errors into a brighter or darker region. So the branch's parts are
// told by how thick they are, twice their area over their outline, and
// what is not a shape's fill or line (text, bitmaps, video, a mask, a nested
// filter) counts as thin past any budget.
import { Container, type DisplayObject, ShapeObject } from "../display/display.js";
import { flatten, inside, type Path, type ShapeLayer } from "../display/shapes.js";
import type { Node } from "./node.js";
import type { Linear } from "./strokes.js";

/**
 * A branch's parts on the stage, two numbers each: how thick, in stage
 * pixels, and how long its outline; a part that may not be drawn coarser at
 * all is 0 thick and endlessly long.
 */
export type Parts = number[];

/** The parts of what may not be drawn coarser at all. */
export const THIN_PARTS: Parts = [0, Number.POSITIVE_INFINITY];

/** A layer set's parts in its own space, three numbers each: FILL, area, outline; or a LINE's. */
const FILL = 0;
/** A line that scales with its object: width, length. */
const LINE = 1;
/** A line that keeps its width in some way: width, length. */
const KEPT_LINE = 2;
/** What is thin however drawn: a bitmap fill or drawTriangles. */
const THIN = 3;

/** More contours to a fill than this are not weighed (each against each), but thin. */
const MOST_CONTOURS = 512;

/** The layers' own parts, by the layer set and the version of a drawing's, which change in place. */
const kept = new WeakMap<ShapeLayer[], { version: number; parts: number[] }>();

/** A fill's area by the even-odd rule, its contours not crossing: those inside an odd number of others are holes. */
function fillArea(polygons: number[][]): number {
  const areas = polygons.map((points) => {
    let area = 0;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      area += points[j] * points[i + 1] - points[i] * points[j + 1];
    }

    return Math.abs(area) / 2;
  });
  let total = 0;
  for (let i = 0; i < polygons.length; i++) {
    let depth = 0;
    for (let j = 0; j < polygons.length; j++) {
      if (j !== i && areas[j] > areas[i] && inside(polygons[j], polygons[i][0], polygons[i][1])) {
        depth++;
      }
    }

    total += depth % 2 === 0 ? areas[i] : -areas[i];
  }

  return Math.max(0, total);
}

function outline(points: number[], closed: boolean): number {
  let length = 0;
  for (let i = 2; i < points.length; i += 2) {
    length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  }

  if (closed && points.length >= 4) {
    length += Math.hypot(
      points[0] - points[points.length - 2],
      points[1] - points[points.length - 1],
    );
  }

  return length;
}

function pathsLength(paths: readonly Path[]): number {
  let length = 0;
  for (const path of paths) {
    length += outline(flatten(path), false);
  }

  return length;
}

/** The parts of `layers` in their own space, kept for the layer set (and `version`). */
export function layerParts(layers: ShapeLayer[], version = 0): number[] {
  const known = kept.get(layers);
  if (known && known.version === version) {
    return known.parts;
  }

  const parts: number[] = [];
  for (const layer of layers) {
    if (layer.meshes?.length) {
      parts.push(THIN, 0, 0);
    }

    for (const { fill, contours } of layer.fills) {
      const type = (fill as { type: string }).type;
      if (type === "bitmap" || type === "image" || contours.length > MOST_CONTOURS) {
        parts.push(THIN, 0, 0);
        continue;
      }

      const polygons = contours.map(flatten).filter((points) => points.length >= 6);
      let length = 0;
      for (const points of polygons) {
        length += outline(points, true);
      }

      if (length > 0) {
        parts.push(FILL, fillArea(polygons), length);
      }
    }

    for (const { line, paths } of layer.strokes) {
      const length = pathsLength(paths);
      if (length > 0) {
        parts.push(line.noHScale || line.noVScale ? KEPT_LINE : LINE, line.width / 20, length);
      }
    }
  }

  kept.set(layers, { version, parts });
  return parts;
}

/**
 * Adds `layers`' parts seen through `m`, the linear part of their transform
 * on the stage, to `out`: an area by the determinant, an outline by the
 * matrix's largest stretch at most (its Frobenius norm), a line's width by
 * its smallest at least; `least` is the thinnest line drawn, in stage pixels.
 */
export function addParts(
  out: Parts,
  layers: ShapeLayer[],
  m: Linear,
  least: number,
  version = 0,
): void {
  const local = layerParts(layers, version);
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  const stretch = Math.hypot(m[0], m[1], m[2], m[3]);
  const shrink = stretch > 0 ? det / stretch : 0;
  for (let i = 0; i < local.length; i += 3) {
    const a = local[i + 1];
    const b = local[i + 2];
    switch (local[i]) {
      case FILL: {
        const length = b * stretch;
        out.push(length > 0 ? (2 * a * det) / length : 0, length);
        break;
      }
      case LINE:
        out.push(Math.max(a * shrink, least), 2 * b * stretch);
        break;
      case KEPT_LINE:
        out.push(Math.max(Math.min(a, a * shrink), least), 2 * b * stretch);
        break;
      default:
        out.push(0, Number.POSITIVE_INFINITY);
    }
  }
}

/**
 * The parts of `root`'s branch as drawn, by the nodes the view keeps
 * (`nodeOf`). Only shapes, drawings and containers of them are weighed: any
 * other object, an object masked, clipped, 3D, filtered or blended within
 * it, or one whose node has not drawn yet, is thin.
 */
export function branchParts(
  root: DisplayObject,
  nodeOf: (o: DisplayObject) => Node | undefined,
  least: number,
): Parts {
  const out: Parts = [];
  const visit = (o: DisplayObject): void => {
    if (o !== root && (!o.visible || o.maskOf)) {
      return;
    }

    const node = nodeOf(o);
    if (
      !node ||
      node.stale ||
      node.clipped ||
      node.groups.length > 0 ||
      o.mask ||
      o.scroll ||
      o.space ||
      (o !== root && (o.filters.length > 0 || o.blendMode !== "normal")) ||
      !(o instanceof ShapeObject || o instanceof Container)
    ) {
      out.push(0, Number.POSITIVE_INFINITY);
      return;
    }

    if (node.layers.length > 0) {
      addParts(out, node.layers, node.world, least, o.drawing?.version ?? 0);
    }

    if (o instanceof Container) {
      for (const child of o.children) {
        visit(child);
        if (out.length > 1 && out[out.length - 1] === Number.POSITIVE_INFINITY) {
          return;
        }
      }
    }
  };
  visit(root);
  return out;
}

/** How many times a part's thickness must be a coarse texel's to count as thick. */
export const THICK_TEXELS = 8;

/**
 * Whether `parts` may be drawn into a layer whose texel is `texel` stage
 * pixels, under a blur `box` stage pixels wide whose alpha is multiplied by
 * `strength`: each part THICK_TEXELS texels thick or more, but for thin
 * ones whose outlines, each moved by half a texel, move no more coverage
 * than `levels` of 255 of a box's area.
 */
export function thickEnough(
  parts: Parts,
  texel: number,
  box: number,
  strength: number,
  levels: number,
): boolean {
  let moved = 0;
  const budget = (levels * box * box) / (255 * Math.max(1, strength));
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] < THICK_TEXELS * texel) {
      moved += (parts[i + 1] * texel) / 2;
      if (!(moved <= budget)) {
        return false;
      }
    }
  }

  return true;
}
