// avmshell's own classes, which a player has not: its System, and its
// Worker as the one that runs, the primordial, with no others to start.
import {
  type AsObject,
  type ClassHook,
  type Runtime,
  setStaticVar,
  type Value,
} from "../runtime.js";
import { elements, type Natives, registerNativeClass } from "./define.js";

const started = Date.now();

/** System.getFeatures as the oracle's avmshell gives it. */
const SHELL_FEATURES = [
  "AVMSYSTEM_32BIT",
  "AVMSYSTEM_UNALIGNED_INT_ACCESS",
  "AVMSYSTEM_UNALIGNED_FP_ACCESS",
  "AVMSYSTEM_LITTLE_ENDIAN",
  "AVMSYSTEM_IA32",
  "AVMSYSTEM_UNIX",
  "AVMFEATURE_JIT",
  "AVMFEATURE_ALCHEMY_POSIX",
  "AVMFEATURE_COMPILEPOLICY",
  "AVMFEATURE_ABC_INTERP",
  "AVMFEATURE_SELFTEST",
  "AVMFEATURE_EVAL",
  "AVMFEATURE_PROTECT_JITMEM",
  "AVMFEATURE_SHARED_GCHEAP",
  "AVMFEATURE_CACHE_GQCN",
  "AVMFEATURE_SAFEPOINTS",
  "AVMFEATURE_INTERRUPT_SAFEPOINT_POLL",
  "AVMFEATURE_SWF12",
  "AVMFEATURE_SWF13",
  "AVMFEATURE_SWF14",
  "AVMFEATURE_SWF15",
  "AVMFEATURE_SWF16",
  "AVMFEATURE_SWF17",
  "AVMFEATURE_SWF18",
  "AVMTWEAK_EXACT_TRACING",
]
  .map((f) => `${f};`)
  .join("");

/** System's natives, for `rt`: all static, as avmshell has them. */
export function shellNatives(rt: Runtime): Natives {
  const natives: Natives = {};

  class SystemNatives {
    // avmshell's console skips NUL characters, which strings may hold.
    static trace(args: Value): void {
      rt.print(
        elements(args)
          .map((v) => rt.toString(v))
          .join(" ")
          .replaceAll("\0", ""),
      );
    }

    static write(s: Value): void {
      rt.print(rt.toString(s).replaceAll("\0", ""));
    }

    static "avmplus:System::getArgv"(): Value {
      return rt.array([]);
    }

    static getAvmplusVersion(): string {
      return "swf2es";
    }

    static get swfVersion(): number {
      return 31;
    }

    static get apiVersion(): number {
      return 50;
    }

    static getTimer(): number {
      return Date.now() - started;
    }

    static getRunmode(): string {
      return "jit";
    }

    static isDebugger(): boolean {
      return rt.debugger;
    }

    static exit(): void {}

    // A number's one representation: avmplus' makes a double that is an int one.
    static canonicalizeNumber(a: Value): Value {
      return a;
    }

    static isGlobal(o: Value): boolean {
      return o !== null && typeof o === "object" && rt.traitsOf(o).isGlobal;
    }

    // The oracle's avmshell's, which swf2es stands in for: 32-bit, as its
    // ByteArrays are limited (kMaxCapacity in bytearray.ts).
    static getFeatures(): string {
      return SHELL_FEATURES;
    }

    // JavaScript's collector decides when to collect.
    static forceFullCollection(): void {}

    static queueCollection(): void {}

    static pauseForGCIfCollectionImminent(_imminence: Value): void {}
  }

  class WorkerNatives {
    declare $shared: Map<string, Value>;

    static pr(s: Value): void {
      rt.print(rt.toString(s));
    }

    "flash.system:Worker::internalGetState"(): string {
      return "running";
    }

    get isPrimordial(): boolean {
      return true;
    }

    isParentOf(_other: Value): boolean {
      return false;
    }

    setSharedProperty(key: Value, value: Value): void {
      this.$shared ??= new Map();
      this.$shared.set(rt.toString(key), value);
    }

    getSharedProperty(key: Value): Value {
      return this.$shared?.get(rt.toString(key));
    }

    start(): void {
      throw rt.unsupported("starting a Worker");
    }

    terminate(): boolean {
      return false;
    }
  }

  class WorkerDomainNatives {
    listWorkers(): Value {
      throw rt.unsupported("WorkerDomain.listWorkers");
    }

    "flash.system:WorkerDomain::createWorkerFromByteArrayInternal"(): Value {
      throw rt.unsupported("creating a Worker");
    }
  }

  registerNativeClass(natives, "avmplus::System", SystemNatives);
  registerNativeClass(natives, "flash.system::Worker", WorkerNatives);
  registerNativeClass(natives, "flash.system::WorkerDomain", WorkerDomainNatives);
  return natives;
}

/** As ShellWorkerClass: Worker.current is the primordial worker, made with the class. */
export const shellHooks: Record<string, ClassHook> = {
  "flash.system::Worker": {
    created(rt: Runtime, cls: AsObject): void {
      setStaticVar(cls, "m_current", rt.constructClass(cls, []));
    },
  },
};
