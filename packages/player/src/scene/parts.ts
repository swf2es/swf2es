// The geometries the view draws shapes, bitmaps and glyphs with (RenderView),
// made once and kept while drawn: a shape layer's parts, each for its
// drawing's version, a drawing used as a mask's apart; a bitmap's quad of
// each size; a glyph's fill. A drawing drawn again lets go of the parts
// of the layers it no longer draws (dropUndrawn). A layer slow to tessellate
// keeps its triangles past its geometries' expiry, to add them again
// (kept-parts.ts).
import type { Glyph } from "@swf2es/format";
import type { Geometries, GeometryHandle } from "@swf2es/render";
import type { DisplayObject } from "../display/displayobject.js";
import { type ShapeLayer, shapeLayers } from "../display/shapes.js";
import { type FillTessellator, fillsApart } from "./fills.js";
import { type KeptEntry, type KeptParts, keptParts } from "./kept-parts.js";
import type { LineCache } from "./lines.js";
import { bitmapQuad, layerParts, type PartPaint } from "./shapes.js";
import { glyphShape } from "./text.js";

/** Quads made, past which those let go of are looked for and forgotten. */
const QUAD_KEYS = 512;

/**
 * Frames a part of several fills stands unchanged before it is looked into
 * (markFlat), drawn through its layer until then: a drawing made again on
 * every frame, as a burst of particles in add is, would otherwise
 * tessellate its fills together on every frame, at several times what
 * tessellating them apart costs. Each look at an object's part doubles what
 * its next parts must stand, up to MOST_STANDING_FRAMES: one drawn again
 * every second or third frame stands a frame or two, and is looked into a
 * few times, not every time.
 */
const STANDING_FRAMES = 1;
const MOST_STANDING_FRAMES = 64;

/**
 * A part as made: its geometry's handle, the frame it was made on, and the
 * layer's fills of a part of several not yet looked into (markFlat), from
 * `fillsFrom` up to `fillsTo`, none once they have been.
 */
export interface MadePart extends PartPaint {
  handle: GeometryHandle;
  madeAt: number;
  fillsFrom: number;
  fillsTo: number;
}

/** A layer's parts as made, for its drawing's version, as a drawing changes its layers in place. */
export interface Made {
  parts: MadePart[];
  version: number;
  checkedAt: number;
  /**
   * Its parts' geometries, where they were slow to make (SLOW_PARTS_MS)
   * and are among those kept (kept-parts.ts): added again when theirs
   * expire, rather than tessellated again.
   */
  kept: KeptEntry | null;
}

/**
 * The layers an object's drawing was last drawn as, of its version
 * (dropUndrawn): a set, as a drawing refills its own list as it is cleared
 * and drawn again, and the list they came in, which a frame's walk passes
 * again unchanged.
 */
interface DrawnLayers {
  version: number;
  source: ShapeLayer[];
  layers: Set<ShapeLayer>;
}

export class Parts {
  private readonly made = new WeakMap<ShapeLayer, Made>();
  private readonly maskMade = new WeakMap<ShapeLayer, Made>();
  /**
   * The layers each object's drawing (Graphics) was last drawn as, and of
   * which version: those its next version leaves out are let go of then.
   */
  private readonly drawnLayers = new WeakMap<DisplayObject, DrawnLayers>();
  /** The frames each object's next part must stand before it is looked into (markFlat). */
  private readonly standing = new WeakMap<DisplayObject, number>();
  /** Quads by their width, then their height: numbers, not a key formatted from them. */
  private readonly quads = new Map<number, Map<number, GeometryHandle>>();
  /** Quads made since the last were let go of, which past QUAD_KEYS looks for those gone. */
  private quadsMade = 0;
  /** Each glyph's fill, made once for every text drawn in it; null for an empty glyph. */
  private readonly glyphs = new WeakMap<Glyph, GeometryHandle | null>();

  constructor(
    private readonly geometries: Geometries,
    private readonly tessellator: FillTessellator,
    private readonly lineCache: LineCache,
    /** Where slow layers' triangles are kept: every view's store, or a test's. */
    private readonly kept: KeptParts = keptParts,
  ) {}

  /** The view destroyed: its kept triangles let go of, which another view's budget may use. */
  destroy(): void {
    this.kept.forgetView(this.geometries);
  }

  /** A frame drawn, its geometries' frame ended: the kept triangles whose geometries expired counted. */
  endFrame(): void {
    this.kept.settle(this.geometries);
  }

  /**
   * `o`'s drawing drawn as `layers` of `version`: the parts of the layers it
   * was last drawn as and is no more let go of now. A drawing cleared and
   * drawn again on every frame, as a software 3D engine draws its
   * triangles, makes new layers each time, whose old parts the idle frames
   * would otherwise keep for hundreds of frames.
   */
  dropUndrawn(o: DisplayObject, layers: ShapeLayer[], version: number): void {
    const last = this.drawnLayers.get(o);
    if (last?.version === version) {
      // Another set of the same version, mirrored (facing) or sliced, kept beside the first.
      if (layers !== last.source) {
        for (const layer of layers) {
          last.layers.add(layer);
        }
      }

      return;
    }

    if (last) {
      const now = new Set(layers);
      for (const layer of last.layers) {
        if (!now.has(layer)) {
          this.dropParts(this.made, layer);
          this.dropParts(this.maskMade, layer);
          this.lineCache.drop(layer);
        }
      }
    }

    this.drawnLayers.set(o, { version, source: layers, layers: new Set(layers) });
  }

