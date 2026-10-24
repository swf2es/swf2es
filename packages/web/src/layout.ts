// Where the stage goes in its element, as Flash's plug-in placed it by the
// embedding's `scale` and `salign`, and the resolution it is drawn at.

export type ScaleMode = "showAll" | "noBorder" | "exactFit" | "noScale";

/** The stage's box in the element, in CSS pixels, and the renderer's resolution: device pixels to a stage pixel. */
export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  resolution: number;
}

/** The largest side of the canvas, in device pixels: past it a stage drawn full screen on a large display costs more memory than it shows. */
export const MAX_SIDE = 4096;

/** A `scale` attribute's mode, any case, Flash's showAll for none or one unknown. */
export function scaleMode(value: string | null): ScaleMode {
  switch (value?.toLowerCase()) {
    case "noborder":
      return "noBorder";
    case "exactfit":
      return "exactFit";
    case "noscale":
      return "noScale";
    default:
      return "showAll";
  }
}

/**
 * The stage of `stageWidth` by `stageHeight` in a box of `boxWidth` by
 * `boxHeight`: showAll fits it whole, noBorder fills the box and crops,
 * exactFit stretches it to the box, and noScale leaves it its size. `salign`
 * holds its edges, as Flash's T, B, L and R in any order and case; the
 * stage is centred along an axis it names neither edge of. `dpr` is the
 * device's pixels to a CSS pixel.
 */
export function place(
  stageWidth: number,
  stageHeight: number,
  boxWidth: number,
  boxHeight: number,
  mode: ScaleMode,
  salign: string | null,
  dpr: number,
  leadingEdge = false,
): Placement {
  const sx = boxWidth / stageWidth;
  const sy = boxHeight / stageHeight;
  let width = boxWidth;
  let height = boxHeight;
  if (mode !== "exactFit") {
    const scale =
      mode === "showAll" ? Math.min(sx, sy) : mode === "noBorder" ? Math.max(sx, sy) : 1;
    width = stageWidth * scale;
    height = stageHeight * scale;
  }

  const align = (salign ?? "").toUpperCase();
  const along = (free: number, start: boolean, end: boolean) =>
    start && (leadingEdge || !end) ? 0 : end && !start ? free : free / 2;
  // Stretched one way more than the other, it is drawn as fine as its finer axis needs.
  const finest = Math.max(width / stageWidth, height / stageHeight) * dpr;
  const largest = MAX_SIDE / Math.max(stageWidth, stageHeight);
  return {
    x: along(boxWidth - width, align.includes("L"), align.includes("R")),
    y: along(boxHeight - height, align.includes("T"), align.includes("B")),
    width,
    height,
    // Never nothing: a hidden element's renderer still needs a size.
    resolution: Math.max(Math.min(finest, largest), 1 / 64),
  };
}

/**
 * What the canvas shows, in stage coordinates, and the renderer's resolution
 * for it. Flash draws what lies past the stage's edges where the box shows
 * it, in showAll's and noScale's margins as on its stage, so the canvas
 * covers the whole box and the viewport is the box taken into the stage's
 * coordinates; `css` is where the canvas goes in the box, in CSS pixels.
 * exactFit stretches the stage to the box, one axis more than the other,
 * which leaves no margin: the canvas is the stage, stretched by CSS.
 */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  resolution: number;
  css: { x: number; y: number; width: number; height: number };
}

/** The viewport for `placed`, the stage of `stageWidth` by `stageHeight` placed in a box of `boxWidth` by `boxHeight`. */
export function viewport(
  stageWidth: number,
  stageHeight: number,
  boxWidth: number,
  boxHeight: number,
  mode: ScaleMode,
  placed: Placement,
): Viewport {
  const scale = placed.width / stageWidth;
  if (mode === "exactFit" || !(scale > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return {
      x: 0,
      y: 0,
      width: stageWidth,
      height: stageHeight,
      resolution: placed.resolution,
      css: { x: placed.x, y: placed.y, width: placed.width, height: placed.height },
    };
  }

  const width = boxWidth / scale;
  const height = boxHeight / scale;
  return {
    x: placed.x ? -placed.x / scale : 0,
    y: placed.y ? -placed.y / scale : 0,
    width,
    height,
    // As fine as the stage, whose MAX_SIDE bounds it: the canvas then has at most the box's device pixels.
    resolution: placed.resolution,
    css: { x: 0, y: 0, width: boxWidth, height: boxHeight },
  };
}
