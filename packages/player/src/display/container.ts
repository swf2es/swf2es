// A display object with children. It keeps them in render order, which
// is their index in AS3, and apart from it the children the timeline
// placed, by depth, which is how SWF tags address them; a child the
// timeline places goes before the first child of a greater depth.
import { CHILDREN, DisplayObject, OTHER, scriptWork } from "./displayobject.js";
import type { Library } from "./timeline.js";
import type { WalkList } from "./walk.js";

export class Container extends DisplayObject {
  /** The library whose timeline this is, for what it tells of children going; a script's container has none. */
  library: Library | null = null;
  /** Its children in render order: index 0 is drawn first, below the rest. */
  readonly children: DisplayObject[] = [];
  /** The children the timeline placed, by depth. */
  readonly depths = new Map<number, DisplayObject>();
  /** Whether a descendant changed since the renderer last synced. */
  descendantsDirty = true;
  /**
   * The clips and buttons the frame's walks visit at and under it, in
   * their order, kept while no clip or container comes or goes below it
   * (walkList), and its arrays after, to be made again in; null where it
   * has never been long enough to keep.
   */
  walk: WalkList | null = null;
  /** Counts the children put on the list, for removeAtDepth to see whether a listener put one back. */
  protected puts = 0;

  constructor() {
    super();
    this.frameChildren = this.children;
  }

  /**
   * A child came, went or moved: the walks' lists that hold it are made
   * again, those of this container and every one above it. Not for a
   * leaf, a shape or a text, which no walk visits: a timeline's shapes
   * swapped every frame leave the lists be.
   */
  protected relist(child: DisplayObject): void {
    if (child.kind === OTHER && child.frameChildren.length === 0) {
      return;
    }

    for (let p: Container | null = this; p; p = p.parent) {
      const walk = p.walk;
      if (walk?.current) {
        walk.current = false;
        // Emptied, its room kept: one no walk makes again, off the list or now too short to
        // keep, would hold what left it alive.
        (walk.items as (DisplayObject | null)[]).fill(null);
      }
    }
  }

  /** Place `child` at timeline depth `depth`: before the first child of a greater depth. */
  placeAtDepth(child: DisplayObject, depth: number): void {
    this.removeAtDepth(depth);
    let index = this.children.length;
    for (let i = 0; i < this.children.length; i++) {
      const d = this.children[i].depth;
      if (d !== null && d > depth) {
        index = i;
        break;
      }
    }

    child.depth = depth;
    child.parent = this;
    this.children.splice(index, 0, child);
    this.puts++;
    this.depths.set(depth, child);
    this.relist(child);
    this.invalidate(CHILDREN);
    scriptWork.changes++;
  }

  removeAtDepth(depth: number): DisplayObject | null {
    const child = this.depths.get(depth);
    if (!child) {
      return null;
    }

    // An AVM1 clip with an unload handler stays, drawn, at a depth below
    // the timeline's until the next frame, as Flash keeps one (avm1/avm1.ts).
    if (this.library?.avm1?.keeps(child)) {
      const kept = -depth - 1;
      this.depths.delete(depth);
      this.depths.set(kept, child);
      child.depth = kept;
      return child;
    }

    // The timeline's removal: a script's goes through the natives, which tell of it themselves.
    // Flash has the child out of the list while it tells of it, still its parent's: the
    // siblings' indexes have closed up, and the parent no longer finds it there (#2025).
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.takeOut(child, index);
    }

    const puts = this.puts;
    this.library?.removing?.(child, true);
    this.library?.sounds?.removed(child);
    // A listener may have put it on this list again (which Flash does not survive). Where
    // nothing was put on it meanwhile, the search, a whole list's on every removal, is spared.
    if (child.parent === this && (this.puts === puts || !this.children.includes(child))) {
      child.parent = null;
      child.focusDrop?.(child);
    }

    return child;
  }

  /**
   * Take `child` out, wherever it is in the list, and off the timeline's
   * depths; nothing for one not in it, which a listener of its removal may
   * have taken out already.
   */
  removeChild(child: DisplayObject): void {
    const index = this.children.indexOf(child);
    if (index < 0) {
      return;
    }

    this.takeOut(child, index);
    child.parent = null;
    child.focusDrop?.(child);
  }

  /** `child`, at `index`, out of the list and off the depths; its parent is left to the caller. */
  private takeOut(child: DisplayObject, index: number): void {
    if (child.depth !== null) {
      this.depths.delete(child.depth);
      child.depth = null;
    }

    this.children.splice(index, 1);
    this.relist(child);
    this.invalidate(CHILDREN);
    scriptWork.changes++;
  }

  /**
   * Put `child` at `index` in render order, as a script's addChildAt does:
   * out of its parent first, and off the timeline's depths, which no
   * longer place it.
   */
  addChildAt(child: DisplayObject, index: number): void {
    const same = child.parent === this;
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.splice(same ? Math.min(index, this.children.length) : index, 0, child);
    this.puts++;
    this.relist(child);
    this.invalidate(CHILDREN);
    scriptWork.changes++;
  }

  swapChildren(a: DisplayObject, b: DisplayObject): void {
    const i = this.children.indexOf(a);
    const j = this.children.indexOf(b);
    this.children[i] = b;
    this.children[j] = a;
    this.relist(a);
    this.relist(b);
    this.invalidate(CHILDREN);
    scriptWork.changes++;
  }
}
