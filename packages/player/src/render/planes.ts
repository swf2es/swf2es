// 3D display objects in the view (render/view.ts): each one's container
// moved into its plane's holder and drawn into its bitmap, its quad put in
// its place in its parent and placed in perspective as the frame is
// prepared (render/three.ts has the plane itself).
import type { Matrix as FlatMatrix } from "@swf2es/format";
import type { BLEND_MODES, Container as PixiContainer, Renderer } from "pixi.js";
import { filterRect } from "../bitmap/filters.js";
import { bounds, toStage } from "../display/bounds.js";
import type { DisplayObject } from "../display/display.js";
import { apply, concat } from "../display/geometry.js";
import { blendFilters } from "./blend.js";
import { FilterChain } from "./filters.js";
import type { Node } from "./node.js";
import { Plane, SAMPLES } from "./three.js";

/**
 * The map from the space of `mask`, a 2D mask outside the 3D object `o`, to
 * `o`'s, as Flash clips the bitmap it draws `o` into: the mask is placed by
 * its matrices up to the nearest 3D object above it (or the stage), and then
 * moved as if the bitmap's corner, `o`'s bounds' top left in its own space,
 * were where `o`'s bounds' top left is on the stage. So a mask over a turned
 * card clips a part of the card that is not under it (the `three-d-mask` case).
 */
function outsideMaskMap(o: DisplayObject, mask: DisplayObject): FlatMatrix {
  let m = mask.placed;
  for (let p = mask.parent; p && !p.space; p = p.parent) {
    m = concat(m, p.placed);
  }

  const own = bounds(o, true) ?? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  const up = toStage(o, null);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const [x, y] = apply(up, i & 1 ? own.xMax : own.xMin, i & 2 ? own.yMax : own.yMin);
    left = Math.min(left, x);
    top = Math.min(top, y);
  }

  return {
    a: m.a,
    b: m.b,
    c: m.c,
    d: m.d,
    tx: m.tx + own.xMin - Math.round(left),
    ty: m.ty + own.yMin - Math.round(top),
  };
}

/** The view's 3D objects: their planes, and the outside masks they let go of. */
export class Planes {
  /** The nodes of 3D objects, each drawn into its bitmap before the stage is drawn (`render`). */
  private readonly nodes = new Set<Node>();
  /**
   * The outside masks planes let go of in this sync (`letGo`), which Pixi puts back in the
   * build: those still another's mask are taken out again after it (`rebuildMasks`).
   */
  private readonly droppedMasks: PixiContainer[] = [];
  /** render's scratch, the 3D objects to draw, deepest first. */
  private readonly order: { depth: number; node: Node; o: DisplayObject }[] = [];

  constructor(
    private readonly renderer: Renderer,
    /** The view's nodes by their objects, and by their containers. */
    private readonly objectNodes: WeakMap<DisplayObject, Node>,
    private readonly containerNodes: WeakMap<PixiContainer, Node>,
    /**
     * `o` synced again at its plane's units, for one drawn at other units than its content was
     * made for: its lines and filters made again for them.
     */
    private readonly resync: (o: DisplayObject, node: Node) => void,
  ) {}

  /** Whether there are no 3D objects to draw. */
  get empty(): boolean {
    return this.nodes.size === 0;
  }

  /** Every plane let go of, as a fresh view is disposed of. */
  dropAll(): void {
    for (const node of this.nodes) {
      this.drop(node);
    }
  }

  /**
   * What a 3D object is drawn by in its parent, its quad, which takes its
   * container's place, the container going into the plane's holder; and
   * the container again for one no longer drawn in 3D. A mask set on it
   * clips its content in its bitmap (Plane.maskWith).
   */
  of(o: DisplayObject, node: Node, three: boolean, redrawn: boolean): PixiContainer {
    const { container } = node;
    let plane = node.plane;
    if (!three) {
      const quad = plane?.quad;
      const parent = quad?.parent;
      if (quad && parent) {
        parent.addChildAt(container, parent.getChildIndex(quad));
      }

      this.drop(node);
      // Its chain blends it again, as a 2D object's does.
      const chain = node.filters[0];
      if (chain instanceof FilterChain) {
        chain.blendOver((node.directBlend as BLEND_MODES | null) ?? "normal");
      }

      return container;
    }

    if (!plane) {
      plane = new Plane();
      node.plane = plane;
      this.nodes.add(node);
    }

    const quad = plane.quad;
    if (container.parent !== plane.holder) {
      const parent = container.parent;
      if (parent) {
        parent.addChildAt(quad, parent.getChildIndex(container));
      }

      plane.holder.addChild(container);
    }

    this.blendQuad(node, plane);

    // A 2D mask in the object clips its content in its bitmap, as on a 2D object; one outside it
    // clips the bitmap too, put there by Flash's rule (`render`). The view's clip() has just set
    // the mask's container on the object's, where it set one.
    const set = container.mask as PixiContainer | null;
    if (set !== plane.maskCopy) {
      const before = plane.outsideMask;
      plane.maskWith(container, set && o.mask && !o.encloses(o.mask) ? set : null);
      this.letGo(before, plane);
    }

    plane.stale ||= redrawn;
    return quad;
  }

