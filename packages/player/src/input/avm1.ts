// Mouse and keyboard input shared by an AS3 host and the AVM1 movies its
// Loaders hold. The player has one focus, as Flash Player 32 keeps it: what
// a movie focuses takes it from the host's objects and the other movies,
// and an object of the host's that takes it takes it from the movies. Every
// key goes to each movie's Key listeners and clip events; the movie with
// the focus alone types or presses with it, and Tab moves through one order
// of the host's objects and the movies' (input/keyboard.ts).
import type { Avm1 } from "../avm1/avm1.js";
import type { Tabbed } from "../avm1/focus.js";
import { Avm1Keyboard } from "../avm1/keyboard.js";
import { Avm1Pointer } from "../avm1/pointer.js";
import { Container, type DisplayObject, type MovieClip } from "../display/display.js";
import type { Scripting } from "../scripting.js";
import type { MenuItem } from "./context-menu.js";
import { type KeyState, setFocus } from "./keyboard.js";
import type { Cursor, PointerState } from "./pointer.js";

export class LoadedAvm1Input {
  private readonly movies = new Map<MovieClip, Avm1Pointer>();
  private readonly keyboards = new Map<MovieClip, { vm: Avm1; keyboard: Avm1Keyboard }>();
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
    this.keyboards.set(root, { vm, keyboard: new Avm1Keyboard(vm) });
    vm.onFocus = (d) => {
      if (d === null) {
        return;
      }

      for (const [other, movie] of this.keyboards) {
        if (other !== root && movie.vm.focused !== null) {
          movie.vm.focus(null);
        }
      }

      setFocus(this.s, null);
    };
  }

  remove(root: MovieClip): boolean {
    const pointer = this.movies.get(root);
    if (this.over === pointer) {
      this.over = null;
    }

    const movie = this.keyboards.get(root);
    if (movie) {
      movie.vm.onFocus = null;
    }

    this.movies.delete(root);
    this.keyboards.delete(root);
    return this.movies.size === 0;
  }

  /** The keyboard of the movie whose focus is on something, which no object of the host's has then. */
  focused(): Avm1Keyboard | null {
    for (const { keyboard } of this.keyboards.values()) {
      if (keyboard.focused !== null) {
        return keyboard;
      }
    }

    return null;
  }

  /** What a movie's focus is on where its tracker shows the highlight, as Tab onto a button does. */
  highlighted(): DisplayObject | null {
    for (const { vm } of this.keyboards.values()) {
      const tracker = vm.focusTracker;
      if (!vm.halted && tracker.highlight === "visible" && tracker.focusedObject !== null) {
        return tracker.focusedObject;
      }
    }

    return null;
  }

  /** The objects Tab may focus in the movie `root` is the root of, or null for no such movie. */
  tabbables(root: DisplayObject): Tabbed[] | null {
    return this.keyboards.get(root as MovieClip)?.vm.focusTracker.tabbables() ?? null;
  }

  /** Tab's move of the focus to `d`, in the movie `root` is the root of. */
  tabTo(root: DisplayObject, d: DisplayObject): void {
    this.keyboards.get(root as MovieClip)?.vm.focus(d);
  }

  /** An object of the host's took the focus: no movie keeps it. */
  blur(): void {
    for (const { vm } of [...this.keyboards.values()]) {
      if (vm.focused !== null) {
        vm.focus(null);
      }
    }
  }

  /**
   * A key to each movie, as `edits` lets its host type (KeyboardInput's
   * handle), Tab moving nothing: every movie's Key listeners and clip
   * events, then the edit of the field that has the focus, as Flash Player
   * 32 orders them. Whether a movie used it.
   */
  key(type: "down" | "up", k: KeyState, edits: boolean): boolean {
    let used = false;
    // A listener may unload a movie, or load one, as the key goes round.
    for (const { keyboard } of [...this.keyboards.values()]) {
      if (keyboard.handle(type, k, edits, true)) {
        used = true;
      }
    }

    if (type === "down" && edits && !used && k.keyCode !== 9) {
      used = this.focused()?.edit(k) ?? false;
    }

    return used;
  }

  /**
   * A display object hidden: a movie whose focus is on it, or in it, loses
   * the focus at once, as Flash Player 32 takes it from a field whose Loader
   * is hidden, though not from one whose Loader leaves the stage.
   */
  hidden(d: DisplayObject): void {
    for (const { vm } of [...this.keyboards.values()]) {
      for (let p = vm.focused; p !== null; p = p.parent) {
        if (p === d) {
          vm.focus(null);
          break;
        }
      }
    }
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
    for (const [root, pointer] of this.movies) {
      const before = pointer.redraws;
      pointer.pickable = pointer === this.over;
      // A press on an object of the host's, not on the movie or its Loader, is no press on
      // nothing to the movie: it tracks no menu (Flash Player 32).
      if (type === "down") {
        pointer.hostPressed =
          target !== null && target !== this.s.stage && target !== root && target !== root.parent;
      }

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
    // A press over any movie's button, as its handlers left what is under the pointer, moves no
    // movie's focus (Flash Player 32), whether or not the press reaches the button.
    const keep = type === "down" && (this.over?.pressable(p.x, p.y) ?? false);
    for (const pointer of this.movies.values()) {
      const before = pointer.redraws;
      pointer.keepFocus = keep;
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

  /** The press each movie keeps from its broadcast, forgotten once the host is done with it. */
  forgetPress(): void {
    for (const pointer of this.movies.values()) {
      pointer.forgetPress();
    }
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

  /**
   * The menu a right click at `p` shows over a movie: the one whose root is
   * `target`, as the host picked it (its button), or held by `target`, a
   * Loader whose content's drawing is under the pointer; null where it is
   * no movie's or no clip of the movie there has a menu (avm1/avm1.ts menu).
   */
  menu(p: PointerState, target: DisplayObject | null): ReturnType<Avm1["menu"]> {
    let root: MovieClip | null = null;
    if (target !== null && this.movies.has(target as MovieClip)) {
      root = target as MovieClip;
    } else if (target instanceof Container) {
      root = (target.children.find((c) => this.movies.has(c as MovieClip)) as MovieClip) ?? null;
    }

    const pointer = root === null ? undefined : this.movies.get(root);
    const movie = root === null ? undefined : this.keyboards.get(root);
    if (root === null || pointer === undefined || movie === undefined) {
      return null;
    }

    const menu = movie.vm.menu(pointer.contentAt(p.x, p.y));
    if (menu === null) {
      return null;
    }

    // A movie unloaded, or a player destroyed, while its menu is open calls nothing.
    const movieRoot = root;
    const select = (item: MenuItem) => () => {
      if (this.movies.has(movieRoot) && !this.s.destroyed) {
        item.select();
      }
    };
    return { ...menu, items: menu.items.map((item) => ({ ...item, select: select(item) })) };
  }

  cursor(): Cursor | null {
    return this.over?.cursor() ?? null;
  }
}
