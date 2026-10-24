// Draws the display list with PixiJS. Pixi only mirrors it: one container
// for each display object, kept from frame to frame and updated where the
// display object says it changed. A shape's fills are GraphicsContexts its
// instances share (tessellate.ts); its lines depend on its transform and are
// shared by the instances that see them through the same one (strokes.ts).
//
// The view walks the list and keeps each object's node (node.ts) in step:
// its transform, colour, filters, masks, children and render group. What
// an object itself draws is art.ts's, its blending compositing.ts's, a 3D
// object's plane planes.ts's, and the nodes kept for reuse spares.ts's.
import type { ColorTransform } from "@swf2es/format";
import {
  type Filter,
  Graphics,
  Matrix,
  Container as PixiContainer,
  Rectangle,
  type Renderer,
  RendererType,
} from "pixi.js";
import { BitmapStore } from "../bitmap/bitmap.js";
import { toStage } from "../display/bounds.js";
import { concatColor, multipliesOnly, sameColor } from "../display/color.js";
import {
  BitmapObject,
  CHILDREN,
  CLEAN,
  Clips,
  CONTENT,
  Container,
  cached,
  type DisplayObject,
  PIXELS,
  ShapeObject,
  TRANSFORM,
  unloads,
} from "../display/display.js";
import { shifted } from "../display/geometry.js";
import { sliceDrawn } from "../display/scale9.js";
import type { Player } from "../player.js";
import { Art } from "./art.js";
import { retireBatchers, trimBatchers, viewGroups } from "./batchers.js";
import { gpuBitmaps } from "./bitmaps.js";
import { blendFilters } from "./blend.js";
import { setFlashColor } from "./color.js";
import { Compositing } from "./compositing.js";
import { displayFilters, FilterChain, sameFilterRecords } from "./filters.js";
import { hookRenderer } from "./hooks.js";
import { makeNode, NO_RECORDS, type Node } from "./node.js";
import { Planes } from "./planes.js";
import { bindPointer } from "./pointer.js";
import { IDLE_MS, PARKED_FIRST_GROUPS_MOST, PARKED_MOST, trimPools } from "./pools.js";
import { uploadSegments } from "./saffron.js";
import { SETTLE_MS, type Settling, settle, unsettle } from "./settle.js";
import { SharedGraphics } from "./shared.js";
import { drawInto, snapshot } from "./snapshot.js";
import { SpareNodes } from "./spares.js";
import { type Linear, sameLinear, UNIT } from "./strokes.js";
import { SAMPLES } from "./three.js";
import { TriangleView } from "./triangles.js";

/** No transform, for a 3D object's container in its bitmap's space. */
const IDENTITY_PLACE = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

const NO_KIDS: readonly DisplayObject[] = [];
/** Whether any of `children` is a timeline's mask, which clips those after it. */
function anyClips(children: readonly DisplayObject[]): boolean {
  for (let i = 0; i < children.length; i++) {
    if (children[i].clipDepth > 0) {
      return true;
    }
  }

  return false;
}

/** Whether `ct` leaves every pixel clear, whatever its alpha. */
function clearsAll(ct: ColorTransform | null): boolean {
  return ct !== null && ct.aAdd <= 0 && ct.aMul * 255 + ct.aAdd <= 0;
}

/** Whether any layer has lines of the node's own to stroke. */
function hasLines(strokes: readonly (SharedGraphics | null)[]): boolean {
  for (let i = 0; i < strokes.length; i++) {
    if (strokes[i]) {
      return true;
    }
  }

  return false;
}

/** sync's scratch, which a container's matrix is set from and which it does not keep. */
const PLACED = new Matrix();
/** A Shape child's slice key once its owner's slice changed: it is sliced again on its next sync. */
const STALE = "stale";

/** Only a partner outside the branch prevents it owning a separate instruction set. */
function maskLink(
  o: DisplayObject,
  partner: DisplayObject | null,
  links: WeakRef<DisplayObject>[],
): void {
  if (partner && !o.encloses(partner)) {
    links.push(partner.ref);
  }
}

export class PixiView {
  readonly stage = new PixiContainer();
  private readonly viewport: { bounds: Rectangle | null } = { bounds: null };
  /** What the view has built since it was made, for measuring: lines' contexts made and reused. */
  readonly counts = { strokeContexts: 0, strokeReuses: 0 };
  /** The released nodes, for a new object of their character to take (render/spares.ts). */
  private readonly spares: SpareNodes;
  /** The unloads (display's `unloads`) the spares were last dropped for. */
  private unloadsSeen = unloads.count;
  /** The nodes by their containers, for a child's sync to take the node that is in its place. */
  private readonly containerNodes = new WeakMap<PixiContainer, Node>();
  /** The container in the place the next object synced goes to, set and read as arrange syncs it. */
  private placeHint: PixiContainer | null = null;
  /** settleGroups' scratch: the groups whose batched Graphics draw alone again, and whose to look through. */
  private readonly unsettling = new Set<Settling>();
  private readonly scanned: Settling[] = [];
  private readonly nodes = new WeakMap<DisplayObject, Node>();
  /** What each object itself draws: its fills, lines, bitmap, text and triangles (render/art.ts). */
  private readonly art: Art;
  /** The 3D objects, each drawn into its bitmap before the stage is drawn (render/planes.ts). */
  private readonly planes: Planes;
  /** How each object is composited, by the GPU's own blending, a layer or a blend filter. */
  private readonly blends: Compositing;
  /**
   * In a 3D object's sync, the renderer's units a pixel of its own space its content is drawn at
   * (render/three.ts), and its thinnest line, a texel; 0 elsewhere.
   */
  private planeUnits = 0;
  private planeLeast = 1;

  /**
   * The released nodes that drew something, oldest first, with the time
   * each left the list: kept whole for IDLE_MS, at most PARKED_MOST of them,
   * as a pool's objects or a panel shown and hidden come back, then emptied.
   */
  private readonly parked = new Map<Node, number>();
  /** Retain only batches, not detached display trees, while a group waits for reuse. */
  private readonly parkedGroups = new Map<
    number,
    { since: number; group: WeakRef<NonNullable<PixiContainer["renderGroup"]>> }
  >();
  private readonly parkedFirstGroups = new Set<number>();
  /** The filters a fresh view made, which it destroys with the rest. */
  private readonly builtFilters: Filter[] = [];
  /** The objects `mask` was found set on, for the masks to be placed that are not under the root. */
  private readonly maskees = new Set<WeakRef<DisplayObject>>();
  /** Where those masks are placed, beside the root. */
  private readonly offList = new PixiContainer();

