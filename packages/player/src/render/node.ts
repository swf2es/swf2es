// What the view keeps for each display object it mirrors (render/view.ts):
// its containers, what it drew, and the state each sync compares against.
import type { ColorTransform } from "@swf2es/format";
import {
  type Filter,
  type Graphics,
  type GraphicsContext,
  Container as PixiContainer,
  type Sprite,
} from "pixi.js";
import type { DisplayObject, StaleCache } from "../display/display.js";
import type { Filter as FilterRecord } from "../display/filters.js";
import type { Slice } from "../display/scale9.js";
import type { ShapeLayer } from "../display/shapes.js";
import type { ShapeCharacter } from "../display/timeline.js";
import type { SharedGraphics } from "./shared.js";
import type { Linear } from "./strokes.js";
import type { Plane } from "./three.js";
import type { TriangleView } from "./triangles.js";

/** No filters, the records of an object that has none or is a mask. */
export const NO_RECORDS: readonly FilterRecord[] = [];

/** What the view keeps for a display object. */
export interface Node {
  container: PixiContainer;
  /** The linear part of the object's transform on the stage, its own, which it changes in place. */
  world: Linear;
  /** A stale cache drawn, the scale it was first drawn at, and whether that has changed since. */
  stale: { cache: StaleCache; world: Linear; spent: boolean } | null;
  /** What the object itself draws, a shape's or a drawing's layers, under any children. */
  art: PixiContainer;
  /** The layers drawn, a shape's or a drawing's, as of the last redraw. */
  layers: ShapeLayer[];
  /** Whether they were drawn turned over, which decides the triangles a culled drawTriangles keeps. */
  mirrored: boolean;
  /** Their fills, one context a layer. */
  fills: GraphicsContext[];
  /**
   * Whether the fills are this node's own, a drawing's, not its character's or blend's, which
   * instances share.
   */
  ownFills: boolean;
  /** The shape, or morph's blend, whose shared fills it holds, given back as it draws another or leaves. */
  sharedFills: ShapeCharacter | null;
  /** The lines, a Graphics for each layer that has any; null where one has none. */
  strokes: (SharedGraphics | null)[];
  /** Whether the layers are a character's or a blend's, whose lines' contexts instances share. */
  sharedLines: boolean;
  /** The children as of the last arrangement, to know those that left. */
  kids: readonly DisplayObject[];
  /**
   * Whether it is off the list, released: kept whole a while
   * (`PixiView.parked`), then emptied (`emptied`), its lines given back.
   */
  released: boolean;
  /** Whether this branch has returned after leaving the display list. */
  reused: boolean;
  /** Whether its art was emptied while off the list: drawn again if it comes back. */
  emptied: boolean;
  /** The thinnest line last drawn with; NaN while hidden strokes await their next visible sync. */
  strokedAt: number;
  /**
   * The stretch its lines were last stroked through, where all were
   * stroked through its stretch alone (stretchOf): a turn that keeps it
   * leaves them as they are. Null otherwise.
   */
  stretched: Linear | null;
  /** The width of the widest line of its layers that scale both ways, in twips (settledStretch). */
  widest: number;
  /** A Bitmap's sprite, over its store's texture, which Bitmaps share; null for any other object. */
  bitmap: Sprite | null;
  /** Every line drawn, its own or borrowed: hidden while the object is a mask or in one. */
  lines: SharedGraphics[];
  /**
   * Between a redraw's clear and its draw (while `spared`), the Graphics
   * and meshes the content left, and what each was (FILL, LINE or MESH),
   * for the next to take in place; kept, emptied, for the next redraw.
   */
  spare: { art: (SharedGraphics | TriangleView)[]; kinds: number[] } | null;
  spared: boolean;
  /** Whether the object is a mask or in one, as of the last sync. */
  masking: boolean;
  /** Whether this branch's ordinary art is hidden by its own or an ancestor's visibility. */
  hidden: boolean;
  /** The containers of the children a timeline's mask clips, each masked by it. */
  groups: PixiContainer[];
  /** Its scroll's clip: a rectangle in its space, and the container it masks, of the art and children. */
  scroll: { clip: Graphics; content: PixiContainer } | null;
  /** Whether it has a mask or a scroll's clip, to be taken off when the object's go. */
  clipped: boolean;
  /** Its colour transform from the stage down, null for none, and its parent's that it was made from. */
  color: ColorTransform | null;
  inherited: ColorTransform | null;
  /**
   * Whether its filters' output takes its colour, not what they are run on, as Flash colours a
   * filtered object's bitmap: what is in it is then drawn uncoloured by it and all above it.
   */
  rooted: boolean;
  /** The blend mode its filters composite it in. */
  blend: string;
  /** Its filters' records as of the last sync, and the Pixi filters made of them, its own. */
  filterRecords: readonly FilterRecord[];
  filters: Filter[];
  /** A 3D object's bitmap and quad (render/three.ts), which it is drawn by in its parent; null for any other. */
  plane: Plane | null;
  /** Draws in this branch, excluding those already isolated in a child render group. */
  draws: number;
  /** Zero draws, one safe draw, or more than one draw/one requiring isolation. */
  singleDraw: 0 | 1 | 2;
  /** The fixed-function blend currently applied without an offscreen filter. */
  directBlend: string | null;
  /** Whether this branch's children draw into an isolated target. */
  childIsolation: boolean;
  /** Outside partners must share the group; a hidden node must not keep an old partner alive. */
  maskLinks: WeakRef<DisplayObject>[];
  /** The 9-slice its grid gives its shapes and its Shape children's (display/scale9.ts), or null. */
  slice: Slice | null;
  /** What the slice its layers were drawn with is told by, "" for none. */
  sliceKey: string;
  /** The parent and the linear part of the matrix the slice was made under, to tell when to make it again. */
  sliceOwner: DisplayObject | null;
  sliceLinear: Linear | null;
  /**
   * The linear transform on the stage its lines' widths go by, where a
   * 9-slice draws them: the grid's owner's parent's, as Flash keeps a sliced
   * line as wide as in that space. Null for its own transform.
   */
  lineSpace: Linear | null;
  /**
   * The object it draws, the one it was made for or the last to take it,
   * and the character and class of those that may take it (render/spares.ts).
   */
  owner: WeakRef<DisplayObject>;
  character: object | null;
  kind: object;
}

/** A new node for `o`, its art in its container, drawing nothing yet. */
export function makeNode(o: DisplayObject): Node {
  const art = new PixiContainer();
  const node: Node = {
    container: new PixiContainer(),
    world: [0, 0, 0, 0],
    mirrored: false,
    stale: null,
    art,
    layers: [],
    fills: [],
    ownFills: false,
    sharedFills: null,
    strokes: [],
    sharedLines: false,
    kids: [],
    released: false,
    reused: false,
    emptied: false,
    strokedAt: 0,
    stretched: null,
    widest: 0,
    bitmap: null,
    lines: [],
    spare: null,
    spared: false,
    masking: false,
    hidden: false,
    groups: [],
    scroll: null,
    clipped: false,
    color: null,
    inherited: null,
    rooted: false,
    blend: "normal",
    filterRecords: NO_RECORDS,
    filters: [],
    plane: null,
    draws: 0,
    singleDraw: 0,
    directBlend: null,
    childIsolation: false,
    maskLinks: [],
    slice: null,
    sliceKey: "",
    sliceOwner: null,
    sliceLinear: null,
    lineSpace: null,
    owner: o.ref,
    character: o.character,
    kind: o.constructor,
  };
  node.container.addChild(art);
  return node;
}
