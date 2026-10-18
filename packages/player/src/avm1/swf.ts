// One AVM1 SWF the player runs, the main one or one loadMovie loaded, and
// what is read of its action list once: its root's frames' exports,
// DoInitAction blocks, ScriptLimits and the places Flash cannot read, a
// place's clip actions and a button's condition blocks.
// The per-movie library and button conditions follow Ruffle's
// (https://github.com/ruffle-rs/ruffle): MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors.
import {
  type ActionList,
  ClipEvent,
  type Place,
  readExports,
  type Swf,
  tags,
} from "@swf2es/format";
import type { avm1 } from "@swf2es/runtime";
import type { MovieClip } from "../display/display.js";
import type { Library } from "../display/timeline.js";

/**
 * Where in a frame Flash stops the SWF at a place whose clip actions it
 * cannot read: it reads them as the first of the place's events comes, so
 * as it places the clip for load and initialize, before any of the
 * frame's actions; after the frame's DoInitActions for construct; at the
 * next frame for enterFrame, the frame's actions run. A place of other
 * events stops it as one comes to the clip (`dispatch`).
 */
export type Stop = "place" | "construct" | "enterFrame";

/** The first of `events`, a place's field of all events, by which Flash stops. */
export function stopOf(events: number): Stop | null {
  if (events & (ClipEvent.load | ClipEvent.initialize)) {
    return "place";
  }

  if (events & ClipEvent.construct) {
    return "construct";
  }

  return events & ClipEvent.enterFrame ? "enterFrame" : null;
}

const STOPS: Stop[] = ["place", "construct", "enterFrame"];

/** What happens as the root enters a frame, before its places and DoAction blocks. */
interface RootFrame {
  /** Its ExportAssets' names, which attachMovie and registerClass find characters by. */
  exports: { id: number; name: string }[];
  /** Its DoInitAction blocks, by index, with the sprite each is of. */
  inits: { sprite: number; block: number }[];
  /** Where a place in the frame whose clip actions Flash cannot read stops the SWF. */
  stop: Stop | null;
  /** The frame's last ScriptLimits: its recursion depth and script timeout, in seconds. */
  limits: [number, number] | null;
}

/** A clip action: the block, the events it runs for, and keyPress's key code. */
export interface Handler {
  events: number;
  key: number;
  block: number;
}

export const NO_HANDLERS: Handler[] = [];

/** A button's condition block: the transitions it runs on, and its key (0 for none). */
export interface ButtonHandler {
  conditions: number;
  key: number;
  block: number;
}

const NO_BUTTON_HANDLERS: readonly ButtonHandler[] = [];

/**
 * One AVM1 SWF the player runs, the main one or one loadMovie loaded: its
 * blocks, its library and what its root's frames export and initialize,
 * which its own code and timelines use, not another's (Ruffle's per-movie
 * library). Every SWF shares the player's realm, `_global` among it.
 */
export class Avm1Swf {
  /** Its module's blocks, by index. */
  blocks: avm1.Blocks = [];
  /** By its root's frame, 1 the first. */
  readonly frames = new Map<number, RootFrame>();
  /** The sprites whose DoInitAction has run. */
  readonly initialized = new Set<number>();
  /** Exported characters by name in lower case, as attachMovie finds them, and each one's name. */
  readonly exports = new Map<string, number>();
  readonly exportNames = new Map<number, string>();
  /** Each button character's condition blocks, by its id, gathered from the action list once. */
  buttonHandlers: Map<number, ButtonHandler[]> | null = null;
  /** The clip that plays it as its root: level 0's, a level's or the clip it was loaded into. */
  root: MovieClip | null = null;

  constructor(
    readonly library: Library | null,
    readonly list: ActionList | null,
    readonly version: number,
    /** Its URL, which `_url` gives. */
    readonly url: string,
    /** Its length in bytes, which getBytesTotal and getBytesLoaded give for its root. */
    readonly length: number,
    /** Its size as it came, compressed, which MovieClipLoader.getProgress gives. */
    readonly size = length,
  ) {}
}

/** Each root frame's exports, DoInitAction blocks, the tags Flash cannot read and its ScriptLimits. */
export function readRootFrames(swf: Swf, into: Avm1Swf): void {
  const list = into.list;
  if (list === null) {
    return;
  }

  // The root has a frame a ShowFrame tag ends; what follows the last is the last's.
  const last = Math.max(1, swf.tags.filter((t) => t.code === tags.ShowFrame).length);
  const frameOf = (frame: number) => {
    const at = Math.min(frame, last);
    let actions = into.frames.get(at);
    if (!actions) {
      actions = { exports: [], inits: [], stop: null, limits: null };
      into.frames.set(at, actions);
    }

    return actions;
  };
  for (const block of list.blocks) {
    const owner = block.owner;
    if (block.length > 0 && owner.type === "init" && owner.timeline === null) {
      frameOf(owner.frame + 1).inits.push({ sprite: owner.sprite, block: block.index });
    }
  }

  // A ScriptLimits takes effect as its frame comes, before the frame's
  // actions, the frame's last one if it has two (adl): two u16s, the
  // recursion depth and the script timeout in seconds.
  let frame = 1;
  for (const tag of swf.tags) {
    const events = list.corruptEvents.get(tag.offset);
    if (tag.code === tags.ShowFrame) {
      frame++;
    } else if (tag.code === tags.ScriptLimits && tag.length >= 4) {
      const at = tag.offset;
      const b = swf.bytes;
      frameOf(frame).limits = [b[at] | (b[at + 1] << 8), b[at + 2] | (b[at + 3] << 8)];
    } else if (tag.code === tags.ExportAssets) {
      frameOf(frame).exports.push(...readExports(swf.bytes, tag));
    } else if (events !== undefined) {
      const actions = frameOf(frame);
      const stop = stopOf(events);
      if (stop && (!actions.stop || STOPS.indexOf(stop) < STOPS.indexOf(actions.stop))) {
        actions.stop = stop;
      }
    }
  }
}

/** A place's clip actions, with the events each runs for, as `swf`'s action list has them. */
export function handlersOf(place: Place, swf: Avm1Swf): Handler[] | null {
  const list = swf.list;
  if (place.actions === null || place.actions.length === 0 || list === null) {
    return null;
  }

  const handlers: Handler[] = [];
  for (const index of place.actions) {
    const owner = list.blocks[index].owner;
    if (owner.type === "clip") {
      handlers.push({ events: owner.events, key: owner.key, block: index });
    }
  }

  return handlers;
}

/** `id`'s condition blocks: a DefineButton's one, or a DefineButton2's, one a BUTTONCONDACTION. */
export function handlersOfButton(swf: Avm1Swf, id: number): readonly ButtonHandler[] {
  if (swf.buttonHandlers === null) {
    const handlers = new Map<number, ButtonHandler[]>();
    for (const [block, { owner }] of (swf.list?.blocks ?? []).entries()) {
      if (owner.type === "button") {
        const list = handlers.get(owner.button) ?? [];
        list.push({ conditions: owner.conditions, key: owner.key, block });
        handlers.set(owner.button, list);
      }
    }

    swf.buttonHandlers = handlers;
  }

  return swf.buttonHandlers.get(id) ?? NO_BUTTON_HANDLERS;
}