  /**
   * `fresh` makes a view that draws every object as new and leaves the
   * objects' dirty flags as they were, for a one-off render such as
   * BitmapData.draw's, so the stage's own view still sees each change.
   */
  /**
   * How many screen pixels a stage pixel covers, for the thinnest line,
   * which Flash draws a pixel of the screen wide however far the stage is
   * zoomed. The renderer's resolution unless set: a host that renders
   * finer than the screen to average down, as the test page does, sets it
   * to what the screen shows. A fresh view draws a BitmapData's pixels,
   * which are the stage's, so its thinnest line is a pixel.
   */
  screenScale: number | null = null;
  /**
   * The stage's quality, Flash's "LOW" to "BEST": at low, no bitmap is
   * smoothed. Its edges' anti-aliasing is the host's, which makes the
   * renderer and draws on it.
   */
  set quality(quality: string) {
    gpuBitmaps(this.renderer).smoothing = quality !== "LOW";
  }

  /** The target's pixels a side of one of Flash's its textured triangles were last told, and their smoothing. */
  private meshPixel = 1;
  private meshSmoothing = true;
  /** The thinnest line it last drew the stage's lines with; a change draws them all again. */
  private strokedAt = 0;
  /** The filter units it last drew the stage's filters with; the stage's own scale changes them too. */
  private filteredAt = 0;
  /** The root the last prepare synced, to know whether an object is on the list. */
  private root: DisplayObject | null = null;
  /** Whether this prepare visits every node, to stroke and filter again for a new screen scale. */
  private rescaled = false;
  /** What a fresh view draws, under the draw's matrix: Flash slices it by no grid of its own. */
  drawRoot: DisplayObject | null = null;
  /** A fresh view's units to a pixel of the BitmapData it draws, rendered that many times larger. */
  private samples = 1;

  constructor(
    readonly renderer: Renderer,
    private readonly fresh = false,
    /** The stage's view, whose geometry and textures a fresh view borrows where they are current. */
    source: PixiView | null = null,
  ) {
    hookRenderer(renderer);
    this.art = new Art(renderer, fresh, this, this.nodes, source?.art ?? null, this.counts);
    this.spares = new SpareNodes(fresh, this.nodes, this.containerNodes);
    this.planes = new Planes(renderer, this.nodes, this.containerNodes, (o, node) => {
      this.rescaled = true;
      this.sync(o, UNIT, false, o.flatPlaced, false, node.inherited, node.childIsolation);
      this.rescaled = false;
    });
    this.blends = new Compositing(renderer, this.planes, this);
  }

  /** Let Pixi normalize browser coordinates; Flash's display list chooses the target (render/pointer.ts). */
  bindPointer(player: Player): () => void {
    return bindPointer(this.renderer, this.stage, player, this.viewport);
  }

  /** Destroy the view's containers and what it built; borrowed resources stay their owner's. */
  dispose(root: PixiContainer): void {
    this.planes.dropAll();

    root.destroy({ children: true });
    this.art.destroyBuilt();

    // A container destroyed lets go of its filters without destroying them.
    for (const filter of this.builtFilters) {
      filter.destroy();
    }
  }

  private node(o: DisplayObject): Node {
    const hint = this.placeHint;
    this.placeHint = null;
    let node = this.nodes.get(o);
    if (!node && !this.fresh) {
      node = this.spares.take(o, hint);
    }

    if (!node) {
      node = makeNode(o);
      this.nodes.set(o, node);
      if (!this.fresh) {
        this.containerNodes.set(node.container, node);
      }
    }

    return node;
  }

  /**
   * Let go of every spare node, as a SWF unloads: they hold its characters,
   * and its objects' containers, till taken or IDLE_MS on, which a player
   * paused or let go of never reaches. For a host to call too as it lets
   * go of a player whose view it keeps. And the lines' budget back to
   * its floor: what grew it may have gone with the SWF.
   */
  dropSpares(): void {
    this.spares.clear();
    this.art.lines.unloaded();
    this.art.dropMeshes();
  }

  /**
   * Whether `o`'s slice may have changed since its node's was made: its
   * grid, drawing or children changed, a direct child's drawing, its scale
   * (not its position, as a dragged panel's), a Shape child's matrix or
   * parent, its mask role, or its owner's slice.
   */
  private reslices(o: DisplayObject, node: Node, dirty: number, remask: boolean): boolean {
    if (
      remask ||
      node.sliceKey === STALE ||
      o.parent !== node.sliceOwner ||
      dirty & (CONTENT | CHILDREN)
    ) {
      return true;
    }

    const m = o.matrix;
    const was = node.sliceLinear;
    if (
      dirty & TRANSFORM &&
      ((o instanceof ShapeObject && o.parent?.scale9Grid) ||
        !was ||
        was[0] !== m.a ||
        was[1] !== m.b ||
        was[2] !== m.c ||
        was[3] !== m.d)
    ) {
      return true;
    }

    return (
      o instanceof Container && o.descendantsDirty && o.children.some((c) => c.dirty & CONTENT)
    );
  }

  /**
   * The linear transform on the stage a sliced shape's lines are as wide
   * through: the owner's parent's, as in adl a sliced line keeps the width
   * it has in that space, times a Shape child's own, whose scale widens
   * them; `parent` is `o`'s parent's.
   */
  private lineSpace(o: DisplayObject, node: Node, parent: Linear): Linear {
    if (node.slice) {
      return [...parent];
    }

    const owner = this.nodes.get(o.parent as Container)?.lineSpace ?? parent;
    const m = o.matrix;
    return [
      owner[0] * m.a + owner[2] * m.b,
      owner[1] * m.a + owner[3] * m.b,
      owner[0] * m.c + owner[2] * m.d,
      owner[1] * m.c + owner[3] * m.d,
    ];
  }

