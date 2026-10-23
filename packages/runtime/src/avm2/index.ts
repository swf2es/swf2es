// The AVM2 runtime: what generated modules call as `rt`.
import { builtinHooks, builtinNatives } from "./natives/index.js";
import type { RuntimeOptions } from "./options.js";
import { Runtime } from "./runtime.js";

export { Reader as Amf3Reader, Writer as Amf3Writer } from "./amf.js";
export type { Abc, AsObject, CompileUnit, FoundDefinition, Method, Value } from "./descriptors.js";
export { type Domain, frameScripts, frameSites, siteScript, stackFrames } from "./domain.js";
export { FloatValue, hasFloatLibrary } from "./float.js";
export { floatLibrary } from "./float-library.js";
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
export {
  endShellWorker,
  shellWorkerTerminated,
  startShellWorker,
} from "./natives/shell-workers.js";
// avmplus' XML tokenizer, which playerglobal's flash.xml.XMLDocument parses with too.
export { XMLParser, XMLTag } from "./natives/xml/parser.js";
export type {
  RuntimeOptions,
  ShellFiles,
  ShellThread,
  ShellWorkerHost,
  ShellWorkerInit,
  ShellWorkersMemory,
} from "./options.js";
export { errorMessages } from "./player-messages.js";
// A destroyed host must not remain reachable through shared inline-cache entries.
export { invalidate as clearPropertyCaches } from "./property-cache.js";
export { Runtime } from "./runtime.js";
// methodKey: where a method sits on its traits, for a player that makes a closure of its own.
export { instanceVarField, methodKey, setStaticVar } from "./traits.js";

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
