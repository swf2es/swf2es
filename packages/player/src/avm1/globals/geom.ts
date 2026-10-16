// flash.geom's AS2 classes, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/point.rs, rectangle.rs, matrix.rs,
// color_transform.rs and transform.rs have them: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. Point,
// Rectangle and Matrix are plain objects, as Flash writes them in
// ActionScript: their methods read and write their properties by name, so
// any object with them will do, and their values are kept as given.
// ColorTransform and Transform hold native state. What a method makes, a
// Point, a Rectangle, a Matrix, is made by the class `_global.flash.geom`
// has then, a script's own among them, in doubles where Ruffle works in
// floats and twips.
import { avm1 } from "@swf2es/runtime";
import { bounds, toStage } from "../../display/bounds.js";
import { type DisplayObject, TRANSFORM } from "../../display/display.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What the classes read of the movie: its realm, its version, and the stage clips are on. */
export interface GeomHost {
  readonly realm: avm1.Realm;
  readonly version: number;
  /** The stage, which a clip's concatenated matrix and pixel bounds are measured to. */
  stageOf(d: DisplayObject): DisplayObject | null;
}

const num = (v: Value, version: number) => avm1.toNumber(v, version);
const read = (o: Value, name: string, version: number): Value =>
  o instanceof avm1.Avm1Object ? avm1.get(o, name, version) : undefined;
const field = (o: Value, name: string, version: number) => num(read(o, name, version), version);

/** `_global.flash.geom[name]`, as the realm has it now: undefined where there is none. */
function geomClass(realm: avm1.Realm, name: string, version: number): Value {
  const geom = read(read(realm.global, "flash", version), "geom", version);
  return read(geom, name, version);
}

/** A new `name` of `args`, by the class `flash.geom` has now; -1 where it has none (Ruffle). */
export function makeGeom(realm: avm1.Realm, name: string, args: Value[], version: number): Value {
  const constr = geomClass(realm, name, version);
  return constr instanceof avm1.Avm1Function ? realm.construct(constr, args, version) : -1;
}

/** `o.name(...args)`, a method found as code calls it; undefined where there is none. */
function callMethod(o: Value, name: string, args: Value[], version: number): Value {
  const method = read(o, name, version);
  return method instanceof avm1.Avm1Function && o instanceof avm1.Avm1Object
    ? method.call(o, args, version, 1)
    : undefined;
}

/** `(a=1, b=2)`: each value as AVM1 makes it a string. */
function described(o: Obj, names: string[], version: number, short?: string[]): string {
  const parts = names.map(
    (n, i) => `${short?.[i] ?? n}=${avm1.stringOf(avm1.get(o, n, version), version)}`,
  );
  return `(${parts.join(", ")})`;
}

/** A getter, and a setter if given, on `o` as `name`. */
function accessor(
  realm: avm1.Realm,
  o: Obj,
  name: string,
  get: avm1.Native,
  set: avm1.Native | null,
  flags = 0,
): void {
  const p = o.add(name, undefined, flags);
  p.get = realm.method(get);
  if (set !== null) {
    p.set = realm.method(set);
  }
}

