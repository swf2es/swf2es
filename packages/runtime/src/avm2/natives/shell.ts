// avmshell's own classes, which a player has not: its System, File and
// Domain, and its Worker and WorkerDomain, whose workers run on threads
// the host starts (RuntimeOptions.workers; shell-workers.ts).

import { Reader, Writer } from "../amf.js";
import type { AsObject, Value } from "../descriptors.js";
import type { Domain } from "../domain.js";
import type { ClassHook } from "../hooks.js";
import type { ShellThread } from "../options.js";
import type { Runtime } from "../runtime.js";
import { setStaticVar } from "../traits.js";
import {
  byteArrayCapacity,
  bytesOf,
  fromUtf8,
  GLOBAL_MEMORY_MIN_SIZE,
  knownSharedByteArray,
  setDomainMemory,
  sharedByteArray,
  utf8,
} from "./bytearray.js";
import { syncObject, syncOf, syncRef } from "./concurrent.js";
import { elements, type Natives, registerNativeClass } from "./define.js";
import {
  CANSTART,
  entryKey,
  FAILED,
  ITEM_AMF,
  ITEM_BYTES,
  ITEM_NUMBER,
  ITEM_SHARED,
  ITEM_SYNC,
  NEW,
  newWorkersMemory,
  RUNNING,
  STATE_NAMES,
  sleep,
  Workers,
  WorkerTerminated,
} from "./shell-workers.js";

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

