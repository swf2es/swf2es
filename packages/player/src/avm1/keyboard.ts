// The keyboard of an AVM1 movie: each key goes to Key, its clips' keyDown
// and keyUp clip actions, and a press to the first button or clip whose
// keyPress it is (input.ts's key). A keyPress's key is Flash's own code, as
// Ruffle's ButtonKeyCode has it (https://github.com/ruffle-rs/ruffle,
// core/src/events.rs: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle
// LLC and Ruffle contributors): a printable character's ASCII code, or one
// of the editing keys' below 20. A host whose text comes apart from its
// keys (the corpus's replay) gives the character by `text`.

import { TextObject } from "../display/display.js";
import type { ClipboardText } from "../hosts.js";
import type { Keyboard, KeyState } from "../input/keyboard.js";
import { pasteable, TextEditor } from "../input/text-editor.js";
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
  private readonly editor = new TextEditor((field) => {
    const movie = this.avm1;
    movie.timers.begin();
    try {
      field.fit();
      movie.textChanged(field);
      if (field.avm1) {
        movie.callback(field.avm1, "broadcastMessage", ["onChanged", field.avm1]);
      }

      movie.queue.run();
    } finally {
      movie.timers.end();
    }
  });

  constructor(private readonly avm1: Avm1) {}

  /** A key: its keyPress, where it is one, the editing key's, else, with edits, its character's. */
  handle(type: "down" | "up", k: KeyState, edits = true): boolean {
    this.handled++;
    if (type === "up") {
      this.avm1.input.key(false, k.keyCode, k.charCode, 0);
      return false;
    }

    const typed = edits ? printable(k.charCode) : 0;
    const press = KEY_PRESSES.get(k.keyCode) ?? typed;
    const used = this.avm1.input.key(true, k.keyCode, k.charCode, press, typed, !!k.shiftKey);
    return used || (edits && k.keyCode !== 9 && this.edit(k));
  }

  text(k: KeyState): boolean {
    this.handled++;
    const used = this.avm1.input.keyPress(printable(k.charCode));
    return used || this.edit(k);
  }

  private field(): TextObject | null {
    const d = this.avm1.focused;
    return !this.avm1.halted && d instanceof TextObject && !this.avm1.removed(d) ? d : null;
  }

  private edit(k: KeyState): boolean {
    const field = this.field();
    if (!field || (field.type !== "input" && !field.selectable)) {
      return false;
    }

    if (k.ctrlKey && !k.altKey && k.keyCode === 65) {
      if (field.selectable) {
        field.select(0, field.model.text.length);
      }

      return true;
    }

    return this.editor.edit(field, k);
  }

  copy(cut = false): ClipboardText | null {
    this.handled++;
    const field = this.field();
    if (!field || field.displayAsPassword || (cut && field.type !== "input")) {
      return null;
    }

    const [from, to] = field.selection;
    if (from === to) {
      return null;
    }

    const data = { text: field.model.text.slice(from, to).replace(/\r\n?/g, "\n") };
    if (cut) {
      this.editor.replace(field, from, to, "");
    }

    return data;
  }

  paste(data: ClipboardText | null = null): boolean {
    this.handled++;
    const field = this.field();
    if (field?.type !== "input" || !data) {
      return false;
    }

    const text = pasteable(field.multiline, data.text);
    if (text !== "") {
      this.editor.type(field, text);
    }

    return true;
  }
}
