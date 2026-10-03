// DefineButton and DefineButton2 (SWF specification, chapter 4): a
// button's records, each a character shown in some of its four states, and
// whether it tracks as a menu. Their actions are AVM1's, and left out.
import { readFilterBytes } from "./display.js";
import { type ColorTransform, type Matrix, readColorTransform, readMatrix } from "./shape.js";
import { SwfReader, type Tag } from "./swf.js";
import { DefineButton2 } from "./tags.js";

/** A button's state, as BUTTONRECORD's flags have them. */
export const BUTTON_UP = 0x01;
export const BUTTON_OVER = 0x02;
export const BUTTON_DOWN = 0x04;
export const BUTTON_HIT_TEST = 0x08;

/** A character a button shows in the states `states` names (BUTTON_UP and the rest). */
export interface ButtonRecord {
  states: number;
  character: number;
  depth: number;
  matrix: Matrix;
  /** DefineButton2's; null in a DefineButton. */
  colorTransform: ColorTransform | null;
  /** The filter list's bytes, undecoded, as a place keeps them; null without one. */
  filters: Uint8Array | null;
  blendMode: number | null;
}

export interface Button {
  id: number;
  records: ButtonRecord[];
  /** DefineButton2's TrackAsMenu: a press elsewhere can be released on it. */
  trackAsMenu: boolean;
}

export function readButton(bytes: Uint8Array, tag: Tag): Button {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const two = tag.code === DefineButton2;
  const button: Button = { id: r.u16(), records: [], trackAsMenu: false };
  if (two) {
    button.trackAsMenu = (r.u8() & 0x01) !== 0;
    // The offset of the actions, which follow the records.
    r.u16();
  }

  // The records end at a flags byte of 0.
  while (r.pos < r.end && !r.overrun) {
    const flags = r.u8();
    if (flags === 0) {
      break;
    }

    const record: ButtonRecord = {
      states: flags & 0x0f,
      character: r.u16(),
      depth: r.u16(),
      matrix: readMatrix(r),
      colorTransform: null,
      filters: null,
      blendMode: null,
    };
    if (two) {
      record.colorTransform = readColorTransform(r, true);
      if (flags & 0x10) {
        record.filters = readFilterBytes(r);
      }

      if (flags & 0x20) {
        record.blendMode = r.u8();
      }
    }

    if (!r.overrun) {
      button.records.push(record);
    }
  }

  return button;
}
