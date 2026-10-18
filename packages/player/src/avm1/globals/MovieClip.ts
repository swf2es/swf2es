// MovieClip's AS2 face over the player's display objects (docs/avm1.md,
// "Hosting AVM1 objects"): a clip's, a button's or a text field's AVM1
// object finds its children by name, `_root`, `_parent` and `_levelN`, and
// the display properties `_x` to `_ymouse`, after its own properties; and
// MovieClip's methods, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/object/stage_object.rs and globals/movie_clip.rs have them:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. Where adl parts from Ruffle, adl decides (docs/avm1.md,
// "Clips and paths").

import type { Matrix } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import type { BitmapStore } from "../../bitmap/bitmap.js";
import { bounds, hitsObject, hitsPoint, toStage } from "../../display/bounds.js";
import {
  ButtonObject,
  type DisplayObject,
  MovieClip,
  TextObject,
  TRANSFORM,
} from "../../display/display.js";
import { apply, contains, invert, type Rect, transformRect } from "../../display/geometry.js";
import { asciiLower, childByName, pathOf, slashPathOf } from "../paths.js";
import type { Avm1Swf, Handler } from "../swf.js";
import { blendModeOf, storeOf } from "./BitmapData.js";
import { type FilterFaces, filtersProperty } from "./filters.js";
import { assignTransform, type GeomHost, transformOf } from "./geom.js";
import { formVars } from "./LoadVars.js";

type Value = avm1.Value;