function pointClass(realm: avm1.Realm): Obj {
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      avm1.set(self, "x", args.length === 0 ? 0 : args[0], v);
      avm1.set(self, "y", args.length === 0 ? 0 : args[1], v);
      return self;
    },
    () => undefined,
  );
  const point = (x: number, y: number, v: number) => makeGeom(realm, "Point", [x, y], v);
  const method = (name: string, f: avm1.Native) => proto.define(name, realm.method(f), 0);

  accessor(
    realm,
    proto,
    "length",
    (self, _, v) => Math.hypot(field(self, "x", v), field(self, "y", v)),
    null,
  );
  method("add", (self, args, v) =>
    point(
      field(self, "x", v) + field(args[0], "x", v),
      field(self, "y", v) + field(args[0], "y", v),
      v,
    ),
  );
  method("subtract", (self, args, v) =>
    point(
      field(self, "x", v) - field(args[0], "x", v),
      field(self, "y", v) - field(args[0], "y", v),
      v,
    ),
  );
  method(
    "equals",
    (self, args, v) =>
      args[0] instanceof avm1.Avm1Object &&
      read(self, "x", v) === read(args[0], "x", v) &&
      read(self, "y", v) === read(args[0], "y", v),
  );
  method("normalize", (self, args, v) => {
    // A point of no length stays as it is, as Flash's (the corpus's `point`).
    const length = Math.hypot(field(self, "x", v), field(self, "y", v));
    if (Number.isFinite(length) && length !== 0) {
      const k = num(args[0], v) / length;
      avm1.set(self, "x", field(self, "x", v) * k, v);
      avm1.set(self, "y", field(self, "y", v) * k, v);
    }

    return undefined;
  });
  method("offset", (self, args, v) => {
    avm1.set(self, "x", field(self, "x", v) + num(args[0], v), v);
    avm1.set(self, "y", field(self, "y", v) + num(args[1], v), v);
    return undefined;
  });
  method("clone", (self, _, v) =>
    makeGeom(realm, "Point", [read(self, "x", v), read(self, "y", v)], v),
  );
  method("toString", (self, _, v) => described(self, ["x", "y"], v));

  const statics = (name: string, f: avm1.Native) => constr.define(name, realm.method(f), 0);
  statics("distance", (_, args, v) =>
    args.length < 2 ? Number.NaN : read(callMethod(args[0], "subtract", [args[1]], v), "length", v),
  );
  statics("interpolate", (_, args, v) => {
    if (args.length < 3) {
      return point(Number.NaN, Number.NaN, v);
    }

    const [a, b, f] = [args[0], args[1], num(args[2], v)];
    const bx = field(b, "x", v);
    const by = field(b, "y", v);
    return point(bx - (bx - field(a, "x", v)) * f, by - (by - field(a, "y", v)) * f, v);
  });
  statics("polar", (_, args, v) => {
    const length = num(args[0], v);
    const angle = num(args[1], v);
    return point(length * Math.cos(angle), length * Math.sin(angle), v);
  });
  return constr;
}

