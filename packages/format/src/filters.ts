// The filters a PlaceObject3 gives a display object, as the SWF stores
// them: FILTERLIST's records, with their fixed-point and float fields.
import { SwfReader } from "./swf.js";

/** A colour of a filter: RGB and alpha 0 to 255, as RGBA stores them. */
export interface FilterColor {
  rgb: number;
  alpha: number;
}

export type SwfFilter =
  | {
      type: "dropShadow";
      color: FilterColor;
      blurX: number;
      blurY: number;
      /** In radians. */
      angle: number;
      distance: number;
      strength: number;
      inner: boolean;
      knockout: boolean;
      /** The object drawn with its shadow: false hides it. */
      composite: boolean;
      passes: number;
    }
  | { type: "blur"; blurX: number; blurY: number; passes: number }
  | {
      type: "glow";
      color: FilterColor;
      blurX: number;
      blurY: number;
      strength: number;
      inner: boolean;
      knockout: boolean;
      composite: boolean;
      passes: number;
    }
  | {
      type: "bevel" | "gradientGlow" | "gradientBevel";
      /** A bevel's shadow and highlight, in that order; a gradient's stops. */
      colors: FilterColor[];
      ratios: number[];
      blurX: number;
      blurY: number;
      angle: number;
      distance: number;
      strength: number;
      inner: boolean;
      knockout: boolean;
      composite: boolean;
      onTop: boolean;
      passes: number;
    }
  | {
      type: "convolution";
      matrixX: number;
      matrixY: number;
      divisor: number;
      bias: number;
      matrix: number[];
      color: FilterColor;
      clamp: boolean;
      preserveAlpha: boolean;
    }
  | { type: "colorMatrix"; matrix: number[] };

function color(r: SwfReader): FilterColor {
  const red = r.u8();
  const green = r.u8();
  const blue = r.u8();
  return { rgb: (red << 16) | (green << 8) | blue, alpha: r.u8() };
}

const fixed = (r: SwfReader) => (r.u32() | 0) / 65536;
const fixed8 = (r: SwfReader) => ((r.u16() << 16) >> 16) / 256;

function float(r: SwfReader): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setUint32(0, r.u32());
  return v.getFloat32(0);
}

/** A FILTERLIST's filters, as far as the bytes go. */
export function readFilters(bytes: Uint8Array): SwfFilter[] {
  const r = new SwfReader(bytes, 0, bytes.length);
  const count = r.u8();
  const filters: SwfFilter[] = [];
  for (let i = 0; i < count && !r.overrun; i++) {
    const id = r.u8();
    let filter: SwfFilter | null = null;
    switch (id) {
      case 0: {
        const c = color(r);
        const [blurX, blurY, angle, distance] = [fixed(r), fixed(r), fixed(r), fixed(r)];
        const strength = fixed8(r);
        const flags = r.u8();
        filter = {
          type: "dropShadow",
          color: c,
          blurX,
          blurY,
          angle,
          distance,
          strength,
          inner: (flags & 0x80) !== 0,
          knockout: (flags & 0x40) !== 0,
          composite: (flags & 0x20) !== 0,
          passes: flags & 0x1f,
        };
        break;
      }
      case 1: {
        const [blurX, blurY] = [fixed(r), fixed(r)];
        filter = { type: "blur", blurX, blurY, passes: r.u8() >> 3 };
        break;
      }
      case 2: {
        const c = color(r);
        const [blurX, blurY] = [fixed(r), fixed(r)];
        const strength = fixed8(r);
        const flags = r.u8();
        filter = {
          type: "glow",
          color: c,
          blurX,
          blurY,
          strength,
          inner: (flags & 0x80) !== 0,
          knockout: (flags & 0x40) !== 0,
          composite: (flags & 0x20) !== 0,
          passes: flags & 0x1f,
        };
        break;
      }
      case 3:
      case 4:
      case 7: {
        let colors: FilterColor[];
        let ratios: number[];
        if (id === 3) {
          // The highlight, then the shadow: the SWF spec has them the other way, adl this.
          const highlight = color(r);
          colors = [color(r), highlight];
          ratios = [];
        } else {
          const n = r.u8();
          colors = Array.from({ length: n }, () => color(r));
          ratios = Array.from({ length: n }, () => r.u8());
        }

        const [blurX, blurY, angle, distance] = [fixed(r), fixed(r), fixed(r), fixed(r)];
        const strength = fixed8(r);
        const flags = r.u8();
        filter = {
          type: id === 3 ? "bevel" : id === 4 ? "gradientGlow" : "gradientBevel",
          colors,
          ratios,
          blurX,
          blurY,
          angle,
          distance,
          strength,
          inner: (flags & 0x80) !== 0,
          knockout: (flags & 0x40) !== 0,
          composite: (flags & 0x20) !== 0,
          onTop: (flags & 0x10) !== 0,
          passes: flags & 0x0f,
        };
        break;
      }
      case 5: {
        const matrixX = r.u8();
        const matrixY = r.u8();
        const divisor = float(r);
        const bias = float(r);
        const matrix = Array.from({ length: matrixX * matrixY }, () => float(r));
        const c = color(r);
        const flags = r.u8();
        filter = {
          type: "convolution",
          matrixX,
          matrixY,
          divisor,
          bias,
          matrix,
          color: c,
          clamp: (flags & 0x02) !== 0,
          preserveAlpha: (flags & 0x01) !== 0,
        };
        break;
      }
      case 6:
        filter = { type: "colorMatrix", matrix: Array.from({ length: 20 }, () => float(r)) };
        break;
    }

    if (!filter || r.overrun) {
      break;
    }

    filters.push(filter);
  }

  return filters;
}
