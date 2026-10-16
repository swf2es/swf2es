// Color, AS1's colour transform of a clip, as Ruffle's (https://github.com/
// ruffle-rs/ruffle) core/src/avm1/globals/color.rs has it: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// A Color keeps its target as given, a clip or a path, and finds it again
// each time it is used; the clip's colour transform is kept as a clip keeps
// one, the multipliers in 8.8 fixed point and the offsets whole, 16 bits
// each, wrapped.
import { avm1 } from "@swf2es/runtime";
import { type DisplayObject, TRANSFORM } from "../../display/display.js";
import { int16 } from "./geom.js";

/** What Color reads of the movie. */
export interface ColorHost {
  readonly realm: avm1.Realm;
  /** What `value`, an object or a path from the code's target, names; null for nothing. */
  resolve(value: avm1.Value, version: number): DisplayObject | null;
}

const IDENTITY = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };
const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY;

/** `_global.Color`. */
export function colorClass(host: ColorHost): avm1.Avm1Object {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args) => {
      self.define("target", args.length > 0 ? args[0] : undefined, FIXED);
      return self;
    },
    () => undefined,
  );

  const target = (self: avm1.Avm1Object, v: number): DisplayObject | null => {
    const value = avm1.get(self, "target", v);
    return value === undefined ? null : host.resolve(value, v);
  };
  const changed = (d: DisplayObject) => {
    d.touch();
    d.invalidate(TRANSFORM);
  };
  const method = (name: string, f: avm1.Native) => proto.define(name, realm.method(f), FIXED);

  // The offsets as one colour, 0xRRGGBB, signed.
  method("getRGB", (self, _, v) => {
    const d = target(self, v);
    if (d === null) {
      return undefined;
    }

    const c = d.colorTransform ?? IDENTITY;
    return (c.rAdd << 16) | (c.gAdd << 8) | c.bAdd;
  });
  method("setRGB", (self, args, v) => {
    const d = target(self, v);
    if (d !== null) {
      const rgb = avm1.toNumber(args[0], v) | 0;
      const c = d.colorTransform ?? IDENTITY;
      d.colorTransform = {
        ...c,
        rMul: 0,
        gMul: 0,
        bMul: 0,
        rAdd: (rgb >> 16) & 0xff,
        gAdd: (rgb >> 8) & 0xff,
        bAdd: rgb & 0xff,
      };
      changed(d);
    }

    return undefined;
  });
  // The multipliers as percentages, ra to aa, then the offsets, rb to ab.
  method("getTransform", (self, _, v) => {
    const d = target(self, v);
    if (d === null) {
      return undefined;
    }

    const c = d.colorTransform ?? IDENTITY;
    const out = new avm1.Avm1Object(realm.objectProto);
    const values: [string, number][] = [
      ["ra", c.rMul * 100],
      ["ga", c.gMul * 100],
      ["ba", c.bMul * 100],
      ["aa", c.aMul * 100],
      ["rb", c.rAdd],
      ["gb", c.gAdd],
      ["bb", c.bAdd],
      ["ab", c.aAdd],
    ];
    for (const [name, value] of values) {
      avm1.set(out, name, value, v);
    }

    return out;
  });
  // Only the fields the object has of its own; each wrapped to 16 bits, as Flash keeps them.
  method("setTransform", (self, args, v) => {
    const d = target(self, v);
    const t = args.length > 0 ? realm.box(args[0], v) : null;
    if (d === null || t === null) {
      return undefined;
    }

    const c = { ...(d.colorTransform ?? IDENTITY) };
    const field = (name: string) => {
      const p = t.own(name, v);
      return p === undefined ? null : avm1.toNumber(avm1.get(t, name, v), v);
    };
    const mul = (name: string, old: number) => {
      const n = field(name);
      return n === null ? old : int16(n * 2.56) / 256;
    };
    const add = (name: string, old: number) => {
      const n = field(name);
      return n === null ? old : int16(n);
    };
    d.colorTransform = {
      rMul: mul("ra", c.rMul),
      gMul: mul("ga", c.gMul),
      bMul: mul("ba", c.bMul),
      aMul: mul("aa", c.aMul),
      rAdd: add("rb", c.rAdd),
      gAdd: add("gb", c.gAdd),
      bAdd: add("bb", c.bAdd),
      aAdd: add("ab", c.aAdd),
    };
    changed(d);
    return undefined;
  });
  return constr;
}