  /**
   * A 3D object's blend mode put on its quad, which Flash composites with what is behind it, not
   * on its content within its bitmap: the blend's filters, or the GPU's own blending, from the
   * node's state, as blendDirectly may change them outside a sync. Its filters' chain draws
   * their result into the bitmap as it is, the quad blending it (`three-d-filter-blend`).
   */
  blendQuad(node: Node, plane: Plane): void {
    const { container } = node;
    const filters = container.filters;
    if (filters && filters.length > node.filters.length) {
      container.filters = node.filters.length > 0 ? node.filters : null;
    }

    const chain = node.filters[0];
    if (chain instanceof FilterChain) {
      chain.blendOver("normal");
    }

    const blending = node.directBlend === null ? blendFilters(node.blend) : null;
    if (blending !== plane.blending) {
      plane.blending = blending;
      plane.quad.filters = blending;
    }

    plane.quad.blendMode = (node.directBlend as BLEND_MODES | null) ?? "inherit";
    container.blendMode = "inherit";
  }

  /** A 3D object's plane let go of, its container on no list. */
  drop(node: Node): void {
    const plane = node.plane;
    if (!plane) {
      return;
    }

    const before = plane.outsideMask;
    plane.destroy(node.container);
    this.letGo(before, plane);
    node.plane = null;
    this.nodes.delete(node);
  }

  /** `mask`, a plane's outside mask before a change, noted where the plane has let go of it. */
  private letGo(mask: PixiContainer | null, plane: Plane): void {
    if (mask && plane.outsideMask !== mask) {
      this.droppedMasks.push(mask);
    }
  }

  /**
   * The masks planes let go of in this sync kept out of the build where they still mask
   * another object: Pixi puts a mask back as any that held it lets go, which may come after
   * the next holder took it, as when a mask goes from one 3D object to another before it in
   * the list (`three-d-mask-handover`).
   */
  rebuildMasks(): void {
    for (const mask of this.droppedMasks) {
      if (this.containerNodes.get(mask)?.owner.deref()?.maskOf) {
        mask.includeInBuild = false;
      }
    }

    this.droppedMasks.length = 0;
  }

  /**
   * Each 3D object's quad placed by its plane in perspective, which moves
   * as anything above it does, and its bitmap drawn again where it may
   * have changed: those in another first, as the other's bitmap draws
   * their quads. One with a corner behind the eye is not drawn.
   */
  render(onStage: number): void {
    const drawn = this.order;
    drawn.length = 0;
    for (const node of this.nodes) {
      const o = node.owner.deref();
      if (!o || !node.plane) {
        this.drop(node);
        continue;
      }

      if (node.released) {
        continue;
      }

      let depth = 0;
      for (let p = o.parent; p; p = p.parent) {
        depth += p.space ? 1 : 0;
      }

      drawn.push({ depth, node, o });
    }

    drawn.sort((a, b) => b.depth - a.depth);
    for (const { depth, node, o } of drawn) {
      const plane = node.plane as Plane;
      // What it draws is measured again only when it may have changed, as its bitmap is drawn.
      if (plane.stale || plane.drawnRect === undefined) {
        const r = bounds(o, true, true);
        let rect = r && { x: r.xMin, y: r.yMin, width: r.xMax - r.xMin, height: r.yMax - r.yMin };
        for (const f of node.filterRecords) {
          rect = rect && filterRect(rect, f);
        }

        plane.drawnRect = rect;
      }

      const rect = plane.drawnRect;
      let shown = false;
      // A 3D mask on a 3D object leaves nothing of it drawn in Flash.
      if (rect && node.container.visible && !o.mask?.space) {
        shown = plane.place(
          o.placed,
          rect.x,
          rect.y,
          rect.x + rect.width,
          rect.y + rect.height,
          depth > 0 ? this.unitsAbove(o) : onStage,
        );
      }

      plane.changed ||= plane.quad.visible !== shown;
      plane.quad.visible = shown;
      if (shown) {
        if (plane.outsideMask && o.mask) {
          plane.placeMask(outsideMaskMap(o, o.mask));
        }

        plane.draw(this.renderer);
        // Drawn at other units than its content was made for, as an object grown past what the
        // GPU or the budget takes at full samples: its lines and filters made again for them.
        if (plane.units !== plane.syncedUnits) {
          this.resync(o, node);
          plane.draw(this.renderer);
        }
      }

      // Its quad is drawn into the bitmap of the 3D object it is in, which then shows it as it is
      // now: its plane there moves as that object turns, which changes nothing in it.
      if (depth > 0 && plane.changed) {
        this.restaleAbove(o);
      }

      plane.changed = false;
    }
  }

  /** The units of the bitmap of the nearest 3D object above `o`, which its quad is drawn into. */
  private unitsAbove(o: DisplayObject): number {
    for (let p = o.parent; p; p = p.parent) {
      if (p.space) {
        return this.objectNodes.get(p)?.plane?.units ?? SAMPLES;
      }
    }

    return SAMPLES;
  }

  /** The bitmap of the nearest 3D object above `o` marked to be drawn again. */
  private restaleAbove(o: DisplayObject): void {
    for (let p = o.parent; p; p = p.parent) {
      if (p.space) {
        const plane = this.objectNodes.get(p)?.plane;
        if (plane) {
          plane.stale = true;
        }

        return;
      }
    }
  }
}
