// What AVM1 code asks of the player, which has the display list the
// runtime does not (docs/avm1.md, "Where each piece lives"). A clip is the
// player's, opaque here.

import type { Avm1Object } from "./objects.js";
import type { Value } from "./values.js";

/** A display object the player gives the runtime, as an activation's target. */
export type Target = object;

/** What a display object's AVM1 object found for a name that is none of its own properties: nothing. */
export const ABSENT: unique symbol = Symbol("absent");

/**
 * A display object's side of its AVM1 object (docs/avm1.md, "Hosting AVM1
 * objects"): what the object has beyond its own properties, looked up
 * after them and before its prototypes', as Ruffle's stage_object.rs has
 * it. The player gives each clip, button and text field one.
 */
export interface DisplayNative {
  /** What `typeof` says of the object: "movieclip" for a clip, else "object". */
  readonly type: string;
  /** The display object. */
  readonly target: Target;
  /**
   * `_root`, `_parent`, `_global` and `_levelN`, in the version's case; a
   * child by its instance name; a display property (`_x`...), in any case;
   * ABSENT for none of them.
   */
  get(name: string, version: number): Value | typeof ABSENT;
  /**
   * A set of a display property by name, which the object takes where it
   * has no property of its own of the name: whether it was one.
   */
  set(name: string, value: Value, version: number): boolean;
  /** Its children's names, the highest depth first, which for..in lists after its own properties. */
  keys(out: string[]): void;
  /** Its path, `_level0.a.b`, which TargetPath gives, and a clip converts to as a string. */
  path(): string;
  /**
   * The AVM1 object a reference to this one reaches now: itself, or once
   * its display object is gone, the one placed at its path since (a clip's
   * reference is its path in Flash), null where there is none.
   */
  live(): Avm1Object | null;
  /** GetProperty's property `index` (0 `_x` to 21 `_ymouse`), undefined for none. */
  property(index: number, version: number): Value;
  /** SetProperty's property `index` set: false where there is none. */
  setProperty(index: number, value: Value, version: number): boolean;
}

/** What timeline actions do to a clip. */
export interface Timeline {
  readonly currentFrame: number;
  readonly totalFrames: number;
  /** A goto of frame `frame`, 1 the first, past the last the last, after the clip is played or stopped. */
  goto(frame: number, play: boolean): void;
  /** The frame of label `label`, in any ASCII case, undefined for none. */
  labelFrame(label: string): number | undefined;
  /** The actions of frame `frame` run now, as CallFrame runs them. */
  call(frame: number): void;
}

export interface Host {
  /**
   * A trace's text, as it is: Flash's log breaks its lines at a carriage
   * return as at a line feed, which is the host's to do where it writes one.
   */
  trace(text: string): void;
  /** Play or stop `target`'s timeline. */
  play(target: Target): void;
  stop(target: Target): void;
  /**
   * Stop the whole SWF, every timeline and every action of it, as Flash
   * does at an action it cannot read.
   */
  halt(): void;
  /**
   * What paths need of the display list (docs/avm1.md, "Scopes, targets
   * and names"), each a clip's AVM1 object: the root's, `_levelN`, a
   * clip's parent, and a clip's child by its instance name, found in its
   * case from SWF 7. A host without a display list leaves them out.
   */
  root?(): Value;
  level?(level: number): Value;
  parent?(clip: object): Value;
  child?(clip: object, name: string, caseSensitive: boolean): Value;
  /** The display object whose AVM1 object `object` is, where it is one's. */
  clipOf?(object: object): Target | undefined;
  /** The AVM1 object of `target`. */
  objectOf?(target: Target): Avm1Object;
  /** Whether `target` has been removed: SetTarget in its code finds no clip. */
  removed?(target: Target): boolean;
  /** The timeline of `target` where it is a clip, null for anything else. */
  timeline?(target: Target): Timeline | null;
  /** StopSounds: every sound playing stops. */
  stopSounds?(): void;
  /** ToggleQuality: the stage's quality from high or best to low, or back. */
  toggleQuality?(): void;
}
