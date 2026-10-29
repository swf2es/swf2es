// What both views' pointer bindings (render/pointer.ts, scene/pointer.ts)
// take from the browser alike: where a client point lies on a canvas's
// pixels as CSS shows them, and the wheel's movement in Flash's lines.

/**
 * Where a client point lies on `canvas`'s pixels. CSS `object-fit` shows
 * them in a box of their own within the element's content box,
 * letterboxed by `contain`, cropped by `cover`, centred as the default
 * `object-position` puts it. Also the CSS pixels a canvas pixel spans each
 * way. `style` is the canvas's live computed style.
 */
export function canvasPoint(
  canvas: HTMLCanvasElement,
  style: CSSStyleDeclaration,
  clientX: number,
  clientY: number,
): [x: number, y: number, sx: number, sy: number] {
  // The content box: the element's rectangle within its borders and padding.
  const px = (v: string | undefined) => Number.parseFloat(v ?? "") || 0;
  const rect = canvas.getBoundingClientRect();
  let left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
  let top = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
  const width =
    rect.width -
    px(style.borderLeftWidth) -
    px(style.paddingLeft) -
    px(style.borderRightWidth) -
    px(style.paddingRight);
  const height =
    rect.height -
    px(style.borderTopWidth) -
    px(style.paddingTop) -
    px(style.borderBottomWidth) -
    px(style.paddingBottom);

  let sx = width / canvas.width;
  let sy = height / canvas.height;
  const fit = style.objectFit;
  if (fit === "contain" || fit === "scale-down" || fit === "cover" || fit === "none") {
    let scale = fit === "cover" ? Math.max(sx, sy) : fit === "none" ? 1 : Math.min(sx, sy);
    if (fit === "scale-down") {
      scale = Math.min(scale, 1);
    }

    left += (width - canvas.width * scale) / 2;
    top += (height - canvas.height * scale) / 2;
    sx = scale;
    sy = scale;
  }

  return [(clientX - left) / sx, (clientY - top) / sy, sx, sy];
}

/**
 * The wheel's movement in Flash's lines, up positive: 3 a notch, Flash's
 * delta on Windows. A browser gives a notch as 3 lines, or as about 100
 * pixels, fewer where the page is zoomed or the screen scaled, and several
 * at once as their multiple; a touchpad's few pixels at a time add up in
 * `left`, 100 to 3 lines, till a whole line is taken.
 */
export function wheelLines(left: { lines: number }, e: WheelEvent): number {
  const size = Math.abs(e.deltaY);
  if (e.deltaMode !== 0) {
    left.lines = -e.deltaY * (e.deltaMode === 2 ? 3 : 1);
  } else if (size >= 50) {
    left.lines = -Math.sign(e.deltaY) * 3 * Math.max(1, Math.round(size / 100));
  } else {
    left.lines -= (e.deltaY * 3) / 100;
  }

  const delta = Math.trunc(left.lines);
  left.lines -= delta;
  return delta;
}
