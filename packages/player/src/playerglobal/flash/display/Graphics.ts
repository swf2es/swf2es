// flash.display.Graphics: the natives record into the display object's
// drawing (drawing.ts). drawCircle and drawEllipse are playerglobal's own,
// over curveTo.
import type { Line } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { BitmapStore } from "../../../bitmap.js";
import type { DisplayObject } from "../../../display.js";
import { CONTENT } from "../../../display.js";
import { Drawing } from "../../../drawing.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const TWIPS = 20;
const CAPS: Record<string, number> = { round: 0, none: 1, square: 2 };
const JOINTS: Record<string, number> = { round: 0, bevel: 1, miter: 2 };

/** A Graphics object for `display`, made once. */
export function graphicsOf(s: Scripting, o: AsObject): AsObject {
  if (!o.$graphics) {
    const g = s.rt.construct(s.rt.classNamed("flash.display::Graphics")) as AsObject;
    g.$display = o.$display;
    o.$graphics = g;
  }

  return o.$graphics;
}

/** 0xAARRGGBB of a color and an alpha in [0, 1], the alpha a byte floored as Flash stores it (0.5 is 127). */
function argb(color: Value, alpha: Value): number {
  const a = Math.floor(Math.max(0, Math.min(1, Number(alpha))) * 255);
  return ((a << 24) | (Number(color) & 0xffffff)) >>> 0;
}

