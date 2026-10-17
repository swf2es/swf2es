// Sound, AS1 and AS2's, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/sound.rs has it: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. A Sound keeps its target
// as given and finds the clip again each time it is used: its transform is
// the clip's, which every sound under the clip plays by; with no target it
// is the global one, over every sound. The sounds it starts are the
// timeline's kind, held to the same 32 and stopped with them.
import { avm1 } from "@swf2es/runtime";
import type { DisplayObject } from "../../display/display.js";
import type { SoundCharacter } from "../../display/timeline.js";
import type { SoundMix } from "../../media/audio.js";
import {
  type SoundHost,
  soundsOf,
  startScriptSound,
  stopSoundsOf,
  stopTimelineSound,
  stopTimelineSounds,
  type TimelineSound,
} from "../../media/sounds.js";

type Obj = avm1.Avm1Object;

/** A transform as AVM1 keeps it: whole percentages, as getVolume and getTransform give them back. */
export interface Avm1SoundTransform {
  volume: number;
  leftToLeft: number;
  leftToRight: number;
  rightToLeft: number;
  rightToRight: number;
}

export const FULL: Readonly<Avm1SoundTransform> = {
  volume: 100,
  leftToLeft: 100,
  leftToRight: 0,
  rightToLeft: 0,
  rightToRight: 100,
};

/** What Sound reads of the movie. */
export interface SoundClassHost {
  readonly realm: avm1.Realm;
  readonly sounds: SoundHost;
  /** What `value`, an object or a path from the code's target, names; null for nothing. */
  resolve(value: avm1.Value, version: number): DisplayObject | null;
  /** The DefineSound ExportAssets named `name`, any case; null for none. */
  exportedSound(name: string): SoundCharacter | null;
  /** `d`'s transform, the global one for null. */
  soundTransform(d: DisplayObject | null): Avm1SoundTransform;
  /** `d`'s transform, the global one for null, set: the sounds playing follow it. */
  setSoundTransform(d: DisplayObject | null, transform: Avm1SoundTransform): void;
  /** `o.onSoundComplete()`, as the frame's actions run. */
  complete(o: Obj): void;
}

