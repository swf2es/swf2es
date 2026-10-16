// AVM1's actions on clips: targets (SetTarget, SetTarget2), properties by
// index (GetProperty, SetProperty), the timeline actions (GotoFrame,
// GotoFrame2, GotoLabel, NextFrame, PrevFrame, WaitForFrame, CallFrame)
// and TargetPath, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/activation.rs and globals/movie_clip.rs (goto_frame) have
// them: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. Where adl parts from Ruffle, adl decides (docs/avm1.md,
// "Clips and paths").
//
// What needs the display list the player gives through the host: a
// target's AVM1 object and timeline, and each clip's DisplayNative.
import type { Activation } from "./activation.js";
import type { Target, Timeline } from "./host.js";
import { PRIMITIVE } from "./inheritance.js";
import { Avm1Object } from "./objects.js";
import { toInt32 } from "./operators.js";
import { SCOPE_Target, Scope, stoppedAtPrimitive, targetPath } from "./scope.js";
import { stringOf, toBoolean, toNumber, type Value } from "./values.js";

/** The target, or where SetTarget found none, the root: where GotoFrame2 and a function's `this` go. */
export function targetOrRoot(cx: Activation): Target {
  if (cx.target !== null) {
    return cx.target;
  }

  const root = cx.host.root?.();
  return (root instanceof Avm1Object ? cx.host.clipOf?.(root) : undefined) ?? cx.base;
}

/** The target's timeline, where it is a clip. */
const timelineOf = (cx: Activation, target: Target | null): Timeline | null =>
  target === null ? null : (cx.host.timeline?.(target) ?? null);

/** `scope` with its timeline's scope, a clip's, now `object`'s, as tellTarget makes it. */
function retarget(scope: Scope, object: Avm1Object): Scope {
  if (scope.kind === SCOPE_Target) {
    return new Scope(scope.parent, SCOPE_Target, object, scope.depth);
  }

  return scope.parent === null
    ? scope
    : new Scope(retarget(scope.parent, object), scope.kind, scope.object, scope.depth);
}

/** The target `target` from here on: names resolve on its clip, or the root's where there is none. */
function setTargetClip(cx: Activation, target: Target | null): void {
  cx.target = target !== null && cx.host.removed?.(target) ? null : target;
  const clip = cx.host.objectOf?.(targetOrRoot(cx));
  if (clip !== undefined) {
    cx.clip = clip;
    cx.scope = retarget(cx.scope, clip);
  }
}

/** The display object a path from `start`'s AVM1 object names, null for none or no display object. */
function pathTarget(cx: Activation, start: Target, path: string, version: number): Target | null {
  const from = cx.host.objectOf?.(start);
  if (from === undefined) {
    return null;
  }

  const object = targetPath(cx, from, path, true, false, version);
  if (object === null && stoppedAtPrimitive && version >= 5) {
    cx.host.trace(PRIMITIVE);
  }

  return object === null ? null : (cx.host.clipOf?.(object) ?? null);
}

/**
 * SetTarget: the clip `path` names from the code's own clip, that clip
 * for "", none where it names none or the code's clip is gone.
 */
export function setTarget(cx: Activation, path: string, version: number): void {
  if (path === "") {
    setTargetClip(cx, cx.base);
    return;
  }

  const removed = cx.host.removed?.(cx.base) ?? false;
  setTargetClip(cx, removed ? null : pathTarget(cx, cx.base, path, version));
}

/**
 * SetTarget2: as SetTarget of the value as a string, but undefined is the
 * code's own clip up to SWF 6 and none from 7; nothing where that clip is
 * gone.
 */
export function setTarget2(cx: Activation, value: Value, version: number): void {
  if (cx.host.removed?.(cx.base)) {
    cx.target = null;
    return;
  }

  if (value === undefined) {
    if (version > 6) {
      cx.target = null;
      const clip = cx.host.objectOf?.(cx.base);
      if (clip !== undefined) {
        cx.clip = cx.host.objectOf?.(targetOrRoot(cx)) ?? clip;
        cx.scope = retarget(cx.scope, clip);
      }
    } else {
      setTargetClip(cx, cx.base);
    }

    return;
  }

  setTarget(cx, stringOf(value, version), version);
}

/**
 * The display object a GetProperty or SetProperty names: a clip's AVM1
 * object itself, else the path it converts to, from `start`; the empty
 * path is `start` where `empty`, else none.
 */
function displayOf(
  cx: Activation,
  start: Target,
  value: Value,
  empty: boolean,
  version: number,
): Target | null {
  if (value instanceof Avm1Object && value.display !== null) {
    return value.display.target;
  }

  const path = stringOf(value, version);
  if (!empty && path === "") {
    return null;
  }

  return pathTarget(cx, start, path, version);
}

