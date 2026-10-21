// MovieClip's drawing methods, following Ruffle's avm1/globals/movie_clip.rs
// (MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors),
// with coercions and bounds checked against AIR. The paths use the same Drawing
// as AS3; AVM1 keeps bounds even for commands with no fill or line style.
import type { Line } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import { CONTENT, type MovieClip } from "../../display/display.js";
import { Drawing } from "../../display/drawing.js";
import type { Rect } from "../../display/geometry.js";
import { CURVE, extent, MOVE } from "../../display/shapes.js";

type Value = avm1.Value;
type Method = (
  name: string,
  flags: number,
  fn: (clip: MovieClip, args: Value[], version: number) => Value,
) => void;

/** x87's integer conversion, as Flash's drawing API uses it. */
function integer(n: number): number {
  return n > -2147483649 && n < 2147483648 ? Math.trunc(n) : -2147483648;
}

function coordinate(value: Value, version: number): number {
  const n = avm1.toNumber(value, version);
  return Number.isNaN(n) ? 0 : integer(n * 20) / 20;
}

function color(rgb: Value, alpha: Value, version: number): number {
  const c = avm1.toNumber(rgb, version) & 0xffffff;
  const percent = Math.fround(Math.max(0, Math.min(100, avm1.toNumber(alpha, version))));
  const a = Math.fround(Math.fround(percent / 100) * 255) | 0;
  return ((a << 24) | c) >>> 0;
}

/** Bounds before SWF 8 include control points and a line's full width. */
class ClipDrawing extends Drawing {
  private penX = 0;
  private penY = 0;
  private pad = 0;
  private plain: Rect | null = null;
  private outlined: Rect | null = null;
  private plainAt = -1;
  private outlinedAt = -1;
  private plainResult: Rect | null = null;
  private outlinedResult: Rect | null = null;

  constructor(private readonly versionOfSwf: number) {
    super();
  }

  override lineStyle(line: Line | null): void {
    this.pad = (line?.width ?? 0) / (this.versionOfSwf < 8 ? 20 : 40);
    super.lineStyle(line);
  }

  override moveTo(x: number, y: number): void {
    this.penX = x;
    this.penY = y;
    super.moveTo(x, y);
  }

  override lineTo(x: number, y: number): void {
    this.remember(
      Math.min(this.penX, x),
      Math.min(this.penY, y),
      Math.max(this.penX, x),
      Math.max(this.penY, y),
    );
    this.penX = x;
    this.penY = y;
    super.lineTo(x, y);
  }

  override curveTo(cx: number, cy: number, x: number, y: number): void {
    if (this.versionOfSwf < 8) {
      this.remember(
        Math.min(this.penX, cx, x),
        Math.min(this.penY, cy, y),
        Math.max(this.penX, cx, x),
        Math.max(this.penY, cy, y),
      );
    } else {
      const r = extent([MOVE, this.penX, this.penY, CURVE, cx, cy, x, y]);
      if (r) {
        this.remember(
          Math.floor(r[0] * 20) / 20,
          Math.floor(r[1] * 20) / 20,
          Math.floor(r[2] * 20) / 20,
          Math.floor(r[3] * 20) / 20,
        );
      }
    }

    this.penX = x;
    this.penY = y;
    super.curveTo(cx, cy, x, y);
  }

  override clear(): void {
    this.penX = 0;
    this.penY = 0;
    this.pad = 0;
    this.plain = null;
    this.outlined = null;
    super.clear();
  }

  override bounds(lines: boolean): Rect | null {
    // Keep snapshots stable for callers retaining the previous drawing's bounds.
    if (lines) {
      if (this.outlinedAt !== this.version) {
        this.outlinedResult = this.outlined ? { ...this.outlined } : null;
        this.outlinedAt = this.version;
      }

      return this.outlinedResult;
    }

    if (this.plainAt !== this.version) {
      this.plainResult = this.plain ? { ...this.plain } : null;
      this.plainAt = this.version;
    }

    return this.plainResult;
  }

