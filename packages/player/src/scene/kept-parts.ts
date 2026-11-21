// Slow layers' triangles kept past their geometries' expiry (scene/parts.ts):
// a morph's blend of many crossing contours can take the tessellator a
// second, and a tween longer than IDLE_FRAMES would otherwise make each of
// its blends again on every loop. One store for every view, within one
// budget, which counts only the triangles whose geometries have gone: while
// a geometry is held, its registry holds the same arrays.
import type { Geometries, GeometryData, GeometryHandle } from "@swf2es/render";
import type { ShapeLayer } from "../display/shapes.js";

/**
 * Milliseconds a layer's parts must take to make for their triangles to
 * outlive their geometries. A layer made faster is made again, as keeping
 * it would cost more memory than time.
 */
export const SLOW_PARTS_MS = 20;

/**
 * The fewest bytes of triangles kept: a small layer slow only as a
 * collection paused its making would seem worth a great deal a byte, and
 * makes again in no time.
 */
export const LEAST_KEPT_BYTES = 64 * 1024;

/**
 * Bytes of expired triangles kept at most, for every view together: a
 * blend of a hundred crossing contours keeps about 2 MB, and a tween of a
 * few dozen such blends fits.
 */
export const KEPT_PARTS_BYTES = 64 * 1024 * 1024;

/** How a store keeps triangles: the defaults, or a test's. */
export interface KeptPartsOptions {
  /** SLOW_PARTS_MS by default. */
  slowMs?: number;
  /** LEAST_KEPT_BYTES by default. */
  leastBytes?: number;
  /** KEPT_PARTS_BYTES by default. */
  bytes?: number;
  /** The clock a layer's making is timed by, in milliseconds; performance.now by default. */
  now?: () => number;
}

/**
 * One registry's kept triangles, and among them those whose geometries it
 * still holds, with its removals as last settled: none since, none of them
 * can have expired. Holds no reference to the registry, so that it goes.
 */
interface View {
  owners: Set<KeptOwner>;
  held: Set<KeptOwner>;
  settledAt: number;
}

/** A layer's triangles as kept: what they cost to make, and whether they count against the budget. */
export interface KeptEntry {
  /** Its parts' geometries, in order. */
  geometries: GeometryData[];
  bytes: number;
  /** Milliseconds they took to make. */
  ms: number;
  /** The kept triangles of the registry its parts are added to. */
  view: View;
  /** Whether its geometries have expired, so that it alone holds them, and counts. */
  expired: boolean;
}

/** What a store keeps triangles for: a layer's parts as made (Parts' Made). */
interface KeptOwner {
  parts: { handle: GeometryHandle }[];
  kept: KeptEntry | null;
}

const worth = (e: KeptEntry) => e.ms / e.bytes;

/**
 * The slow layers' triangles kept. Kept as made, they count once their
 * geometries expire; one that does not fit then takes the place of those
 * worth less, in milliseconds saved a byte, and is let go of otherwise, a
 * tie too, so that what is kept stays kept while it is worth the most.
 * Nothing is let go of by age: a tween's loop of more blends than fit
 * would then find none of them kept, each let go of before it comes round.
 * They go otherwise with their layer, their registry, or as their drawing
 * changes or no longer draws them (Parts).
 */
export class KeptParts {
  readonly slowMs: number;
  readonly now: () => number;
  /** The budget, in bytes of expired triangles. */
  readonly most: number;
  private readonly least: number;
  private readonly views = new WeakMap<Geometries, View>();
  /** The views, which the budget weighs together: a WeakMap cannot list them. */
  private readonly listed = new Set<View>();
  private count = 0;
  private expiredBytes = 0;
  /** An owner's triangles let go of with its layer: the owner holds no reference to it. */
  private readonly layerGone = new FinalizationRegistry<KeptOwner>((owner) => this.forget(owner));
  /** A registry's triangles let go of with it, however long their layers live on. */
  private readonly viewGone = new FinalizationRegistry<View>((view) => {
    for (const owner of view.owners) {
      this.forget(owner);
    }

    this.listed.delete(view);
  });

  constructor(options: KeptPartsOptions = {}) {
    this.slowMs = options.slowMs ?? SLOW_PARTS_MS;
    this.least = options.leastBytes ?? LEAST_KEPT_BYTES;
    this.most = options.bytes ?? KEPT_PARTS_BYTES;
    this.now = options.now ?? (() => performance.now());
  }

  /** Bytes of triangles kept whose geometries have expired, which the budget counts. */
  get bytes(): number {
    return this.expiredBytes;
  }

