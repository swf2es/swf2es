// DefineButton and DefineButton2 (SWF specification, chapter 4): a
// button's records, each a character shown in some of its four states, and
// whether it tracks as a menu. Their actions are the SWF's action blocks
// (actions.ts), which a button gives by their indices.
import type { ActionList } from "./actions.js";
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
  /**
   * The indices of its AVM1 actions in the SWF's ActionList; null without
   * them, or when read without the list.
   */
  actions: number[] | null;
}

/** A DefineButton or DefineButton2; given the SWF's action list, with the indices of its actions. */
export function readButton(bytes: Uint8Array, tag: Tag, actions?: ActionList): Button {
  const { button } = parseButton(bytes, tag);
  button.actions = actions?.byTag.get(tag.offset) ?? null;
  return button;
}

/** A button's id, and where its actions start: -1 for a DefineButton2 whose action offset is 0. */
export function buttonActionsOffset(bytes: Uint8Array, tag: Tag): { id: number; offset: number } {
  const { button, actions } = parseButton(bytes, tag);
  return { id: button.id, offset: actions };
}

function parseButton(bytes: Uint8Array, tag: Tag): { button: Button; actions: number } {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const two = tag.code === DefineButton2;
  const button: Button = { id: r.u16(), records: [], trackAsMenu: false, actions: null };
  // Only whether it is 0 counts: the actions start after the records' end, as Ruffle reads them.
  let hasActions = true;
  if (two) {
    button.trackAsMenu = (r.u8() & 0x01) !== 0;
    hasActions = r.u16() !== 0;
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

  return { button, actions: hasActions ? Math.min(r.pos, r.end) : -1 };
}