/** What the clips' AVM1 faces ask of the player's AVM1 (avm1.ts). */
export interface Movie extends GeomHost {
  /** Level 0's clip. */
  readonly root: MovieClip;
  readonly realm: avm1.Realm;
  /** The main SWF's version. */
  readonly version: number;
  /**
   * The SWF `d` is of, the nearest clip's: its version, URL and length,
   * which `getSWFVersion`, `_url` and `getBytesTotal` give, and its root.
   */
  swfOf(d: DisplayObject | null): Avm1Swf;
  /**
   * `_root` for code of `d`'s: its level, or the first clip up from it whose
   * `_lockroot` is set.
   */
  rootOf(d: DisplayObject): MovieClip;
  /** The level `d` is, null for none. */
  levelOf(d: DisplayObject): number | null;
  /** Level `n`'s clip, null where there is none. */
  level(n: number): MovieClip | null;
  /** The stage's quality, "LOW" to "BEST". */
  quality: string;
  /** The stage's focus rectangle's, `_focusrect` up to SWF 5 and on the root. */
  focusRect: boolean;
  soundBufferTime: number;
  /**
   * Whether getBounds has switched the invalid bounds it gives in another
   * clip's space to 6710886.4, which it does for good once code of SWF 8 or
   * later calls it, or any code under a root of SWF 8 or later.
   */
  newInvalidBounds: boolean;
  /** The filter objects `filters` reads, once flash.filters is made. */
  readonly filterFaces: FilterFaces | null;
  /** The pointer's position on the stage. */
  readonly mouseX: number;
  readonly mouseY: number;
  /** The screen's pixels to a stage pixel, which `_xmouse` is measured in. */
  readonly pixelRatio: number;
  /** What `d` was last dragged over, its `_droptarget`; null for nothing. */
  dropTargetOf(d: DisplayObject): DisplayObject | null;
  /** `d` hidden by its `_visible`: the focus, if it has it, goes. */
  hidden(d: DisplayObject): void;
  /** attachBitmap: `store` shown in `parent` at AVM1 depth `depth`. */
  attachBitmap(parent: MovieClip, store: BitmapStore, depth: number, smoothing: boolean): void;
  /** startDrag: `d` follows the pointer, within `bounds` (left, top, right, bottom) where given. */
  startDrag(d: DisplayObject, lockCenter: boolean, bounds: number[] | null): void;
  stopDrag(): void;
  faceOf(d: DisplayObject): avm1.Avm1Object | null;
  /** Whether `d` was removed from the display list, its AVM1 object a reference by path from then on. */
  removed(d: DisplayObject): boolean;
  /** The display object at a path now, as a removed clip's reference finds one again. */
  atPath(path: string): DisplayObject | null;
  /** What timeline actions do to `clip`. */
  timeline(clip: MovieClip): avm1.Timeline;
  /** attachMovie: the character exported as `name` placed as `instance` at AVM1 depth `depth`. */
  attachMovie(
    parent: MovieClip,
    name: string,
    instance: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject | null;
  /** createEmptyMovieClip: an empty clip as `instance` at AVM1 depth `depth`. */
  createEmptyMovieClip(parent: MovieClip, instance: string, depth: number): DisplayObject;
  /** createTextField: an empty text field as `instance` at AVM1 depth `depth`, at (x, y), width by height. */
  createTextField(
    parent: MovieClip,
    instance: string,
    depth: number,
    rect: [x: number, y: number, width: number, height: number],
  ): DisplayObject;
  /** duplicateMovieClip: `d` again as `name` at timeline depth `depth`. */
  duplicate(
    d: DisplayObject,
    name: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject | null;
  /** removeMovieClip: `d` removed, where a script may remove it. */
  remove(d: DisplayObject): void;
  /** A property of `d`'s AVM1 object set, which a text field bound to it shows. */
  propertyChanged(d: DisplayObject, name: string, value: Value, version: number): void;
  /** loadVariables: the variables at `url` set on `d`, `form`'s sent with them. */
  loadVariables(d: DisplayObject, url: string, form: avm1.UrlForm | null): void;
  /** loadMovie: the SWF or image at `url` into `d`, `form`'s variables sent with the request. */
  loadMovie(d: DisplayObject | number, url: string, form: avm1.UrlForm | null): void;
  /** unloadMovie: what `d` shows unloaded, and it left empty. */
  unloadMovie(d: DisplayObject): void;
}

/** AVM1's depths are the timeline's less this, as Flash gives them to scripts. */
export const DEPTH_BIAS = 16384;

/** A number cast to an int as x86 casts one: cut toward zero, NaN and what does not fit -2^31. */
const castInt = (n: number): number =>
  n > -2147483649 && n < 2147483648 ? Math.trunc(n) : -2147483648;

/** A pixel value in whole twips, as Flash keeps positions. */
const twips = (px: number): number => castInt(px * 20);

/** A value as a property set takes it: a number, or none for undefined, null or NaN, which leave the property be. */
function numberOf(value: Value, version: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const n = avm1.toNumber(value, version);
  return Number.isNaN(n) ? null : n;
}

/** An object's width and height in its parent's space, in twips as Flash reports them. */
function size(d: DisplayObject): [number, number] {
  const r = twipsBounds(d, twipsMatrix(d.placed));
  return r === null ? [0, 0] : [(r.xMax - r.xMin) / 20, (r.yMax - r.yMin) / 20];
}

/** Move a display object, by a copy of its matrix, and have it drawn again. */
function moveTo(d: DisplayObject, x: number | null, y: number | null): void {
  d.touch();
  d.matrix = { ...d.matrix, tx: x ?? d.matrix.tx, ty: y ?? d.matrix.ty };
  d.invalidate(TRANSFORM);
}

/** A property: its getter, and its setter, null for a read-only one. */
interface DisplayProperty {
  get(face: ClipNative, version: number): Value;
  set: ((face: ClipNative, value: Value, version: number) => void) | null;
}

/** An alpha as Flash keeps it, an 8.8 multiplier: the percentage's 256ths cut toward zero, in 16 bits. */
function alphaOf(percent: number): number {
  const n = castInt(percent * 2.56);
  return (n << 16) >> 16;
}

/**
 * The display properties, in GetProperty's and SetProperty's order: `_x`
 * is 0, `_ymouse` 21.
 */
const PROPERTIES: [string, DisplayProperty][] = [
  [
    "_x",
    {
      get: (f) => f.target.matrix.tx,
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          moveTo(f.target, twips(n) / 20, null);
        }
      },
    },
  ],
  [
    "_y",
    {
      get: (f) => f.target.matrix.ty,
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          moveTo(f.target, null, twips(n) / 20);
        }
      },
    },
  ],
  [
    "_xscale",
    {
      get: (f) =>
        f.xscale !== null && f.target.scaleX === clampScale(f.xscale / 100)
          ? f.xscale
          : f.target.scaleX * 100,
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          f.target.touch();
          setScaleX(f, n / 100);
        }
      },
    },
  ],
  [
    "_yscale",
    {
      get: (f) =>
        f.yscale !== null && f.target.scaleY === clampScale(f.yscale / 100)
          ? f.yscale
          : f.target.scaleY * 100,
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          f.target.touch();
          setScaleY(f, n / 100);
        }
      },
    },
  ],
  [
    "_currentframe",
    { get: (f) => (f.target instanceof MovieClip ? f.target.currentFrame : undefined), set: null },
  ],
  [
    "_totalframes",
    { get: (f) => (f.target instanceof MovieClip ? f.target.totalFrames : undefined), set: null },
  ],
  [
    "_alpha",
    {
      get: (f) => (f.target.colorTransform?.aMul ?? 1) * 100,
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          const d = f.target;
          d.touch();
          const aMul = Number.isFinite(n) ? alphaOf(n) / 256 : 0;
          d.colorTransform = { ...(d.colorTransform ?? IDENTITY_COLOR), aMul };
          d.invalidate(TRANSFORM);
        }
      },
    },
  ],
  [
    "_visible",
    {
      get: (f) => f.target.visible,
      set(f, value, version) {
        // A number, as in Flash 4: "false" is NaN, which leaves it be.
        const n = numberOf(value, version);
        if (n !== null) {
          f.target.visible = n !== 0;
          f.target.invalidate(TRANSFORM);
          if (n === 0) {
            f.movie.hidden(f.target);
          }
        }
      },
    },
  ],
  [
    "_width",
    {
      get: (f) => size(f.target)[0],
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          setSize(f, n, true);
        }
      },
    },
  ],
  [
    "_height",
    {
      get: (f) => size(f.target)[1],
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          setSize(f, n, false);
        }
      },
    },
  ],
  [
    "_rotation",
    {
      get: (f) => f.target.rotation,
      set(f, value, version) {
        const n = numberOf(value, version);
        if (n !== null) {
          f.target.touch();
          f.target.setRotation(n);
        }
      },
    },
  ],
  ["_target", { get: (f) => slashPathOf(f.target, (d) => f.movie.levelOf(d)), set: null }],
  [
    "_framesloaded",
    {
      // -1 for a load's root in error, which has -1 bytes.
      get: (f) => {
        if (!(f.target instanceof MovieClip)) {
          return undefined;
        }

        const swf = f.movie.swfOf(f.target);
        return swf.root === f.target && swf.length < 0 ? -1 : f.target.totalFrames;
      },
      set: null,
    },
  ],
  [
    "_name",
    {
      get: (f) => f.target.name,
      set(f, value, version) {
        f.target.name = avm1.stringOf(
          version >= 7 && typeof value === "number" && Number.isNaN(value) ? 0 : value,
          version,
        );
      },
    },
  ],
  [
    "_droptarget",
    {
      // The slash path of what it was last dragged over; "" for nothing, in every version (adl;
      // Ruffle: undefined up to SWF 5).
      get: (f) => {
        const over = f.movie.dropTargetOf(f.target);
        return over === null ? "" : slashPathOf(over, (d) => f.movie.levelOf(d));
      },
      set: null,
    },
  ],
  ["_url", { get: (f) => f.movie.swfOf(f.target).url, set: null }],
  [
    "_highquality",
    {
      get: (f) => (f.movie.quality === "BEST" ? 2 : f.movie.quality === "LOW" ? 0 : 1),
      set(f, value, version) {
        if (value === undefined || value === null) {
          return;
        }

        const n = avm1.toNumber(value, version);
        if (!Number.isNaN(n)) {
          f.movie.quality = n > 1.5 ? "BEST" : n === 0 ? "LOW" : "HIGH";
        }
      },
    },
  ],
  [
    "_focusrect",
    {
      get(f, version) {
        if (version <= 5) {
          return f.movie.focusRect ? 1 : 0;
        }

        return f.target === f.movie.root ? f.movie.focusRect : (f.focusRect ?? null);
      },
      set(f, value, version) {
        if (version <= 5 || f.target === f.movie.root) {
          if (value === undefined || value === null) {
            return;
          }

          const n = value instanceof avm1.Avm1Object ? 0 : avm1.toNumber(value, version);
          if (!Number.isNaN(n)) {
            f.movie.focusRect = n !== 0;
          }
        } else {
          f.focusRect =
            value === undefined || value === null ? null : avm1.toBoolean(value, version);
        }
      },
    },
  ],
  [
    "_soundbuftime",
    {
      get: (f) => f.movie.soundBufferTime,
      set(f, value, version) {
        if (value === undefined || value === null) {
          return;
        }

        const n = avm1.toNumber(value, version);
        if (!Number.isNaN(n)) {
          f.movie.soundBufferTime = castInt(n);
        }
      },
    },
  ],
  [
    "_quality",
    {
      get: (f) => f.movie.quality,
      set(f, value, version) {
        const quality = avm1.stringOf(value, version).toUpperCase();
        if (QUALITIES.includes(quality)) {
          f.movie.quality = quality;
        }
      },
    },
  ],
  ["_xmouse", { get: (f) => mouse(f.target, f.movie)[0], set: null }],
  ["_ymouse", { get: (f) => mouse(f.target, f.movie)[1], set: null }],
];

