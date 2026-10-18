// Advanced anti-aliasing's (Saffron's) cutoffs: Flash draws a glyph of an
// advanced field with each pixel's coverage a ramp over its signed
// distance to the outline, in pixels, inside positive, from 0 at the
// outside cutoff to 1 at the inside one. The cutoffs come from a table
// by the size in pixels on the screen, the font's CSM hint (its
// DefineFontAlignZones; none is thin) and whether the text is light or
// dark, linear between a table's sizes and flat past its ends; thickness
// and sharpness then move them, and TextRenderer's
// setAdvancedAntiAliasingTable puts a table of a font's own in place of
// both colours'.
//
// The tables were measured in adl (AIR 51), from the ramps across the
// edges of a block glyph drawn at each size from 4 to 96 pixels: the
// sizes here are where the ramp's ends stop being one straight line, to
// within 0.004 of a pixel.

/** Sizes in pixels, each with its inside and outside cutoffs: size, in, out, size, in, out... */
export type CsmTable = readonly number[];

const table = (...entries: [number, number, number][]): CsmTable => entries.flat();

/** By CSM hint, thin, medium and thick: light text's table, then dark text's. */
const DEFAULTS: readonly (readonly [CsmTable, CsmTable])[] = [
  [
    table(
      [8, 0.081, -0.82],
      [12, 0.029, -0.821],
      [16, 0.127, -0.813],
      [26, 0.333, -0.852],
      [27, 0.349, -0.854],
    ),
    table(
      [8, 0.255, -0.528],
      [12, 0.206, -0.441],
      [13, 0.234, -0.439],
      [16, 0.276, -0.469],
      [26, 0.398, -0.591],
      [27, 0.407, -0.601],
    ),
  ],
  [
    table(
      [8, 0.08, -0.671],
      [12, 0.309, -0.54],
      [16, 0.445, -0.492],
      [20, 0.525, -0.513],
      [26, 0.645, -0.54],
      [27, 0.656, -0.541],
    ),
    table(
      [8, 0.442, -0.439],
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: measured, not log10(e)
      [10, 0.486, -0.434],
      [11, 0.515, -0.428],
      [12, 0.566, -0.421],
      [18, 0.57, -0.422],
      [27, 0.619, -0.469],
    ),
  ],
  [
    table(
      [8, 0.18, -0.571],
      [12, 0.46, -0.39],
      [16, 0.526, -0.415],
      [26, 0.649, -0.536],
      [27, 0.656, -0.541],
    ),
    table([8, 0.566, -0.42], [16, 0.567, -0.419], [27, 0.619, -0.469]),
  ],
];

/**
 * Tables set by TextRenderer.setAdvancedAntiAliasingTable, by font name
 * and style; adl uses one for light and dark text alike, whichever
 * colour type it was set for. TextRenderer's settings are the player's,
 * not a SWF's: they are kept for the page, as Flash keeps them for its
 * process.
 */
const custom = new Map<string, CsmTable>();

const styleKey = (name: string, bold: boolean, italic: boolean) =>
  `${name}\u0000${bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular"}`;

/**
 * Set a font's own table, entries of size, inside and outside cutoff, in
 * any order; none takes it away. Text drawn by it before is drawn by it
 * once drawn again. An entry with NaN or an infinity in it is left out,
 * as the shader could make nothing of it.
 */
export function setCsmTable(
  name: string,
  style: string,
  entries: [number, number, number][],
): void {
  const key = `${name}\u0000${style}`;
  const usable = entries.filter((entry) => entry.every(Number.isFinite));
  if (usable.length === 0) {
    custom.delete(key);
  } else {
    usable.sort((a, b) => a[0] - b[0]);
    custom.set(key, usable.flat());
  }
}

/**
 * Whether Flash takes a colour, 0xRRGGBB, for light text: its luma,
 * 30:59:11, over 200 of 255. It is the colour as drawn, under the
 * object's colour transform. This and cutoffs mirror what
 * render/saffron.ts' vertex shader does in GLSL, which draws by it: a
 * change to one is a change to the other.
 */
export function isLight(color: number): boolean {
  return 30 * ((color >> 16) & 0xff) + 59 * ((color >> 8) & 0xff) + 11 * (color & 0xff) > 20000;
}

/** The tables a font's text is drawn by, light and dark. */
export function csmTables(font: {
  name: string;
  bold: boolean;
  italic: boolean;
  csmHint?: number;
}): readonly [CsmTable, CsmTable] {
  const own = custom.size > 0 ? custom.get(styleKey(font.name, font.bold, font.italic)) : undefined;
  if (own) {
    return [own, own];
  }

  return DEFAULTS[Math.min(2, Math.max(0, font.csmHint ?? 0))];
}

/**
 * The cutoffs at `ppem` pixels to the em, under `thickness` (-200 to
 * 200) and `sharpness` (-400 to 400), into `out` as inside, outside: each
 * moves them by a fiftieth of a pixel per pixel of size at its end of its
 * range, thickness both outward, sharpness the two together; met, they
 * stay where they met. render/saffron.ts' shader does the same per glyph.
 */
export function cutoffs(
  table: CsmTable,
  ppem: number,
  thickness: number,
  sharpness: number,
  out: Float32Array,
): void {
  let inside = table[1];
  let outside = table[2];
  if (ppem >= table[table.length - 3]) {
    inside = table[table.length - 2];
    outside = table[table.length - 1];
  } else if (ppem > table[0]) {
    for (let i = 3; i < table.length; i += 3) {
      if (ppem <= table[i]) {
        const t = (ppem - table[i - 3]) / (table[i] - table[i - 3]);
        inside = table[i - 2] + (table[i + 1] - table[i - 2]) * t;
        outside = table[i - 1] + (table[i + 2] - table[i - 1]) * t;
        break;
      }
    }
  }

  const unit = 0.0001 * ppem;
  const t = Math.max(-200, Math.min(200, thickness));
  const s = Math.max(-400, Math.min(400, sharpness));
  inside -= unit * (t + s / 2);
  outside -= unit * (t - s / 2);
  if (inside < outside) {
    inside = outside = (inside + outside) / 2;
  }

  out[0] = inside;
  out[1] = outside;
}