/** What GetProperty and SetProperty act on: from the target, or from the code's clip where there is none. */
const propertyTarget = (cx: Activation, path: Value, version: number): Target | null =>
  cx.target !== null
    ? displayOf(cx, cx.target, path, true, version)
    : displayOf(cx, cx.base, path, false, version);

/** A property's index: the number truncated, none for NaN, an infinity or -1 and below. */
function indexOf(index: Value, version: number): number {
  const n = toNumber(index, version);
  return Number.isFinite(n) && n > -1 ? Math.trunc(n) : -1;
}

/** GetProperty: property `index` of the clip `path` names, undefined for none. */
export function getProperty(cx: Activation, index: Value, path: Value, version: number): Value {
  const i = indexOf(index, version);
  const target = propertyTarget(cx, path, version);
  if (target === null || i < 0) {
    return undefined;
  }

  return cx.host.objectOf?.(target).display?.property(i, version);
}

/** SetProperty: property `index` of the clip `path` names set to `value`. */
export function setProperty(
  cx: Activation,
  value: Value,
  index: Value,
  path: Value,
  version: number,
): void {
  const i = indexOf(index, version);
  const target = propertyTarget(cx, path, version);
  if (target === null) {
    // The value is converted all the same (Ruffle's action_property_coerce).
    coerceFor(i, value, version);
    return;
  }

  if (i >= 0) {
    cx.host.objectOf?.(target).display?.setProperty(i, value, version);
  }
}

/**
 * What a property's set converts its value to before it finds the target
 * read-only or missing: a number for 0 to 12 but `_target` (11), a string
 * for `_name` and `_quality`, a number for the rest but `_focusrect`.
 */
export function coerceFor(index: number, value: Value, version: number): void {
  if (index < 0 || index === 11 || index === 14 || index === 15 || index === 17) {
    return;
  }

  if (index <= 12) {
    if (value !== undefined && value !== null) {
      toNumber(value, version);
    }
  } else if (index === 13 || index === 19) {
    stringOf(value, version);
  } else if (index <= 21) {
    toNumber(value, version);
  }
}

/** GotoFrame: frame `frame` (0 the first) of the target, which stops. */
export function gotoFrame(cx: Activation, frame: number): void {
  timelineOf(cx, cx.target)?.goto(frame + 1, false);
}

/** GotoLabel: the frame of `label`, if the target has it, which stops. */
export function gotoLabel(cx: Activation, label: string): void {
  const timeline = timelineOf(cx, cx.target);
  const frame = timeline?.labelFrame(label);
  if (frame !== undefined) {
    timeline?.goto(frame, false);
  }
}

/** GotoFrame2: as `goto` on the target, or the root where there is none, `bias` frames on. */
export function gotoFrame2(
  cx: Activation,
  frame: Value,
  play: boolean,
  bias: number,
  version: number,
): void {
  const target = targetOrRoot(cx);
  if (timelineOf(cx, target) !== null) {
    goto(cx, target, frame, play, bias, version);
  }
}

/** A string as Rust reads an f64: digits with a sign, a point and an exponent, or inf and NaN; null for anything else. */
function parseNumber(s: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    return Number(s);
  }

  if (/^[+-]?(inf|infinity)$/i.test(s)) {
    return s.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  return /^[+-]?nan$/i.test(s) ? Number.NaN : null;
}

/**
 * The clip and the frame a goto's or CallFrame's value names from clip
 * `start`: a whole number its frame; anything else as a string, a path to
 * a clip and a frame, `/a/b:3` or `a.b.label`, the frame a number or a
 * label; null where it names none.
 */
function frameOf(
  cx: Activation,
  start: Target,
  value: Value,
  version: number,
): [Target, number] | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return [start, toInt32(value, version)];
  }

  const path = stringOf(value, version);
  let clip: Target | null = start;
  let frame = path;
  const separator = Math.max(path.lastIndexOf(":"), path.lastIndexOf("."));
  if (separator >= 0) {
    clip = null;
    for (let s: Scope | null = cx.scope; s !== null && clip === null; s = s.parent) {
      const object = targetPath(cx, s.object, path.slice(0, separator), true, true, version);
      if (object !== null) {
        clip = cx.host.clipOf?.(object) ?? null;
        // Not a clip: none, as Ruffle's resolve_variable_path finds an object first.
        if (clip === null) {
          return null;
        }
      }
    }

    frame = path.slice(separator + 1);
  }

  const timeline = clip === null ? null : timelineOf(cx, clip);
  if (clip === null || timeline === null) {
    return null;
  }

  const n = parseNumber(frame);
  if (n !== null) {
    return [clip, toInt32(n, version)];
  }

  const labelled = timeline.labelFrame(frame);
  return labelled === undefined ? null : [clip, labelled];
}