function rectangleClass(realm: avm1.Realm): Obj {
  const proto = new avm1.Avm1Object(realm.objectProto);
  const NAMES = ["x", "y", "width", "height"];
  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      for (const [i, n] of NAMES.entries()) {
        avm1.set(self, n, args.length === 0 ? 0 : args[i], v);
      }

      return self;
    },
    () => undefined,
  );
  const f = (o: Value, n: string, v: number) => field(o, n, v);
  const put = (o: Obj, n: string, value: Value, v: number) => avm1.set(o, n, value, v);
  const make = (x: Value, y: Value, w: Value, h: Value, v: number) =>
    makeGeom(realm, "Rectangle", [x, y, w, h], v);
  const point = (x: number, y: number, v: number) => makeGeom(realm, "Point", [x, y], v);
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), 0);
  const empty = (o: Value, v: number) => !(f(o, "width", v) > 0) || !(f(o, "height", v) > 0);

  accessor(
    realm,
    proto,
    "left",
    (self, _, v) => read(self, "x", v),
    (self, args, v) => {
      put(self, "width", f(self, "width", v) + f(self, "x", v) - num(args[0], v), v);
      put(self, "x", args[0], v);
      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "top",
    (self, _, v) => read(self, "y", v),
    (self, args, v) => {
      put(self, "height", f(self, "height", v) + f(self, "y", v) - num(args[0], v), v);
      put(self, "y", args[0], v);
      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "right",
    (self, _, v) => f(self, "x", v) + f(self, "width", v),
    (self, args, v) => {
      put(self, "width", num(args[0], v) - f(self, "x", v), v);
      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "bottom",
    (self, _, v) => f(self, "y", v) + f(self, "height", v),
    (self, args, v) => {
      put(self, "height", num(args[0], v) - f(self, "y", v), v);
      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "topLeft",
    // Points of the values as they are, not numbers (the corpus's `rectangle`).
    (self, _, v) => makeGeom(realm, "Point", [read(self, "x", v), read(self, "y", v)], v),
    (self, args, v) => {
      put(self, "width", f(self, "width", v) + f(self, "x", v) - f(args[0], "x", v), v);
      put(self, "height", f(self, "height", v) + f(self, "y", v) - f(args[0], "y", v), v);
      put(self, "x", read(args[0], "x", v), v);
      put(self, "y", read(args[0], "y", v), v);
      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "bottomRight",
    (self, _, v) =>
      point(f(self, "x", v) + f(self, "width", v), f(self, "y", v) + f(self, "height", v), v),
    (self, args, v) => {
      put(self, "width", f(args[0], "x", v) - f(self, "x", v), v);
      put(self, "height", f(args[0], "y", v) - f(self, "y", v), v);
      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "size",
    (self, _, v) => makeGeom(realm, "Point", [read(self, "width", v), read(self, "height", v)], v),
    (self, args, v) => {
      put(self, "width", read(args[0], "x", v), v);
      put(self, "height", read(args[0], "y", v), v);
      return undefined;
    },
  );

  method("clone", (self, _, v) =>
    make(
      read(self, "x", v),
      read(self, "y", v),
      read(self, "width", v),
      read(self, "height", v),
      v,
    ),
  );
  method("isEmpty", (self, _, v) => empty(self, v));
  method("setEmpty", (self, _, v) => {
    for (const n of NAMES) {
      put(self, n, 0, v);
    }

    return undefined;
  });
  const inflate = (self: Obj, dx: number, dy: number, v: number) => {
    put(self, "x", f(self, "x", v) - dx, v);
    put(self, "width", f(self, "width", v) + 2 * dx, v);
    put(self, "y", f(self, "y", v) - dy, v);
    put(self, "height", f(self, "height", v) + 2 * dy, v);
    return undefined;
  };
  method("inflate", (self, args, v) => inflate(self, num(args[0], v), num(args[1], v), v));
  method("inflatePoint", (self, args, v) =>
    inflate(self, f(args[0], "x", v), f(args[0], "y", v), v),
  );
  const offset = (self: Obj, dx: number, dy: number, v: number) => {
    put(self, "x", f(self, "x", v) + dx, v);
    put(self, "y", f(self, "y", v) + dy, v);
    return undefined;
  };
  method("offset", (self, args, v) => offset(self, num(args[0], v), num(args[1], v), v));
  method("offsetPoint", (self, args, v) => offset(self, f(args[0], "x", v), f(args[0], "y", v), v));

  // A NaN anywhere makes it undefined, neither in nor out (Ruffle).
  const contains = (self: Obj, x: number, y: number, v: number): Value => {
    const [rx, ry, w, h] = NAMES.map((n) => f(self, n, v));
    if ([x, y, rx, ry, w, h].some(Number.isNaN)) {
      return undefined;
    }

    return x >= rx && x < rx + w && y >= ry && y < ry + h;
  };
  method("contains", (self, args, v) => contains(self, num(args[0], v), num(args[1], v), v));
  method("containsPoint", (self, args, v) =>
    contains(self, f(args[0], "x", v), f(args[0], "y", v), v),
  );
  method("containsRectangle", (self, args, v) => {
    const [rx, ry, w, h] = NAMES.map((n) => f(self, n, v));
    const [ox, oy, ow, oh] = NAMES.map((n) => f(args[0], n, v));
    if ([rx, ry, w, h, ox, oy, ow, oh].some(Number.isNaN)) {
      return undefined;
    }

    return ox >= rx && oy >= ry && ox + ow <= rx + w && oy + oh <= ry + h;
  });
  const overlap = (self: Obj, other: Value, v: number) => {
    const [ax, ay, aw, ah] = NAMES.map((n) => f(self, n, v));
    const [bx, by, bw, bh] = NAMES.map((n) => f(other, n, v));
    const left = Math.max(ax, bx);
    const top = Math.max(ay, by);
    const right = Math.min(ax + aw, bx + bw);
    const bottom = Math.min(ay + ah, by + bh);
    return { left, top, right, bottom };
  };
  method("intersects", (self, args, v) => {
    const o = overlap(self, args[0], v);
    return o.right > o.left && o.bottom > o.top;
  });
  method("intersection", (self, args, v) => {
    const o = overlap(self, args[0], v);
    return o.right > o.left && o.bottom > o.top
      ? make(o.left, o.top, o.right - o.left, o.bottom - o.top, v)
      : make(0, 0, 0, 0, v);
  });
  method("union", (self, args, v) => {
    // Empty here by a size not above 0: one of NaNs is not, and its NaNs go into the union.
    const other = args[0];
    const none = (o: Value) => f(o, "width", v) <= 0 || f(o, "height", v) <= 0;
    if (none(self)) {
      return callMethod(other, "clone", [], v);
    }

    if (none(other)) {
      return callMethod(self, "clone", [], v);
    }

    const [ax, ay, aw, ah] = NAMES.map((n) => f(self, n, v));
    const [bx, by, bw, bh] = NAMES.map((n) => f(other, n, v));
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    return make(left, top, Math.max(ax + aw, bx + bw) - left, Math.max(ay + ah, by + bh) - top, v);
  });
  method("equals", (self, args, v) => {
    const other = args[0];
    const constr = geomClass(realm, "Rectangle", v);
    const prototype = read(constr, "prototype", v);
    let p = other instanceof avm1.Avm1Object ? read(other, "__proto__", v) : undefined;
    let isRectangle = false;
    for (let depth = 0; p instanceof avm1.Avm1Object && depth < 256; depth++) {
      if (p === prototype) {
        isRectangle = true;
        break;
      }

      p = read(p, "__proto__", v);
    }

    return isRectangle && NAMES.every((n) => read(self, n, v) === read(other, n, v));
  });
  method("toString", (self, _, v) => described(self, NAMES, v, ["x", "y", "w", "h"]));
  return constr;
}

/** A matrix's six fields by name, as numbers. */
function matrixOf(o: Value, v: number): [number, number, number, number, number, number] {
  return [
    field(o, "a", v),
    field(o, "b", v),
    field(o, "c", v),
    field(o, "d", v),
    field(o, "tx", v),
    field(o, "ty", v),
  ];
}

const MATRIX_NAMES = ["a", "b", "c", "d", "tx", "ty"];

function setMatrix(o: Obj, m: readonly number[], v: number): undefined {
  for (const [i, n] of MATRIX_NAMES.entries()) {
    avm1.set(o, n, m[i], v);
  }

  return undefined;
}

function matrixClass(realm: avm1.Realm): Obj {
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      if (args.length === 0) {
        setMatrix(self, [1, 0, 0, 1, 0, 0], v);
      } else {
        for (const [i, n] of MATRIX_NAMES.entries()) {
          if (i < args.length) {
            avm1.set(self, n, args[i], v);
          }
        }
      }

      return self;
    },
    () => undefined,
  );
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), 0);
  const point = (x: number, y: number, v: number) => makeGeom(realm, "Point", [x, y], v);

  method("identity", (self, _, v) => setMatrix(self, [1, 0, 0, 1, 0, 0], v));
  method("translate", (self, args, v) => {
    const [a, b, c, d, tx, ty] = matrixOf(self, v);
    return setMatrix(self, [a, b, c, d, tx + num(args[0], v), ty + num(args[1], v)], v);
  });
  method("scale", (self, args, v) => {
    const [a, b, c, d, tx, ty] = matrixOf(self, v);
    const sx = num(args[0], v);
    const sy = num(args[1], v);
    return setMatrix(self, [a * sx, b * sy, c * sx, d * sy, tx * sx, ty * sy], v);
  });
  method("rotate", (self, args, v) => {
    const [a, b, c, d, tx, ty] = matrixOf(self, v);
    const q = num(args[0], v);
    const cos = Math.cos(q);
    const sin = Math.sin(q);
    return setMatrix(
      self,
      [
        a * cos - b * sin,
        a * sin + b * cos,
        c * cos - d * sin,
        c * sin + d * cos,
        tx * cos - ty * sin,
        tx * sin + ty * cos,
      ],
      v,
    );
  });
  method("concat", (self, args, v) => {
    const [a, b, c, d, tx, ty] = matrixOf(self, v);
    const [ma, mb, mc, md, mtx, mty] = matrixOf(args[0], v);
    return setMatrix(
      self,
      [
        a * ma + b * mc,
        a * mb + b * md,
        c * ma + d * mc,
        c * mb + d * md,
        tx * ma + ty * mc + mtx,
        tx * mb + ty * md + mty,
      ],
      v,
    );
  });
  method("invert", (self, _, v) => {
    const [a, b, c, d, tx, ty] = matrixOf(self, v);
    const det = a * d - b * c;
    if (det === 0) {
      return setMatrix(self, [1, 0, 0, 1, 0, 0], v);
    }

    return setMatrix(
      self,
      [d / det, -b / det, -c / det, a / det, (c * ty - d * tx) / det, (b * tx - a * ty) / det],
      v,
    );
  });
  // A rotation not given is NaN, as Flash's; a translation not given is 0.
  const box = (sx: number, sy: number, q: number, tx: number, ty: number): number[] => {
    const cos = Math.cos(q);
    const sin = Math.sin(q);
    return [sx * cos, sy * sin, -sx * sin, sy * cos, tx, ty];
  };
  const arg = (args: Value[], i: number, fallback: number, v: number) =>
    i < args.length ? num(args[i], v) : fallback;
  method("createBox", (self, args, v) =>
    setMatrix(
      self,
      box(
        num(args[0], v),
        num(args[1], v),
        arg(args, 2, Number.NaN, v),
        arg(args, 3, 0, v),
        arg(args, 4, 0, v),
      ),
      v,
    ),
  );
  method("createGradientBox", (self, args, v) => {
    const w = num(args[0], v);
    const h = num(args[1], v);
    const x = arg(args, 3, 0, v);
    const y = arg(args, 4, 0, v);
    return setMatrix(
      self,
      box(w / 1638.4, h / 1638.4, arg(args, 2, 0, v), x + w / 2, y + h / 2),
      v,
    );
  });
  method("transformPoint", (self, args, v) => {
    const [a, b, c, d, tx, ty] = matrixOf(self, v);
    const x = field(args[0], "x", v);
    const y = field(args[0], "y", v);
    return point(a * x + c * y + tx, b * x + d * y + ty, v);
  });
  method("deltaTransformPoint", (self, args, v) => {
    const [a, b, c, d] = matrixOf(self, v);
    const x = field(args[0], "x", v);
    const y = field(args[0], "y", v);
    return point(a * x + c * y, b * x + d * y, v);
  });
  method("clone", (self, _, v) =>
    makeGeom(
      realm,
      "Matrix",
      MATRIX_NAMES.map((n) => read(self, n, v)),
      v,
    ),
  );
  method("toString", (self, _, v) => described(self, MATRIX_NAMES, v));
  return constr;
}

/** A ColorTransform's eight values: the multipliers, red, green, blue, alpha, then the offsets. */
const colors = new WeakMap<Obj, Float64Array>();

const COLOR_NAMES = [
  "redMultiplier",
  "greenMultiplier",
  "blueMultiplier",
  "alphaMultiplier",
  "redOffset",
  "greenOffset",
  "blueOffset",
  "alphaOffset",
];

/** A native ColorTransform's values, or null for anything else. */
export function colorValues(o: Value): Float64Array | null {
  return o instanceof avm1.Avm1Object ? (colors.get(o) ?? null) : null;
}

function colorTransformClass(realm: avm1.Realm): Obj {
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      const values = Float64Array.of(1, 1, 1, 1, 0, 0, 0, 0);
      const copied = args.length === 1 ? colorValues(args[0]) : null;
      if (copied) {
        values.set(copied);
      } else if (args.length >= 8) {
        for (let i = 0; i < 8; i++) {
          values[i] = num(args[i], v);
        }
      }

      colors.set(self, values);
      return self;
    },
    () => undefined,
  );

  // Alpha first of each four, as Flash defines them: for..in lists them the other way.
  for (const i of [3, 0, 1, 2, 7, 4, 5, 6]) {
    const name = COLOR_NAMES[i];
    accessor(
      realm,
      proto,
      name,
      (self) => colors.get(self)?.[i],
      (self, args, v) => {
        const values = colors.get(self);
        if (values) {
          values[i] = num(args[0], v);
        }

        return undefined;
      },
    );
  }

  accessor(
    realm,
    proto,
    "rgb",
    (self) => {
      const c = colors.get(self);
      return c ? (((c[4] | 0) << 16) + ((c[5] | 0) << 8) + (c[6] | 0)) >>> 0 : undefined;
    },
    (self, args, v) => {
      const c = colors.get(self);
      if (c) {
        const rgb = num(args[0], v) >>> 0;
        c.set([0, 0, 0], 0);
        c[4] = (rgb >>> 16) & 0xff;
        c[5] = (rgb >>> 8) & 0xff;
        c[6] = rgb & 0xff;
      }

      return undefined;
    },
  );
  proto.define(
    "concat",
    realm.method((self, args) => {
      const c = colors.get(self);
      const o = colorValues(args[0]);
      if (c && o) {
        for (let i = 0; i < 4; i++) {
          c[4 + i] = o[4 + i] * c[i] + c[4 + i];
          c[i] *= o[i];
        }
      }

      return undefined;
    }),
    0,
  );
  proto.define(
    "toString",
    realm.method((self, _, v) => described(self, COLOR_NAMES, v)),
    0,
  );
  return constr;
}

