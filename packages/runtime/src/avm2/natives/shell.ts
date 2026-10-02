// avmshell's own classes, which a player has not: its System, File and
// Domain, and its Worker as the one that runs, the primordial, with no
// others to start.
import {
  type AsObject,
  type ClassHook,
  type Runtime,
  setStaticVar,
  type Value,
} from "../runtime.js";
import { bytesOf, fromUtf8, GLOBAL_MEMORY_MIN_SIZE, setDomainMemory, utf8 } from "./bytearray.js";
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

/** The SWF versions avmplus' BugCompatibility names, which Domain.loadBytes takes. */
const SWF_VERSIONS = { first: 9, last: 31 };

/** As FileClass::read: UTF-16 after its byte order mark, else UTF-8, not strict. */
function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return fromUtf8(bytes.subarray(3));
    }

    const big = bytes[0] === 0xfe && bytes[1] === 0xff;
    if (big || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
      const units: string[] = [];
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        const unit = big ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] | (bytes[i + 1] << 8);
        units.push(String.fromCharCode(unit));
      }

      return units.join("");
    }
  }

  return fromUtf8(bytes);
}

/** avmshell's System, File and Domain natives, for `rt`, and its Worker's. */
export function shellNatives(rt: Runtime): Natives {
  const natives: Natives = {};

  const fileName = (name: Value): string => {
    if (name === null || name === undefined) {
      throw rt.error("ArgumentError", 1507, "filename");
    }

    return rt.toString(name);
  };
  const readFile = (name: string): Uint8Array => {
    const bytes = rt.files.read(name);
    if (bytes === null) {
      throw rt.error("Error", 1500, name);
    }

    return bytes;
  };
  const writeFile = (name: string, bytes: Uint8Array): void => {
    if (!rt.files.write(name, bytes)) {
      throw rt.error("Error", 1501, name);
    }
  };

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

  // The files are the runtime's (RuntimeOptions.files), in avmshell's
  // working directory.
  class FileNatives {
    static exists(filename: Value): boolean {
      return rt.files.read(fileName(filename)) !== null;
    }

    static read(filename: Value): string {
      return decodeText(readFile(fileName(filename)));
    }

    static write(filename: Value, data: Value): void {
      const name = fileName(filename);
      if (data === null || data === undefined) {
        throw rt.error("ArgumentError", 1507, "data");
      }

      writeFile(name, utf8(rt.toString(data)));
    }

    static readByteArray(filename: Value): Value {
      const bytes = readFile(fileName(filename));
      const o = rt.construct(rt.classNamed("flash.utils::ByteArray")) as AsObject;
      const b = bytesOf(rt, o);
      b.write(bytes);
      b.position = 0;
      return o;
    }

    static writeByteArray(filename: Value, bytes: Value): boolean {
      const name = fileName(filename);
      const b = bytesOf(rt, bytes);
      writeFile(name, b.buffer.subarray(0, b.length));
      return true;
    }
  }

  // Every Domain is the runtime's one: a child sees its parent's
  // definitions, and what it loads every other sees, which avmshell's
  // tests do not tell apart. Its domain memory is the runtime's too.
  class DomainNatives {
    static get currentDomain(): Value {
      return rt.currentDomain();
    }

    static get MIN_DOMAIN_MEMORY_LENGTH(): number {
      return GLOBAL_MEMORY_MIN_SIZE;
    }

    "avmplus:Domain::init"(_base: Value): void {}

    // As DomainObject::loadBytes: the ABC compiled by the host, then its
    // entry point run.
    loadBytes(bytes: Value, swfVersion: Value): Value {
      if (bytes === null || bytes === undefined) {
        throw rt.error("TypeError", 1507, "bytes");
      }

      const version = rt.toUint(swfVersion ?? 0);
      if (version !== 0 && (version < SWF_VERSIONS.first || version > SWF_VERSIONS.last)) {
        throw rt.error("TypeError", 1508, "swfVersion");
      }

      if (!rt.compileAbc) {
        throw rt.unsupported("Domain.loadBytes without RuntimeOptions.compileAbc");
      }

      const b = bytesOf(rt, bytes);
      const compiled = rt.compileAbc(b.buffer.slice(0, b.length));
      if (typeof compiled === "number") {
        throw rt.error("VerifyError", compiled);
      }

      rt.run(compiled(rt));
      return undefined;
    }

    // As DomainObject::getClass: "a.b.C" names C in package a.b.
    getClass(className: Value): Value {
      if (className === null || className === undefined) {
        throw rt.error("ArgumentError", 1507, "name");
      }

      const name = rt.toString(className);
      const dot = name.lastIndexOf(".");
      const cls = rt.classNamed(dot < 0 ? name : `${name.slice(0, dot)}::${name.slice(dot + 1)}`);
      if (cls === null || typeof cls !== "object" || cls.$it === undefined) {
        throw rt.error("TypeError", 1034, rt.toString(cls), "Class");
      }

      return cls;
    }

    get domainMemory(): Value {
      return rt.memoryProvider;
    }

    set domainMemory(v: Value) {
      setDomainMemory(rt, v);
    }
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
  registerNativeClass(natives, "avmplus::File", FileNatives);
  registerNativeClass(natives, "avmplus::Domain", DomainNatives);
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
