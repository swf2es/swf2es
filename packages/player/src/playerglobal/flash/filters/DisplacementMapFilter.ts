// flash.filters.DisplacementMapFilter: its map, a copy of a BitmapData, its
// point, mode and scales.
import type { avm2 } from "@swf2es/runtime";
import type { BitmapStore } from "../../../bitmap/bitmap.js";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

type AsObject = avm2.AsObject;

/**
 * A copy of a displacement map's BitmapData, made as Flash makes it: a
 * plain BitmapData of the same pixels, not through the object's own
 * clone, which a script may override. Null for none, or one disposed.
 */
export function copyMap(s: Scripting, map: object | null): AsObject | null {
  const store = (map as { $store?: BitmapStore } | null)?.$store;
  if (!store || store.disposed) {
    return null;
  }

  const o = s.rt.construct(
    s.rt.classNamed("flash.display::BitmapData"),
    store.width,
    store.height,
    store.transparent,
    0,
  ) as AsObject;
  o.$store = store.clone();
  return o;
}

export function displacementMapFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "displacementMap", ({ num }) => ({
    // A copy each way, as adl gives one: the map's pixels, the point in whole pixels.
    mapBitmap: [
      (f) => copyMap(s, f.mapBitmap),
      (f, v) => {
        f.mapBitmap = (v as AsObject | null) ?? null;
      },
    ],
    mapPoint: [
      (f) => s.rt.construct(s.rt.classNamed("flash.geom::Point"), f.mapPoint[0], f.mapPoint[1]),
      (f, v) => {
        const p = v as AsObject | null;
        f.mapPoint = p
          ? [
              Math.trunc(num(s.rt.getProperty(p, s.rt.publicName("x")))) || 0,
              Math.trunc(num(s.rt.getProperty(p, s.rt.publicName("y")))) || 0,
            ]
          : [0, 0];
      },
    ],
    mode: [
      (f) => f.mode,
      (f, v) => {
        if (v === null || v === undefined) {
          throw s.rt.error("TypeError", 2007, "mode");
        }

        const mode = s.rt.toString(v);
        if (!["wrap", "clamp", "ignore", "color"].includes(mode)) {
          throw s.rt.error("ArgumentError", 2008, "mode");
        }

        f.mode = mode;
      },
    ],
  }));
}