  /**
   * An object off the list, and all below it: their lines given back, so
   * that the cache can let them go, and drawn again if they come back.
   */
  private release(o: DisplayObject): void {
    const node = this.nodes.get(o);
    if (!node || node.released) {
      return;
    }

    node.released = true;
    this.blends.forget(node);
    this.planes.drop(node);
    this.spares.list(node);
    const group = node.container.isRenderGroup ? node.container.renderGroup : null;
    if (group) {
      const uid = group.instructionSet.uid;
      this.parkedGroups.delete(uid);
      this.parkedGroups.set(uid, { since: performance.now(), group: new WeakRef(group) });
      if (!node.reused) {
        this.parkedFirstGroups.add(uid);
        if (this.parkedFirstGroups.size > PARKED_FIRST_GROUPS_MOST) {
          const oldest = this.parkedFirstGroups.values().next().value;
          if (oldest !== undefined) {
            this.emptyGroup(oldest, this.parkedGroups.get(oldest)?.group.deref());
          }
        }
      }
    }

    const chain = node.filters[0];
    if (chain instanceof FilterChain) {
      chain.forget();
    }

    // What it drew is kept a while for it to come back to, as a pool's
    // objects do, then goes, its Graphics let go of their geometry and
    // kept for the next content to take: Pixi keeps a Graphics it has
    // drawn, with its geometry, for a minute after it was last drawn, which
    // a timeline that makes its children anew on every frame turned into
    // gigabytes.
    if (node.art.children.length > 0) {
      this.parked.delete(node);
      this.parked.set(node, performance.now());
      if (this.parked.size > PARKED_MOST) {
        this.empty(this.parked.keys().next().value as Node);
      }
    } else {
      this.empty(node);
    }

    // Those it last drew, which may since have left it too, and any it has
    // now; not one it last drew that has moved to another parent on the
    // list, which draws it.
    // Those last drawn first, then any new: one in both is released once, as a second does nothing.
    const kids = node.kids;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].parent === o || this.left(kids[i], o)) {
        this.release(kids[i]);
      }
    }

    if (o instanceof Container) {
      const children = o.children;
      for (let i = 0; i < children.length; i++) {
        this.release(children[i]);
      }
    }

    // Released, they need no keeping: a node kept spare held its last
    // object's children, and through them their own children, scripts and
    // timelines, after all had gone (some 6 MB in a crowd of 32 animated
    // characters). Coming back, a container arranges its children anew.
    node.kids = NO_KIDS;
  }

  /**
   * Whether `kid`, which `from` last drew, is off the list: taken out, or
   * moved to a parent that is off it too, which no sync will release.
   */
  private left(kid: DisplayObject, from: DisplayObject): boolean {
    return kid.parent === null || (kid.parent !== from && !this.root?.encloses(kid));
  }

  /** A released node's art emptied, its fills and lines given back: drawn again if it comes back. */
  private empty(node: Node): void {
    this.parked.delete(node);
    node.emptied = true;
    this.art.clear(node);
    this.art.giveBack();
  }

  /** Return a parked group's batches without changing its nested group hierarchy. */
  private emptyGroup(
    uid: number,
    group: NonNullable<PixiContainer["renderGroup"]> | undefined,
  ): void {
    this.parkedGroups.delete(uid);
    this.parkedFirstGroups.delete(uid);
    retireBatchers(this.renderer, uid);
    if (group) {
      group.instructionSet.destroy();
      group.structureDidChange = true;
    }
  }

  /**
   * Bring `o`'s mirror up to date where it changed, and return it. `parent`
   * is the linear part of its parent's transform on the stage, and `moved`
   * whether that changed, which changes the lines of every shape below.
   * `own` stands in for `o`'s own matrix, as a draw's matrix does.
   */
  private sync(
    o: DisplayObject,
    parent: Linear,
    moved: boolean,
    own: DisplayObject["matrix"] = o.flatPlaced,
    inMask = false,
    tint: ColorTransform | null = null,
    isolated = false,
    parentHidden = false,
  ): PixiContainer {
    const node = this.node(o);
    const { container } = node;
    // A 3D object's content is drawn in its own space into its bitmap, which its plane then
    // places (render/three.ts); a mask, which Flash draws by no plane, and the root of a
    // BitmapData's draw, which its matrix places, go by its matrix3D's x and y rows.
    const three =
      o.space !== null &&
      o !== this.drawRoot &&
      this.renderer.type !== RendererType.WEBGPU &&
      !(inMask || o.maskOf !== null || o.clipDepth > 0);
    const outsideUnits = this.planeUnits;
    const outsideLeast = this.planeLeast;
    if (three) {
      own = IDENTITY_PLACE;
      parent = UNIT;
      this.planeUnits = node.plane?.units ?? SAMPLES;
      this.planeLeast = 1 / (node.plane?.texels ?? 1);
      if (node.plane) {
        node.plane.syncedUnits = this.planeUnits;
      }
    }

    let dirty = this.fresh ? TRANSFORM | CHILDREN | CONTENT : o.dirty;
    // What a 3D object's bitmap shows changes with what is in it, not with its own transform.
    let redrawn = three && o instanceof Container && o.descendantsDirty;
    if (node.released) {
      // Back from off the list: drawn again if its art was emptied, its transform as if unknown, so
      // that it and all below draw their lines again; a parked one has kept its own. A container's
      // children, if it has or had any, are arranged again, as those that were emptied with it are
      // drawn again.
      node.released = false;
      node.reused = true;
      this.parked.delete(node);
      this.spares.unlist(node);
      const group = node.container.renderGroup;
      if (group) {
        this.parkedGroups.delete(group.instructionSet.uid);
        this.parkedFirstGroups.delete(group.instructionSet.uid);
      }

      // Those it drew are in its content after its art, as are their masks' groups.
      const kids =
        o instanceof Container &&
        (o.children.length > 0 || (node.scroll?.content ?? node.container).children.length > 1);
      dirty |= TRANSFORM | (kids ? CHILDREN : 0);
      if (node.emptied) {
        node.emptied = false;
        node.world.fill(Number.NaN);
        dirty |= CONTENT;
      }
    }

    // A mask is drawn, whatever its visibility, alpha and colour, by its fills alone.
    const masking = inMask || o.maskOf !== null || o.clipDepth > 0;
    const remask = masking !== node.masking;
    node.masking = masking;
    const hidden = !masking && (parentHidden || (!o.visible && o !== this.drawRoot));
    const visibilityChanged = hidden !== node.hidden;
    node.hidden = hidden;
    redrawn ||= visibilityChanged;
    if (remask) {
      container.visibilityRoot = masking;
      dirty |= TRANSFORM | CONTENT;
    }

    // Whether its filters were made again, which a direct blend sets again.
    let refilled = false;
    if (dirty & TRANSFORM) {
      const m = own;
      container.setFromMatrix(PLACED.set(m.a, m.b, m.c, m.d, m.tx, m.ty));
      // A 3D mask masks nothing in Flash, and is not drawn.
      container.visible = (o.visible || masking) && !(o.maskOf && o.space);
      // A blend mode composites the object as a layer (render/blend.ts); a mask is its fills alone.
      // Its filters, then its blend: adl filters the object, then blends what they make.
      const blend = masking ? "normal" : o.blendMode;
      const records = masking ? NO_RECORDS : o.filters;
      // Filters set again with the same values, as a tween writes them on each frame, keep their
      // chain and the output it kept.
      const refiltered =
        records !== node.filterRecords && !sameFilterRecords(records, node.filterRecords);
      node.filterRecords = records;
      if (blend !== node.blend || refiltered) {
        redrawn = true;
        node.blend = blend;
        for (const f of node.filters) {
          f.destroy();
        }

        // Flash's filters are WebGL's alone; Pixi skips a chain with one it
        // cannot run, so under WebGPU they are left out and the blend kept.
        const chain =
          this.renderer.type === RendererType.WEBGPU
            ? []
            : displayFilters(records, (map) => {
                // A displacement map's map: its store's texture, brought up to date as it is read.
                const store = (map as { $store?: BitmapStore }).$store;
                return store && !store.disposed
                  ? gpuBitmaps(this.renderer).texture(store, false)
                  : null;
              });
        // A plain layer colours its combined children in one pass, without keeping a bitmap.
        // A view drawn once keeps no output either.
        node.filters =
          chain.length > 0 || blend === "layer"
            ? [new FilterChain(chain, container, chain.length > 0 && !this.fresh, this.filterUnits)]
            : [];
        if (this.fresh) {
          this.builtFilters.push(...node.filters);
        }

        const blending = blendFilters(blend);
        container.filters =
          node.filters.length > 0 || blending ? [...node.filters, ...(blending ?? [])] : null;
        refilled = true;
      }

      // Most objects have neither: they pay one test.
      if (o.mask || o.scroll || node.clipped) {
        if (this.clip(o, node) && o instanceof Container) {
          dirty |= CHILDREN;
        }
      }
    }

    // The colour transform from the stage down. One that only multiplies is
    // Pixi's tint and alpha, which Pixi composes down the tree itself; any
    // other is what is drawn's own (render/color.ts), and the tint stays white.
    let recolor = false;
    // A 3D one's chain runs in its bitmap, where it colours what its filters make as any does.
    // A layer colours its combined children, including its own art when it has children. With
    // none, Flash colours each of its fills separately, even with blendMode LAYER.
    const rooted =
      node.filters[0] instanceof FilterChain &&
      (node.filters[0].filters.length > 0 ||
        (node.blend === "layer" && o instanceof Container && o.children.length > 0)) &&
      !masking;
    const rerooted = rooted !== node.rooted;
    if (rerooted || remask) {
      node.rooted = rooted;
      container.colorRoot = rooted || masking;
      recolor = true;
    }

    // BitmapData.draw takes its object without its own colour transform, as adl draws it, though
    // its filters with it (filtered-colors).
    const ownColor = o === this.drawRoot ? null : o.colorTransform;
    if (dirty & TRANSFORM || tint !== node.inherited) {
      node.inherited = tint;
      const ct = ownColor;
      const color = masking ? null : ct ? (tint ? concatColor(tint, ct) : ct) : tint;
      if (!sameColor(color, node.color)) {
        node.color = color;
        recolor = true;
      }
    }

    if (node.filters[0] instanceof FilterChain && (recolor || refilled)) {
      node.filters[0].recolor(rooted ? node.color : null);
    }

    const flash = !rooted && node.color && !multipliesOnly(node.color) ? node.color : null;
    if (dirty & TRANSFORM || recolor) {
      // A 3D object's bitmap is drawn coloured by all above it too, each of its fills under the
      // alpha, as Flash's is: its quad takes none of Pixi's colour (render/three.ts). A filtered
      // object's chain colours what its filters make.
      const ct = flash || masking || rooted ? null : three ? node.color : ownColor;
      container.alpha = ct ? Math.max(0, Math.min(1, ct.aMul)) : 1;
      const tint = ct
        ? (Math.round(Math.max(0, Math.min(1, ct.rMul)) * 255) << 16) |
          (Math.round(Math.max(0, Math.min(1, ct.gMul)) * 255) << 8) |
          Math.round(Math.max(0, Math.min(1, ct.bMul)) * 255)
        : 0xffffff;
      // Set only as it changes: Pixi parses a tint set through its Color, which allocates, though
      // most objects keep theirs white.
      if (container.tint !== tint) {
        container.tint = tint;
      }

      // One its colour leaves wholly clear is not drawn, nor its filters run, as Pixi skips one
      // whose alpha is 0: a filtered object's alpha is its chain's.
      container.renderable = !rooted || !clearsAll(node.color);
    }

    if (moved || dirty & TRANSFORM) {
      const m = own;
      const a = parent[0] * m.a + parent[2] * m.b;
      const b = parent[1] * m.a + parent[3] * m.b;
      const c = parent[0] * m.c + parent[2] * m.d;
      const d = parent[1] * m.c + parent[3] * m.d;
      const was = node.world;
      moved = a !== was[0] || b !== was[1] || c !== was[2] || d !== was[3];
      // In place, as a node's world is held by none but it: what keeps one keeps a copy. Thousands
      // of parts move on a busy frame, and each made an array.
      if (moved) {
        was[0] = a;
        was[1] = b;
        was[2] = c;
        was[3] = d;
      }
    }

    // Flash draws a stale cache again when the object's scale on the stage changes, as by its
    // parent's, or a frame is drawn with its cache off; from then on the view draws the object
    // as it is.
    const stale = node.stale;
    if (
      stale &&
      !stale.spent &&
      o instanceof ShapeObject &&
      o.stale === stale.cache &&
      (!sameLinear(stale.world, node.world) || !cached(o))
    ) {
      stale.spent = true;
      dirty |= CONTENT;
    }

    // A 9-slice reshapes the shapes as the owner's scale, bounds or grid change, or a Shape child's
    // matrix or parent, not as anything moves; a mask, and the root of a BitmapData's draw, are not
    // sliced.
    let resliced = false;
    if (
      (o.scale9Grid || node.sliceKey || (o instanceof ShapeObject && o.parent?.scale9Grid)) &&
      this.reslices(o, node, dirty, remask)
    ) {
      node.slice = o.scale9Grid && !masking && o !== this.drawRoot ? sliceDrawn(o) : null;
      node.sliceOwner = o.parent;
      const m = o.matrix;
      node.sliceLinear = [m.a, m.b, m.c, m.d];
      const slicing = this.art.slicing(o, node);
      const at = slicing?.m;
      const key = !slicing
        ? ""
        : at
          ? `${slicing.slice.key};${at.a},${at.b},${at.c},${at.d},${at.tx},${at.ty}`
          : slicing.slice.key;
      if (key !== node.sliceKey) {
        node.sliceKey = key;
        dirty |= CONTENT;
        resliced = o instanceof Container;
        node.lineSpace = null;
      }
    }

    if (node.sliceKey && (moved || dirty & (TRANSFORM | CONTENT) || !node.lineSpace)) {
      node.lineSpace = this.lineSpace(o, node, parent);
    }

    if (resliced) {
      for (const child of (o as Container).children) {
        const kid = child instanceof ShapeObject ? this.nodes.get(child) : undefined;
        if (kid) {
          kid.sliceKey = STALE;
        }
      }
    }

    if (o.drawing?.culled && !(dirty & CONTENT)) {
      const w = node.world;
      if (w[0] * w[3] - w[1] * w[2] < 0 !== node.mirrored) {
        dirty |= CONTENT;
      }
    }

    if (dirty & CONTENT) {
      this.art.redraw(o, node);
    } else if ((moved || node.strokedAt !== this.leastWidth) && hasLines(node.strokes)) {
      this.art.restroke(node, true);
    }

    if (dirty & CONTENT || remask) {
      for (const lines of node.lines) {
        lines.visible = !masking;
      }
    }

    if (dirty & CONTENT || recolor) {
      for (const leaf of node.art.children) {
        setFlashColor(leaf, flash);
      }
    }

    if (dirty & PIXELS && !(dirty & CONTENT)) {
      // Pixels set since: the textures brought up to date, uploaded where the CPU changed them.
      const bitmaps = gpuBitmaps(this.renderer);
      if (node.bitmap && o instanceof BitmapObject && o.store) {
        bitmaps.texture(o.store, o.smoothing);
      }

      for (const layer of node.layers) {
        for (const { fill } of layer.fills) {
          if (fill.type === "image" && fill.image instanceof BitmapStore) {
            bitmaps.fillTexture(fill.image, fill.repeat, fill.smooth);
          }
        }
      }

      for (const leaf of node.art.children) {
        if (leaf instanceof TriangleView) {
          const texture = bitmaps.texture(leaf.source.image);
          leaf.visible = texture !== null;
          if (texture) {
            leaf.show(texture);
          }
        }
      }
    }

    // What its filters' kept output was drawn from changed, but for a move.
    // (A mask from outside it does not count: adl keeps the output, clipped as it was.)
    const chain = node.filters[0];
    // Kept on the chain, as lines' strokedAt: one off the list while the screen's scale changed
    // comes back at the old units.
    if (chain instanceof FilterChain && chain.units !== this.filterUnits) {
      chain.rescale(this.filterUnits);
    }

    if (
      chain instanceof FilterChain &&
      (dirty & ~TRANSFORM ||
        moved ||
        remask ||
        visibilityChanged ||
        (recolor && !rooted) ||
        rerooted ||
        this.rescaled ||
        // A scroll moves what is drawn within the input; any move of a scrolled object counts.
        (dirty & TRANSFORM && (o.scroll || node.scroll)) ||
        (o instanceof Container && o.descendantsDirty))
    ) {
      chain.changed();
    }

    const childIsolation =
      isolated || node.blend !== "normal" || node.filters.length > 0 || node.clipped;
    const isolationChanged = childIsolation !== node.childIsolation;
    node.childIsolation = childIsolation;

    if (o instanceof Container) {
      if (dirty & CHILDREN) {
        this.arrange(o, node, moved, masking, childIsolation);
      } else if (
        moved ||
        remask ||
        visibilityChanged ||
        recolor ||
        this.rescaled ||
        isolationChanged ||
        resliced ||
        o.descendantsDirty
      ) {
        for (const child of o.children) {
          if (
            moved ||
            (resliced && child instanceof ShapeObject) ||
            remask ||
            visibilityChanged ||
            this.rescaled ||
            recolor ||
            isolationChanged ||
            child.dirty !== CLEAN ||
            (child instanceof Container && child.descendantsDirty)
          ) {
            this.sync(
              child,
              node.world,
              moved,
              child.flatPlaced,
              masking,
              node.rooted ? null : node.color,
              childIsolation,
              hidden,
            );
          }
        }
      }

      if (!this.fresh) {
        o.descendantsDirty = false;
      }
    }

    if (!this.fresh) {
      this.group(o, node);
      this.blends.sync(node, isolated, refilled);
      o.dirty = CLEAN;
    }

    if (node.blend !== "normal" && node.blend !== "layer" && !node.directBlend) {
      this.blends.checkBackBuffer();
    }

    this.planeUnits = outsideUnits;
    this.planeLeast = outsideLeast;
    if (three || node.plane) {
      redrawn ||= (dirty & ~TRANSFORM) !== 0 || recolor || remask || this.rescaled;
      return this.planes.of(o, node, three, redrawn);
    }

    return container;
  }

  /** Keep an animated branch from rebuilding all the stage's batches when its children change. */
  private group(o: DisplayObject, node: Node): void {
    let draws = node.art.children.length;
    let singleDraw: 0 | 1 | 2 = 0;
    if (node.art.children.length === 1) {
      const art = node.art.children[0];
      singleDraw =
        art instanceof SharedGraphics &&
        art.context.instructions.length === 1 &&
        art.context.instructions[0].action === "fill"
          ? 1
          : 2;
    } else if (node.art.children.length > 1) {
      singleDraw = 2;
    }

    const links = node.maskLinks;
    links.length = 0;
    maskLink(o, o.mask, links);
    maskLink(o, o.maskOf, links);
    if (o instanceof Container) {
      // Indexes, not for-of: this runs for every object synced.
      const children = o.children;
      for (let i = 0; i < children.length; i++) {
        const part = this.nodes.get(children[i]);
        if (part) {
          for (let k = 0; k < part.maskLinks.length; k++) {
            maskLink(o, part.maskLinks[k].deref() ?? null, links);
          }

          draws += part.container.isRenderGroup ? 0 : part.draws;
          if (part.singleDraw !== 0) {
            singleDraw =
              singleDraw === 0 &&
              part.singleDraw === 1 &&
              part.blend === "normal" &&
              !part.container.isRenderGroup
                ? 1
                : 2;
          }
        }
      }
    }

    node.draws = draws;
    node.singleDraw =
      links.length === 0 && !node.masking && !node.clipped && node.filters.length === 0
        ? singleDraw
        : 2;
    // A stencil mask's geometry is collected into the masked object's instructions. Until both
    // belong to this branch, it must share its parent's group. A timeline mask itself also stays
    // with its siblings, though their common parent may form a group.
    if ((links.length > 0 || node.masking) && node.container.isRenderGroup) {
      this.disableRenderGroup(node.container);
    } else if (
      links.length === 0 &&
      !node.masking &&
      o.parent &&
      draws >= 64 &&
      !node.container.isRenderGroup
    ) {
      // Keep the group when its animation gets smaller, avoiding repeated batcher destruction.
      node.container.enableRenderGroup();
      const set = node.container.renderGroup?.instructionSet;
      if (set) {
        viewGroups.add(set);
      }
    }
  }

  /** Retire Pixi's per-group batches before it returns the group to its pool. */
  private disableRenderGroup(container: PixiContainer): void {
    // Its Graphics join the group above, which may not have settled; and Pixi
    // pools the group, which the next to take it must find unmarked.
    const group = container.renderGroup as unknown as Settling | null;
    if (group) {
      this.unsettling.add(group);
      unsettle(this.unsettling, this.unsettling);
      this.unsettling.clear();
      group.$batched = undefined;
      group.$builtAt = undefined;
      group.$settled = undefined;
      group.$settling = undefined;
      group.$seen = undefined;
    }

    const set = container.renderGroup?.instructionSet;
    if (set) {
      // Pixi pools the group, set included, for any root it renders next.
      viewGroups.delete(set);
      retireBatchers(this.renderer, set.uid);
      set.destroy();
    }

    container.disableRenderGroup();
  }

  /**
   * The children's containers in render order, under the object's art,
   * those a timeline's mask clips in a container the mask masks, nested as
   * the masks are; the masks themselves among them, where their place in
   * the tree puts them, though not drawn.
   */
  private arrange(
    o: Container,
    node: Node,
    moved: boolean,
    masking: boolean,
    isolated: boolean,
  ): void {
    const content = node.scroll?.content ?? node.container;
    // Where no mask clips them, the children's containers are put in order where they are, those
    // that kept their places left alone: taken off and put back, each was an event of Pixi's, and
    // the render group's structure changed though its order had not.
    const inPlace =
      node.groups.length === 0 && content.children[0] === node.art && !anyClips(o.children);
    const keepGroups =
      !inPlace && content.children[0] === node.art && this.sameClips(o.children, node.groups);
    if (!inPlace && !keepGroups) {
      for (const group of node.groups) {
        group.mask = null;
        group.destroy();
      }

      node.groups = [];
      content.removeChildren();
      content.addChild(node.art);
    }

    // Those that left the list give their lines back, all the way down; one
    // moved to another parent on the list is drawn there, perhaps already this frame.
    if (!this.fresh) {
      for (const kid of node.kids) {
        if (this.left(kid, o)) {
          this.release(kid);
        }
      }

      node.kids = [...o.children];
    }

    if (inPlace) {
      const children = o.children;
      let at = 1;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        this.placeHint = content.children[at] ?? null;
        const container = this.sync(
          child,
          node.world,
          moved,
          child.flatPlaced,
          masking,
          node.rooted ? null : node.color,
          isolated,
          node.hidden,
        );
        if (content.children[at] !== container) {
          content.addChildAt(container, at);
        }

        at++;
      }

      // What is left after them, those that left.
      if (content.children.length > at) {
        content.removeChildren(at);
      }

      return;
    }

    if (keepGroups) {
      this.arrangeClips(o, node, content, moved, masking, isolated);
      return;
    }

    const clips = new Clips();
    const open: PixiContainer[] = [];
    for (const child of o.children) {
      open.length = clips.enter(child);
      const into = open.length > 0 ? open[open.length - 1] : content;
      const container = this.sync(
        child,
        node.world,
        moved,
        child.flatPlaced,
        masking,
        node.rooted ? null : node.color,
        isolated,
        node.hidden,
      );
      into.addChild(container);
      if (child.clipDepth > 0) {
        const group = new PixiContainer();
        group.mask = container;
        into.addChild(group);
        open.push(group);
        node.groups.push(group);
      }
    }
  }

  /** Mask groups survive child edits while the masks themselves keep their order. */
  private sameClips(children: readonly DisplayObject[], groups: readonly PixiContainer[]): boolean {
    if (groups.length === 0) {
      return false;
    }

    let at = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.clipDepth > 0) {
        if (at >= groups.length || groups[at].mask !== this.nodes.get(child)?.container) {
          return false;
        }

        at++;
      }
    }

    return at === groups.length;
  }

  /** Reconcile children and nesting without retiring unchanged stencil-mask effects. */
  private arrangeClips(
    o: Container,
    node: Node,
    content: PixiContainer,
    moved: boolean,
    masking: boolean,
    isolated: boolean,
  ): void {
    const groups = node.groups;
    const positions: number[] = new Array(groups.length + 1).fill(0);
    // Slot zero is the content, whose art precedes the children; others name mask groups.
    positions[0] = 1;
    const clips = new Clips();
    const open: number[] = [];
    let next = 0;

    for (let i = 0; i < o.children.length; i++) {
      const child = o.children[i];
      open.length = clips.enter(child);
      const slot = open.length > 0 ? open[open.length - 1] : 0;
      const into = slot === 0 ? content : groups[slot - 1];
      const at = positions[slot]++;
      this.placeHint = into.children[at] ?? null;
      const container = this.sync(
        child,
        node.world,
        moved,
        child.flatPlaced,
        masking,
        node.rooted ? null : node.color,
        isolated,
        node.hidden,
      );
      if (into.children[at] !== container) {
        into.addChildAt(container, at);
      }

      if (child.clipDepth > 0) {
        const group = groups[next++];
        const at = positions[slot]++;
        if (into.children[at] !== group) {
          into.addChildAt(group, at);
        }

        open.push(next);
      }
    }

    for (let i = 0; i <= groups.length; i++) {
      const into = i === 0 ? content : groups[i - 1];
      if (into.children.length > positions[i]) {
        into.removeChildren(positions[i]);
      }
    }
  }

  /**
   * The object's mask, and its scroll: true where the scroll's clip came
   * or went, which moves the children. A mask's own mask, or one that is
   * the object or above it, Pixi could not draw: it is left out.
   */
  private clip(o: DisplayObject, node: Node): boolean {
    // A 3D mask masks nothing in Flash.
    const mask = o.mask && !o.maskOf && !o.mask.encloses(o) && !o.mask.space ? o.mask : null;
    node.container.mask = mask ? this.node(mask).container : null;
    if (mask) {
      this.maskees.add(o.ref);
    }

    const moved = this.scrollClip(o, node);
    node.clipped = mask !== null || node.scroll !== null;
    return moved;
  }

  /**
   * The object's scroll, as a clip of its art and children to the
   * rectangle, which its matrix's shift has moved to its place; true where
   * the clip came or went, which moves the children.
   */
  private scrollClip(o: DisplayObject, node: Node): boolean {
    const r = o.scroll;
    const scroll = node.scroll;
    if (!r) {
      if (!scroll) {
        return false;
      }

      scroll.content.mask = null;
      node.container.addChild(...scroll.content.removeChildren());
      scroll.clip.destroy();
      scroll.content.destroy();
      node.scroll = null;
      return true;
    }

    const clip = scroll?.clip ?? new Graphics();
    clip
      .clear()
      .rect(r.xMin, r.yMin, r.xMax - r.xMin, r.yMax - r.yMin)
      .fill(0xffffff);
    if (scroll) {
      return false;
    }

    const content = new PixiContainer();
    const children = node.container.removeChildren();
    if (children.length > 0) {
      content.addChild(...children);
    }

    content.mask = clip;
    node.container.addChild(clip, content);
    node.scroll = { clip, content };
    return true;
  }

  /**
   * The masks `mask` set that are not under `root`, off the display list
   * or elsewhere on it, each in `holder` at its place in the stage's space
   * (the space a draw draws into, for a draw's), as Flash places such a
   * mask; the objects they mask synced already.
   */
  private placeMasks(root: DisplayObject, holder: PixiContainer): void {
    holder.removeChildren();
    for (const ref of this.maskees) {
      const o = ref.deref();
      const mask = o?.mask;
      if (!o || !mask) {
        this.maskees.delete(ref);
        continue;
      }

      if (root.encloses(o) && !root.encloses(mask)) {
        holder.addChild(this.sync(mask, UNIT, false, toStage(mask, null), true));
      }
    }
  }

  /**
   * The target's pixels a side of a pixel of Flash's, which a 3D object's
   * quad and textured triangles sample once: in a BitmapData's draw, its
   * samples; on the stage, a pixel of the screen, where the host says what
   * that is.
   */
  /** Whether it syncs a 3D object's content, drawn into the object's bitmap. */
  get inPlane(): boolean {
    return this.planeUnits !== 0;
  }

  get flashPixel(): number {
    if (this.fresh) {
      return this.samples;
    }

    const scale = this.stage.scale.x;
    return this.screenScale
      ? ((this.renderer.resolution ?? 1) * (Number.isFinite(scale) && scale > 0 ? scale : 1)) /
          this.screenScale
      : 1;
  }

  /** Bring the stage up to date with `root`'s display list, without drawing. */
  /** The thinnest line, in stage pixels: a pixel of the screen. */
  get leastWidth(): number {
    // In a 3D object's bitmap, a pixel of its own space, as Flash draws a hairline there.
    if (this.planeUnits) {
      return this.planeLeast;
    }

    return this.fresh ? 1 : 1 / (this.screenScale ?? this.renderer.resolution ?? 1);
  }

  /**
   * The renderer's units to a pixel of the stage, which Flash's filters reach in: a host showing
   * the stage larger has them reach as much further on the screen, as Flash Player's do.
   */
  get filterUnits(): number {
    const units = this.planeUnits || (this.fresh ? this.samples : this.stage.scale.x);
    // A stage scaled to nothing filters at a unit a pixel rather than not at all.
    return Number.isFinite(units) && units > 0 ? units : 1;
  }

  prepare(root: DisplayObject): void {
    this.root = root;
    this.art.lines.tick();
    this.art.shared.tick();
    const now = performance.now();
    for (const [node, since] of this.parked) {
      if (now - since < IDLE_MS) {
        break;
      }

      this.empty(node);
    }
    for (const [uid, entry] of this.parkedGroups) {
      if (now - entry.since < IDLE_MS) {
        break;
      }

      this.emptyGroup(uid, entry.group.deref());
    }

    this.spares.expire(now);

    trimPools();
    trimBatchers(this.renderer, now);
    this.art.dropMeshes(now - IDLE_MS);
    const pixel = this.flashPixel;
    // Flash's pixels to a unit of the world, whose units are the renderer's resolution in pixels.
    this.art.saffron.unit = this.fresh ? 1 / this.samples : (this.renderer.resolution ?? 1) / pixel;
    if (pixel !== this.meshPixel) {
      this.meshPixel = pixel;
      for (const mesh of this.art.meshes) {
        mesh.pixel = pixel;
      }
    }

    // Smoothed or not, the bitmaps in kept filter outputs are drawn again, as a new scale's are.
    const smoothing = gpuBitmaps(this.renderer).smoothing;
    const resmoothed = smoothing !== this.meshSmoothing;
    if (resmoothed) {
      this.meshSmoothing = smoothing;
      for (const mesh of this.art.meshes) {
        mesh.smoothing = smoothing;
      }
    }

    const units = this.filterUnits;
    this.rescaled = this.leastWidth !== this.strokedAt || units !== this.filteredAt || resmoothed;
    this.strokedAt = this.leastWidth;
    this.filteredAt = units;
    if (!this.fresh) {
      this.blends.checkStageClear();
    }

    const node = this.sync(root, UNIT, false);
    uploadSegments(this.renderer);
    this.rescaled = false;
    if (!this.fresh) {
      this.blends.checkStageClear();
    }

    if (node.parent !== this.stage) {
      this.stage.removeChildren();
      this.stage.addChild(node, this.offList);
    }

    this.placeMasks(root, this.offList);
    if (!this.fresh) {
      this.settleGroups();
    }

    // After the sync, which released what an unload took off the list and listed it spare.
    if (unloads.count !== this.unloadsSeen) {
      this.unloadsSeen = unloads.count;
      this.dropSpares();
    }

    this.planes.rebuildMasks();
    // Their bitmaps are drawn now, as a host may draw the stage itself after.
    this.renderPlanes();
  }

  /**
   * Each 3D object's quad placed in perspective and its bitmap drawn again where it may have
   * changed (render/planes.ts).
   */
  private renderPlanes(): void {
    if (!this.planes.empty) {
      this.planes.render(this.flashPixel);
    }
  }

  /**
   * Batch the Graphics of each render group drawn that has not been rebuilt
   * for SETTLE_MS, and draw those of one rebuilt since alone again: walking
   * Pixi's tree of groups from the stage's, which holds those drawn and no
   * other. What a group batched is looked through as it unsettles or its
   * structure changes, for Graphics a branch took along as it moved under
   * another group or became a group of its own (unsettle).
   */
  private settleGroups(): void {
    const stage = this.stage.renderGroup as unknown as Settling | null;
    if (!stage) {
      return;
    }

    const now = performance.now();
    const unsettling = this.unsettling;
    const scanned = this.scanned;
    const visit = (group: Settling) => {
      const quiet = group.$builtAt !== undefined && now - group.$builtAt >= SETTLE_MS;
      if (quiet && !group.$settled) {
        settle(group);
      } else if (!quiet && (group.$settled || group.$seen !== group.$builtAt)) {
        unsettling.add(group);
      }

      // What it batched may have left it only as its structure changed, or be its own to unbatch.
      if (group.$batched?.size && (group.structureDidChange || unsettling.has(group))) {
        scanned.push(group);
      }

      group.$seen = group.$builtAt;
      const children = group.renderGroupChildren;
      for (let i = 0; i < children.length; i++) {
        visit(children[i]);
      }
    };
    visit(stage);
    if (unsettling.size > 0 || scanned.length > 0) {
      unsettle(unsettling, scanned);
      unsettling.clear();
      scanned.length = 0;
    }
  }

  /**
   * A fresh view of this one's, for BitmapData.draw (render/snapshot.ts):
   * it draws `root` under the draw's matrix at `samples` units a pixel,
   * borrowing this view's current geometry, so this one's is untouched.
   */
  forDraw(root: DisplayObject, samples: number): PixiView {
    const view = new PixiView(this.renderer, true, this);
    view.samples = samples;
    // Its world is the BitmapData's pixels, each drawn `samples` units a side (render/snapshot.ts).
    view.art.saffron.unit = 1 / samples;
    view.drawRoot = root;
    return view;
  }

  /**
   * A fresh view's `o` synced through `m` into `into`, with the masks and 3D objects' bitmaps it
   * needs. Only a fresh view (forDraw's) may: the stage's would take `o` into its own nodes,
   * clear its dirty flags and move its container.
   */
  drawAlone(o: DisplayObject, m: DisplayObject["matrix"], into: PixiContainer): void {
    if (!this.fresh) {
      throw new Error("swf2es: drawAlone on the stage's view, not a fresh one (forDraw)");
    }

    const node = this.sync(o, [1, 0, 0, 1], true, o.scroll ? shifted(m, o.scroll) : m);
    uploadSegments(this.renderer);
    const masks = new PixiContainer();
    into.addChild(node, masks);
    this.placeMasks(o, masks);
    this.planes.rebuildMasks();
    this.renderPlanes();
  }

  /** `o` drawn alone, as BitmapData.draw takes a display object, read back as premultiplied ARGB. */
  snapshot(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples = 4,
  ): Uint32Array {
    return snapshot(this, o, m, width, height, samples);
  }

  /** `o` drawn into `store` on the GPU at (x, y), as `snapshot`; false where the store has no texture. */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    x: number,
    y: number,
    width: number,
    height: number,
    samples = 4,
  ): boolean {
    return drawInto(this, store, o, m, x, y, width, height, samples);
  }

  /** The visible rectangle in stage coordinates; its size matches the renderer's screen. */
  setViewport(x: number, y: number, width: number, height: number): void {
    this.viewport.bounds ??= new Rectangle();
    const bounds = this.viewport.bounds;
    bounds.x = x;
    bounds.y = y;
    bounds.width = width;
    bounds.height = height;
    this.stage.position.set(-x, -y);
    if (this.stage.hitArea instanceof Rectangle) {
      this.stage.hitArea.copyFrom(bounds);
    }
  }

  /** Draw `root`'s display list, synced first. */
  render(root: DisplayObject): void {
    this.prepare(root);
    this.renderer.render(this.stage);
  }
}