/** System.totalMemory, freeMemory and privateMemory as the oracle's avmshell starts with them. */
const START_TOTAL_MEMORY = 1347584;
const START_FREE_MEMORY = 753664;
const START_PRIVATE_MEMORY = 6557696;

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
      return rt.swfVersion;
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

    // A terminated worker's code stops in a sleep, as avmplus interrupts it there.
    static sleep(ms: Value): void {
      const { workers } = workersOf(rt);
      const stopped = () => {
        if (workers.terminated) {
          throw new WorkerTerminated();
        }
      };

      stopped();
      for (let left = rt.toInt(ms); left > 0; left -= SLEEP_STEP) {
        sleep(Math.min(left, SLEEP_STEP));
        stopped();
      }
    }

    // There is no shell to run a command in: system()'s -1, of no process made.
    static exec(command: Value): number {
      if (command === null || command === undefined) {
        throw rt.error("ArgumentError", 1507, "command");
      }

      return -1;
    }

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

    // The oracle's avmshell's memory when it starts, which JavaScript does
    // not tell, and as in avmshell, the ByteArrays' capacity.
    static get totalMemory(): number {
      return START_TOTAL_MEMORY + byteArrayCapacity(rt);
    }

    static get freeMemory(): number {
      return START_FREE_MEMORY;
    }

    static get privateMemory(): number {
      return START_PRIVATE_MEMORY + byteArrayCapacity(rt);
    }
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

  // Each Domain is one of the runtime's: a child's definitions after its
  // parent's, its own invisible to the parent and to its siblings. Their
  // domain memory is the runtime's one.
  const domainOf = (o: AsObject): Domain => o.$domain ?? rt.root;

  class DomainNatives {
    static get currentDomain(): Value {
      return rt.currentDomain();
    }

    static get MIN_DOMAIN_MEMORY_LENGTH(): number {
      return GLOBAL_MEMORY_MIN_SIZE;
    }

    // As DomainObject::init: a domain after `base`'s. A null base makes
    // avmshell a domain of its own, with builtins of its own, which here
    // are the root's.
    "avmplus:Domain::init"(this: AsObject, base: Value): void {
      this.$domain = rt.childDomain(base ? domainOf(base) : rt.root);
    }

    // As DomainObject::loadBytes: the ABC compiled by the host, then its
    // entry point run.
    loadBytes(this: AsObject, bytes: Value, swfVersion: Value): Value {
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

      const domain = domainOf(this);
      const b = bytesOf(rt, bytes);
      const compiled = rt.compileAbc(b.buffer.slice(0, b.length), rt.compileUnit(domain));
      if (typeof compiled === "number") {
        throw rt.error("VerifyError", compiled);
      }

      rt.run(rt.loadInto(domain, () => compiled(rt)));
      return undefined;
    }

    // As DomainObject::getClass: "a.b.C" names C in package a.b.
    getClass(this: AsObject, className: Value): Value {
      if (className === null || className === undefined) {
        throw rt.error("ArgumentError", 1507, "name");
      }

      const name = rt.toString(className);
      const dot = name.lastIndexOf(".");
      const qualified = dot < 0 ? name : `${name.slice(0, dot)}::${name.slice(dot + 1)}`;
      const cls = rt.classNamed(qualified, domainOf(this));
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

  // A Worker is one of the workers its VM knows (workersOf), by id; one
  // made and not started keeps its code, as avmplus' m_byteCode.
  class WorkerNatives {
    static pr(s: Value): void {
      rt.print(rt.toString(s));
    }

    // As WorkerObjectBase::get_state.
    "flash.system:Worker::internalGetState"(this: WorkerObject): string {
      return STATE_NAMES[workersOf(rt).workers.state(this.$id)] || "aborted";
    }

    get isPrimordial(): boolean {
      return (this as unknown as WorkerObject).$id === 0;
    }

    isParentOf(this: WorkerObject, other: Value): boolean {
      if (other === null || other === undefined) {
        throw rt.error("TypeError", 2007, "worker");
      }

      return workersOf(rt).workers.parent((other as WorkerObject).$id) === this.$id;
    }

    // As avmplus' ChannelItem: undefined deletes; a number is kept as itself,
    // a ByteArray's bytes copied, a shareable one's memory shared, a Mutex
    // or a Condition by reference, and anything else as AMF3, read back as
    // a new copy.
    setSharedProperty(this: WorkerObject, key: Value, value: Value): void {
      const { workers } = workersOf(rt);
      const k = sharedKey(rt, key);
      if (value === undefined) {
        workers.set(this.$id, k, null);
        workers.objects.delete(entryKey(this.$id, k));
        return;
      }

      const item = sharedItem(rt, value);
      const token = workers.set(this.$id, k, item);
      if (item.kind === ITEM_BYTES || item.kind === ITEM_SHARED) {
        workers.objects.set(entryKey(this.$id, k), { token, value });
      }
    }

    getSharedProperty(this: WorkerObject, key: Value): Value {
      const { workers } = workersOf(rt);
      const k = sharedKey(rt, key);
      const entry = workers.get(this.$id, k);
      if (!entry) {
        return undefined;
      }

      switch (entry.kind) {
        case ITEM_NUMBER:
          return new DataView(entry.bytes.buffer).getFloat64(0, true);
        case ITEM_AMF:
          return readAmf(rt, entry.bytes);
        case ITEM_SYNC: {
          // The VM's one object for it, as avmplus interns one for its State.
          const address = new DataView(entry.bytes.buffer).getInt32(1, true);
          return syncObject(rt, { kind: entry.bytes[0] === 0 ? "mutex" : "condition", address });
        }
      }

      // One object a VM for the item, as avmplus interns it.
      const cached = workers.objects.get(entryKey(this.$id, k));
      if (cached?.token === entry.token) {
        return cached.value;
      }

      if (entry.kind === ITEM_SHARED) {
        // The VM's one ByteArray for the memory, by its id.
        const id = new DataView(entry.bytes.buffer).getFloat64(0, true);
        const known = knownSharedByteArray(rt, id);
        if (known) {
          return known;
        }

        const memory = rt.workerHost?.shared?.(id);
        if (!memory) {
          throw rt.unsupported("a shareable ByteArray from a worker whose host does not share it");
        }

        return sharedByteArray(rt, memory);
      }

      const value = newByteArray(rt, entry.bytes);
      workers.objects.set(entryKey(this.$id, k), { token: entry.token, value });
      return value;
    }

    // As WorkerObjectBase::internalStart: its parent starts it, once, on a
    // thread of the host's that runs its code, or the primordial's.
    start(this: WorkerObject): void {
      const { workers, threads } = workersOf(rt);
      if (workers.state(this.$id) !== NEW) {
        throw rt.error("flash.errors::IllegalOperationError", 1511);
      }

      if (workers.parent(this.$id) !== workers.self) {
        throw rt.error("flash.errors::IllegalOperationError", 1521);
      }

      if (!rt.workerHost) {
        throw rt.unsupported("starting a Worker without RuntimeOptions.workers");
      }

      const code = this.$code === null || this.$code === undefined ? null : copyOf(rt, this.$code);
      this.$code = null;
      workers.setState(this.$id, CANSTART);
      try {
        threads.set(this.$id, rt.workerHost.start({ id: this.$id, memory: workers.memory, code }));
      } catch (e) {
        workers.setState(this.$id, FAILED);
        throw e;
      }
    }

    // As Aggregate::requestIsolateExit: true for a worker started and not
    // yet ended, which is terminated at once, with the workers it started,
    // its thread stopped and their properties let go; false for one not
    // started or ended. The primordial ends with Error 1513; a worker that
    // terminates itself stops at once, as avmshell's does.
    terminate(this: WorkerObject): boolean {
      const { workers, threads } = workersOf(rt);
      // A worker terminating itself stops there, which no script catches.
      if (this.$id !== 0 && this.$id === workers.self) {
        workers.terminateSelf();
        throw new WorkerTerminated();
      }

      if (this.$id === 0) {
        throw rt.error("Error", 1513);
      }

      const ended = workers.terminate(this.$id);
      if (ended.size === 0) {
        return false;
      }

      const thread = threads.get(this.$id);
      threads.delete(this.$id);
      if (thread) {
        stopThread(rt, this.$id, thread, ended);
      }

      return true;
    }
  }

  class WorkerDomainNatives {
    // As Aggregate::listWorkers: those running, the primordial among them.
    listWorkers(): Value {
      const { workers } = workersOf(rt);
      const list: Value[] = [];
      for (let id = 0; id < workers.count(); id++) {
        if (workers.state(id) === RUNNING) {
          list.push(workerObject(rt, id));
        }
      }

      const cls = rt.applyType(rt.classNamed("__AS3__.vec::Vector"), [
        rt.classNamed("flash.system::Worker"),
      ]);
      const o = cls.$it.instance();
      o.$a = list;
      o.$fixed = false;
      return o;
    }

    // A worker of this one's, NEW; its code is `bytes`, or the primordial's for null.
    "flash.system:WorkerDomain::createWorkerFromByteArrayInternal"(bytes: Value): Value {
      const o = workerObject(rt, workersOf(rt).workers.create());
      o.$code = bytes;
      return o;
    }
  }

  registerNativeClass(natives, "avmplus::System", SystemNatives);
  registerNativeClass(natives, "avmplus::File", FileNatives);
  registerNativeClass(natives, "avmplus::Domain", DomainNatives);
  registerNativeClass(natives, "flash.system::Worker", WorkerNatives);
  registerNativeClass(natives, "flash.system::WorkerDomain", WorkerDomainNatives);
  return natives;
}

/** How long a sleep goes before it looks whether its worker was terminated. */
const SLEEP_STEP = 50;

/** How long a terminated worker's thread is given to stop at its next wait or sleep before it is stopped. */
const STOP_GRACE = 100;

/**
 * Stop the thread of worker `id`, terminated with the workers in `ended`,
 * whose threads stop with its own. A thread may be stopped anywhere, even
 * where it writes what a Mutex it holds guards, so their Mutexes are let go
 * only once it has stopped: at once where its code stops at its next wait,
 * lock or sleep, as avmplus interrupts it, and which it is given a moment
 * to reach; else once the host says the thread has gone.
 */
function stopThread(rt: Runtime, id: number, thread: ShellThread, ended: Set<number>): void {
  const sync = syncOf(rt);
  sync.waitStopped(id, STOP_GRACE);
  void Promise.resolve(thread.terminate()).then(() => {
    for (const d of ended) {
      sync.end(d);
    }
  });
}

interface WorkerObject extends AsObject {
  $id: number;
  $code: Value;
}

/** What a VM keeps of the workers: their shared memory, its Worker objects and its threads. */
interface VmWorkers {
  workers: Workers;
  objects: Map<number, WorkerObject>;
  threads: Map<number, ShellThread>;
}

const vmWorkers = new WeakMap<Runtime, VmWorkers>();

/** The workers as `rt` sees them: those of its primordial, which it is unless a host started it. */
function workersOf(rt: Runtime): VmWorkers {
  let vm = vmWorkers.get(rt);
  if (!vm) {
    const init = rt.workerInit;
    vm = {
      workers: init
        ? new Workers(init.memory, init.id)
        : new Workers(newWorkersMemory(syncOf(rt).memory), 0),
      objects: new Map(),
      threads: new Map(),
    };
    vmWorkers.set(rt, vm);
  }

  return vm;
}

/** The VM's one Worker for worker `id`, as avmplus interns it; Worker's own constructor refuses. */
function workerObject(
  rt: Runtime,
  id: number,
  cls = rt.classNamed("flash.system::Worker"),
): WorkerObject {
  const { objects } = workersOf(rt);
  let o = objects.get(id);
  if (!o) {
    o = cls.$it.instance() as WorkerObject;
    cls.$it.proto.$init.apply(o, []);
    o.$id = id;
    o.$code = null;
    objects.set(id, o);
  }

  return o;
}

function newByteArray(rt: Runtime, bytes: Uint8Array): AsObject {
  const o = rt.construct(rt.classNamed("flash.utils::ByteArray")) as AsObject;
  const b = bytesOf(rt, o);
  b.write(bytes);
  b.position = 0;
  return o;
}

/** A ByteArray's bytes, copied. */
function copyOf(rt: Runtime, o: Value): Uint8Array {
  const b = bytesOf(rt, o);
  return b.buffer.slice(0, b.length);
}

function readAmf(rt: Runtime, bytes: Uint8Array): Value {
  return new Reader(rt, bytesOf(rt, newByteArray(rt, bytes))).value();
}

/** A shared property's key: null is one of its own, apart from "null". */
const sharedKey = (rt: Runtime, key: Value): string | null =>
  key === null || key === undefined ? null : rt.toString(key);

/** What a shared property keeps of `value`, as makeChannelItem. */
function sharedItem(rt: Runtime, value: Value): { kind: number; bytes: Uint8Array } {
  if (typeof value === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return { kind: ITEM_NUMBER, bytes };
  }

  if (value !== null && typeof value === "object") {
    if (rt.isInstance(value, rt.classNamed("flash.utils::ByteArray"))) {
      const b = bytesOf(rt, value);
      if (!b.shareable) {
        return { kind: ITEM_BYTES, bytes: copyOf(rt, value) };
      }

      // Its memory, known to every thread before the property names it.
      const memory = b.share();
      rt.workerHost?.share?.(memory);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, memory.id, true);
      return { kind: ITEM_SHARED, bytes };
    }

    const ref = syncRef(value);
    if (ref) {
      const bytes = new Uint8Array(5);
      bytes[0] = ref.kind === "mutex" ? 0 : 1;
      new DataView(bytes.buffer).setInt32(1, ref.address, true);
      return { kind: ITEM_SYNC, bytes };
    }
  }

  const holder = newByteArray(rt, new Uint8Array(0));
  const b = bytesOf(rt, holder);
  new Writer(rt, b).value(value);
  return { kind: ITEM_AMF, bytes: b.buffer.slice(0, b.length) };
}

