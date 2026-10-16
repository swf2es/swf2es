// The keyboard of an AVM1 movie: each key goes to Key, its clips' keyDown
// and keyUp clip actions, and a press to the first button or clip whose
// keyPress it is (Avm1.key). A keyPress's key is Flash's own code, as
// Ruffle's ButtonKeyCode has it (https://github.com/ruffle-rs/ruffle,
// core/src/events.rs: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle
// LLC and Ruffle contributors): a printable character's ASCII code, or one
// of the editing keys' below 20. A host whose text comes apart from its
// keys (the corpus's replay) gives the character by `text`.
import type { ClipboardText } from "../hosts.js";
import type { Keyboard, KeyState } from "../input/keyboard.js";
import type { Avm1 } from "./avm1.js";

/** The editing keys' keyPress codes, by Flash's key codes. */
const KEY_PRESSES = new Map<number, number>([
  [37, 1], // Left
  [39, 2], // Right
  [36, 3], // Home
  [35, 4], // End
  [45, 5], // Insert
  [46, 6], // Delete
  [8, 8], // Backspace
  [13, 13], // Enter
  [38, 14], // Up
  [40, 15], // Down
  [33, 16], // Page Up
  [34, 17], // Page Down
  [9, 18], // Tab
  [27, 19], // Escape
]);

/** A printable ASCII character's keyPress code, its own; 0 for any other. */
const printable = (charCode: number) => (charCode >= 32 && charCode <= 126 ? charCode : 0);

export class Avm1Keyboard implements Keyboard {
  handled = 0;

  constructor(private readonly avm1: Avm1) {}

  /** A key: its keyPress, where it is one, the editing key's, else, with edits, its character's. */
  handle(type: "down" | "up", k: KeyState, edits = true): boolean {
    this.handled++;
    if (type === "up") {
      this.avm1.key(false, k.keyCode, k.charCode, 0);
      return false;
    }

    const typed = edits ? printable(k.charCode) : 0;
    const press = KEY_PRESSES.get(k.keyCode) ?? typed;
    return this.avm1.key(true, k.keyCode, k.charCode, press, typed, !!k.shiftKey);
  }

  text(k: KeyState): boolean {
    this.handled++;
    return this.avm1.keyPress(printable(k.charCode));
  }

  /** Text fields come with step 13: nothing to copy or paste into yet. */
  copy(_cut?: boolean): ClipboardText | null {
    return null;
  }

  paste(_data?: ClipboardText | null): boolean {
    return false;
  }
}