  private remember(xMin: number, yMin: number, xMax: number, yMax: number): void {
    if (this.plain && this.outlined) {
      this.plain.xMin = Math.min(this.plain.xMin, xMin);
      this.plain.yMin = Math.min(this.plain.yMin, yMin);
      this.plain.xMax = Math.max(this.plain.xMax, xMax);
      this.plain.yMax = Math.max(this.plain.yMax, yMax);
      this.outlined.xMin = Math.min(this.outlined.xMin, xMin - this.pad);
      this.outlined.yMin = Math.min(this.outlined.yMin, yMin - this.pad);
      this.outlined.xMax = Math.max(this.outlined.xMax, xMax + this.pad);
      this.outlined.yMax = Math.max(this.outlined.yMax, yMax + this.pad);
    } else {
      this.plain = { xMin, yMin, xMax, yMax };
      this.outlined = {
        xMin: xMin - this.pad,
        yMin: yMin - this.pad,
        xMax: xMax + this.pad,
        yMax: yMax + this.pad,
      };
    }
  }
}

/** The basic MovieClip drawing API, visible from SWF 6. */
export function drawingMethods(method: Method, swfVersion: (clip: MovieClip) => number): void {
  const drawing = (clip: MovieClip): Drawing => {
    clip.drawing ??= new ClipDrawing(swfVersion(clip));
    clip.invalidate(CONTENT);
    return clip.drawing;
  };

  method("clear", avm1.VERSION_6, (clip) => {
    if (clip.drawing) {
      clip.drawing.clear();
      clip.invalidate(CONTENT);
    }

    return undefined;
  });
  method("lineStyle", avm1.VERSION_6, (clip, args, version) => {
    if (args.length === 0) {
      if (clip.drawing) {
        clip.drawing.lineStyle(null);
        clip.invalidate(CONTENT);
      }

      return undefined;
    }

    const width = integer(args[0] === undefined ? 1 : avm1.toNumber(args[0], version));
    const rgb = color(args[1] ?? 0, args.length > 2 ? args[2] : 100, version);
    const advanced = version >= 8;
    const hinted = advanced && avm1.toBoolean(args[3], version);
    const scale = advanced && args.length > 4 ? avm1.stringOf(args[4], version) : "";
    const caps = advanced && args.length > 5 ? avm1.stringOf(args[5], version) : "";
    const join = advanced && args.length > 6 ? avm1.stringOf(args[6], version) : "";
    const limit =
      join === "miter" && args.length > 7
        ? Math.max(0, Math.min(255, avm1.toNumber(args[7], version)))
        : 3;
    drawing(clip).lineStyle({
      width: Math.max(0, Math.min(255, width)) * 20,
      color: rgb,
      startCap: caps === "square" ? 2 : caps === "none" ? 1 : 0,
      endCap: caps === "square" ? 2 : caps === "none" ? 1 : 0,
      join: join === "miter" ? 2 : join === "bevel" ? 1 : 0,
      miterLimit: (Math.trunc(limit * 256) | 0) / 256,
      noHScale: scale === "none" || scale === "horizontal",
      noVScale: scale === "none" || scale === "vertical",
      pixelHinting: hinted,
      noClose: false,
      fill: null,
    });

    return undefined;
  });
  method("beginFill", avm1.VERSION_6, (clip, args, version) => {
    if (args[0] === undefined) {
      if (clip.drawing) {
        clip.drawing.endFill();
        clip.invalidate(CONTENT);
      }
    } else {
      const rgb = color(args[0], args.length > 1 ? args[1] : 100, version);
      drawing(clip).beginFill({ type: "solid", color: rgb });
    }

    return undefined;
  });
  method("endFill", avm1.VERSION_6, (clip) => {
    if (clip.drawing) {
      clip.drawing.endFill();
      clip.invalidate(CONTENT);
    }

    return undefined;
  });
  method("moveTo", avm1.VERSION_6, (clip, args, version) => {
    if (args.length >= 2) {
      const x = coordinate(args[0], version);
      const y = coordinate(args[1], version);
      drawing(clip).moveTo(x, y);
    }

    return undefined;
  });
  method("lineTo", avm1.VERSION_6, (clip, args, version) => {
    if (args.length >= 2) {
      const x = coordinate(args[0], version);
      const y = coordinate(args[1], version);
      drawing(clip).lineTo(x, y);
    }

    return undefined;
  });
  method("curveTo", avm1.VERSION_6, (clip, args, version) => {
    if (args.length >= 4) {
      const cx = coordinate(args[0], version);
      const cy = coordinate(args[1], version);
      const x = coordinate(args[2], version);
      const y = coordinate(args[3], version);
      drawing(clip).curveTo(cx, cy, x, y);
    }

    return undefined;
  });
}
