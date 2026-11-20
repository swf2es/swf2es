/**
 * The most blends drawn direct, reading what is below or not, offered
 * after one copy of it, which bounds the rectangles each is compared with.
 */
export const SHARED_MOST = 64;

/**
 * How much larger than the rectangles it holds a box copied for them may
 * be, by area, before a rectangle far from the others is copied apart.
 */
export const SPREAD = 2;

/**
 * Which consecutive blends drawn direct (WebGLBackend.blendDirect) share
 * one copy of what is below (Compositor.copyBoxes), and the boxes it
 * copies. The copy made before the first is still what is below each one
 * after it whose rectangle meets none drawn since: a blend drawn direct
 * draws inside its rectangle alone. The blends are offered in order, those
 * that do not read what is below as well, as what they draw counts.
 *
 * A rectangle is copied in the box of others it lies near: one box where
 * all of them together are at most SPREAD times their area, else apart, as
 * a union of rectangles far apart would copy far more than they hold, or,
 * where the copy is not made where its rectangles lie (`spread` false),
 * not shared.
 */
export class Backdrops {
  /** The blends' commands that share the copy, each with its box, `shared` of them. */
  private readonly commands: number[] = [];
  private readonly boxOf: number[] = [];
  private shared = 0;
  /** What was drawn since the copy, as least x and y, greatest x and y, `drawnCount` of them. */
  private readonly drawn: number[] = [];
  private drawnCount = 0;
  /**
   * The boxes copied, x, y, width and height each in the target's
   * framebuffer, as Compositor.copyBoxes takes them, and the area of the
   * rectangles each holds; `boxCount` of them, past which the arrays hold
   * an earlier copy's.
   */
  readonly boxes: number[] = [];
  private readonly areas: number[] = [];
  boxCount = 0;
  /** Which copy the blends share (Compositor.copies), set once it is made. */
  copy = -1;
  private spread = true;

  /** None shared, for a copy to be made for the blends offered from here on. */
  begin(spread: boolean): void {
    this.shared = 0;
    this.drawnCount = 0;
    this.boxCount = 0;
    this.copy = -1;
    this.spread = spread;
  }

  /**
   * The next blend drawn direct, at command `command`, over rectangle `x`,
   * `y`, `width`, `height` of the target's framebuffer, which `reads` what
   * is below or not: whether the copy holds what is below it as it draws.
   * One that does not ends the blends that share it, as does the one past
   * SHARED_MOST.
   */
  offer(
    command: number,
    x: number,
    y: number,
    width: number,
    height: number,
    reads: boolean,
  ): boolean {
    if (this.drawnCount >= SHARED_MOST) {
      return false;
    }

    const drawn = this.drawn;
    const right = x + width;
    const top = y + height;

    if (reads) {
      for (let a = 0; a < this.drawnCount * 4; a += 4) {
        if (drawn[a] < right && x < drawn[a + 2] && drawn[a + 1] < top && y < drawn[a + 3]) {
          return false;
        }
      }

      const box = this.box(x, y, width, height);
      if (box < 0) {
        return false;
      }

      this.commands[this.shared] = command;
      this.boxOf[this.shared] = box;
      this.shared++;
    }

    const at = this.drawnCount++ * 4;
    drawn[at] = x;
    drawn[at + 1] = y;
    drawn[at + 2] = right;
    drawn[at + 3] = top;
    return true;
  }

  /** The box that holds the rectangle of the blend at command `command`, -1 for one not shared. */
  boxFor(command: number): number {
    const commands = this.commands;
    for (let n = 0; n < this.shared; n++) {
      if (commands[n] === command) {
        return this.boxOf[n];
      }
    }

    return -1;
  }

  /** The box a rectangle is copied in, grown to hold it or new; -1 for none. */
  private box(x: number, y: number, width: number, height: number): number {
    const boxes = this.boxes;
    const areas = this.areas;
    const area = width * height;
    for (let b = 0; b < this.boxCount; b++) {
      const at = b * 4;
      const x0 = Math.min(boxes[at], x);
      const y0 = Math.min(boxes[at + 1], y);
      const x1 = Math.max(boxes[at] + boxes[at + 2], x + width);
      const y1 = Math.max(boxes[at + 1] + boxes[at + 3], y + height);
      if ((x1 - x0) * (y1 - y0) <= SPREAD * (areas[b] + area)) {
        boxes[at] = x0;
        boxes[at + 1] = y0;
        boxes[at + 2] = x1 - x0;
        boxes[at + 3] = y1 - y0;
        areas[b] += area;
        return b;
      }
    }

    if (this.boxCount > 0 && !this.spread) {
      return -1;
    }

    const b = this.boxCount++;
    boxes[b * 4] = x;
    boxes[b * 4 + 1] = y;
    boxes[b * 4 + 2] = width;
    boxes[b * 4 + 3] = height;
    areas[b] = area;
    return b;
  }
}
