// The deck: a fill of many wobbly closed contours stacked almost on top of each other, each turned
// a little from the last, so that neighbours cross at many points and libtess2's sweep slows
// with the square of the crossings, as one real morph shape's does (#1104, "pathological
// fills"). bench.ts --deck plays it.

/** Points a contour. */
export const DECK_POINTS = 200;

/** How far each contour turns from the one before, in radians. */
export const DECK_TURN = 0.004;

/** The deck's middle, the bench's stage's (800 by 600). */
const MIDDLE_X = 400;
const MIDDLE_Y = 300;

/**
 * `count` contours of DECK_POINTS points each, x and y in turn, in stage pixels rounded to twips
 * as a SWF holds them: ellipses of 140 by 200 pixels whose radius wobbles by 12 nine times
 * round, the c-th turned by `turn` + c times `step`, its wobble moved on by `phase`.
 */
export function deckContours(count: number, turn = 0, phase = 0, step = DECK_TURN): number[][] {
  const contours: number[][] = [];
  for (let c = 0; c < count; c++) {
    const a = turn + c * step;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const points: number[] = [];
    for (let k = 0; k < DECK_POINTS; k++) {
      const u = (k / DECK_POINTS) * Math.PI * 2;
      const r = 200 + 12 * Math.sin(u * 9 + phase);
      const x = r * Math.cos(u) * 0.7;
      const y = r * Math.sin(u);
      points.push(
        Math.round((MIDDLE_X + x * cos - y * sin) * 20) / 20,
        Math.round((MIDDLE_Y + x * sin + y * cos) * 20) / 20,
      );
    }

    contours.push(points);
  }

  return contours;
}

/** The box every deck contour lies in, whatever its turn: [x0, x1, y0, y1] in stage pixels. */
export const DECK_BOX = [MIDDLE_X - 212, MIDDLE_X + 212, MIDDLE_Y - 212, MIDDLE_Y + 212];
