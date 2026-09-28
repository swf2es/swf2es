// The AVM2 runtime: what generated modules call as `rt`.
import { builtinHooks, builtinNatives } from "./natives.js";
import { Runtime, type RuntimeOptions } from "./runtime.js";

export { Runtime, type RuntimeOptions } from "./runtime.js";

/** A runtime with the builtins' natives, for modules compiled from builtin.abc and after. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new Runtime(builtinNatives(), builtinHooks(), options);
}

/** AS3 `int(value)`: ToInt32(ToNumber(value)). */
export function toInt(value: unknown): number {
  return Number(value) | 0;
}

/** AS3 `uint(value)`: ToUint32(ToNumber(value)). */
export function toUint(value: unknown): number {
  return Number(value) >>> 0;
}
