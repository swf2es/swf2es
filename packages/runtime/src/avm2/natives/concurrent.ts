// flash.concurrent's Mutex and Condition, and avm2.intrinsics.memory's
// compare and swap, as avmplus' ConcurrencyGlue on its one thread: a mutex
// is held or not, recursively, and nothing else runs to take it, to notify
// a condition or to see memory out of order. Crossbridge uses them all on
// startup whether or not it starts workers.
import type { AsObject, Runtime, Value } from "../runtime.js";
import { type Natives, plain, registerNativeClass } from "./define.js";

/** A mutex's state: how many times this one thread holds it. */
interface MutexObject extends AsObject {
  $held: number;
}

interface ConditionObject extends AsObject {
  $mutex: MutexObject;
}

export function concurrentNatives(rt: Runtime): Natives {
  const natives: Natives = {};

  class MutexNatives {
    static get isSupported(): boolean {
      return true;
    }

    "flash.concurrent:Mutex::ctor"(this: MutexObject): void {
      this.$held = 0;
    }

    lock(this: MutexObject): void {
      this.$held++;
    }

    // No waiter can be ahead of this thread, so the lock is always had.
    tryLock(this: MutexObject): boolean {
      this.$held++;
      return true;
    }

    unlock(this: MutexObject): void {
      if (this.$held === 0) {
        throw rt.error("flash.errors::IllegalOperationError", 1514);
      }

      this.$held--;
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

      this.$mutex = mutex as MutexObject;
    }

    get mutex(): Value {
      return (this as unknown as ConditionObject).$mutex;
    }

    // Nothing else runs to notify it or change what it waits for: a wait
    // ends at once, the mutex held again as it was, and gives true, as
    // avmshell's does once its time is up. avmshell's waits that long,
    // and forever without a timeout; a page cannot block.
    wait(this: ConditionObject, timeout: Value): boolean {
      const t = rt.toNumber(timeout);
      if (t < 0 && t !== -1) {
        throw rt.error("ArgumentError", 1515);
      }

      if (this.$mutex.$held === 0) {
        throw rt.error("flash.errors::IllegalOperationError", 1518);
      }

      return true;
    }

    notify(this: ConditionObject): void {
      if (this.$mutex.$held === 0) {
        throw rt.error("flash.errors::IllegalOperationError", 1516);
      }
    }

    notifyAll(this: ConditionObject): void {
      if (this.$mutex.$held === 0) {
        throw rt.error("flash.errors::IllegalOperationError", 1517);
      }
    }
  }

  // As ConcurrentMemory::casi32: the domain memory's int at a word-aligned
  // address replaced by `next` if it is `expected`; the int there before.
  natives["avm2.intrinsics.memory::casi32"] = plain(
    (address: Value, expected: Value, next: Value) => {
      const at = rt.toInt(address);
      const size = rt.memoryLength;
      if (at % 4 !== 0 || size < 4 || at >>> 0 > size - 4) {
        throw rt.error("RangeError", 1506);
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
