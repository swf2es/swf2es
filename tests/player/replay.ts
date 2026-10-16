// Ruffle's recorded input (a corpus test's input.json) played into the
// player, as Ruffle's test runner plays it: after each frame, the events
// up to the next Wait. Its keys come apart from its text, so a KeyDown
// sends the key's events and moves focus with Tab, and a field is edited
// by TextInput and TextControl alone. FocusGained, FocusLost and the IME's
// events are not played: the player has no window focus or composition to
// give them to.
import type { KeyState, Player, PointerState } from "@swf2es/player";

/** An event of Ruffle's input format (ruffle_input_format's AutomatedEvent). */
export type RecordedEvent = Record<string, unknown> & { type: string };

const BUTTONS: Record<string, number> = { Left: 0, Middle: 1, Right: 2 };
// A button's bit in PointerEvent.buttons.
const BUTTON_BITS = [1, 4, 2];

// Ruffle's named keys: Flash's key code, the character a field reads of it, and where it is.
const NAMED: Record<string, [number, number, number?]> = {
  ArrowDown: [40, 0],
  ArrowLeft: [37, 0],
  ArrowRight: [39, 0],
  ArrowUp: [38, 0],
  Backspace: [8, 8],
  CapsLock: [20, 0],
  Delete: [46, 127],
  End: [35, 0],
  Enter: [13, 13],
  Escape: [27, 27],
  Home: [36, 0],
  Insert: [45, 0],
  LeftAlt: [18, 0, 1],
  LeftControl: [17, 0, 1],
  LeftShift: [16, 0, 1],
  NumLock: [144, 0, 3],
  NumpadDelete: [46, 127, 3],
  NumpadDown: [40, 0, 3],
  NumpadEnd: [35, 0, 3],
  NumpadHome: [36, 0, 3],
  NumpadInsert: [45, 0, 3],
  NumpadLeft: [37, 0, 3],
  NumpadPageDown: [34, 0, 3],
  NumpadPageUp: [33, 0, 3],
  NumpadRight: [39, 0, 3],
  NumpadUp: [38, 0, 3],
  PageDown: [34, 0],
  PageUp: [33, 0],
  Pause: [19, 0],
  RightControl: [17, 0, 2],
  RightShift: [16, 0, 2],
  ScrollLock: [145, 0],
  Space: [32, 32],
  Tab: [9, 9],
  Unknown: [0, 0],
};
for (let i = 1; i <= 9; i++) {
  NAMED[`F${i}`] = [111 + i, 0];
}

// The key a character is typed with, by Ruffle's table of physical keys: a shifted symbol is its digit's.
const SHIFTED = ")!@#$%^&*(";
const PUNCTUATION: Record<string, number> = {
  ";": 186,
  ":": 186,
  "=": 187,
  "+": 187,
  ",": 188,
  "<": 188,
  "-": 189,
  _: 189,
  ".": 190,
  ">": 190,
  "/": 191,
  "?": 191,
  "`": 192,
  "~": 192,
  "[": 219,
  "{": 219,
  "\\": 220,
  "|": 220,
  "]": 221,
  "}": 221,
  "'": 222,
  '"': 222,
  " ": 32,
};
const NUMPAD: Record<string, number> = { "*": 106, "+": 107, "-": 109, ".": 110, "/": 111 };

/** Flash's key code, character and location of one of Ruffle's keys. */
function keyOf(key: unknown): [number, number, number] {
  if (typeof key === "string") {
    const [code, char, location] = NAMED[key] ?? [0, 0];
    return [code, char, location ?? 0];
  }

  const record = key as { Char?: string; Numpad?: string };
  if (record.Numpad !== undefined) {
    const c = record.Numpad;
    const digit = c >= "0" && c <= "9";
    return [digit ? 96 + Number(c) : (NUMPAD[c] ?? 0), c.charCodeAt(0), 3];
  }

  const c = record.Char ?? "";
  const upper = c.toUpperCase();
  const code =
    (upper >= "A" && upper <= "Z") || (c >= "0" && c <= "9")
      ? upper.charCodeAt(0)
      : SHIFTED.includes(c)
        ? 48 + SHIFTED.indexOf(c)
        : (PUNCTUATION[c] ?? 0);
  return [code, c.charCodeAt(0), 0];
}