const QUALITIES = ["LOW", "MEDIUM", "HIGH", "BEST"];

/** A clip's colour transform where it has none. */
export const IDENTITY_COLOR = {
  rMul: 1,
  gMul: 1,
  bMul: 1,
  aMul: 1,
  rAdd: 0,
  gAdd: 0,
  bAdd: 0,
  aAdd: 0,
};

/** The display properties by name in lower case, which they are found by in any case. */
const BY_NAME = new Map(PROPERTIES.map(([name, p]) => [name, p]));

/**
 * The pointer in `d`'s space, as Flash gives it (Ruffle's
 * local_mouse_position): through the matrix from `d`'s twips to the
 * screen's pixels (`pixelRatio` of them a stage pixel), whose translation
 * a matrix keeps whole, so a whole pixel, and back to whole twips, each
 * rounded half to even; where that matrix cannot be inverted, as for a
 * clip scaled to nothing, the pointer's pixels are taken as twips (the
 * corpus's `mouse_pos`).
 */
function mouse(d: DisplayObject, movie: Movie): [number, number] {
  const m = toStage(d, movie.root.parent);
  const ratio = movie.pixelRatio;
  const px = movie.mouseX * ratio;
  const py = movie.mouseY * ratio;
  const device = {
    a: (m.a * ratio) / 20,
    b: (m.b * ratio) / 20,
    c: (m.c * ratio) / 20,
    d: (m.d * ratio) / 20,
    tx: roundEven(m.tx * ratio),
    ty: roundEven(m.ty * ratio),
  };
  const back = invert(device);
  if (back === null) {
    return [roundEven(px) / 20, roundEven(py) / 20];
  }

  const x = back.a * px + back.c * py + roundEven(back.tx);
  const y = back.b * px + back.d * py + roundEven(back.ty);
  return [roundEven(x) / 20, roundEven(y) / 20];
}

/**
 * The largest scale Flash's matrix holds, either way: a larger `_xscale`
 * or `_yscale` is given back as set but draws at this (adl).
 */
const MAX_SCALE = 32768;

const clampScale = (s: number): number => Math.max(-MAX_SCALE, Math.min(MAX_SCALE, s));

/** `_xscale` set, as a fraction: kept as set, the matrix's clamped. */
function setScaleX(f: ClipNative, s: number): void {
  f.target.setScaleX(clampScale(s));
  f.xscale = s * 100;
}

function setScaleY(f: ClipNative, s: number): void {
  f.target.setScaleY(clampScale(s));
  f.yscale = s * 100;
}

/**
 * `_width` or `_height` set, as adl sets them: the bounds of the object's
 * own content turned by its rotation, unscaled, in whole twips, are the
 * base; the side set scales to the value over its base, the other to its
 * size now over its base, both positive. A negative value changes nothing.
 */