export function graphicsNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const drawing = (o: { $display: DisplayObject }): Drawing => {
    o.$display.drawing ??= new Drawing();
    o.$display.invalidate(CONTENT);
    return o.$display.drawing;
  };
  const num = (v: Value, fallback = 0) => {
    const n = Number(v);
    return Number.isNaN(n) ? fallback : n;
  };

  class GraphicsNatives {
    declare $display: DisplayObject;

    clear(): void {
      drawing(this).clear();
    }

    beginFill(color: Value, alpha: Value = 1): void {
      drawing(this).beginFill({ type: "solid", color: argb(color, alpha) });
    }

    /** Recorded as a shape's gradient is drawn: its first stop's color, until gradients draw. */
    /**
     * As adl draws one: arrays of different lengths, or a ratio outside 0
     * to 255, draw nothing; no stops draw black; past 16 stops are left
     * out; an unknown spread or interpolation is pad or RGB; null alphas
     * and ratios are opaque and even, null colours TypeError 2007.
     */
    beginGradientFill(
      type: Value,
      colors: Value,
      alphas: Value,
      ratios: Value,
      matrix: Value = null,
      spreadMethod: Value = "pad",
      interpolationMethod: Value = "rgb",
      focalPointRatio: Value = 0,
    ): void {
      const kind = s.rt.toString(type);
      if (kind !== "linear" && kind !== "radial") {
        throw s.rt.error("ArgumentError", 2008, "type");
      }

      if (colors === null || colors === undefined) {
        throw s.rt.error("TypeError", 2007, "colors");
      }

      // Null alphas are opaque, and null ratios spread evenly, floor(255 k / (n - 1)), as adl draws them.
      const array = (v: Value) => ((v as AsObject).$a as Value[] | undefined) ?? [];
      const c = array(colors);
      const a = alphas === null || alphas === undefined ? c.map(() => 1) : array(alphas);
      const r =
        ratios === null || ratios === undefined
          ? c.map((_, k) => (c.length > 1 ? Math.floor((255 * k) / (c.length - 1)) : 0))
          : array(ratios).map((v) => Math.trunc(s.rt.toNumber(v)));
      if (a.length !== c.length || r.length !== c.length || r.some((v) => !(v >= 0 && v <= 255))) {
        drawing(this).beginFill({ type: "solid", color: 0 });
        return;
      }

      const read = (k: string, fallback: number) =>
        matrix === null || matrix === undefined
          ? fallback
          : s.rt.toNumber(s.rt.getProperty(matrix as AsObject, s.rt.publicName(k)));
      const spread = s.rt.toString(spreadMethod);
      drawing(this).beginFill({
        type: "gradient",
        radial: kind === "radial",
        focal: kind === "radial" ? num(focalPointRatio) : 0,
        stops: c.slice(0, 16).map((color, i) => ({ ratio: r[i], color: argb(color, a[i]) })),
        spread: spread === "reflect" ? 1 : spread === "repeat" ? 2 : 0,
        linearRgb: s.rt.toString(interpolationMethod) === "linearRGB",
        matrix: {
          a: read("a", 1),
          b: read("b", 0),
          c: read("c", 0),
          d: read("d", 1),
          tx: read("tx", 0),
          ty: read("ty", 0),
        },
      });
    }

    /** The BitmapData itself, not a copy: the fill shows its later changes, the shape a view of its store. */
    beginBitmapFill(
      bitmap: Value,
      matrix: Value = null,
      repeat: Value = true,
      smooth: Value = false,
    ): void {
      if (bitmap === null || bitmap === undefined) {
        throw s.rt.error("TypeError", 2007, "bitmap");
      }

      const store: BitmapStore | null | undefined = (bitmap as AsObject).$store;
      if (!store) {
        throw s.rt.error("ArgumentError", 2015);
      }

      const read = (k: string, fallback: number) =>
        matrix === null || matrix === undefined
          ? fallback
          : s.rt.toNumber(s.rt.getProperty(matrix as AsObject, s.rt.publicName(k)));
      store.views.add(this.$display.ref);
      drawing(this).beginFill({
        type: "image",
        image: store,
        matrix: {
          a: read("a", 1),
          b: read("b", 0),
          c: read("c", 0),
          d: read("d", 1),
          tx: read("tx", 0),
          ty: read("ty", 0),
        },
        repeat: !!repeat,
        smooth: !!smooth,
      });
    }

    endFill(): void {
      drawing(this).endFill();
    }

    lineStyle(
      thickness: Value = Number.NaN,
      color: Value = 0,
      alpha: Value = 1,
      pixelHinting: Value = false,
      scaleMode: Value = "normal",
      caps: Value = null,
      joints: Value = null,
      miterLimit: Value = 3,
    ): void {
      const t = Number(thickness);
      if (Number.isNaN(t)) {
        drawing(this).lineStyle(null);
        return;
      }

      const cap = CAPS[String(caps ?? "round")] ?? 0;
      const line: Line = {
        width: Math.round(Math.max(0, Math.min(255, t)) * TWIPS),
        color: argb(color, alpha),
        startCap: cap,
        endCap: cap,
        join: JOINTS[String(joints ?? "round")] ?? 0,
        miterLimit: num(miterLimit, 3),
        noHScale: scaleMode === "none" || scaleMode === "vertical",
        noVScale: scaleMode === "none" || scaleMode === "horizontal",
        pixelHinting: !!pixelHinting,
        noClose: false,
        fill: null,
      };
      drawing(this).lineStyle(line);
    }

    lineGradientStyle(): void {
      // The line keeps the color lineStyle gave it, as a shape's gradient line does.
    }

    lineBitmapStyle(): void {
      // As lineGradientStyle.
    }

    drawRect(x: Value, y: Value, w: Value, h: Value): void {
      drawing(this).drawRect(num(x), num(y), num(w), num(h));
    }

    drawRoundRect(x: Value, y: Value, w: Value, h: Value, ew: Value, eh: Value = Number.NaN): void {
      const e = num(ew);
      drawing(this).drawRoundRect(num(x), num(y), num(w), num(h), e, num(eh, e));
    }

    drawRoundRectComplex(
      x: Value,
      y: Value,
      w: Value,
      h: Value,
      tl: Value,
      tr: Value,
      bl: Value,
      br: Value,
    ): void {
      const r = (v: Value): [number, number] => {
        const c = Math.min(Math.abs(num(v)), Math.abs(num(w)) / 2, Math.abs(num(h)) / 2);
        return [c, c];
      };
      drawing(this).drawRoundRectComplex(
        num(x),
        num(y),
        num(w),
        num(h),
        r(tl),
        r(tr),
        r(bl),
        r(br),
      );
    }

    moveTo(x: Value, y: Value): void {
      drawing(this).moveTo(num(x), num(y));
    }

    lineTo(x: Value, y: Value): void {
      drawing(this).lineTo(num(x), num(y));
    }

    curveTo(cx: Value, cy: Value, x: Value, y: Value): void {
      drawing(this).curveTo(num(cx), num(cy), num(x), num(y));
    }

    cubicCurveTo(c1x: Value, c1y: Value, c2x: Value, c2y: Value, x: Value, y: Value): void {
      drawing(this).cubicCurveTo(num(c1x), num(c1y), num(c2x), num(c2y), num(x), num(y));
    }

    /** As Flash checks: the winding one of its two, and the data's count even when there are commands (ArgumentError #2008, #2004). */
    drawPath(commands: Value, data: Value, winding: Value = "evenOdd"): void {
      if (winding !== "evenOdd" && winding !== "nonZero") {
        throw s.rt.error("ArgumentError", 2008, "winding");
      }

      const c = (((commands as AsObject)?.$a as Value[] | undefined) ?? []).map((v) => Number(v));
      const d = (((data as AsObject)?.$a as Value[] | undefined) ?? []).map((v) => Number(v));
      if (c.length && d.length % 2) {
        throw s.rt.error("ArgumentError", 2004);
      }

      drawing(this).drawPath(c, d, winding);
    }

    copyFrom(other: Value): void {
      const source = (other as AsObject)?.$display?.drawing as Drawing | undefined;
      if (source) {
        drawing(this).copyFrom(source);
        // Its BitmapData fills watched as the other's are.
        for (const layer of source.layers) {
          for (const { fill } of layer.fills) {
            if (fill.type === "image" && fill.image instanceof BitmapStore) {
              fill.image.views.add(this.$display.ref);
            }
          }
        }
      } else {
        drawing(this).clear();
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Graphics", GraphicsNatives);
  return natives;
}
