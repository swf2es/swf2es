// Mouse input shared by an AS3 host and the AVM1 movies its Loaders hold.
import type { Avm1 } from "../avm1/avm1.js";
import { Avm1Pointer } from "../avm1/pointer.js";
import type { DisplayObject, MovieClip } from "../display/display.js";
import type { Scripting } from "../scripting.js";
import type { Cursor, PointerState } from "./pointer.js";

export class LoadedAvm1Input {
  private readonly movies = new Map<MovieClip, Avm1Pointer>();
  private over: Avm1Pointer | null = null;

  constructor(private readonly s: Scripting) {}

  add(root: MovieClip, vm: Avm1): void {
    const stage = this.s.stage;
    if (!stage) {
      return;
    }

    const pointer = new Avm1Pointer(stage, vm, root);
    pointer.onCursor = () => this.s.pointer?.updateCursor();
    this.movies.set(root, pointer);
  }

  remove(root: MovieClip): boolean {
    const pointer = this.movies.get(root);
    if (this.over === pointer) {
      this.over = null;
    }

    this.movies.delete(root);
    return this.movies.size === 0;
  }

  /** A stable callback for the AS3 pick: the AVM1Movie stands in for its interactive children. */
  readonly hit = (root: MovieClip, x: number, y: number): boolean =>
    this.movies.get(root)?.hit(x, y) ?? false;

  broadcast(type: "move" | "down" | "up", p: PointerState): void {
    for (const pointer of this.movies.values()) {
      pointer.broadcast(type, p);
    }
  }

  /** Global listeners ran already; only the winning movie gets button picks. */
  prepare(type: "move" | "down" | "up", p: PointerState, target: DisplayObject | null): number {
    this.over = this.movies.get(target as MovieClip) ?? null;
    let redraws = 0;
    for (const pointer of this.movies.values()) {
      const before = pointer.redraws;
      pointer.pickable = pointer === this.over;
      if (type === "move") {
        pointer.handle(type, p, false);
      } else {
        pointer.sync(p, pointer.pickable);
      }

      redraws += pointer.redraws - before;
    }

    return redraws;
  }

  finish(type: "down" | "up", p: PointerState): number {
    let redraws = 0;
    for (const pointer of this.movies.values()) {
      const before = pointer.redraws;
      pointer.handle(type, p, false);
      redraws += pointer.redraws - before;
    }

    return redraws;
  }

  sync(p: PointerState, target: DisplayObject | null): number {
    this.over = this.movies.get(target as MovieClip) ?? null;
    let redraws = 0;
    for (const pointer of this.movies.values()) {
      const before = pointer.redraws;
      pointer.sync(p, pointer === this.over);
      redraws += pointer.redraws - before;
    }

    return redraws;
  }

  leave(p: PointerState): number {
    let redraws = 0;
    this.over = null;
    for (const pointer of this.movies.values()) {
      const before = pointer.redraws;
      pointer.handle("leave", p, false);
      redraws += pointer.redraws - before;
    }

    return redraws;
  }

  cursor(): Cursor | null {
    return this.over?.cursor() ?? null;
  }
}
