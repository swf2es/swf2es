// What the runtime's errors say: their messages, the number alone or, in
// debugger mode, its text, as avmplus words them; how a value is named in
// one; and where an AS3 error was made, for a host to show.

import type { Value } from "./descriptors.js";
import { FloatValue } from "./float.js";
import { Namespace } from "./names.js";
import { errorMessages } from "./player-messages.js";
import type { Runtime } from "./runtime.js";

/** Thrown for an AS3 exception that is an Error the runtime made, before its class existed. */
export class AsError extends Error {}

/**
 * Where an AS3 error was made, as JavaScript stack lines from the first
 * compiled method's (their names begin with `$`), the runtime's and the
 * player's frames before it left out, those between kept; every line if
 * no compiled method made it, and null for anything but an AS3 error.
 */
export function stackOf(error: Value): string | null {
  const made = (error as { $jsError?: Error } | null)?.$jsError;
  if (!(made instanceof Error) || !made.stack) {
    return null;
  }

  // V8 heads its stack with the error's own line; other engines give frames alone, `name@url`.
  const frames = made.stack.split("\n").filter((line) => !/^Error\b/.test(line));
  const first = frames.findIndex((line) => /^(?:\s*at (?:[\w$]+\.)?)?\$[\w$]/.test(line));
  return frames.slice(Math.max(0, first)).join("\n");
}

/**
 * Error `id`'s message as AS3 sees it: its number, as the release player
 * and avmshell give it, or with its text and arguments in debugger mode.
 */
export function errorMessage(debuggerMode: boolean, id: number, args: Value[]): string {
  if (!debuggerMode) {
    return `Error #${id}`;
  }

  const template = errorMessages[id] ?? "";
  const text = template.replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1] ?? ""));
  return `Error #${id}: ${text}`;
}

/** A value as avmplus names it in an error message. */
export function describe(rt: Runtime, v: Value): string {
  if (v === null || typeof v !== "object" || v instanceof FloatValue || v instanceof Namespace) {
    return rt.toString(v);
  }

  const name: string = v.$traits.name;
  return `${name.slice(name.lastIndexOf("::") + (name.includes("::") ? 2 : 0))}@0`;
}