interface State {
  /** The target as given; undefined or null for the global sound. */
  target: avm1.Value;
  character: SoundCharacter | null;
  /** The ms attachSound found, rounded. */
  duration: number | undefined;
  playing: TimelineSound | null;
  /** Where start began, in ms, for the position while it plays. */
  offset: number;
  /** The position once it stopped or ended. */
  position: number;
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY;

/** A number as Ruffle's clamp_to_i32 makes it: cut where it is in range, else, NaN too, -2^31 (the corpus's `sound`). */
function clampInt(n: number): number {
  return n >= -0x80000000 && n <= 0x7fffffff ? Math.trunc(n) : -0x80000000;
}

/** loops as Rust's `as u16` casts it, at least 1. */
function loopsOf(n: number): number {
  return Math.max(1, Number.isNaN(n) ? 0 : Math.trunc(Math.max(0, Math.min(0xffff, n))));
}

/**
 * The pan as Flash gives it back from the left and right volumes (Ruffle's
 * `sound` test): it is neither's plain difference.
 */
function panOf(t: Avm1SoundTransform): number {
  return t.leftToLeft !== 100 ? 100 - Math.abs(t.leftToLeft) : Math.abs(t.rightToRight) - 100;
}

/** `_global.Sound`. */
export function soundClass(host: SoundClassHost): Obj {
  const realm = host.realm;
  const h = host.sounds;
  const states = new WeakMap<Obj, State>();
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      // The target is made a path now, a clip's too, its toString called once (the corpus's
      // sound_owner_reference): a clip renamed is found by its path, as a variable or a child.
      const given = args.length > 0 ? args[0] : undefined;
      const target = given === undefined || given === null ? given : avm1.stringOf(given, v);
      states.set(self, {
        target,
        character: null,
        duration: undefined,
        playing: null,
        offset: 0,
        position: 0,
      });
      return self;
    },
    () => undefined,
  );

  const global = (state: State) => state.target === undefined || state.target === null;
  // The clip a targeted Sound works on, null where the target names none.
  const owner = (state: State, v: number) => (global(state) ? null : host.resolve(state.target, v));
  const valid = (state: State, v: number) => global(state) || owner(state, v) !== null;
  // The transform it reads and sets: its clip's, or the global one; undefined for no clip.
  const transformOf = (state: State, v: number): Avm1SoundTransform | undefined => {
    if (global(state)) {
      return host.soundTransform(null);
    }

    const d = owner(state, v);
    return d === null ? undefined : host.soundTransform(d);
  };
  const setTransform = (state: State, v: number, f: (t: Avm1SoundTransform) => void) => {
    const g = global(state);
    const d = g ? null : owner(state, v);
    if (g || d !== null) {
      const t = { ...host.soundTransform(d) };
      f(t);
      host.setSoundTransform(d, t);
    }
  };
  // Where it plays: from its offset, each loop after the first from the offset again, as the
  // device loops it; where it was stopped, by whatever stopped it; the end once it ended.
  const positionOf = (state: State): number => {
    const playing = state.playing;
    if (playing === null || playing.endedAt !== null) {
      return state.position;
    }

    const length = state.duration ?? 0;
    const elapsed = Math.max(0, (playing.stoppedAt ?? h.now) - playing.started);
    const loop = length - state.offset;
    return Math.round(state.offset + (loop > 0 && elapsed >= loop ? elapsed % loop : elapsed));
  };
  const method = (
    name: string,
    f: (state: State, args: avm1.Value[], v: number, self: Obj) => avm1.Value,
    flags = 0,
  ) =>
    proto.define(
      name,
      realm.method((self, args, v) => {
        const state = states.get(self);
        return state === undefined ? undefined : f(state, args, v, self);
      }),
      FIXED | flags,
    );
  const duration = (state: State, _: avm1.Value[], v: number) =>
    valid(state, v) ? state.duration : undefined;
  const position = (state: State, _: avm1.Value[], v: number) =>
    state.character !== null && valid(state, v) ? positionOf(state) : undefined;

  method("getPan", (state, _, v) => {
    const t = transformOf(state, v);
    return t === undefined ? undefined : panOf(t);
  });
  // Surprisingly, lr is right to left and rl left to right (Ruffle).
  method("getTransform", (state, _, v) => {
    const t = transformOf(state, v);
    if (t === undefined) {
      return undefined;
    }

    const o = realm.newObject(v);
    avm1.set(o, "ll", t.leftToLeft, v);
    avm1.set(o, "lr", t.rightToLeft, v);
    avm1.set(o, "rr", t.rightToRight, v);
    avm1.set(o, "rl", t.leftToRight, v);
    return o;
  });
  method("getVolume", (state, _, v) => transformOf(state, v)?.volume);
  method("setPan", (state, args, v) => {
    const pan = clampInt(avm1.toNumber(args.length > 0 ? args[0] : 0, v));
    setTransform(state, v, (t) => {
      t.leftToLeft = pan >= 0 ? 100 - pan : 100;
      t.rightToRight = pan >= 0 ? 100 : 100 + pan;
      t.leftToRight = 0;
      t.rightToLeft = 0;
    });
    return undefined;
  });
  // Only the keys the object has of its own change, each wrapped to 32 bits.
  method("setTransform", (state, args, v) => {
    const o = args[0];
    setTransform(state, v, (t) => {
      if (!(o instanceof avm1.Avm1Object)) {
        return;
      }

      const own = (key: string) =>
        o.own(key, v) ? avm1.toNumber(avm1.get(o, key, v), v) | 0 : undefined;
      t.leftToLeft = own("ll") ?? t.leftToLeft;
      t.leftToRight = own("rl") ?? t.leftToRight;
      t.rightToLeft = own("lr") ?? t.rightToLeft;
      t.rightToRight = own("rr") ?? t.rightToRight;
    });
    return undefined;
  });
  method("setVolume", (state, args, v) => {
    const volume = clampInt(avm1.toNumber(args.length > 0 ? args[0] : 0, v));
    setTransform(state, v, (t) => {
      t.volume = volume;
    });
    return undefined;
  });
  // A name stops every sound of that export, whoever started it; none, the
  // sounds under its clip, or, for the global Sound, all of them.
  method("stop", (state, args, v) => {
    if (args.length > 0) {
      const name = avm1.stringOf(args[0], v);
      const character = valid(state, v) ? host.exportedSound(name) : null;
      if (character !== null) {
        stopSoundsOf(h, character);
      }

      return undefined;
    }

    if (global(state)) {
      stopTimelineSounds(h);
    } else {
      const d = owner(state, v);
      if (d !== null) {
        for (const sound of soundsOf(h, d)) {
          stopTimelineSound(h, sound);
        }
      }
    }

    return undefined;
  });
  method("attachSound", (state, args, v, self) => {
    if (!valid(state, v)) {
      return undefined;
    }

    const character = host.exportedSound(avm1.stringOf(args[0], v));
    if (character === null) {
      return undefined;
    }

    const definition = character.definition;
    state.character = character;
    state.duration = Math.round((definition.sampleCount * 1000) / definition.sampleRate);
    state.position = 0;
    // position and duration are the object's own from its first sound, as getters.
    for (const [name, get] of [
      ["position", position],
      ["duration", duration],
    ] as const) {
      if (!avm1.has(self, name, v)) {
        const p = self.add(name, undefined, avm1.DONT_ENUM | avm1.DONT_DELETE);
        p.get = realm.method((o, a, version) => {
          const s = states.get(o);
          return s === undefined ? undefined : get(s, a, version);
        });
      }
    }

    return undefined;
  });
  // From `offset` seconds in, `loops` times.
  method("start", (state, args, v, self) => {
    if (!valid(state, v) || state.character === null) {
      return undefined;
    }

    const offset = avm1.toNumber(args.length > 0 ? args[0] : 0, v) * 1000;
    const loops = loopsOf(avm1.toNumber(args.length > 1 ? args[1] : 1, v));
    const start = Number.isNaN(offset) ? 0 : Math.max(0, offset);
    const sound = startScriptSound(h, owner(state, v), state.character, start, loops, () => {
      if (state.playing === sound) {
        state.position = state.duration ?? 0;
      }

      host.complete(self);
    });
    if (sound !== null) {
      state.playing = sound;
      state.offset = start;
    }

    return undefined;
  });
  method("getDuration", duration, avm1.VERSION_6);
  method("setDuration", () => undefined, avm1.VERSION_6);
  method("getPosition", position, avm1.VERSION_6);
  method("setPosition", () => undefined, avm1.VERSION_6);
  // Loading a sound by URL is not here yet: nothing starts, and onLoad never comes.
  method("loadSound", () => undefined, avm1.VERSION_6);
  method("getBytesLoaded", () => 1, avm1.VERSION_6);
  method("getBytesTotal", () => 1, avm1.VERSION_6);
  return constr;
}

/** An AVM1 transform as the device mixes it, from percentages to fractions. */
export function mixOfTransform(t: Avm1SoundTransform): SoundMix {
  return {
    volume: t.volume / 100,
    leftToLeft: t.leftToLeft / 100,
    leftToRight: t.leftToRight / 100,
    rightToLeft: t.rightToLeft / 100,
    rightToRight: t.rightToRight / 100,
  };
}