function setSize(f: ClipNative, value: number, horizontal: boolean): void {
  if (value < 0) {
    return;
  }

  const d = f.target;
  d.touch();
  // A field's own size is the value, in whole twips, whatever its scale (the corpus's
  // `movieclip_create_text_field` and `edittext_width_height`).
  if (d instanceof TextObject) {
    if (horizontal) {
      d.width = twips(value) / 20;
    } else {
      d.height = twips(value) / 20;
    }

    d.fit();
    return;
  }

  const r = twipsBounds(d, null);
  const width = r === null ? 0 : r.xMax - r.xMin;
  const height = r === null ? 0 : r.yMax - r.yMin;
  const radians = ((d.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const baseWidth = Math.round(cos * width + sin * height) / 20;
  const baseHeight = Math.round(sin * width + cos * height) / 20;
  const [w, h] = size(d);
  const sx = baseWidth !== 0 ? (horizontal ? value : w) / baseWidth : 0;
  const sy = baseHeight !== 0 ? (horizontal ? h : value) / baseHeight : 0;
  setScaleX(f, sx);
  setScaleY(f, sy);
}

/** A number rounded to the nearest whole one, a half to the even one, as Rust's round_ties_even. */
function roundEven(n: number): number {
  const r = Math.round(n);
  return Math.abs(n % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * A matrix as Flash keeps one: a, b, c and d single floats, the
 * translation in whole twips; Ruffle's render/src/matrix.rs.
 */
interface TwipsMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

const f32 = Math.fround;

/** `m`, in pixels, as Flash keeps it. */
const twipsMatrix = (m: Matrix): TwipsMatrix => ({
  a: f32(m.a),
  b: f32(m.b),
  c: f32(m.c),
  d: f32(m.d),
  tx: Math.round(m.tx * 20),
  ty: Math.round(m.ty * 20),
});

/** A single float rounded to an int, a half to the even one, out of range -2^31, NaN 0 (Ruffle's round_to_i32). */
function roundInt(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }

  return n < 2147483648 ? roundEven(n) | 0 : -2147483648;
}

/** `m` then `n`, a child's matrix then its parent's, as Flash concatenates them. */
function concatTwips(n: TwipsMatrix, m: TwipsMatrix): TwipsMatrix {
  return {
    a: f32(f32(n.a * m.a) + f32(n.c * m.b)),
    b: f32(f32(n.b * m.a) + f32(n.d * m.b)),
    c: f32(f32(n.a * m.c) + f32(n.c * m.d)),
    d: f32(f32(n.b * m.c) + f32(n.d * m.d)),
    tx: roundInt(f32(f32(n.a * m.tx) + f32(n.c * m.ty))) + n.tx,
    ty: roundInt(f32(f32(n.b * m.tx) + f32(n.d * m.ty))) + n.ty,
  };
}

/** `d`'s matrix to the stage's space, as Flash's local_to_global_matrix. */
function toStageTwips(d: DisplayObject, stage: DisplayObject | null): TwipsMatrix {
  let m = twipsMatrix(d.placed);
  for (let p = d.parent; p !== null && p !== stage; p = p.parent) {
    m = concatTwips(twipsMatrix(p.placed), m);
  }

  return m;
}

/** The inverse of `m`, null for a singular one (Ruffle's Matrix::inverse). */
function invertTwips(m: TwipsMatrix): TwipsMatrix | null {
  const det = f32(f32(m.a * m.d) - f32(m.b * m.c));
  if (!(Math.abs(det) > 1.1920929e-7)) {
    return null;
  }

  return {
    a: f32(m.d / det),
    b: f32(m.b / -det),
    c: f32(m.c / -det),
    d: f32(m.a / det),
    tx: roundInt(f32(f32(f32(m.d * m.tx) - f32(m.c * m.ty)) / -det)),
    ty: roundInt(f32(f32(f32(m.b * m.tx) - f32(m.a * m.ty)) / det)),
  };
}

/** A point in twips through `m`, rounded to twips as Flash's matrices do. */
function transformTwips(m: TwipsMatrix, x: number, y: number): [number, number] {
  return [
    roundInt(f32(f32(m.a * x) + f32(m.c * y))) + m.tx,
    roundInt(f32(f32(m.b * x) + f32(m.d * y))) + m.ty,
  ];
}

/**
 * `d`'s bounds in twips, its own (`m` null) or through matrix `m`, each
 * corner rounded to twips; null for an object with nothing in it.
 */
function twipsBounds(d: DisplayObject, m: TwipsMatrix | null, lines = true): Rect | null {
  const r = bounds(d, lines);
  if (r === null) {
    return null;
  }

  const xMin = Math.round(r.xMin * 20);
  const yMin = Math.round(r.yMin * 20);
  const xMax = Math.round(r.xMax * 20);
  const yMax = Math.round(r.yMax * 20);
  if (m === null) {
    return { xMin, yMin, xMax, yMax };
  }

  const corners = [
    transformTwips(m, xMin, yMin),
    transformTwips(m, xMin, yMax),
    transformTwips(m, xMax, yMin),
    transformTwips(m, xMax, yMax),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys),
  };
}

/** `name` among the path properties: `_root`, `_parent`, `_global` from SWF 6, `_levelN` and `_flashN`. */
function pathProperty(face: ClipNative, name: string, version: number): Value | typeof avm1.ABSENT {
  if (version < 5) {
    return avm1.ABSENT;
  }

  const key = version > 6 ? name : asciiLower(name);
  const movie = face.movie;
  switch (key) {
    case "_root":
      return movie.faceOf(movie.rootOf(face.target)) ?? undefined;
    case "_parent": {
      const parent = movie.levelOf(face.target) !== null ? null : face.target.parent;
      return parent === null ? undefined : (movie.faceOf(parent) ?? undefined);
    }
    case "_global":
      return version >= 6 ? movie.realm.global : avm1.ABSENT;
  }

  if (!key.startsWith("_level") && !key.startsWith("_flash")) {
    return avm1.ABSENT;
  }

  const level = movie.level(levelOf(key.slice(6)));
  return level === null ? undefined : (movie.faceOf(level) ?? undefined);
}

/** `_levelN`'s N as Flash reads it: a sign and the digits up to anything else, wrapping. */
function levelOf(digits: string): number {
  const negative = digits.charCodeAt(0) === 0x2d;
  let n = 0;
  for (let i = negative ? 1 : 0; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - 0x30;
    if (d < 0 || d > 9) {
      break;
    }

    n = (Math.imul(n, 10) + d) | 0;
  }

  return negative ? -n | 0 : n;
}

/** `d`'s AVM1 side, null for one without. */
export function nativeOf(d: DisplayObject): ClipNative | null {
  const native = d.avm1?.display;
  return native instanceof ClipNative ? native : null;
}

/** A display object's side of its AVM1 object (runtime's DisplayNative). */
export class ClipNative implements avm1.DisplayNative {
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ClipNative(${this.target.name})`;
  }

  readonly type: string;
  /** `_xscale` and `_yscale` as last set, given back as set while the scale is still theirs. */
  xscale: number | null = null;
  yscale: number | null = null;
  /** A clip's own `_focusrect` from SWF 6, null for the stage's. */
  focusRect: boolean | null = null;
  /** Where it was as it was removed, the path its references find a clip at from then on. */
  removedAt: string | null = null;
  /** A clip's clip actions, from its place or the clip it duplicates; null for none. */
  handlers: Handler[] | null = null;
  /** The events of clip actions Flash could not read, which stop the SWF as one comes. */
  corrupt = 0;
  /** Whether a clip's load came, on its first frame. */
  loaded = false;
  /** Whether its unload came. */
  unloaded = false;
  /** Whether it was removed with an unload handler, and stays until the next frame. */
  pending = false;
  /** The SWF whose blocks its clip actions are, its place's. */
  swf: Avm1Swf | null = null;
  /** `_lockroot`: whether it is `_root` for the code in it, as a SWF loaded into it has it. */
  lockroot = false;

  constructor(
    readonly movie: Movie,
    readonly target: DisplayObject,
  ) {
    this.type = target instanceof MovieClip ? "movieclip" : "object";
  }

  get(name: string, version: number): Value | typeof avm1.ABSENT {
    // Ruffle's stage_object.rs: the path properties, then children, then the display properties.
    const magic = name.charCodeAt(0) === 0x5f;
    if (magic) {
      const p = pathProperty(this, name, version);
      if (p !== avm1.ABSENT) {
        return p;
      }
    }

    const child = childByName(this.target, name, version > 6);
    if (child !== null) {
      // An object without an AVM1 object of its own, a shape's, is its parent's.
      return this.movie.faceOf(child) ?? this.movie.faceOf(this.target) ?? undefined;
    }

    if (magic) {
      const property = BY_NAME.get(asciiLower(name));
      if (property !== undefined) {
        return property.get(this, version);
      }
    }

    return avm1.ABSENT;
  }

  set(name: string, value: Value, version: number): boolean {
    if (name.charCodeAt(0) !== 0x5f) {
      return false;
    }

    const property = BY_NAME.get(asciiLower(name));
    if (property === undefined) {
      return false;
    }

    property.set?.(this, value, version);
    return true;
  }

  changed(name: string, value: Value, version: number): void {
    this.movie.propertyChanged(this.target, name, value, version);
  }

  keys(out: string[]): void {
    const d = this.target;
    if (d instanceof MovieClip || d instanceof ButtonObject) {
      const children = d.children;
      for (let i = children.length - 1; i >= 0; i--) {
        if (children[i].name !== "") {
          out.push(children[i].name);
        }
      }
    }
  }

  path(): string {
    return pathOf(this.target, (d) => this.movie.levelOf(d));
  }

  live(): avm1.Avm1Object | null {
    if (!this.movie.removed(this.target)) {
      return this.movie.faceOf(this.target);
    }

    const path = this.removedAt;
    const d = path === null ? null : this.movie.atPath(path);
    return d === null || d === this.target ? null : this.movie.faceOf(d);
  }

  property(index: number, version: number): Value {
    const p = PROPERTIES[index];
    return p === undefined ? undefined : p[1].get(this, version);
  }

  setProperty(index: number, value: Value, version: number): boolean {
    const p = PROPERTIES[index];
    if (p === undefined) {
      return false;
    }

    if (p[1].set === null) {
      avm1Coerce(index, value, version);
    } else {
      p[1].set(this, value, version);
    }

    return true;
  }
}

/** A read-only property's value converted all the same, as SetProperty converts it. */
function avm1Coerce(index: number, value: Value, version: number): void {
  if (index <= 12 && value !== undefined && value !== null) {
    avm1.toNumber(value, version);
  } else if (index === 20 || index === 21) {
    avm1.toNumber(value, version);
  }
}

/** The display object of `self`, a clip's AVM1 object, where it is one's. */
function clipOf(self: Value): MovieClip | null {
  if (!(self instanceof avm1.Avm1Object) || self.display === null) {
    return null;
  }

  const live = self.display.live();
  const d = live?.display?.target;
  return d instanceof MovieClip ? d : null;
}

/** The bounds of `d` in `target`'s space, or the invalid ones of nothing, as an Object of xMin, xMax, yMin, yMax. */
function boundsObject(
  movie: Movie,
  d: DisplayObject,
  target: DisplayObject,
  lines: boolean,
  version: number,
): avm1.Avm1Object {
  let r: Rect | null;
  if (target === d) {
    r = twipsBounds(d, null, lines);
  } else {
    const stage = movie.root.parent;
    const up = toStageTwips(d, stage);
    const down = invertTwips(toStageTwips(target, stage));
    r = twipsBounds(d, down ? concatTwips(down, up) : up, lines);
  }

  if (!movie.newInvalidBounds && (version >= 8 || movie.version >= 8)) {
    movie.newInvalidBounds = true;
  }

  // Twips of nothing: one more in another clip's space once switched, as Flash.
  const none = target !== d && movie.newInvalidBounds ? 0x8000000 : 0x7ffffff;
  const o = movie.realm.newObject(version);
  avm1.set(o, "xMin", (r?.xMin ?? none) / 20, version);
  avm1.set(o, "xMax", (r?.xMax ?? none) / 20, version);
  avm1.set(o, "yMin", (r?.yMin ?? none) / 20, version);
  avm1.set(o, "yMax", (r?.yMax ?? none) / 20, version);
  return o;
}

/**
 * A display object's `blendMode` on its class's prototype, of `flags`: its
 * mode's name; one set that is none leaves it as it was (the corpus's
 * movieclip_blend_mode_property, adl for a button's).
 */
export function blendModeProperty(
  realm: avm1.Realm,
  proto: avm1.Avm1Object,
  flags: number,
  targetOf: (self: avm1.Avm1Object) => DisplayObject | null,
): void {
  const p = proto.add("blendMode", undefined, flags);
  p.get = realm.method((self) => targetOf(self)?.blendMode);
  p.set = realm.method((self, args) => {
    const d = targetOf(self);
    const mode = blendModeOf(args[0]);
    if (d !== null && mode !== null) {
      d.touch();
      d.setBlendMode(mode);
    }

    return undefined;
  });
}

/** The display object a method's argument names from `start`: a clip's AVM1 object, or a path. */
export function targetOf(
  movie: Movie,
  start: DisplayObject,
  value: Value,
  version: number,
): DisplayObject | null {
  if (value instanceof avm1.Avm1Object && value.display !== null) {
    return value.display.target as DisplayObject;
  }

  const path = avm1.stringOf(value, version);
  const from = movie.faceOf(start);
  const cx = movie.realm.current;
  if (path === "" || from === null || cx === null) {
    return null;
  }

  const object = avm1.targetPath(cx, from, path, true, false, version);
  const d = object?.display?.target;
  return d === undefined ? null : (d as DisplayObject);
}

/** A point's own stored x and y, numbers both, as localToGlobal reads them, null for anything else. */
function pointOf(value: Value): [avm1.Avm1Object, number, number] | null {
  if (!(value instanceof avm1.Avm1Object)) {
    return null;
  }

  const x = value.exact("x");
  const y = value.exact("y");
  if (
    x === undefined ||
    y === undefined ||
    typeof x.value !== "number" ||
    typeof y.value !== "number"
  ) {
    return null;
  }

  return [value, x.value, y.value];
}

/** MovieClip: its constructor and its prototype's methods, as `_global.MovieClip`. */
export function movieClipClass(movie: Movie): {
  constr: avm1.Avm1Function;
  proto: avm1.Avm1Object;
} {
  const realm = movie.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => self,
    () => undefined,
  );

  const method = (
    name: string,
    flags: number,
    fn: (clip: MovieClip, args: Value[], version: number) => Value,
  ) => {
    proto.define(
      name,
      realm.method((self, args, version) => {
        const clip = clipOf(self);
        return clip === null ? undefined : fn(clip, args, version);
      }),
      avm1.DONT_ENUM | avm1.DONT_DELETE | flags,
    );
  };

  proto.define("useHandCursor", true, avm1.DONT_ENUM);
  proto.define("enabled", true, avm1.DONT_ENUM);
  method("attachMovie", 0, (clip, args, version) => {
    if (args.length < 3) {
      return undefined;
    }

    const name = avm1.stringOf(args[0], version);
    const instance = avm1.stringOf(args[1], version);
    const depth = avm1.toNumber(args[2], version) | 0;
    const init = args.length > 3 && args[3] instanceof avm1.Avm1Object ? args[3] : null;
    const child = movie.attachMovie(clip, name, instance, depth, init);
    // A SWF 5 gets nothing back, as from duplicateMovieClip (adl).
    return version < 6 || child === null ? undefined : (movie.faceOf(child) ?? undefined);
  });
  method("swapDepths", 0, (clip, args, version) => {
    swapDepths(movie, clip, args[0], version);
    return undefined;
  });
  method("localToGlobal", 0, (clip, args, version) => {
    const p = pointOf(args[0]);
    if (p !== null) {
      const m = toStageTwips(clip, movie.root.parent);
      const [x, y] = transformTwips(m, twips(p[1]), twips(p[2]));
      avm1.set(p[0], "x", x / 20, version);
      avm1.set(p[0], "y", y / 20, version);
    }

    return undefined;
  });
  method("globalToLocal", 0, (clip, args, version) => {
    const p = pointOf(args[0]);
    if (p !== null) {
      const m = invertTwips(toStageTwips(clip, movie.root.parent));
      const [x, y] = m ? transformTwips(m, twips(p[1]), twips(p[2])) : [twips(p[1]), twips(p[2])];
      avm1.set(p[0], "x", x / 20, version);
      avm1.set(p[0], "y", y / 20, version);
    }

    return undefined;
  });
  method("hitTest", 0, (clip, args, version) => {
    if (args.length > 1) {
      const x = avm1.toNumber(args[0], version);
      const y = avm1.toNumber(args[1], version);
      const shape = args.length > 2 && avm1.toBoolean(args[2], version);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        // In the root's space, which may have moved; without the shape, in the
        // box around the clip on the stage (Ruffle's hit_test_bounds).
        const stage = movie.root.parent;
        const [sx, sy] = apply(toStage(movie.root, stage), x, y);
        if (shape) {
          return hitsPoint(clip, sx, sy, true, stage);
        }

        const r = bounds(clip, true);
        return r !== null && contains(transformRect(r, toStage(clip, stage)), sx, sy);
      }

      return false;
    }

    if (args.length === 1) {
      const other = targetOf(movie, clip, args[0], version);
      return other !== null && hitsObject(clip, other, movie.root.parent);
    }

    return false;
  });
  // A snapshot of this clip by whatever TextSnapshot is on _global now.
  method("getTextSnapshot", 0, (clip, _, version) =>
    realm.construct(
      avm1.get(realm.global, "TextSnapshot", version),
      [movie.faceOf(clip) ?? undefined],
      version,
    ),
  );
  method("getBounds", 0, (clip, args, version) => {
    const target = args.length > 0 ? targetOf(movie, clip, args[0], version) : clip;
    return target === null ? undefined : boundsObject(movie, clip, target, true, version);
  });
  // A sprite's are its tags', a SWF's root's the SWF's.
  const bytes = (clip: MovieClip) => {
    const swf = movie.swfOf(clip);
    return clip === swf.root ? swf.length : (clip.timeline.length ?? 0);
  };
  method("getBytesTotal", 0, bytes);
  // A load in error has -1 bytes in all, none loaded (the corpus's movieclip_state_values).
  method("getBytesLoaded", 0, (clip) => Math.max(0, bytes(clip)));
  // The root is level 0's, at depth 0 (the corpus's movieclip_get_instance_at_depth).
  method("getDepth", avm1.READ_ONLY | avm1.VERSION_6, (clip) =>
    clip.depth !== null ? clip.depth - DEPTH_BIAS : clip === movie.root ? -DEPTH_BIAS : undefined,
  );
  // The SWF at the URL in place of what the clip shows, the clip's own variables sent where
  // a method is "GET" or "POST", in any case (Ruffle's load_movie).
  method("loadMovie", 0, (clip, args, version) => {
    const face = clip.avm1;
    if (face === null) {
      return undefined;
    }

    const url = avm1.stringOf(args[0], version);
    const method = args.length > 1 ? avm1.stringOf(args[1], version).toUpperCase() : "";
    const form: avm1.UrlForm | null =
      method === "GET" || method === "POST" ? { method, vars: formVars(face, version) } : null;
    movie.loadMovie(clip, url, form);
    return undefined;
  });
  method("unloadMovie", 0, (clip) => {
    movie.unloadMovie(clip);
    return undefined;
  });
  method("play", 0, (clip) => {
    clip.playing = true;
    return undefined;
  });
  // As GetURL, from the code that called it, whose variables a method sends.
  method("getURL", 0, (_, args, version) => {
    const cx = movie.realm.current;
    if (cx !== null) {
      avm1.getUrlMethod(cx, args, version);
    }

    return undefined;
  });
  // The clip's own variables sent where a method is "GET" or "POST", in any case.
  method("loadVariables", 0, (clip, args, version) => {
    const face = clip.avm1;
    if (args.length === 0 || face === null) {
      return undefined;
    }

    const method = args.length > 1 ? avm1.stringOf(args[1], version).toUpperCase() : "";
    const form: avm1.UrlForm | null =
      method === "GET" || method === "POST" ? { method, vars: formVars(face, version) } : null;
    movie.loadVariables(clip, avm1.stringOf(args[0], version), form);
    return undefined;
  });
  method("stop", 0, (clip) => {
    clip.playing = false;
    return undefined;
  });
  method("nextFrame", 0, (clip) => {
    if (clip.currentFrame < clip.totalFrames) {
      movie.timeline(clip).goto(clip.currentFrame + 1, false);
    }

    return undefined;
  });
  method("prevFrame", 0, (clip) => {
    if (clip.currentFrame > 1) {
      movie.timeline(clip).goto(clip.currentFrame - 1, false);
    }

    return undefined;
  });
  // Whether the clip is `_root` for the code in it; any value set as a boolean (the corpus's
  // movieclip_lockroot).
  const lockroot = proto.add("_lockroot", undefined, avm1.DONT_ENUM | avm1.DONT_DELETE);
  lockroot.get = realm.method((self) => {
    const clip = clipOf(self);
    const native = clip?.avm1?.display;
    return native instanceof ClipNative ? native.lockroot : undefined;
  });
  lockroot.set = realm.method((self, args, version) => {
    const clip = clipOf(self);
    const native = clip?.avm1?.display;
    if (native instanceof ClipNative) {
      native.lockroot = avm1.toBoolean(args[0], version);
    }

    return undefined;
  });
  // A new Transform of it each read; one given takes the matrix and colour transform of its clip.
  const transform = proto.add("transform", undefined, avm1.DONT_ENUM | avm1.VERSION_8);
  transform.get = realm.method((self, _, version) => {
    const clip = clipOf(self);
    const face = clip === null ? null : movie.faceOf(clip);
    return face === null ? undefined : transformOf(movie, face, version);
  });
  transform.set = realm.method((self, args) => {
    const clip = clipOf(self);
    if (clip !== null) {
      assignTransform(clip, args[0]);
    }

    return undefined;
  });
  filtersProperty(
    realm,
    proto,
    avm1.DONT_DELETE | avm1.DONT_ENUM | avm1.VERSION_8,
    clipOf,
    () => movie.filterFaces,
  );
  blendModeProperty(realm, proto, avm1.DONT_DELETE | avm1.DONT_ENUM | avm1.VERSION_8, clipOf);
  // A BitmapData, disposed or not, at a depth; anything else does nothing. pixelSnapping is
  // not read (Ruffle).
  method("attachBitmap", avm1.VERSION_8, (clip, args, version) => {
    const store = storeOf(args[0]);
    if (store !== null && args.length > 1) {
      const depth = avm1.toNumber(args[1], version) | 0;
      movie.attachBitmap(clip, store, depth, args.length > 3 && avm1.toBoolean(args[3], version));
    }

    return undefined;
  });
  method("startDrag", 0, (clip, args, version) => {
    const lockCenter = args.length > 0 && avm1.toBoolean(args[0], version);
    const bounds = args.length > 4 ? args.slice(1, 5).map((a) => avm1.toNumber(a, version)) : null;
    movie.startDrag(clip, lockCenter, bounds);
    return undefined;
  });
  method("stopDrag", 0, () => {
    movie.stopDrag();
    return undefined;
  });
  method("gotoAndPlay", 0, (clip, args, version) => {
    const cx = realm.current;
    if (cx !== null) {
      avm1.goto(cx, clip, args[0], true, 0, version);
    }

    return undefined;
  });
  method("gotoAndStop", 0, (clip, args, version) => {
    const cx = realm.current;
    if (cx !== null) {
      avm1.goto(cx, clip, args[0], false, 0, version);
    }

    return undefined;
  });
  method("duplicateMovieClip", 0, (clip, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    // Any init object, as Flash takes it, an object made of a primitive (Ruffle: not version-gated).
    const name = avm1.stringOf(args[0], version);
    const depth = args.length > 1 ? avm1.toNumber(args[1], version) | 0 : 0;
    const init = args.length > 2 ? realm.box(args[2], version) : null;
    const child = movie.duplicate(clip, name, (depth + DEPTH_BIAS) | 0, init);
    // A SWF 5 gets nothing back.
    return version < 6 || child === null ? undefined : (movie.faceOf(child) ?? undefined);
  });
  proto.define(
    "removeMovieClip",
    realm.method((self) => {
      // Any display object's, as removeMovieClip.call(field) takes a text field.
      const d = self instanceof avm1.Avm1Object ? self.display?.live()?.display?.target : undefined;
      if (d !== undefined) {
        movie.remove(d as DisplayObject);
      }

      return undefined;
    }),
    avm1.DONT_ENUM | avm1.DONT_DELETE,
  );
  method("getNextHighestDepth", avm1.VERSION_7, (clip) => {
    let highest = -1;
    for (const depth of clip.depths.keys()) {
      highest = Math.max(highest, depth);
    }

    return Math.max(0, highest - (DEPTH_BIAS - 1));
  });
  method("getInstanceAtDepth", avm1.VERSION_7, (clip, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    const child = clip.depths.get((avm1.toNumber(args[0], version) | 0) + DEPTH_BIAS);
    return child === undefined
      ? undefined
      : (movie.faceOf(child) ?? movie.faceOf(clip) ?? undefined);
  });
  method("getSWFVersion", 0, (clip) => {
    const version = movie.swfOf(clip).version;
    return version > 0 ? version : -1;
  });
  method("getRect", avm1.VERSION_8, (clip, args, version) => {
    const target = args.length > 0 ? targetOf(movie, clip, args[0], version) : clip;
    return target === null ? undefined : boundsObject(movie, clip, target, false, version);
  });
  method("createEmptyMovieClip", avm1.VERSION_6, (clip, args, version) => {
    if (args.length < 2) {
      return undefined;
    }

    const instance = avm1.stringOf(args[0], version);
    const depth = avm1.toNumber(args[1], version) | 0;
    return movie.faceOf(movie.createEmptyMovieClip(clip, instance, depth)) ?? undefined;
  });
  // Its place in whole pixels; a SWF 8 gets the field back, an earlier one nothing. The
  // depth is cast as Rust casts it, saturating (Ruffle).
  method("createTextField", avm1.VERSION_6, (clip, args, version) => {
    const instance = avm1.stringOf(args[0], version);
    const d = avm1.toNumber(args[1], version);
    const depth = Number.isNaN(d) ? 0 : Math.trunc(Math.max(-0x80000000, Math.min(0x7fffffff, d)));
    const [x, y, width, height] = args.slice(2, 6).map((a) => avm1.toNumber(a, version) | 0);
    const field = movie.createTextField(clip, instance, depth, [x, y, width, height]);
    return version < 8 ? undefined : (movie.faceOf(field) ?? undefined);
  });
  return { constr, proto };
}

/** swapDepths: to a depth, or to where a sibling is, swapping with what is there. */
function swapDepths(movie: Movie, clip: MovieClip, arg: Value, version: number): void {
  const parent = clip === movie.root ? null : clip.parent;
  if (movie.removed(clip) || !(parent instanceof MovieClip)) {
    return;
  }

  let depth: number | null = null;
  if (typeof arg === "number") {
    depth = ((avm1.toNumber(arg, version) | 0) + DEPTH_BIAS) | 0;
  } else {
    const target = targetOf(movie, clip, arg, version);
    if (target !== null && target.parent === parent && !movie.removed(target)) {
      depth = target.depth;
    }
  }

  if (depth === null || depth < 0 || depth > 2130706428 || depth === clip.depth) {
    return;
  }

  const other = parent.depths.get(depth);
  const from = clip.depth as number;
  if (other !== undefined) {
    parent.swapChildren(clip, other);
    parent.depths.set(from, other);
    other.depth = from;
  } else {
    parent.removeChild(clip);
    parent.placeAtDepth(clip, depth);
  }

  parent.depths.set(depth, clip);
  clip.depth = depth;
  clip.touch();
}
