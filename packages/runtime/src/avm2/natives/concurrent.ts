// flash.concurrent's Mutex and Condition, as avmplus' ConcurrencyGlue, over
// the memory a primordial's workers share (sync.ts): a Mutex or a Condition
// is an address in it, the same in every worker, and each VM keeps one
// object for each, as avmplus interns one for its State. And
// avm2.intrinsics.memory's compare and swap. Crossbridge uses them all on
// startup whether or not it starts workers.

import type { AsObject, Value } from "../descriptors.js";
import type { Runtime } from "../runtime.js";
import { bytesOf } from "./bytearray.js";
import { type Natives, plain, registerNativeClass } from "./define.js";
import { newSyncMemory, Sync, SyncFull, SyncTimeout } from "./sync.js";

interface MutexObject extends AsObject {
  /** Its address in the shared memory. */
  $mutex: number;
}

interface ConditionObject extends AsObject {
  $condition: number;
  /** Its Mutex object in this VM, once known. */
  $mutexObject: MutexObject | null;
}

interface VmSync {
  sync: Sync;
  /** This VM's one object for each Mutex and Condition, by its address. */
  objects: Map<number, WeakRef<AsObject>>;
}

const vmSyncs = new WeakMap<Runtime, VmSync>();

function vmSync(rt: Runtime): VmSync {
  let vm = vmSyncs.get(rt);
  if (!vm) {
    const init = rt.syncInit;
    const sync = init
      ? new Sync(init.memory, init.thread, init)
      : rt.workerInit
        ? new Sync(rt.workerInit.memory.sync, rt.workerInit.id)
        : new Sync(newSyncMemory(), 0);
    vm = { sync, objects: new Map() };
    vmSyncs.set(rt, vm);
  }

  return vm;
}

/** The shared memory as `rt` sees it: its own, or that of the primordial whose worker it runs. */
export function syncOf(rt: Runtime): Sync {
  return vmSync(rt).sync;
}

/** What a Mutex or a Condition crosses to another worker as: its address. */
export interface SyncRef {
  kind: "mutex" | "condition";
  address: number;
}

/** The address of a Mutex or a Condition; null for anything else. */
export function syncRef(value: Value): SyncRef | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const o = value as AsObject;
  if (typeof o.$mutex === "number") {
    return { kind: "mutex", address: o.$mutex };
  }

  if (typeof o.$condition === "number") {
    return { kind: "condition", address: o.$condition };
  }

  return null;
}

/** This VM's one Mutex or Condition for `ref`, made without running its constructor. */
export function syncObject(rt: Runtime, ref: SyncRef): AsObject {
  const { objects } = vmSync(rt);
  const known = objects.get(ref.address)?.deref();
  if (known) {
    return known;
  }

  const name = ref.kind === "mutex" ? "flash.concurrent::Mutex" : "flash.concurrent::Condition";
  const o = rt.classNamed(name).$it.instance() as AsObject;
  if (ref.kind === "mutex") {
    o.$mutex = ref.address;
  } else {
    o.$condition = ref.address;
    o.$mutexObject = null;
  }

  objects.set(ref.address, new WeakRef(o));
  return o;
}

/** An error of class `name`, or a plain Error where the VM has no such class, as avmshell has none of flash.errors'. */
function errorOf(rt: Runtime, name: string, id: number): Value {
  let cls: AsObject | undefined;
  try {
    cls = rt.classNamed(name);
  } catch {
    cls = undefined;
  }

  return rt.error(cls ? name : "Error", id);
}

/**
 * What a script gets for what the sync memory threw: Flash's script
 * timeout (1502) for a lock or wait that spun too long on the primordial,
 * MemoryError 1000 where the memory is full; anything else as it is, as a
 * terminated worker's SyncTerminated, which no script catches.
 */
export function syncError(rt: Runtime, e: unknown): unknown {
  if (e instanceof SyncTimeout) {
    return errorOf(rt, "flash.errors::ScriptTimeoutError", 1502);
  }

  if (e instanceof SyncFull) {
    return errorOf(rt, "flash.errors::MemoryError", 1000);
  }

  return e;
}