  /** `layer`'s parts in `cache` let go of. */
  private dropParts(cache: WeakMap<ShapeLayer, Made>, layer: ShapeLayer): void {
    const made = cache.get(layer);
    if (!made) {
      return;
    }

    for (const { handle } of made.parts) {
      if (this.geometries.alive(handle)) {
        this.geometries.remove(handle.id);
      }
    }

    this.kept.forget(made);
    cache.delete(layer);
  }

  /**
   * `layer`'s parts, made if they were not, or one was let go of, or its
   * drawing changed since; a drawing used as a mask's apart, filled non-zero.
   */
  partsOf(layer: ShapeLayer, version: number, masking = false): Made["parts"] {
    const cache = masking ? this.maskMade : this.made;
    const made = cache.get(layer);
    // Additions and frame advances cannot invalidate handles; removals can, even mid-frame.
    if (made && made.version === version) {
      const removalVersion = this.geometries.removalVersion;
      if (made.checkedAt === removalVersion) {
        return made.parts;
      }

      let alive = true;

      for (let i = 0; alive && i < made.parts.length; i++) {
        alive = this.geometries.alive(made.parts[i].handle);
      }

      if (alive) {
        made.checkedAt = removalVersion;
        return made.parts;
      }
    }

    for (const { handle } of made?.parts ?? []) {
      if (this.geometries.alive(handle)) {
        this.geometries.remove(handle.id);
      }
    }

    if (made?.kept && made.version === version) {
      const kept = made.kept.geometries;
      const madeAt = this.geometries.frame;
      // Looked into or not (markFlat) as they were, and standing again from now before a look.
      made.parts = made.parts.map((part, i) => ({
        ...part,
        handle: this.geometries.add(kept[i]),
        madeAt,
      }));
      made.checkedAt = this.geometries.removalVersion;
      this.kept.added(made);
      return made.parts;
    }

    if (made) {
      this.kept.forget(made);
    }

    const outcome = { refused: false };
    const started = this.kept.now();
    const fresh = layerParts(layer, this.tessellator, masking, outcome);
    const ms = this.kept.now() - started;
    // The layer can outlive its handle. Let the registry release the tessellated buffers on expiry,
    // unless they were slow to make.
    const parts = fresh.map(({ geometry, paint, region, mesh, fillsFrom = 0, fillsTo = 0 }) => ({
      handle: this.geometries.add(geometry),
      paint,
      region,
      mesh,
      madeAt: this.geometries.frame,
      fillsFrom,
      fillsTo,
    }));
    const entry: Made = { parts, version, checkedAt: this.geometries.removalVersion, kept: null };
    cache.set(layer, entry);
    // A fill refused is tried again when the geometries expire, as it would be otherwise.
    if (!outcome.refused) {
      this.kept.keep(
        layer,
        entry,
        fresh.map((part) => part.geometry),
        ms,
        this.geometries,
      );
    }

    return parts;
  }

  /**
   * `part` of `layer`, of several fills, drawn by `o`, marked flat
   * (Geometries.markFlat) if they do not overlap: for a part drawn alone in
   * a blend mode, which is then drawn without a layer of its own. Looked
   * into once, and only once it has stood as long as `o`'s parts must
   * (STANDING_FRAMES). Asked of every part of several, it would tessellate
   * each such layer twice.
   */
  markFlat(o: DisplayObject, layer: ShapeLayer, part: MadePart): void {
    const { fillsFrom, fillsTo } = part;
    const standing = this.standing.get(o) ?? STANDING_FRAMES;
    if (fillsTo <= fillsFrom || this.geometries.frame - part.madeAt < standing) {
      return;
    }

    part.fillsTo = fillsFrom;
    this.standing.set(o, Math.min(standing * 2, MOST_STANDING_FRAMES));
    const data = this.geometries.get(part.handle.id);
    if (
      data &&
      fillsApart(layer, fillsFrom, fillsTo, data.positions, data.indices, this.tessellator)
    ) {
      this.geometries.markFlat(part.handle.id);
    }
  }

  /** A glyph's outline as a white fill, in the font's units over 20, as shapeLayers takes twips. */
  glyphGeometry(glyph: Glyph): GeometryHandle | null {
    const known = this.glyphs.get(glyph);
    if (known === null || (known && this.geometries.alive(known))) {
      return known;
    }

    const layers = shapeLayers(glyphShape(glyph));
    const part = layers.length > 0 ? layerParts(layers[0], this.tessellator)[0] : undefined;
    const handle = part ? this.geometries.add(part.geometry) : null;
    this.glyphs.set(glyph, handle);
    return handle;
  }

  /** A white square of a pixel, for a row to scale to a rectangle. */
  unitQuad(): GeometryHandle {
    return this.quad(1, 1);
  }

  /** A bitmap's quad of its size, made once for every bitmap of that size. */
  quad(width: number, height: number): GeometryHandle {
    let byHeight = this.quads.get(width);
    const known = byHeight?.get(height);
    if (known && this.geometries.alive(known)) {
      return known;
    }

    // Device text makes quads of many sizes: those let go of are forgotten.
    if (++this.quadsMade > QUAD_KEYS) {
      this.quadsMade = 0;
      for (const [w, heights] of this.quads) {
        for (const [h, handle] of heights) {
          if (!this.geometries.alive(handle)) {
            heights.delete(h);
          } else {
            this.quadsMade++;
          }
        }

        if (heights.size === 0) {
          this.quads.delete(w);
        }
      }

      // Its width's map, which the sweep may have let go of.
      byHeight = this.quads.get(width);
    }

    if (!byHeight) {
      byHeight = new Map();
      this.quads.set(width, byHeight);
    }

    const handle = this.geometries.add(bitmapQuad(width, height));
    byHeight.set(height, handle);
    return handle;
  }
}
