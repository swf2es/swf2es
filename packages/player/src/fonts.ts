// The fonts a field's text is laid out in (docs/architecture.md, "Text"):
// a SWF's embedded fonts, found by name, and the browser's for a device
// font, measured on a canvas where there is one.
import type { Font } from "@swf2es/format";

/** A SWF's embedded fonts: DefineFont2 and 3, by name. */
export class FontSet {
  private readonly byName = new Map<string, Font[]>();

  add(font: Font): void {
    const fonts = this.byName.get(font.name);
    if (fonts) {
      fonts.push(font);
    } else {
      this.byName.set(font.name, [font]);
    }
  }

  /** Prefer a font with layout metrics when a library has more than one of the same name. */
  find(name: string, bold: boolean, italic: boolean): Font | null {
    const fonts = this.byName.get(name);
    if (!fonts) {
      return null;
    }

    return (
      fonts.find((f) => f.bold === bold && f.italic === italic && f.layout) ??
      fonts.find((f) => f.layout) ??
      fonts.find((f) => f.bold === bold && f.italic === italic) ??
      fonts[0]
    );
  }
}

/** A device font as the browser has it: `_sans`, `_serif` and `_typewriter` as its kinds, any other by name, then serif, as Flash's default is. */
export function fontFamily(font: string): string[] {
  switch (font) {
    case "_sans":
      return ["Arial", "Helvetica", "sans-serif"];
    case "_serif":
      return ["Times New Roman", "Times", "serif"];
    case "_typewriter":
      return ["Courier New", "Courier", "monospace"];
    default:
      return [font, "serif"];
  }
}

/** A device font's metrics at a size, in pixels: an advance for each character, the ascent and descent. */
export interface DeviceMetrics {
  advance(char: string): number;
  ascent: number;
  descent: number;
}

let canvas:
  | { context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D }
  | null
  | undefined;

function context(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  if (canvas === undefined) {
    canvas = null;
    if (typeof OffscreenCanvas !== "undefined") {
      const c = new OffscreenCanvas(1, 1).getContext("2d");
      canvas = c ? { context: c } : null;
    } else if (typeof document !== "undefined") {
      const c = document.createElement("canvas").getContext("2d");
      canvas = c ? { context: c } : null;
    }
  }

  return canvas?.context ?? null;
}

const measured = new Map<string, DeviceMetrics>();

/**
 * A device font's metrics: the browser's, from its canvas, where there is
 * one; else (node) a stand-in, half the size a character, ascent 0.9 and
 * descent 0.2 of it. Flash's system fonts are neither.
 */
export function deviceMetrics(
  font: string,
  size: number,
  bold: boolean,
  italic: boolean,
): DeviceMetrics {
  const key = `${font}|${size}|${bold}|${italic}`;
  let metrics = measured.get(key);
  if (metrics) {
    return metrics;
  }

  const c = context();
  if (c) {
    const families = fontFamily(font)
      .map((f) => (/^[a-z-]+$/.test(f) ? f : `"${f}"`))
      .join(", ");
    const css = `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px ${families}`;
    const widths = new Map<string, number>();
    c.font = css;
    const box = c.measureText("Mg");
    metrics = {
      advance: (char) => {
        let w = widths.get(char);
        if (w === undefined) {
          c.font = css;
          w = c.measureText(char).width;
          widths.set(char, w);
        }

        return w;
      },
      ascent: box.fontBoundingBoxAscent ?? size * 0.9,
      descent: box.fontBoundingBoxDescent ?? size * 0.2,
    };
  } else {
    metrics = { advance: () => size / 2, ascent: size * 0.9, descent: size * 0.2 };
  }

  measured.set(key, metrics);
  return metrics;
}
