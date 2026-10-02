// flash.display.Graphics: the natives record into the display object's
// drawing (drawing.ts). drawCircle and drawEllipse are playerglobal's own,
// over curveTo.
import type { Line } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
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
    beginGradientFill(_type: Value, colors: Value, alphas: Value): void {
      const c = ((colors as AsObject)?.$a as Value[] | undefined) ?? [];
      const a = ((alphas as AsObject)?.$a as Value[] | undefined) ?? [];
      drawing(this).beginFill({ type: "solid", color: argb(c[0] ?? 0, a[0] ?? 1) });
    }

    beginBitmapFill(): void {
      // Until bitmaps draw: a fill with nothing to show, so that the shape has its contours.
      drawing(this).beginFill({ type: "solid", color: 0 });
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
      } else {
        drawing(this).clear();
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Graphics", GraphicsNatives);
  return natives;
}
