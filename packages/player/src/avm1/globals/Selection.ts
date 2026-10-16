// Selection, the focus's AS2 face, as Ruffle's (https://github.com/ruffle-rs/
// ruffle) core/src/avm1/globals/selection.rs has it: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. A
// broadcaster, whose listeners hear onSetFocus(old, new) as the focus moves
// (avm1.ts). The text selection's methods wait for text fields (step 13).
import { avm1 } from "@swf2es/runtime";
import type { DisplayObject } from "../../display/display.js";

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
  for (const name of ["getBeginIndex", "getEndIndex", "getCaretIndex"]) {
    selection.define(
      name,
      realm.method(() => -1),
      FIXED,
    );
  }

  selection.define(
    "setSelection",
    realm.method(() => undefined),
    FIXED,
  );
  return selection;
}
