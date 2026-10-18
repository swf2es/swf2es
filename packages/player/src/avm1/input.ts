// An AVM1 movie's input as its scripts see it: Key's state and its
// listeners, keyPress's buttons and clips, Mouse's listeners and wheel,
// and the pointer's button events to buttons and to clips in button mode,
// in Ruffle's (https://github.com/ruffle-rs/ruffle) order (Avm1Button,
// MovieClip's event_dispatch: MIT OR Apache-2.0, Copyright (c) 2018-2022
// Ruffle LLC and Ruffle contributors). avm1/keyboard.ts and
// avm1/pointer.ts turn the host's events into these.
import { ButtonCondition, ClipEvent } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import { ButtonObject, Container, type DisplayObject, MovieClip } from "../display/display.js";
import type { Avm1 } from "./avm1.js";
import type { InputState } from "./globals/Key.js";
import { ClipNative, nativeOf } from "./globals/MovieClip.js";
import { BLOCK, NO_ARGS, NO_BLOCKS, NORMAL, NOTIFY, Queued } from "./queue.js";
import { handlersOfButton, NO_HANDLERS } from "./swf.js";

/** The pointer's events that make a clip a button where its clip actions have one (Ruffle's BUTTON_EVENT_FLAGS). */
const BUTTON_EVENTS =
  ClipEvent.press |
  ClipEvent.release |
  ClipEvent.releaseOutside |
  ClipEvent.rollOver |
  ClipEvent.rollOut |
  ClipEvent.dragOver |
  ClipEvent.dragOut |
  ClipEvent.keyPress;

/** The AS2 methods that make a clip a button where its object, or what it inherits, has one. */
const BUTTON_METHODS = [
  "onPress",
  "onRelease",
  "onReleaseOutside",
  "onRollOver",
  "onRollOut",
  "onDragOver",
  "onDragOut",
];

/** The button transition each of the pointer's events is, by the event's bit (Ruffle's Avm1Button). */
const CONDITIONS = new Map<number, number>([
  [ClipEvent.rollOver, ButtonCondition.idleToOverUp],
  [ClipEvent.rollOut, ButtonCondition.overUpToIdle],
  [ClipEvent.press, ButtonCondition.overUpToOverDown],
  [ClipEvent.release, ButtonCondition.overDownToOverUp],
  [ClipEvent.releaseOutside, ButtonCondition.outDownToIdle],
  [ClipEvent.dragOut, ButtonCondition.overDownToOutDown],
  [ClipEvent.dragOver, ButtonCondition.outDownToOverDown],
]);

/** The frame label a clip in button mode goes to and stops at on each of the pointer's events. */
const LABELS = new Map<number, string>([
  [ClipEvent.rollOut, "_up"],
  [ClipEvent.releaseOutside, "_up"],
  [ClipEvent.rollOver, "_over"],
  [ClipEvent.release, "_over"],
  [ClipEvent.dragOut, "_over"],
  [ClipEvent.press, "_down"],
  [ClipEvent.dragOver, "_down"],
]);

/** What Mouse's listeners hear of the pointer's clip events. */
const MOUSE_MESSAGES = new Map<number, string>([
  [ClipEvent.mouseMove, "onMouseMove"],
  [ClipEvent.mouseDown, "onMouseDown"],
  [ClipEvent.mouseUp, "onMouseUp"],
]);

/** The state a button goes to on each of the pointer's events (Ruffle's Avm1Button: a drag out shows over). */
const BUTTON_STATES = new Map<number, "up" | "over" | "down">([
  [ClipEvent.rollOver, "over"],
  [ClipEvent.rollOut, "up"],
  [ClipEvent.press, "down"],
  [ClipEvent.release, "over"],
  [ClipEvent.releaseOutside, "up"],
  [ClipEvent.dragOut, "over"],
  [ClipEvent.dragOver, "down"],
]);

/** The movie's keys and pointer, as its scripts see them. */
export class Avm1Input implements InputState {
  /** The keys down by Flash's codes, the mouse's buttons among them as 1, 2 and 4. */
  private readonly keysDown = new Set<number>();
  /**
   * The keys toggled on, by their codes: each press of a key, a mouse
   * button's too, turns it on or off, Caps Lock's as any other's (the
   * corpus's `key_isToggled`).
   */
  private readonly toggled = new Set<number>();
  keyCode = 0;
  keyAscii = 0;
  private shown = true;
  /** `_global.Key` and `_global.Mouse`, whose listeners the player sends their messages. */
  keyFace: avm1.Avm1Object | null = null;
  mouseFace: avm1.Avm1Object | null = null;

