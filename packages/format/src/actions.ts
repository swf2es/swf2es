// A SWF's AVM1 action blocks, listed from its tags: DoAction, DoInitAction,
// a PlaceObject2 or 3's clip actions and a button's actions, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) swf/src/read.rs reads them
// (read_clip_actions, read_clip_event_flags, read_define_button_1 and 2,
// read_button_action) and its swf/src/types.rs numbers their flags: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Where a record is malformed Ruffle drops the whole tag; here the tag keeps
// the records before it, since the player places the clip or defines the
// button whatever its actions.

import { buttonActionsOffset } from "./button.js";
import { clipActionsOffset, readSprite } from "./display.js";
import { type Swf, SwfReader, type Tag } from "./swf.js";
import {
  DefineButton,
  DefineButton2,
  DefineSprite,
  DoAction,
  DoInitAction,
  PlaceObject2,
  PlaceObject3,
  ShowFrame,
} from "./tags.js";

/** A clip action's events, CLIPEVENTFLAGS' bits; SWF 5 has only the low 16. */
export const ClipEvent = {
  load: 1 << 0,
  enterFrame: 1 << 1,
  unload: 1 << 2,
  mouseMove: 1 << 3,
  mouseDown: 1 << 4,
  mouseUp: 1 << 5,
  keyDown: 1 << 6,
  keyUp: 1 << 7,
  data: 1 << 8,
  initialize: 1 << 9,
  press: 1 << 10,
  release: 1 << 11,
  releaseOutside: 1 << 12,
  rollOver: 1 << 13,
  rollOut: 1 << 14,
  dragOver: 1 << 15,
  dragOut: 1 << 16,
  keyPress: 1 << 17,
  construct: 1 << 18,
} as const;

/** The bits Flash knows; it skips a record with none of them, and only flags of 0 end the list. */
const CLIP_EVENTS = 0x7ffff;

/** A button's state transitions, BUTTONCONDACTION's low 9 bits; its key code is above them. */
export const ButtonCondition = {
  idleToOverUp: 1 << 0,
  overUpToIdle: 1 << 1,
  overUpToOverDown: 1 << 2,
  overDownToOverUp: 1 << 3,
  overDownToOutDown: 1 << 4,
  outDownToOverDown: 1 << 5,
  outDownToIdle: 1 << 6,
  idleToOverDown: 1 << 7,
  overDownToIdle: 1 << 8,
} as const;

/**
 * What a block belongs to. `timeline` is the sprite whose tags hold it, null
 * for the main timeline's, and `frame` counts that timeline's frames from 0.
 */
export type ActionOwner =
  /** DoAction: a frame's actions. */
  | { type: "frame"; timeline: number | null; frame: number }
  /** DoInitAction: `sprite`'s #initclip actions. */
  | { type: "init"; sprite: number; timeline: number | null; frame: number }
  /** A clip action of the PlaceObject2 or 3 at `depth`; `key` is keyPress's key code, else 0. */
  | {
      type: "clip";
      timeline: number | null;
      frame: number;
      depth: number;
      events: number;
      key: number;
    }
  /** A button's actions; DefineButton's one runs on overDownToOverUp. `key` is 0 without one. */
  | { type: "button"; button: number; conditions: number; key: number };

/** A block of actions: its bytes are `length` from `offset` in the SWF's decompressed bytes. */
export interface ActionBlock {
  /** Its place in the SWF's list, which the JIT and AOT modules both number blocks by. */
  index: number;
  owner: ActionOwner;
  /** The offset of the tag's body that holds it, the key of `ActionList.byTag`. */
  tag: number;
  offset: number;
  length: number;
}

export interface ActionList {
  /** The SWF's version, which decides how its actions run and how its clip events are read. */
  version: number;
  /** In tag order, a sprite's within its DefineSprite, and a tag's in record order. */
  blocks: ActionBlock[];
  /** The indices of each tag's blocks, by the offset of the tag's body. */
  byTag: Map<number, number[]>;
}

/**
 * A SWF's action blocks, a pure function of its bytes. A block may be empty.
 * They are listed in an ActionScript 3 SWF too, where Flash runs none.
 */
export function readActions(swf: Swf): ActionList {
  const list: ActionList = { version: swf.header.version, blocks: [], byTag: new Map() };
  walk(swf.bytes, swf.tags, null, list);
  return list;
}