/** A Transform's clip, by its AVM1 object, read again as it is used, as Ruffle's MovieClipReference is. */
const transforms = new WeakMap<Obj, Obj>();

/** What a clip's AVM1 object, or a Transform's, is the face of; null for anything else. */
function displayOf(o: Value): DisplayObject | null {
  const face = o instanceof avm1.Avm1Object ? (transforms.get(o) ?? o) : null;
  const target = face?.display?.target;
  return target === undefined ? null : (target as DisplayObject);
}

/** `d`'s matrix as a new Matrix, in pixels. */
function matrixObject(
  host: GeomHost,
  m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
  v: number,
): Value {
  return makeGeom(host.realm, "Matrix", [m.a, m.b, m.c, m.d, m.tx, m.ty], v);
}

function colorObject(host: GeomHost, c: avm1.Value[] | null, v: number): Value {
  return makeGeom(host.realm, "ColorTransform", c ?? [1, 1, 1, 1, 0, 0, 0, 0], v);
}

/** A 16-bit integer, wrapped, as a clip's colour transform keeps each value. */
const int16 = (n: number) => ((n | 0) << 16) >> 16;

/** A multiplier as a clip keeps it, in 8.8 fixed point, 16 bits. */
const fixed8 = (n: number) => int16(Math.trunc(n * 256)) / 256;