  constructor(private readonly movie: Avm1) {}

  keyIsDown(code: number): boolean {
    return this.keysDown.has(code);
  }

  keyToggled(code: number): boolean {
    return this.toggled.has(code);
  }

  /**
   * Every key let go, with no event, as the player loses focus
   * (Player.setActive): their releases go elsewhere and never come. The
   * mouse's buttons, 1, 2 and 4, stay the pointer's, which tells their
   * releases. What is toggled stays, as a release toggles nothing.
   */
  releaseKeys(): void {
    for (const code of this.keysDown) {
      if (code !== 1 && code !== 2 && code !== 4) {
        this.keysDown.delete(code);
      }
    }
  }

  get mouseShown(): boolean {
    return this.shown;
  }

  set mouseShown(shown: boolean) {
    this.shown = shown;
    this.movie.pointer?.updateCursor();
  }

  /** A mouse button, as the pointer gives it (0 left, 1 middle, 2 right), down or up: Key's 1, 4 or 2. */
  mouseButton(button: number, down: boolean): void {
    const code = button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 0;
    if (code === 0) {
      return;
    }

    this.keyState(code, down);
  }

  /**
   * A key down or up in Key's state: the last key, a press toggling it
   * unless it was already down (a held key's repeats do not), as Ruffle's
   * input state has it.
   */
  private keyState(code: number, down: boolean): void {
    this.keyCode = code;
    if (code === 0) {
      return;
    }

    if (!down) {
      this.keysDown.delete(code);
      return;
    }

    if (!this.keysDown.has(code) && !this.toggled.delete(code)) {
      this.toggled.add(code);
    }

    this.keysDown.add(code);
  }

  /**
   * A key pressed or let go (avm1/keyboard.ts), as Ruffle orders it:
   * every clip's keyDown or keyUp clip actions, as they are drawn, then Key's
   * listeners' onKeyDown or onKeyUp; then, for a press of a key that
   * `press` is a keyPress of, the first button or clip in the order they
   * are drawn whose keyPress it is runs its actions for it. The queue runs
   * once. Whether a keyPress ran.
   */
  key(
    down: boolean,
    keyCode: number,
    charCode: number,
    press: number,
    typed = 0,
    shift = false,
  ): boolean {
    if (this.movie.halted || !this.movie.loaded) {
      return false;
    }

    this.keyState(keyCode, down);
    this.keyAscii = charCode;
    this.movie.timers.begin();
    try {
      // To the clips as they are drawn, the lowest first, what is in one before it (Ruffle's order).
      // What has the focus also hears onKeyDown or onKeyUp, from SWF 6, while the highlight is active.
      const event = down ? ClipEvent.keyDown : ClipEvent.keyUp;
      const focused = this.movie.focusedObject;
      const heard =
        this.movie.version >= 6 &&
        this.movie.highlight !== "inactive" &&
        focused !== null &&
        this.flag(focused, "enabled")
          ? focused
          : null;
      const visit = (d: DisplayObject) => {
        if (d instanceof Container) {
          for (const child of d.children) {
            visit(child);
          }
        }

        if (d instanceof MovieClip) {
          this.movie.dispatch(d, event, d === heard);
        } else if (d instanceof ButtonObject && d === heard) {
          this.movie.method(d, event, false);
        }
      };
      for (const level of this.movie.levelClips()) {
        visit(level);
      }

      this.notify(this.keyFace, down ? "onKeyDown" : "onKeyUp");
      const pressed = down && press !== 0 && this.queueKeyPress(press);

      // A key no keyPress took: Tab moves the focus, after what is queued runs; Enter and Space
      // press what has it.
      let used = pressed;
      if (down && !pressed && keyCode === 9) {
        this.movie.queue.run();
        // A movie with nothing to tab to leaves Tab to the page.
        used = this.movie.tab(shift);
      } else if (down && !pressed && (keyCode === 13 || typed === 32)) {
        // A press it made keeps the page from acting on the key too: Space would scroll it.
        used = this.movie.activate();
      }

      this.movie.queue.run();
      return used;
    } finally {
      this.movie.timers.end();
    }
  }