  /** How many layers' triangles are kept, expired or not. */
  get size(): number {
    return this.count;
  }

  /** `owner`'s `geometries`, made in `ms` for `layer` and added to `registry`, kept if they may be. */
  keep(
    layer: ShapeLayer,
    owner: KeptOwner,
    geometries: GeometryData[],
    ms: number,
    registry: Geometries,
  ): void {
    let bytes = 0;
    for (const g of geometries) {
      bytes += g.positions.byteLength + g.colors.byteLength + g.indices.byteLength;
      bytes += (g.texels?.byteLength ?? 0) + (g.depths?.byteLength ?? 0);
    }

    if (ms < this.slowMs || bytes === 0 || bytes < this.least || bytes > this.most) {
      return;
    }

    let view = this.views.get(registry);
    if (!view) {
      view = { owners: new Set(), held: new Set(), settledAt: registry.removalVersion };
      this.views.set(registry, view);
      this.listed.add(view);
      this.viewGone.register(registry, view, view);
    }

    this.forget(owner);
    owner.kept = { geometries, bytes, ms, view, expired: false };
    view.owners.add(owner);
    view.held.add(owner);
    this.count++;
    this.layerGone.register(layer, owner, owner);
  }

  /** `owner`'s kept triangles added again to their registry: they count no more. */
  added(owner: KeptOwner): void {
    const entry = owner.kept;
    if (entry?.expired) {
      entry.expired = false;
      this.expiredBytes -= entry.bytes;
      entry.view.held.add(owner);
    }
  }

  /** `owner`'s kept triangles let go of, if it has any. */
  forget(owner: KeptOwner): void {
    const entry = owner.kept;
    if (!entry?.view.owners.delete(owner)) {
      return;
    }

    entry.view.held.delete(owner);
    if (entry.expired) {
      this.expiredBytes -= entry.bytes;
    }

    this.count--;
    this.layerGone.unregister(owner);
    owner.kept = null;
  }

  /**
   * `registry`'s view destroyed: its kept triangles let go of now, as one
   * destroyed may still be held a while, keeping them from the budget.
   */
  forgetView(registry: Geometries): void {
    const view = this.views.get(registry);
    if (!view) {
      return;
    }

    for (const owner of view.owners) {
      this.forget(owner);
    }

    this.views.delete(registry);
    this.listed.delete(view);
    this.viewGone.unregister(view);
  }

  /**
   * A frame of `registry` ended: its kept triangles whose geometries
   * expired counted, within the budget. Looked for only where it removed
   * any geometry since it was last settled, so a frame that removed none
   * costs a lookup.
   */
  settle(registry: Geometries): void {
    const view = this.views.get(registry);
    if (!view || view.settledAt === registry.removalVersion) {
      return;
    }

    view.settledAt = registry.removalVersion;
    for (const owner of view.held) {
      if (owner.parts.some((part) => !registry.alive(part.handle))) {
        view.held.delete(owner);
        this.admit(owner, owner.kept as KeptEntry);
      }
    }
  }

  /** `entry`'s geometries expired: counted if it fits, or in place of those worth less, or let go of. */
  private admit(owner: KeptOwner, entry: KeptEntry): void {
    if (this.expiredBytes + entry.bytes > this.most) {
      const out = this.roomFor(entry);
      if (!out) {
        this.forget(owner);
        return;
      }

      for (const other of out) {
        this.forget(other);
      }
    }

    entry.expired = true;
    this.expiredBytes += entry.bytes;
  }

  /**
   * The expired entries of every view to let go of for `entry` to fit,
   * those worth least a byte first; null where those worth less than it
   * are not enough.
   */
  private roomFor(entry: KeptEntry): KeptOwner[] | null {
    const most = worth(entry);
    const cheaper: KeptOwner[] = [];
    for (const view of this.listed) {
      for (const owner of view.owners) {
        const e = owner.kept as KeptEntry;
        if (e.expired && worth(e) < most) {
          cheaper.push(owner);
        }
      }
    }

    cheaper.sort((a, b) => worth(a.kept as KeptEntry) - worth(b.kept as KeptEntry));
    const out: KeptOwner[] = [];
    let bytes = this.expiredBytes;
    for (const owner of cheaper) {
      if (bytes + entry.bytes <= this.most) {
        break;
      }

      out.push(owner);
      bytes -= (owner.kept as KeptEntry).bytes;
    }

    return bytes + entry.bytes <= this.most ? out : null;
  }
}

/** The store every view's parts keep their slow layers' triangles in. */
export const keptParts = new KeptParts();
