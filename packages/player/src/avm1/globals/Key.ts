// Key and Mouse, the keyboard's and the pointer's AS2 faces, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/globals/key.rs and
// mouse.rs have them: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC
// and Ruffle contributors. Each is a broadcaster: the player sends Key's
// listeners onKeyDown and onKeyUp, Mouse's onMouseDown, onMouseMove,
// onMouseUp and onMouseWheel (avm1.ts).
import { avm1 } from "@swf2es/runtime";

/** What Key and Mouse read of the player. */
export interface InputState {
  /** Whether the key of Flash's code `code` is down; the mouse's buttons are keys 1, 2 and 4. */
  keyIsDown(code: number): boolean;
  /** Whether the key of code `code` is toggled on, as each press turns it on or off. */
  keyToggled(code: number): boolean;
  /** The last key pressed: its code, and the character it typed. */
  readonly keyCode: number;
  readonly keyAscii: number;
  /** Whether the pointer shows; set, it shows or hides. */
  mouseShown: boolean;
}

/** Key's constants, its keys' codes. */
const KEYS: [string, number][] = [
  ["ALT", 18],
  ["BACKSPACE", 8],
  ["CAPSLOCK", 20],
  ["CONTROL", 17],
  ["DELETEKEY", 46],
  ["DOWN", 40],
  ["END", 35],
  ["ENTER", 13],
  ["ESCAPE", 27],
  ["HOME", 36],
  ["INSERT", 45],
  ["LEFT", 37],
  ["PGDN", 34],
  ["PGUP", 33],
  ["RIGHT", 39],
  ["SHIFT", 16],
  ["SPACE", 32],
  ["TAB", 9],
  ["UP", 38],
];

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY;

/** `_global.Key`. */
export function keyObject(realm: avm1.Realm, input: InputState, version: number): avm1.Avm1Object {
  const key = new avm1.Avm1Object(realm.objectProto);
  avm1.initializeBroadcaster(key, realm, version);

  for (const [name, code] of KEYS) {
    key.define(name, code, FIXED);
  }

  const code = (args: avm1.Value[], v: number) =>
    args.length > 0 ? avm1.toNumber(args[0], v) | 0 : Number.NaN;
  key.define(
    "isDown",
    realm.method((_, args, v) => input.keyIsDown(code(args, v))),
    FIXED,
  );
  key.define(
    "isToggled",
    realm.method((_, args, v) => input.keyToggled(code(args, v))),
    FIXED,
  );
  key.define(
    "getAscii",
    realm.method(() => input.keyAscii),
    FIXED,
  );
  key.define(
    "getCode",
    realm.method(() => input.keyCode),
    FIXED,
  );

  return key;
}

/**
 * `_global.Mouse`: show and hide give 1 where the pointer showed before
 * the call, else 0, as adl gives them (Ruffle gives the opposite).
 */
export function mouseObject(
  realm: avm1.Realm,
  input: InputState,
  version: number,
): avm1.Avm1Object {
  const mouse = new avm1.Avm1Object(realm.objectProto);
  avm1.initializeBroadcaster(mouse, realm, version);
  const showing = (shown: boolean) => () => {
    const was = input.mouseShown;
    input.mouseShown = shown;
    return was ? 1 : 0;
  };
  mouse.define("show", realm.method(showing(true)), FIXED);
  mouse.define("hide", realm.method(showing(false)), FIXED);

  return mouse;
}