  /** Text typed with no key events (avm1/keyboard.ts): a keyPress of its character, as `key` runs one. */
  keyPress(press: number): boolean {
    if (this.movie.halted || !this.movie.loaded || press === 0) {
      return false;
    }

    this.movie.timers.begin();
    try {
      const pressed = this.queueKeyPress(press) || (press === 32 && this.movie.activate());
      this.movie.queue.run();
      return pressed;
    } finally {
      this.movie.timers.end();
    }
  }

  /**
   * The first button or clip, as they are drawn, the lowest first and what
   * is in one before it, whose keyPress is `press`: a button's condition
   * blocks with that key, enabled or not, with its parent as target; a
   * clip's `on (keyPress)` clip actions. A hidden clip takes none, nor what
   * is in it, a hidden button none while it is up, and a button in a button
   * none. Whether one was queued.
   */
  private queueKeyPress(press: number): boolean {
    const visit = (d: DisplayObject, inButton: boolean): boolean => {
      const button = d instanceof ButtonObject ? d : null;
      if (!d.visible && (button === null || button.state === "up")) {
        return false;
      }

      if (d instanceof Container) {
        for (const child of d.children) {
          if (visit(child, inButton || button !== null)) {
            return true;
          }
        }
      }

      if (button) {
        const id = button.character?.id;
        let found = false;
        if (!inButton && button.parent !== null && id !== undefined) {
          const swf = this.movie.swfOf(button);
          for (const h of handlersOfButton(swf, id)) {
            if (h.key === press) {
              this.movie.queue.enqueue(NORMAL, new Queued(BLOCK, button.parent, swf, h.block));
              found = true;
            }
          }
        }

        return found;
      }

      const native = d instanceof MovieClip ? nativeOf(d) : null;
      if (native !== null && this.movie.swfOf(d).version >= 5) {
        let found = false;
        for (const h of native.handlers ?? NO_HANDLERS) {
          if (h.events & ClipEvent.keyPress && h.key === press) {
            this.movie.queue.enqueue(NORMAL, new Queued(BLOCK, d, native.swf, h.block));
            found = true;
          }
        }

        return found;
      }

      return false;
    };

    return this.movie.levelClips().some((level) => visit(level, false));
  }

  /** `object`'s listeners told `name` with `args`, queued after what is queued now. */
  private notify(object: avm1.Avm1Object | null, name: string, args: avm1.Value[] = NO_ARGS): void {
    if (object !== null && this.movie.root !== null) {
      this.movie.queue.enqueue(
        NORMAL,
        new Queued(NOTIFY, this.movie.root, null, 0, 0, false, name, NO_BLOCKS, object, args),
      );
    }
  }

  /** Whether Mouse has listeners, which the wheel would tell: the page keeps it otherwise. */
  get mouseHeard(): boolean {
    const face = this.mouseFace;
    const listeners = face === null ? undefined : avm1.get(face, "_listeners", this.movie.version);
    return (
      listeners instanceof avm1.Avm1Object &&
      avm1.toNumber(avm1.get(listeners, "length", this.movie.version), this.movie.version) > 0
    );
  }

  /** The wheel turned by `delta` lines over `target`: Mouse's listeners' onMouseWheel, then the queue runs. */
  mouseWheel(delta: number, target: DisplayObject | null): void {
    if (this.movie.halted || !this.movie.loaded) {
      return;
    }

    this.movie.timers.begin();
    try {
      this.notify(this.mouseFace, "onMouseWheel", [delta, target?.avm1 ?? undefined]);
      this.movie.queue.run();
    } finally {
      this.movie.timers.end();
    }
  }

  /**
   * Whether the pointer takes `clip` as a button (Ruffle's is_button_mode):
   * its clip actions have one of the pointer's button events, or, below
   * the root, its object has one of their AS2 methods, its own or
   * inherited, a class's among them.
   */
  buttonMode(clip: MovieClip): boolean {
    const native = nativeOf(clip);
    for (const h of native?.handlers ?? NO_HANDLERS) {
      if (h.events & BUTTON_EVENTS) {
        return true;
      }
    }

    const face = clip.avm1;
    if (face === null || clip === this.movie.root || this.movie.version < 6) {
      return false;
    }

    for (const name of BUTTON_METHODS) {
      if (avm1.has(face, name, this.movie.version)) {
        return true;
      }
    }

    return false;
  }

