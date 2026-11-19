// Mouse and keyboard input shared by an AS3 host and the AVM1 movies its
// Loaders hold. The player has one focus, as Flash Player 32 keeps it: what
// a movie focuses takes it from the host's objects and the other movies,
// and an object of the host's that takes it takes it from the movies. Every
// key goes to each movie's Key listeners and clip events; the movie with
// the focus alone types or presses with it, and Tab moves through one order
// of the host's objects and the movies' (input/keyboard.ts).
import type { avm1 } from "@swf2es/runtime";
import type { Avm1 } from "../avm1/avm1.js";
import type { FocusHost, Tabbed } from "../avm1/focus.js";
import { Avm1Keyboard } from "../avm1/keyboard.js";
import { pathOf } from "../avm1/paths.js";
import { Avm1Pointer } from "../avm1/pointer.js";
import type { DisplayObject, MovieClip } from "../display/display.js";
import type { Scripting } from "../scripting.js";
import { type KeyState, setFocus } from "./keyboard.js";
import type { Cursor, PointerState } from "./pointer.js";

export class LoadedAvm1Input implements FocusHost {
  private readonly movies = new Map<MovieClip, Avm1Pointer>();
  private readonly keyboards = new Map<MovieClip, { vm: Avm1; keyboard: Avm1Keyboard }>();
  private over: Avm1Pointer | null = null;
  /** Whether a movie's move of the focus is taking it from AS3, which tells the movies nothing more. */
  private moving = false;
  /** The object hearing onKillFocus, which no move inside it kills again. */
  private killing: DisplayObject | null = null;
  /** The movie being unloaded, which nothing focuses. */
  private dying: Avm1 | null = null;
  /** The movie that had the focus as the press being handled came. */
  private pressHolder: Avm1 | null = null;

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
    vm.focusHost = this;
  }

  /**
   * A movie about to be unloaded: what it has focused loses the focus, its
   * onKillFocus and every movie's Selection listeners told, as Flash Player
   * 32 tells them, though there after the unload call returned; nothing
   * focuses one of its objects again then.
   */
  unloading(root: MovieClip): void {
    const movie = this.keyboards.get(root);
    if (movie && movie.vm.focused !== null) {
      // Nothing of its own takes the focus back as it goes: its fields are gone to Flash's
      // listeners by then.
      this.dying = movie.vm;
      try {
        movie.vm.focus(null);
      } finally {
        this.dying = null;
      }
    }
  }

  remove(root: MovieClip): boolean {
    const pointer = this.movies.get(root);
    if (this.over === pointer) {
      this.over = null;
    }

    const movie = this.keyboards.get(root);
    if (movie) {
      movie.vm.focusHost = null;
    }

    this.movies.delete(root);
    this.keyboards.delete(root);
    return this.movies.size === 0;
  }

  /** The movie whose focus is on something, which no object of the host's has then. */
  private holder(): Avm1 | null {
    for (const { vm } of this.keyboards.values()) {
      if (vm.focused !== null) {
        return vm;
      }
    }

    return null;
  }

  get current(): DisplayObject | null {
    return this.holder()?.focused ?? this.s.focus;
  }

  /**
   * A movie's move of the one focus, as Flash Player 32 tells it: what had
   * it hears onKillFocus naming what takes it, in whichever movie, then
   * that onSetFocus naming what had it, then every movie's Selection
   * listeners, in the order the movies came; an object of AS3's is null to
   * them, and loses the focus last, with a focusOut naming nothing.
   */
  move(movie: Avm1, d: DisplayObject | null, byPointer: boolean): void {
    const holder = this.holder();
    if ((d === null && holder !== movie) || (d !== null && movie === this.dying)) {
      return;
    }

    const tracker = movie.focusTracker;
    const old = holder?.focused ?? null;
    if (holder === movie && old === d) {
      tracker.assign(d);
      tracker.selectFocused(byPointer);
      return;
    }

    // What had the focus keeps it as it hears onKillFocus: its Selection.setFocus of itself
    // there moves nothing, and the move goes on (Flash Player 32). Any other move there would
    // kill it again: Flash Player 32 does, over and over till its AVM1 stack overflows, and then
    // leaves the focus where the move was going, or nowhere; the player kills it once, and the
    // move under way wins.
    if (old !== null && old === this.killing) {
      return;
    }

    const oldFace = old?.avm1 ?? null;
    const newFace = d?.avm1 ?? null;
    if (holder !== null && old !== null) {
      this.killing = old;
      try {
        holder.focusTracker.killed(old, newFace);
      } finally {
        this.killing = null;
      }

      if (this.current !== old) {
        return;
      }
    }

    holder?.focusTracker.assign(null);
    tracker.assign(d);
    if (d !== null) {
      tracker.given(d, oldFace);
    }

    // A handler that moved the focus on told the movies of that move itself.
    if (movie.focused !== d) {
      return;
    }

    this.selectionMoved(oldFace, newFace);
    tracker.selectFocused(byPointer);

    if (d !== null && this.s.focus !== null) {
      this.moving = true;
      try {
        setFocus(this.s, null);
      } finally {
        this.moving = false;
      }
    }
  }

  /**
   * Every movie's Selection listeners hear onSetFocus(old, new), in the
   * order the movies came: all of them, though one moved the focus on, as
   * Flash Player 32 goes on telling the rest of the move they heard.
   */
  private selectionMoved(old: avm1.Avm1Object | null, next: avm1.Avm1Object | null): void {
    for (const { vm } of [...this.keyboards.values()]) {
      vm.focusTracker.moved(old, next);
    }
  }

  /**
   * AS3's focus moving from one of its objects, or none, to another, or
   * none: every movie's Selection listeners hear onSetFocus(null, null)
   * first, as Flash Player 32 tells them, unless a movie's move of the
   * focus took it.
   */
  hostMoved(): void {
    if (!this.moving) {
      this.selectionMoved(null, null);
    }
  }

  clear(): void {
    const holder = this.holder();
    if (holder !== null) {
      holder.focus(null);
      return;
    }

    setFocus(this.s, null);
  }

  pathOf(d: DisplayObject): string | null {
    for (let p: DisplayObject | null = d; p !== null; p = p.parent) {
      const movie = this.keyboards.get(p as MovieClip);
      if (movie) {
        return movie.vm.pathOf(d);
      }
    }

    // An object of AS3's, from the root as level 0 (Flash Player 32's `_level0.as3field`).
    const { root, stage } = this.s;
    return pathOf(d, (o) => (o === root || o === stage ? 0 : null));
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
    this.holder()?.focus(null);
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
    if (type === "down") {
      this.pressHolder = this.holder();
    }

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
    // A press over any movie's button, as its handlers left what is under the pointer, moves no
    // movie's focus (Flash Player 32), whether or not the press reaches the button.
    const keep = type === "down" && (this.over?.pressable(p.x, p.y) ?? false);
    // The movie pressed first: a field it focuses takes the focus from another movie's, which
    // hears onKillFocus naming it (Flash Player 32), before the press elsewhere drops it.
    const pointers = [...this.movies.entries()];
    if (this.over !== null) {
      pointers.sort(([, a], [, b]) => (a === this.over ? -1 : b === this.over ? 1 : 0));
    }

    for (const [root, pointer] of pointers) {
      const before = pointer.redraws;
      // A movie not pressed takes away only a focus it had as the press came: not one a script
      // gave it as the press's AS3 handlers ran (a Selection listener's, Flash Player 32).
      const vm = this.keyboards.get(root)?.vm ?? null;
      pointer.keepFocus =
        keep || (type === "down" && pointer !== this.over && vm !== this.pressHolder);
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
    this.pressHolder = null;
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

  cursor(): Cursor | null {
    return this.over?.cursor() ?? null;
  }
}