function walk(bytes: Uint8Array, tags: Tag[], timeline: number | null, list: ActionList): void {
  let frame = 0;

  for (const tag of tags) {
    const end = tag.offset + tag.length;
    switch (tag.code) {
      case ShowFrame:
        frame++;
        break;
      case DoAction:
        add(list, tag, { type: "frame", timeline, frame }, tag.offset, end);
        break;
      case DoInitAction:
        // A tag too short for its sprite id is no block, as Ruffle fails to read it.
        if (tag.length >= 2) {
          const sprite = bytes[tag.offset] | (bytes[tag.offset + 1] << 8);
          add(list, tag, { type: "init", sprite, timeline, frame }, tag.offset + 2, end);
        }
        break;
      case PlaceObject2:
      case PlaceObject3: {
        const { depth, offset } = clipActionsOffset(bytes, tag);
        if (offset >= 0) {
          clipActions(bytes, tag, offset, list, timeline, frame, depth);
        }
        break;
      }
      case DefineButton:
      case DefineButton2:
        buttonActions(bytes, tag, list);
        break;
      case DefineSprite: {
        const sprite = readSprite(bytes, tag);
        walk(bytes, sprite.tags, sprite.id, list);
        break;
      }
    }
  }
}

function add(list: ActionList, tag: Tag, owner: ActionOwner, offset: number, end: number): void {
  const index = list.blocks.length;
  list.blocks.push({ index, owner, tag: tag.offset, offset, length: end - offset });

  const indices = list.byTag.get(tag.offset);
  if (indices) {
    indices.push(index);
  } else {
    list.byTag.set(tag.offset, [index]);
  }
}

/** CLIPACTIONS: a reserved u16, every record's events together, then records to one of no events. */
function clipActions(
  bytes: Uint8Array,
  tag: Tag,
  start: number,
  list: ActionList,
  timeline: number | null,
  frame: number,
  depth: number,
): void {
  const end = tag.offset + tag.length;
  const r = new SwfReader(bytes, start, end);
  const wide = list.version >= 6;
  const flagSize = wide ? 4 : 2;
  r.u16();
  // A final record's flags cut short read as none (Ruffle's #2899), which ends the list.
  const flags = () => {
    if (r.pos + flagSize > end) {
      r.pos = end;
      return 0;
    }

    return wide ? r.u32() : r.u16();
  };
  flags();

  for (;;) {
    const raw = flags();
    if (raw === 0 || r.pos + 4 > end) {
      return;
    }

    const events = raw & CLIP_EVENTS;

    let length = r.u32();
    let key = 0;
    // keyPress's key code is counted in the record's length.
    if (events & ClipEvent.keyPress) {
      if (length === 0 || r.pos >= end) {
        return;
      }

      length--;
      key = r.u8();
    }

    if (length > end - r.pos) {
      return;
    }

    if (events !== 0) {
      const owner: ActionOwner = { type: "clip", timeline, frame, depth, events, key };
      add(list, tag, owner, r.pos, r.pos + length);
    }

    r.pos += length;
  }
}

/**
 * DefineButton's actions run to the tag's end. DefineButton2's, after its
 * records when its action offset is not 0, are BUTTONCONDACTIONs: a size,
 * 0 for the last, which runs to the end, then the conditions and key.
 */
function buttonActions(bytes: Uint8Array, tag: Tag, list: ActionList): void {
  const { id, offset } = buttonActionsOffset(bytes, tag);
  const end = tag.offset + tag.length;
  if (offset < 0) {
    return;
  }

  if (tag.code === DefineButton) {
    const owner: ActionOwner = {
      type: "button",
      button: id,
      conditions: ButtonCondition.overDownToOverUp,
      key: 0,
    };
    add(list, tag, owner, offset, end);
    return;
  }

  const r = new SwfReader(bytes, offset, end);
  for (;;) {
    if (r.pos + 4 > end) {
      return;
    }

    const size = r.u16();
    const conditions = r.u16();
    // Sizes 1 to 3 are shorter than the record's own head: Ruffle's error, so the end here.
    if ((size !== 0 && size < 4) || size - 4 > end - r.pos) {
      return;
    }

    const blockEnd = size === 0 ? end : r.pos + size - 4;
    const owner: ActionOwner = {
      type: "button",
      button: id,
      conditions: conditions & 0x1ff,
      key: conditions >> 9,
    };
    add(list, tag, owner, r.pos, blockEnd);
    if (size === 0) {
      return;
    }

    r.pos = blockEnd;
  }
}
