// Selection, the focus's AS2 face, as Ruffle's (https://github.com/ruffle-rs/
// ruffle) core/src/avm1/globals/selection.rs has it: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. A
// broadcaster, whose listeners hear onSetFocus(old, new) as the focus moves
// (focus.ts). The text selection is the focused text field's.
import { avm1 } from "@swf2es/runtime";
import { type DisplayObject, TextObject } from "../../display/display.js";
import { stateOf } from "./TextField.js";

/** What Selection reads and changes of the player's focus. */
export interface FocusState {
  readonly focused: DisplayObject | null;
  /** Focus `d`, or none, telling those it concerns at once. */
  focus(d: DisplayObject | null): void;
  /** Whether a script may focus `d`. */
  focusable(d: DisplayObject): boolean;
  /** `d`'s target path, `_level0.a.b`. */
  pathOf(d: DisplayObject): string;
  /** What `value`, an object or a path from the code's target, names; null for nothing. */
  resolve(value: avm1.Value, version: number): DisplayObject | null;
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY;

/** `_global.Selection`. */
export function selectionObject(
  realm: avm1.Realm,
  focus: FocusState,
  version: number,
): avm1.Avm1Object {
  const selection = new avm1.Avm1Object(realm.objectProto);
  avm1.initializeBroadcaster(selection, realm, version);

  // Nothing given is false; undefined or null take the focus away; anything
  // else focuses what it names, where that may have the focus.
  selection.define(
    "setFocus",
    realm.method((_, args, v) => {
      if (args.length === 0) {
        return false;
      }

      const value = args[0];
      if (value === undefined || value === null) {
        focus.focus(null);
        return true;
      }

      const d = focus.resolve(value, v);
      if (d === null || !focus.focusable(d)) {
        return false;
      }

      focus.focus(d);
      return true;
    }),
    FIXED,
  );
  selection.define(
    "getFocus",
    realm.method(() => (focus.focused ? focus.pathOf(focus.focused) : null)),
    FIXED,
  );
  // The focused field's selection, -1 without one.
  const field = () => (focus.focused instanceof TextObject ? focus.focused : null);
  const selected = () => {
    const f = field();
    return f !== null && stateOf(f).selected ? f : null;
  };
  const indices: [string, (f: TextObject) => number][] = [
    ["getBeginIndex", (f) => f.selection[0]],
    ["getEndIndex", (f) => f.selection[1]],
    ["getCaretIndex", (f) => f.caret],
  ];
  for (const [name, index] of indices) {
    selection.define(
      name,
      realm.method(() => {
        const f = selected();
        return f === null ? -1 : index(f);
      }),
      FIXED,
    );
  }

  // From begin to end, each at least 0; no end is the text's.
  selection.define(
    "setSelection",
    realm.method((_, args, v) => {
      const f = field();
      if (f !== null && args.length > 0) {
        const begin = Math.max(0, avm1.toNumber(args[0], v) | 0);
        const end = args.length > 1 ? Math.max(0, avm1.toNumber(args[1], v) | 0) : 0x7fffffff;
        stateOf(f).selected = true;
        f.select(begin, end);
      }

      return undefined;
    }),
    FIXED,
  );
  return selection;
}