/** An offset as a clip keeps it: whole, 16 bits (-66682.5 is -1147). */
const offset16 = (n: number) => int16(Math.floor(n));

/** A display object's colour transform as ColorTransform's eight values. */
function colorArgs(d: DisplayObject): number[] {
  const c = d.colorTransform;
  return c
    ? [c.rMul, c.gMul, c.bMul, c.aMul, c.rAdd, c.gAdd, c.bAdd, c.aAdd]
    : [1, 1, 1, 1, 0, 0, 0, 0];
}

/** `matrix` set on `d` where it has all six fields of its own: whole twips, as Flash keeps the translation. */
export function setDisplayMatrix(d: DisplayObject, matrix: Value, v: number): void {
  if (
    !(matrix instanceof avm1.Avm1Object) ||
    MATRIX_NAMES.some((n) => matrix.own(n, v) === undefined)
  ) {
    return;
  }

  const [a, b, c, dd, tx, ty] = matrixOf(matrix, v);
  d.setMatrix({ a, b, c, d: dd, tx: Math.round(tx * 20) / 20, ty: Math.round(ty * 20) / 20 });
  d.touch();
  d.invalidate(TRANSFORM);
}

/**
 * A native ColorTransform's values set as `d`'s colour transform, as a
 * clip keeps them: the multipliers in 8.8 fixed point, the offsets whole,
 * each 16 bits, wrapped (the corpus's `transform`: -66682.5 is -1147).
 */
