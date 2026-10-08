// The AVM2 runtime: what generated modules call as `rt`.
import { builtinHooks, builtinNatives } from "./natives/index.js";
import type { RuntimeOptions } from "./options.js";
import { Runtime } from "./runtime.js";

export type { Abc, AsObject, CompileUnit, FoundDefinition, Method, Value } from "./descriptors.js";
export { type Domain, frameScripts, stackFrames } from "./domain.js";
export type { ClassHook, NativesProvider } from "./hooks.js";
export { messages } from "./messages.js";
export { publicNs, qname } from "./names.js";
export {
  Bytes,
  byteArrayHook,
  bytesOf,
  GLOBAL_MEMORY_MIN_SIZE,
  setDomainMemory,
} from "./natives/bytearray.js";
export type { Natives } from "./natives/define.js";
export { type NativeClass, plain, registerNativeClass } from "./natives/define.js";
// The builtins' natives and hooks, for a player that adds playerglobal's to them.
export { builtinHooks, builtinNatives } from "./natives/index.js";
// avmplus' XML tokenizer, which playerglobal's flash.xml.XMLDocument parses with too.
export { XMLParser, XMLTag } from "./natives/xml/parser.js";
export type { RuntimeOptions, ShellFiles } from "./options.js";
export { errorMessages } from "./player-messages.js";
export { Runtime } from "./runtime.js";
export { setStaticVar } from "./traits.js";

/** A runtime with the builtins' natives, for modules compiled from builtin.abc and after. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new Runtime(builtinNatives, builtinHooks(), options);
}

/** AS3 `int(value)`: ToInt32(ToNumber(value)). */
export function toInt(value: unknown): number {
  return Number(value) | 0;
}

/** AS3 `uint(value)`: ToUint32(ToNumber(value)). */
export function toUint(value: unknown): number {
  return Number(value) >>> 0;
}