/** As construct="abstract" and "native": AS3 does not construct the class itself, a subclass it may. */
const abstract = (name: string): ClassHook => ({
  construct: (rt) => {
    throw rt.error("ArgumentError", 2012, name);
  },
});

/**
 * As ShellWorkerClass: Worker.current is the primordial worker, made with
 * the class. And avmshell's classes that test how a native class may limit
 * its construction.
 */
export const shellHooks: Record<string, ClassHook> = {
  "avmshell::AbstractBase": abstract("AbstractBase"),
  "avmshell::RestrictedBase": { restricted: true },
  "avmshell::AbstractRestrictedBase": { ...abstract("AbstractRestrictedBase"), restricted: true },
  "avmshell::NativeBase": abstract("NativeBase"),
  "avmshell::NativeBaseAS3": abstract("NativeBaseAS3"),
  // As CheckBaseClass::preCreateInstanceCheck, which throws an error of its own.
  "avmshell::CheckBase": {
    construct: (rt) => {
      throw rt.error("ArgumentError", 1001, "avmshell::CheckBase");
    },
  },
  "flash.system::Worker": {
    ...abstract("Worker"),
    created(rt: Runtime, cls: AsObject): void {
      // Before the class is defined, which classNamed would find.
      setStaticVar(cls, "m_current", workerObject(rt, workersOf(rt).workers.self, cls));
    },
  },
  // As ShellWorkerDomainClass: WorkerDomain.current, made with the class,
  // its constructor empty. A player's WorkerDomain has no m_current to set.
  "flash.system::WorkerDomain": {
    created(_rt: Runtime, cls: AsObject): void {
      setStaticVar(cls, "m_current", cls.$it.instance());
    },
  },
};
