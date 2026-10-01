// The AVM2 runtime: what generated modules call as `rt`.
import { builtinHooks, builtinNatives } from "./natives/index.js";
import { Runtime, type RuntimeOptions } from "./runtime.js";

export { publicNs, qname } from "./names.js";
export type { Natives } from "./natives/define.js";
export { type NativeClass, plain, registerNativeClass } from "./natives/define.js";
// The builtins' natives and hooks, for a player that adds playerglobal's to them.
export { builtinHooks, builtinNatives } from "./natives/index.js";
export {
  type AsObject,
  type ClassHook,
  type Method,
  Runtime,
  type RuntimeOptions,
  type Value,
} from "./runtime.js";

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
