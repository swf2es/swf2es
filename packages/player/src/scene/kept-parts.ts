// Slow layers' triangles kept past their geometries' expiry (scene/parts.ts):
// a morph's blend of many crossing contours can take the tessellator a
// second, and a tween longer than IDLE_FRAMES would otherwise make each of
// its blends again on every loop. One store for every view, within one
// budget, which counts only the triangles whose geometries have gone: while
// a geometry is held, its registry holds the same arrays.
import {
  type Geometries,
  type GeometryData,
  type GeometryHandle,
  IDLE_FRAMES,
} from "@swf2es/render";
import type { ShapeLayer } from "../display/shapes.js";

/**
 * Milliseconds a layer's parts must take to make for their triangles to
 * outlive their geometries. A layer made faster is made again, as keeping
 * it would cost more memory than time.
 */
export const SLOW_PARTS_MS = 20;

/**
 * Bytes of expired triangles kept at most, for every view together: a
 * blend of a hundred crossing contours keeps about 2 MB, and a tween of a
 * few dozen such blends fits.
 */
export const KEPT_PARTS_BYTES = 64 * 1024 * 1024;

/**
 * Frames kept triangles may stand expired without being added again
 * before they may always be let go of, whatever they cost to make: a
 * layer still alive but no more drawn does not keep its place.
 */
const STALE_KEPT_FRAMES = 10 * IDLE_FRAMES;

/** How a store keeps triangles: the defaults, or a test's. */
export interface KeptPartsOptions {
  /** SLOW_PARTS_MS by default. */
  slowMs?: number;
  /** KEPT_PARTS_BYTES by default. */
  bytes?: number;
  /** The clock a layer's making is timed by, in milliseconds; performance.now by default. */
  now?: () => number;
}

/** A layer's triangles as kept: what they cost to make, and whether they count against the budget. */
export interface KeptEntry {
  /** Its parts' geometries, in order. */
  geometries: GeometryData[];
  bytes: number;
  /** Milliseconds they took to make. */
  ms: number;
  /** The registry its parts are added to, held weakly: a view let go of takes its entries along. */
  registry: WeakRef<Geometries>;
  /** Whether its geometries have expired, so that it alone holds them, and counts. */
  expired: boolean;
  /** The registry's frame it was last added again or found expired on. */
  stamp: number;
}

/** What a store keeps triangles for: a layer's parts as made (Parts' Made). */
interface KeptOwner {
  parts: { handle: GeometryHandle }[];
  kept: KeptEntry | null;
}

/**
 * The slow layers' triangles kept. Kept as made, they count once their
 * geometries expire; one that does not fit then takes the place of those
 * worth less, in milliseconds saved a byte, or of those gone stale, and
 * is let go of otherwise, a tie too. Nothing is let go of to make room by
 * age alone, as a tween's loop longer than the budget would then find
 * none of its blends kept, each let go of just before it comes round.
 */
export class KeptParts {
  readonly slowMs: number;
  readonly now: () => number;
  /** The budget, in bytes of expired triangles. */
  readonly most: number;
  private readonly owners = new Set<KeptOwner>();
  private expiredBytes = 0;
  /** An owner's triangles let go of with its layer: the owner holds no reference to it. */
  private readonly gone = new FinalizationRegistry<KeptOwner>((owner) => this.forget(owner));

  constructor(options: KeptPartsOptions = {}) {
    this.slowMs = options.slowMs ?? SLOW_PARTS_MS;
    this.most = options.bytes ?? KEPT_PARTS_BYTES;
    this.now = options.now ?? (() => performance.now());
  }

  /** Bytes of triangles kept whose geometries have expired, which the budget counts. */
  get bytes(): number {
    return this.expiredBytes;
  }

  /** How many layers' triangles are kept, expired or not. */
  get size(): number {
    return this.owners.size;
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

    if (ms < this.slowMs || bytes === 0 || bytes > this.most) {
      return;
    }

    this.forget(owner);
    owner.kept = {
      geometries,
      bytes,
      ms,
      registry: new WeakRef(registry),
      expired: false,
      stamp: registry.frame,
    };
    this.owners.add(owner);
    this.gone.register(layer, owner, owner);
  }

  /** `owner`'s kept triangles added again to its registry: they count no more. */
  added(owner: KeptOwner, registry: Geometries): void {
    const entry = owner.kept;
    if (!entry) {
      return;
    }

    if (entry.expired) {
      entry.expired = false;
      this.expiredBytes -= entry.bytes;
    }

    entry.stamp = registry.frame;
  }

  /** `owner`'s kept triangles let go of, if it has any. */
  forget(owner: KeptOwner): void {
    const entry = owner.kept;
    if (!entry || !this.owners.delete(owner)) {
      return;
    }

    if (entry.expired) {
      this.expiredBytes -= entry.bytes;
    }

    this.gone.unregister(owner);
    owner.kept = null;
  }

  /**
   * A frame drawn: the triangles whose geometries expired since counted,
   * within the budget, and those of a registry let go of forgotten.
   */
  settle(): void {
    if (this.owners.size === 0) {
      return;
    }

    for (const owner of this.owners) {
      const entry = owner.kept as KeptEntry;
      const registry = entry.registry.deref();
      if (!registry) {
        this.forget(owner);
        continue;
      }

      if (!entry.expired && owner.parts.some((part) => !registry.alive(part.handle))) {
        this.admit(owner, entry, registry);
      }
    }
  }

  /** `entry`'s geometries expired: counted if it fits, or in place of those worth less, or let go of. */
  private admit(owner: KeptOwner, entry: KeptEntry, registry: Geometries): void {
    entry.stamp = registry.frame;
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
   * The expired entries to let go of for `entry` to fit: the stale first,
   * then those worth less a byte, least first; null where those are not
   * enough, `entry` then worth no more than what it would push out.
   */
  private roomFor(entry: KeptEntry): KeptOwner[] | null {
    const worth = (e: KeptEntry) => e.ms / e.bytes;
    const stale = (e: KeptEntry) => {
      const registry = e.registry.deref();
      return !registry || registry.frame - e.stamp > STALE_KEPT_FRAMES;
    };
    const candidates: { owner: KeptOwner; entry: KeptEntry; stale: boolean }[] = [];
    for (const owner of this.owners) {
      const e = owner.kept as KeptEntry;
      if (e.expired) {
        candidates.push({ owner, entry: e, stale: stale(e) });
      }
    }

    candidates.sort((a, b) => Number(b.stale) - Number(a.stale) || worth(a.entry) - worth(b.entry));
    const out: KeptOwner[] = [];
    let bytes = this.expiredBytes;
    for (const c of candidates) {
      if (bytes + entry.bytes <= this.most) {
        break;
      }

      if (!c.stale && worth(c.entry) >= worth(entry)) {
        return null;
      }

      out.push(c.owner);
      bytes -= c.entry.bytes;
    }

    return bytes + entry.bytes <= this.most ? out : null;
  }
}

/** The store every view's parts keep their slow layers' triangles in. */
export const keptParts = new KeptParts();
