// What the runtime's errors say: their messages, the number alone or, in
// debugger mode, its text, as avmplus words them; how a value is named in
// one; where an AS3 error was made, for a host to show; and what an AS3
// catch gets, Runtime.caught's.

import type { AsObject, Value } from "./descriptors.js";
import { isViewRangeError } from "./domain-memory.js";
import { FloatValue } from "./float.js";
import { Namespace, NS_Public, namespace } from "./names.js";
import { errorMessages } from "./player-messages.js";
import type { Runtime } from "./runtime.js";

/** Thrown for an AS3 exception that is an Error the runtime made, before its class existed. */
export class AsError extends Error {}

/**
 * Thrown where a SWF asks for something swf2es has not got (Runtime.unsupported).
 * Uncaught, it stops the script as any error of the runtime's own does; an
 * AS3 catch gets it as an AS3 error (Runtime.caught), since content written
 * for several runtimes guards what one of them may lack with try and catch.
 */
export class UnsupportedError extends Error {}

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
 * What an error the runtime made says in full, its text and arguments as
 * debugger mode words them, for a host to show: the release player's
 * message, which the SWF sees, is the number alone. Null for any other value.
 */
export function detailOf(error: Value): string | null {
  const detail = (error as { $detail?: unknown } | null)?.$detail;
  return typeof detail === "string" ? detail : null;
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

  // Its class's name without the package, as "Object@0", the address left out.
  const name: string = v.$traits.name;
  const colons = name.lastIndexOf("::");
  return `${colons < 0 ? name : name.slice(colons + 2)}@0`;
}

/** An exception as AS3 catches it: a stack overflow is an AS3 Error; the runtime's own errors are not caught. */
export function caught(rt: Runtime, e: unknown): Value {
  if (e instanceof RangeError && /call stack/.test(e.message)) {
    return rt.error("Error", 1023);
  }

  // Domain memory's, in the handler's own method (see memoryError).
  if (isViewRangeError(e)) {
    return rt.error("RangeError", 1506);
  }

  if (e instanceof UnsupportedError) {
    return unsupportedCaught(rt, e);
  }

  if (e instanceof Error && !(e instanceof AsError)) {
    throw e;
  }

  return e;
}

/**
 * What is not supported as the AS3 error a catch gets: an
 * IllegalOperationError with its message, or an Error where the player's
 * classes are not loaded; said once to the host, as the code may say nothing.
 */
function unsupportedCaught(rt: Runtime, e: UnsupportedError): Value {
  if (!rt.unsupportedTold.has(e.message)) {
    rt.unsupportedTold.add(e.message);
    rt.onUnsupported?.(e.message);
  }

  let cls: AsObject;
  try {
    cls = rt.resolve(rt.cls(namespace(NS_Public, "flash.errors"), "IllegalOperationError"));
  } catch {
    cls = rt.builtinClass("Error");
  }

  return rt.constructClass(cls, [e.message, 0]);
}
