// AVM1's GetURL and GetURL2, which getURL, fscommand, loadMovie,
// loadMovieNum, unloadMovie, loadVariables and loadVariablesNum compile
// to, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/activation.rs (action_get_url, action_get_url_2,
// object_into_form_values), core/src/avm1/fscommand.rs and
// core/src/backend/navigator.rs (normalize_navigate_target) have them:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors.
//
// The runtime only routes: what each request does is the host's
// (host.ts), and a host without the hook drops it.
import type { Activation } from "./activation.js";
import { pathTarget, targetOrRoot } from "./clips.js";
import { Avm1Throw } from "./errors.js";
import type { Target, UrlForm } from "./host.js";
import { Avm1Object, get, keys } from "./objects.js";
import { stringOf, type Value } from "./values.js";

/** GetURL2's flags past the method (decode.ts reads a method of 3 as none). */
const METHOD_MASK = 3;
const LOAD_TARGET = 0x40;
const LOAD_VARIABLES = 0x80;

/** The command of an `FSCommand:` URL, in any case; null for any other URL. */
function fsCommandOf(url: string): string | null {
  return url.length >= 10 && url.slice(0, 10).toLowerCase() === "fscommand:" ? url.slice(10) : null;
}

/** "blank" with or without its underscore, in any case, as "_blank"; any other window as given. */
function windowOf(target: string): string {
  return /^_?blank$/i.test(target) ? "_blank" : target;
}

/** A level's number as Rust's i32 parse reads it: a sign and digits only, in range, else null. */
function levelInt(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) {
    return null;
  }

  const n = Number(text);
  return n >= -0x80000000 && n <= 0x7fffffff ? n : null;
}

/** A level's number as Rust's f64 parse reads it and `as i32` truncates it, saturated; null for no number. */
function levelFloat(text: string): number | null {
  if (!/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)$/i.test(text)) {
    return null;
  }

  const body = text.replace(/^[+-]/, "").toLowerCase();
  const n = body === "inf" || body === "infinity" ? Infinity : Number(body);
  if (Number.isNaN(n)) {
    return 0;
  }

  const signed = text.startsWith("-") ? -n : n;
  return Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(signed))) | 0;
}

/**
 * The variables a request with a method sends: the innermost scope's
 * object's, as for..in lists them, each as a string; one whose getter
 * throws is "undefined", as Ruffle has it.
 */
function formOf(cx: Activation, flags: number, version: number): UrlForm | null {
  const method = flags & METHOD_MASK;
  if (method === 0) {
    return null;
  }

  const object = cx.scope.object;
  const vars: [string, string][] = [];
  for (const name of keys(object, version)) {
    let text: string;
    try {
      text = stringOf(get(object, name, version), version);
    } catch (error) {
      if (!(error instanceof Avm1Throw)) {
        throw error;
      }

      text = "undefined";
    }

    vars.push([name, text]);
  }

  return { method: method === 1 ? "GET" : "POST", vars };
}

/**
 * GetURL: `FSCommand:` to the host's fscommand, the target the arguments;
 * a target `_levelN` loads the URL into that level, or with an empty one
 * unloads it, nothing where N is no number; any other target is a window
 * the page opens in.
 */
export function getUrl(cx: Activation, url: string, target: string): void {
  if (target.startsWith("_level") && target.length > 6) {
    const level = levelInt(target.slice(6));
    if (level !== null) {
      cx.host.loadMovie?.(level, url, null);
    }

    return;
  }

  const command = fsCommandOf(url);
  if (command !== null) {
    cx.host.fsCommand?.(command, target);
    return;
  }

  cx.host.navigate?.(url, windowOf(target), null);
}

/**
 * MovieClip.getURL(url, window, method), from the code `cx` runs:
 * `FSCommand:` as GetURL's, the window the arguments; else the page, with
 * the scope's variables where the method is "GET" or "POST" in any case.
 */
export function getUrlMethod(cx: Activation, args: Value[], version: number): void {
  if (args.length === 0) {
    return;
  }

  const url = stringOf(args[0], version);
  const command = fsCommandOf(url);
  if (command !== null) {
    cx.host.fsCommand?.(command, stringOf(args[1], version));
    return;
  }

  const window = args.length > 1 ? stringOf(args[1], version) : "";
  const method = typeof args[2] === "string" ? args[2].toLowerCase() : "";
  const flags = method === "get" ? 1 : method === "post" ? 2 : 0;
  cx.host.navigate?.(url, windowOf(window), formOf(cx, flags, version));
}

/**
 * GetURL2, its target popped first and converted first: `FSCommand:` as
 * GetURL's; else by its flags, loadVariables into a clip or a level (or,
 * named by a path but not the root, a page after all), loadMovie into a
 * clip or a level, loadMovieNum into a level the target names, or the page
 * a window opens; those of a method send the scope's variables, but
 * loadMovieNum and a page without one.
 */
export function getUrl2(
  cx: Activation,
  targetValue: Value,
  urlValue: Value,
  flags: number,
  version: number,
): void {
  const target = stringOf(targetValue, version);
  const url = stringOf(urlValue, version);
  const command = fsCommandOf(url);
  if (command !== null) {
    cx.host.fsCommand?.(command, target);
    return;
  }

  let level = -1;
  if (target.startsWith("_level")) {
    level = levelFloat(target.slice(6)) ?? (target.length === 6 ? 0 : -1);
  }

  const loadVariables = (flags & LOAD_VARIABLES) !== 0;
  const loadTarget = (flags & LOAD_TARGET) !== 0;
  let clip: Target | null = null;
  if (level > -1) {
    clip = levelClip(cx, level);
  } else if (loadVariables || loadTarget) {
    clip = clipOf(cx, targetValue, version);
  }

  if (loadVariables) {
    let into = loadTarget || level > -1;
    // A path's clip that is not the root is a page to open.
    if (!into && targetValue instanceof Avm1Object && clip !== null) {
      into = clip === rootClip(cx);
    }

    if (into) {
      if (clip !== null) {
        cx.host.loadVariables?.(clip, url, formOf(cx, flags, version));
      }

      return;
    }
  } else if (loadTarget) {
    if (url === "") {
      if (clip !== null) {
        cx.host.loadMovie?.(clip, "", null);
      }
    } else if (clip !== null || level > -1) {
      cx.host.loadMovie?.(clip ?? level, url, formOf(cx, flags, version));
    }

    return;
  } else if (level > -1) {
    cx.host.loadMovie?.(clip ?? level, url, null);
    return;
  }

  cx.host.navigate?.(url, windowOf(target), formOf(cx, flags, version));
}

/** The clip of level `level`, null where there is none yet. */
function levelClip(cx: Activation, level: number): Target | null {
  const object = cx.host.level?.(level);
  return object instanceof Avm1Object ? (cx.host.clipOf?.(object) ?? null) : null;
}

function rootClip(cx: Activation): Target | null {
  const root = cx.host.root?.(cx.base);
  return root instanceof Avm1Object ? (cx.host.clipOf?.(root) ?? null) : null;
}

/** The clip a target names: a clip's object itself, none for any other object, else its path from the target. */
function clipOf(cx: Activation, value: Value, version: number): Target | null {
  if (value instanceof Avm1Object) {
    return cx.host.clipOf?.(value) ?? null;
  }

  return pathTarget(cx, targetOrRoot(cx), stringOf(value, version), version);
}