export function setDisplayColor(d: DisplayObject, color: Value): void {
  const c = colorValues(color);
  if (c === null) {
    return;
  }

  d.colorTransform = {
    rMul: fixed8(c[0]),
    gMul: fixed8(c[1]),
    bMul: fixed8(c[2]),
    aMul: fixed8(c[3]),
    rAdd: offset16(c[4]),
    gAdd: offset16(c[5]),
    bAdd: offset16(c[6]),
    aAdd: offset16(c[7]),
  };
  d.touch();
  d.invalidate(TRANSFORM);
}

function transformClass(host: GeomHost): Obj {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args) => {
      // Of exactly one clip; otherwise `new` gives undefined.
      if (args.length !== 1 || displayOf(args[0]) === null || transforms.has(args[0] as Obj)) {
        return undefined;
      }

      transforms.set(self, args[0] as Obj);
      return self;
    },
    () => undefined,
  );
  const clip = (self: Obj) => (transforms.has(self) ? displayOf(self) : null);

  accessor(
    realm,
    proto,
    "matrix",
    (self, _, v) => {
      const d = clip(self);
      return d ? matrixObject(host, d.matrix, v) : undefined;
    },
    (self, args, v) => {
      const d = clip(self);
      if (d) {
        setDisplayMatrix(d, args[0], v);
      }

      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "colorTransform",
    (self, _, v) => {
      const d = clip(self);
      return d ? colorObject(host, colorArgs(d), v) : undefined;
    },
    (self, args) => {
      const d = clip(self);
      if (d) {
        setDisplayColor(d, args[0]);
      }

      return undefined;
    },
  );
  accessor(
    realm,
    proto,
    "concatenatedMatrix",
    (self, _, v) => {
      const d = clip(self);
      return d ? matrixObject(host, toStage(d, host.stageOf(d)), v) : undefined;
    },
    null,
  );
  accessor(
    realm,
    proto,
    "concatenatedColorTransform",
    (self, _, v) => {
      const d = clip(self);
      if (!d) {
        return undefined;
      }

      // Each ancestor's applied after what is in it, each product kept as a clip keeps a
      // colour transform (the corpus's `transform`).
      let c = colorArgs(d);
      for (let p = d.parent; p !== null; p = p.parent) {
        const o = colorArgs(p);
        c = [
          fixed8(c[0] * o[0]),
          fixed8(c[1] * o[1]),
          fixed8(c[2] * o[2]),
          fixed8(c[3] * o[3]),
          offset16(c[4] * o[0] + o[4]),
          offset16(c[5] * o[1] + o[5]),
          offset16(c[6] * o[2] + o[6]),
          offset16(c[7] * o[3] + o[7]),
        ];
      }

      return colorObject(host, c, v);
    },
    null,
  );
  accessor(
    realm,
    proto,
    "pixelBounds",
    (self, _, v) => {
      const d = clip(self);
      if (!d) {
        return undefined;
      }

      const r = bounds(d, true);
      const m = toStage(d, host.stageOf(d));
      if (r === null) {
        return makeGeom(realm, "Rectangle", [0, 0, 0, 0], v);
      }

      const xs = [r.xMin, r.xMax].flatMap((x) =>
        [r.yMin, r.yMax].map((y) => m.a * x + m.c * y + m.tx),
      );
      const ys = [r.xMin, r.xMax].flatMap((x) =>
        [r.yMin, r.yMax].map((y) => m.b * x + m.d * y + m.ty),
      );
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return makeGeom(
        realm,
        "Rectangle",
        [left, top, Math.max(...xs) - left, Math.max(...ys) - top],
        v,
      );
    },
    null,
  );
  return constr;
}

