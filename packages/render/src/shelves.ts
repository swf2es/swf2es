// Rectangles placed side by side on pages, in shelves, in the order they
// come: a frame's held layers and their filters' targets (plan, HOLD_PUSH),
// each of a page a pass draws into with the others of its kind.

/** Rectangles on pages `width` wide and at most `most` high, each page as high as they need. */
export class Shelves {
  /** Each rectangle's page, and its corner there. */
  readonly page: number[] = [];
  readonly x: number[] = [];
  readonly y: number[] = [];
  count = 0;
  /** Each page's height, as far down as its rectangles reach. */
  readonly heights: number[] = [];
  pages = 0;
  private width = 0;
  private most = 0;
  /** Where the shelf open starts, how high it is, and how far along it is filled. */
  private shelf = 0;
  private shelfHeight = 0;
  private along = 0;

  /** Empty, for pages `width` wide and at most `most` high. */
  reset(width: number, most: number): void {
    this.width = width;
    this.most = most;
    this.count = 0;
    this.pages = 0;
    this.shelf = 0;
    this.shelfHeight = 0;
    this.along = 0;
  }

  /** A rectangle `w` by `h` placed: its number; -1 for one larger than a page. */
  add(w: number, h: number): number {
    if (w > this.width || h > this.most) {
      return -1;
    }

    if (this.pages === 0) {
      this.newPage();
    }

    if (this.along + w > this.width) {
      this.shelf += this.shelfHeight;
      this.shelfHeight = 0;
      this.along = 0;
    }

    if (this.shelf + h > this.most) {
      this.newPage();
    }

    const i = this.count++;
    const page = this.pages - 1;
    this.page[i] = page;
    this.x[i] = this.along;
    this.y[i] = this.shelf;
    this.along += w;
    this.shelfHeight = Math.max(this.shelfHeight, h);
    this.heights[page] = Math.max(this.heights[page], this.shelf + this.shelfHeight);
    return i;
  }

  private newPage(): void {
    this.heights[this.pages++] = 0;
    this.shelf = 0;
    this.shelfHeight = 0;
    this.along = 0;
  }
}
