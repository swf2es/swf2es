// flash.system.Worker and WorkerDomain: the one worker that runs, the
// primordial, and no others to start. Crossbridge finds Worker on startup
// and keeps its state in the primordial's shared properties.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function workerNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class WorkerNatives {
    declare $shared: Map<string, Value>;

    // No other worker can be started.
    static get isSupported(): boolean {
      return false;
    }

    get isPrimordial(): boolean {
      return true;
    }

    "flash.system:Worker::internalGetState"(): string {
      return "running";
    }

    "flash.system:Worker::internalGetSharedProperty"(key: Value): Value {
      return this.$shared?.get(s.rt.toString(key));
    }

    "flash.system:Worker::internalSetSharedProperty"(key: Value, value: Value): void {
      this.$shared ??= new Map();
      this.$shared.set(s.rt.toString(key), value);
    }

    // Its state never changes, so nothing listens for a change.
    "flash.system:Worker::internalAddEventListener"(): void {}

    "flash.system:Worker::internalRemoveEventListener"(): void {}

    start(): void {
      throw s.rt.unsupported("starting a Worker");
    }

    terminate(): boolean {
      return false;
    }

    createMessageChannel(): Value {
      throw s.rt.unsupported("Worker.createMessageChannel");
    }
  }

  class WorkerDomainNatives {
    static get isSupported(): boolean {
      return false;
    }

    createWorker(): Value {
      throw s.rt.unsupported("creating a Worker");
    }

    listWorkers(): Value {
      throw s.rt.unsupported("WorkerDomain.listWorkers");
    }
  }

  avm2.registerNativeClass(natives, "flash.system::Worker", WorkerNatives);
  avm2.registerNativeClass(natives, "flash.system::WorkerDomain", WorkerDomainNatives);
  return natives;
}

/** Worker.current is the primordial worker, which the VM keeps in Worker's private static _current. */
export function workerHooks(): Record<string, avm2.ClassHook> {
  return {
    "flash.system::Worker": {
      created(rt: avm2.Runtime, cls: AsObject): void {
        avm2.setStaticVar(cls, "_current", rt.constructClass(cls, []));
      },
    },
  };
}