/** A clip's `transform`: a new Transform of it each read, as Flash gives one. */
export function transformOf(host: GeomHost, face: Obj, v: number): Value {
  return makeGeom(host.realm, "Transform", [face], v);
}

/** `clip.transform = t`: the matrix and colour transform of the clip `t` is a Transform of. */
export function assignTransform(d: DisplayObject, t: Value): void {
  const from = t instanceof avm1.Avm1Object && transforms.has(t) ? displayOf(t) : null;
  if (from === null) {
    return;
  }

  const m = from.matrix;
  d.setMatrix({ a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty });
  d.colorTransform = from.colorTransform ? { ...from.colorTransform } : null;
  d.touch();
  d.invalidate(TRANSFORM);
}

/**
 * `_global.flash`, from SWF 8, with `geom`'s classes; `display` waits for
 * BitmapData. Its members are plain properties, as Flash's.
 */
export function flashPackage(host: GeomHost): Obj {
  const realm = host.realm;
  const flash = new avm1.Avm1Object(realm.objectProto);
  const geom = new avm1.Avm1Object(realm.objectProto);
  const display = new avm1.Avm1Object(realm.objectProto);
  flash.define("geom", geom, 0);
  flash.define("display", display, 0);
  geom.define("Point", pointClass(realm), 0);
  geom.define("Rectangle", rectangleClass(realm), 0);
  geom.define("Matrix", matrixClass(realm), 0);
  geom.define("ColorTransform", colorTransformClass(realm), 0);
  geom.define("Transform", transformClass(host), 0);
  realm.global.define("flash", flash, avm1.DONT_ENUM | avm1.VERSION_8);
  return flash;
}