/**
 * A goto of `frame` on clip `target`, gotoAndPlay's and gotoAndStop's and
 * GotoFrame2's: the frame `frameOf` names, `bias` frames on, if that is
 * from 1; as a u16, where the timeline clamps it.
 */
export function goto(
  cx: Activation,
  target: Target,
  frame: Value,
  play: boolean,
  bias: number,
  version: number,
): void {
  const found = frameOf(cx, target, frame, version);
  if (found === null) {
    return;
  }

  const n = Math.min(((found[1] - 1) | 0) + bias + 1, 0x7fffffff);
  if (n > 0) {
    timelineOf(cx, found[0])?.goto(Math.max(1, n & 0xffff), play);
  }
}

/** NextFrame: the target's next frame, if it has one, where it stops. */
export function nextFrame(cx: Activation): void {
  const timeline = timelineOf(cx, cx.target);
  if (timeline !== null && timeline.currentFrame < timeline.totalFrames) {
    timeline.goto(timeline.currentFrame + 1, false);
  }
}

/** PrevFrame: the target's previous frame, if it has one, where it stops. */
export function prevFrame(cx: Activation): void {
  const timeline = timelineOf(cx, cx.target);
  if (timeline !== null && timeline.currentFrame > 1) {
    timeline.goto(timeline.currentFrame - 1, false);
  }
}

/**
 * WaitForFrame: whether frame `frame` (0 the first) is loaded, which in a
 * SWF the player has whole every frame is, up to Flash's 16000.
 */
export const frameLoaded = (frame: number): boolean => frame <= 16000;

/** WaitForFrame2: as WaitForFrame of the value's frame, 1 the first, read as Ruffle reads it. */
export function frameLoaded2(value: Value, version: number): boolean {
  let n = 0;
  if (typeof value === "number" && Number.isInteger(value)) {
    n = toInt32(value, version);
  } else {
    const parsed = parseNumber(stringOf(value, version));
    n = parsed !== null && Number.isInteger(parsed) ? toInt32(parsed, version) : 0;
  }

  // Less one, wrapping, and one more, saturating.
  const frame = Math.min(((n - 1) | 0) + 1, 0x7fffffff);
  return frame <= 16001;
}

/** TargetPath: a clip's path, `_level0.a`, undefined for anything else. */
export function targetPathOf(value: Value): Value {
  if (!(value instanceof Avm1Object) || value.display === null) {
    return undefined;
  }

  const live = value.display.live();
  return live?.display?.path() ?? undefined;
}

/** CallFrame: the actions of the frame the value names, on the target or the root, run now. */
export function callFrame(cx: Activation, value: Value, version: number): void {
  const target = targetOrRoot(cx);
  const found =
    typeof value === "number"
      ? ([target, toInt32(value, version) >>> 0] as [Target, number])
      : frameOf(cx, target, value, version);
  if (found !== null && found[1] <= 0xffff) {
    timelineOf(cx, found[0])?.call(found[1]);
  }
}

/**
 * CloneSprite: the display object `source` names from the target, or the
 * root's where there is none, duplicated as `name` at timeline depth
 * `depth`, which compilers bias as duplicateMovieClip's own depth is.
 */
export function cloneSprite(
  cx: Activation,
  depth: Value,
  name: Value,
  source: Value,
  version: number,
): void {
  const d = toInt32(depth, version);
  const n = stringOf(name, version);
  const target = displayOf(cx, targetOrRoot(cx), source, true, version);
  if (target !== null) {
    cx.host.duplicate?.(target, n, d);
  }
}

/**
 * StartDrag, its operands on the stack: the target, whether to lock the
 * centre, whether to constrain, and if so the bounds' right-to-left
 * bottom, right, top and left. The display object the target names, or
 * the code's own clip for an empty one, is dragged.
 */
export function startDrag(cx: Activation, version: number): void {
  const st = cx.st;
  const value = st.pop();
  const lockCenter = toBoolean(st.pop(), version);
  let bounds: number[] | null = null;
  if (toBoolean(st.pop(), version)) {
    const bottom = toNumber(st.pop(), version);
    const right = toNumber(st.pop(), version);
    const top = toNumber(st.pop(), version);
    const left = toNumber(st.pop(), version);
    bounds = [left, top, right, bottom];
  }

  const target = displayOf(cx, targetOrRoot(cx), value, true, version);
  if (target !== null) {
    cx.host.startDrag?.(target, lockCenter, bounds);
  }
}

/**
 * RemoveSprite: the display object `value` names from the target, or the
 * root's, removed; a target it removes gives way to the code's own clip.
 */
export function removeSprite(cx: Activation, value: Value, version: number): void {
  const target = displayOf(cx, targetOrRoot(cx), value, true, version);
  if (target === null) {
    return;
  }

  cx.host.remove?.(target);
  if (cx.target !== null && cx.host.removed?.(cx.target)) {
    setTargetClip(cx, cx.base);
  }
}