export function concurrentNatives(rt: Runtime): Natives {
  const natives: Natives = {};

  const blocking = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw syncError(rt, e);
    }
  };

  class MutexNatives {
    static get isSupported(): boolean {
      return true;
    }

    "flash.concurrent:Mutex::ctor"(this: MutexObject): void {
      const vm = vmSync(rt);
      this.$mutex = blocking(() => vm.sync.newMutex());
      vm.objects.set(this.$mutex, new WeakRef(this));
    }

    lock(this: MutexObject): void {
      blocking(() => syncOf(rt).lock(this.$mutex));
    }

    tryLock(this: MutexObject): boolean {
      return blocking(() => syncOf(rt).tryLock(this.$mutex));
    }

    unlock(this: MutexObject): void {
      if (!syncOf(rt).unlock(this.$mutex)) {
        throw rt.error("flash.errors::IllegalOperationError", 1514);
      }
    }
  }

  class ConditionNatives {
    static get isSupported(): boolean {
      return true;
    }

    "flash.concurrent:Condition::ctor"(this: ConditionObject, mutex: Value): void {
      if (mutex === null || mutex === undefined) {
        throw rt.error("ArgumentError", 2007, "mutex");
      }

      const vm = vmSync(rt);
      this.$mutexObject = mutex as MutexObject;
      this.$condition = blocking(() => vm.sync.newCondition((mutex as MutexObject).$mutex));
      vm.objects.set(this.$condition, new WeakRef(this));
    }

    // As ConditionObject::get_mutex: one that crossed from another worker
    // finds its Mutex in this VM, or makes it.
    get mutex(): Value {
      const self = this as unknown as ConditionObject;
      if (!self.$mutexObject) {
        const address = syncOf(rt).conditionMutex(self.$condition);
        self.$mutexObject = syncObject(rt, { kind: "mutex", address }) as MutexObject;
      }

      return self.$mutexObject;
    }

    // As ConditionObject::wait: true when the time ran out, false when
    // notified, and false for a wait without a timeout (-1), which only a
    // notify ends.
    wait(this: ConditionObject, timeout: Value): boolean {
      // Left out, it is the declared -1, which a native is not given.
      const t = timeout === undefined ? -1 : rt.toNumber(timeout);
      if (t < 0 && t !== -1) {
        throw rt.error("ArgumentError", 1515);
      }

      const sync = syncOf(rt);
      if (!sync.holds(sync.conditionMutex(this.$condition))) {
        throw rt.error("flash.errors::IllegalOperationError", 1518);
      }

      const ms = t === -1 ? -1 : Number.isNaN(t) ? 0 : Math.min(Math.ceil(t), 0x7fffffff);
      return blocking(() => sync.wait(this.$condition, ms));
    }

    notify(this: ConditionObject): void {
      const sync = syncOf(rt);
      if (!sync.holds(sync.conditionMutex(this.$condition))) {
        throw rt.error("flash.errors::IllegalOperationError", 1516);
      }

      blocking(() => sync.notify(this.$condition, false));
    }

    notifyAll(this: ConditionObject): void {
      const sync = syncOf(rt);
      if (!sync.holds(sync.conditionMutex(this.$condition))) {
        throw rt.error("flash.errors::IllegalOperationError", 1517);
      }

      blocking(() => sync.notify(this.$condition, true));
    }
  }

  // As ConcurrentMemory::casi32: the domain memory's int at a word-aligned
  // address replaced by `next` if it is `expected`; the int there before.
  // Atomic where another worker shares the memory.
  natives["avm2.intrinsics.memory::casi32"] = plain(
    (address: Value, expected: Value, next: Value) => {
      const at = rt.toInt(address);
      const outside = () => at % 4 !== 0 || rt.memoryLength < 4 || at >>> 0 > rt.memoryLength - 4;
      if (outside()) {
        rt.refreshMemory?.();
        if (outside()) {
          throw rt.error("RangeError", 1506);
        }
      }

      if (rt.refreshMemory && rt.memoryProvider) {
        return bytesOf(rt, rt.memoryProvider).compareAndSwapInt(
          at,
          rt.toInt(expected),
          rt.toInt(next),
        );
      }

      const previous = rt.memory.getInt32(at, true);
      if (previous === rt.toInt(expected)) {
        rt.memory.setInt32(at, rt.toInt(next), true);
      }

      return previous;
    },
  );
  natives["avm2.intrinsics.memory::mfence"] = plain(() => {});

  registerNativeClass(natives, "flash.concurrent::Mutex", MutexNatives);
  registerNativeClass(natives, "flash.concurrent::Condition", ConditionNatives);
  return natives;
}