  /** A button's or clip's AS2 flag, `enabled` or `useHandCursor`: true where it is undefined, as Flash reads it. */
  flag(d: DisplayObject, name: "enabled" | "useHandCursor"): boolean {
    const value = this.read(d, name);
    return value === undefined || avm1.toBoolean(value, this.movie.version);
  }

  /** What a clip's `hitArea` names, a clip or button the pointer tests in its place; null for none. */
  hitArea(clip: MovieClip): DisplayObject | null {
    if (this.movie.version < 6) {
      return null;
    }

    const area = this.read(clip, "hitArea");
    const display = area instanceof avm1.Avm1Object ? area.display : null;
    return display instanceof ClipNative ? display.target : null;
  }

  /**
   * `d`'s AVM1 object's property `name`, read as code reads it, in an
   * activation of `d`'s, as a getter `addProperty` gave it may be AVM1
   * code; undefined where it has no object, or the read throws. Within
   * a script, the begin and end go for nothing: the script's own hold.
   */
  read(d: DisplayObject, name: string): avm1.Value {
    const face = d.avm1;
    const cx = this.movie.halted ? null : this.movie.activationOf(d);
    if (face === null || cx === null) {
      return undefined;
    }

    let value: avm1.Value;
    this.movie.timers.begin();
    try {
      this.movie.rt.call(cx, () => {
        value = avm1.get(face, name, this.movie.version);
      });
    } finally {
      this.movie.timers.end();
    }

    return value;
  }

  /**
   * The pointer's button events, each to its object, in the order given,
   * then the queue runs once. A button runs its condition blocks for the
   * transition, with its parent as target, plays the transition's sound
   * and changes state, then, from SWF 6, its AS2 method; a clip in button
   * mode goes to the event's frame label, if it has one, and stops, then
   * runs its clip actions and method for it. Ruffle's order (Avm1Button
   * and MovieClip's event_dispatch).
   */
  buttonEvents(events: readonly (readonly [DisplayObject, number])[]): void {
    if (this.movie.halted || !this.movie.loaded || events.length === 0) {
      return;
    }

    this.movie.timers.begin();
    try {
      for (const [d, event] of events) {
        this.buttonDispatch(d, event);
      }

      this.movie.queue.run();
    } finally {
      this.movie.timers.end();
    }
  }

  /** One of the pointer's button events to `d`, a button or a clip in button mode, queued. */
  buttonDispatch(d: DisplayObject, event: number): void {
    if (this.movie.removed(d)) {
      return;
    }

    if (d instanceof ButtonObject) {
      this.buttonEvent(d, event);
    } else if (d instanceof MovieClip) {
      const label = LABELS.get(event);
      const timeline = this.movie.timeline(d);
      const frame = label === undefined ? undefined : timeline.labelFrame(label);
      if (frame !== undefined) {
        timeline.goto(frame, false);
      }

      this.movie.dispatch(d, event);
    }
  }

  private buttonEvent(button: ButtonObject, event: number): void {
    const condition = CONDITIONS.get(event) ?? 0;
    const parent = button.parent;
    const id = button.character?.id;
    if (parent !== null && id !== undefined) {
      const swf = this.movie.swfOf(button);
      for (const h of handlersOfButton(swf, id)) {
        if (h.conditions & condition) {
          this.movie.queue.enqueue(NORMAL, new Queued(BLOCK, parent, swf, h.block));
        }
      }
    }

    const state = BUTTON_STATES.get(event);
    if (state !== undefined && state !== button.state) {
      // A drag's transitions are silent.
      button.setState(state, event !== ClipEvent.dragOut && event !== ClipEvent.dragOver);
    }

    this.movie.method(button, event, false);
  }

  /**
   * Broadcast a pointer's event (avm1/pointer.ts): every clip's clip
   * actions for it, the newest first, then Mouse's listeners, then the
   * queue runs. A key's go by `key`.
   */
  clipEvent(event: number): void {
    if (this.movie.halted || !this.movie.loaded) {
      return;
    }

    this.movie.timers.begin();
    try {
      for (let i = this.movie.clips.length - 1; i >= 0; i--) {
        const clip = this.movie.clips[i];
        if (!this.movie.removed(clip)) {
          this.movie.dispatch(clip, event);
        }
      }

      // Mouse's listeners after every clip's, as Ruffle queues them.
      const message = MOUSE_MESSAGES.get(event);
      if (message !== undefined) {
        this.notify(this.mouseFace, message);
      }

      this.movie.queue.run();
    } finally {
      this.movie.timers.end();
    }
  }
}