// TextControl's codes as the keys a field edits by.
const CONTROLS: Record<string, [number, { ctrl?: boolean; shift?: boolean }]> = {
  MoveLeft: [37, {}],
  MoveLeftWord: [37, { ctrl: true }],
  MoveLeftLine: [36, {}],
  MoveLeftDocument: [36, { ctrl: true }],
  MoveRight: [39, {}],
  MoveRightWord: [39, { ctrl: true }],
  MoveRightLine: [35, {}],
  MoveRightDocument: [35, { ctrl: true }],
  SelectLeft: [37, { shift: true }],
  SelectLeftWord: [37, { ctrl: true, shift: true }],
  SelectLeftLine: [36, { shift: true }],
  SelectLeftDocument: [36, { ctrl: true, shift: true }],
  SelectRight: [39, { shift: true }],
  SelectRightWord: [39, { ctrl: true, shift: true }],
  SelectRightLine: [35, { shift: true }],
  SelectRightDocument: [35, { ctrl: true, shift: true }],
  SelectAll: [65, { ctrl: true }],
  Backspace: [8, {}],
  Delete: [46, {}],
  Enter: [13, {}],
};

export class Replay {
  private next = 0;
  private x = 0;
  private y = 0;
  private buttons = 0;
  private shift = false;
  private ctrl = false;
  private alt = false;
  /** The system's text, as the input set it or a copy took it; the player's own clipboard until then. */
  private clipboard: string | null = null;
  /** The time, a frame's duration more each frame: a double click is two clicks close in it. */
  private time = 0;
  /** When the last press came. */
  private pressed = 0;

  private readonly player: Player;
  private readonly events: readonly RecordedEvent[];

  constructor(player: Player, events: readonly RecordedEvent[]) {
    this.player = player;
    this.events = events;
  }

  /** A frame has run: the events up to the next Wait. */
  frame(): void {
    this.time += 1000 / (this.player.frameRate || 24);

    while (this.next < this.events.length) {
      const e = this.events[this.next++];
      if (e.type === "Wait") {
        return;
      }

      this.play(e);
    }
  }

  private play(e: RecordedEvent): void {
    const pointer = this.player.pointer;
    const keyboard = this.player.keyboard;
    switch (e.type) {
      case "MouseMove":
        [this.x, this.y] = e.pos as [number, number];
        pointer?.handle("move", this.point(0));
        break;

      case "MouseDown": {
        [this.x, this.y] = e.pos as [number, number];
        const button = BUTTONS[e.btn as string] ?? 0;
        // Ruffle's runner counts a press as a first click unless its index says it continues
        // one: the player tells them by time, so a first is far from the press before it, and
        // a second or third just after it, however many frames came between.
        this.time = e.index ? this.pressed + 1 : this.time + 10_000;
        this.pressed = this.time;
        this.buttons |= BUTTON_BITS[button];
        pointer?.handle("down", this.point(button));
        break;
      }

      case "MouseUp": {
        [this.x, this.y] = e.pos as [number, number];
        const button = BUTTONS[e.btn as string] ?? 0;
        this.buttons &= ~BUTTON_BITS[button];
        pointer?.handle("up", this.point(button));
        break;
      }

      case "MouseWheel": {
        // Ruffle's lines, or its pixels at a hundred a line.
        const lines = (e.lines as number | undefined) ?? (e.pixels as number) / 100;
        pointer?.wheel(this.point(0), Math.trunc(lines));
        break;
      }

      case "KeyDown":
      case "KeyUp": {
        const [keyCode, charCode, location] = keyOf(e.key);
        const down = e.type === "KeyDown";
        switch (keyCode) {
          case 16:
            this.shift = down;
            break;
          case 17:
            this.ctrl = down;
            break;
          case 18:
            this.alt = down;
            break;
        }

        keyboard?.handle(down ? "down" : "up", this.key(keyCode, charCode, location), false);
        break;
      }

      case "TextInput":
        // Typed, with no modifiers: Ctrl held is not a shortcut for text Ruffle types.
        keyboard?.text({ keyCode: 0, charCode: (e.codepoint as string).codePointAt(0) ?? 0 });
        break;

      case "TextControl": {
        const code = e.code as string;
        if (code === "Copy" || code === "Cut") {
          this.clipboard = keyboard?.copy(code === "Cut")?.text ?? this.clipboard;
          break;
        }

        if (code === "Paste") {
          keyboard?.paste(this.clipboard === null ? null : { text: this.clipboard });
          break;
        }

        const [keyCode, mods] = CONTROLS[code] ?? [0, {}];
        keyboard?.text({
          keyCode,
          charCode: { 8: 8, 13: 13, 46: 127 }[keyCode] ?? 0,
          ctrlKey: !!mods.ctrl,
          shiftKey: !!mods.shift,
        });
        break;
      }

      case "SetClipboardText":
        this.clipboard = e.text as string;
        break;
    }
  }

  private point(button: number): PointerState {
    return {
      x: this.x,
      y: this.y,
      button,
      buttons: this.buttons,
      altKey: this.alt,
      ctrlKey: this.ctrl,
      shiftKey: this.shift,
      time: this.time,
    };
  }

  private key(keyCode: number, charCode: number, location: number): KeyState {
    return {
      keyCode,
      charCode,
      location,
      ctrlKey: this.ctrl,
      altKey: this.alt,
      shiftKey: this.shift,
    };
  }
}
