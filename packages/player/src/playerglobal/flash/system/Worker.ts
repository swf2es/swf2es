// flash.system.Worker, WorkerDomain and MessageChannel: the AS3 faces of
// the workers scripting/workers.ts runs. A Worker object stands for a
// worker by its id, a MessageChannel for a channel by its own; with no
// worker host, the primordial is the one worker, and none other starts.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { eventDispatcherNatives } from "../events/EventDispatcher.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function workerNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class WorkerNatives {
    declare $worker: number;

    static get isSupported(): boolean {
      return s.workers.supported;
    }

    get isPrimordial(): boolean {
      return this.$worker === 0;
    }

    "flash.system:Worker::internalGetState"(): string {
      return s.workers.state(this.$worker);
    }

    getSharedProperty(key: Value): Value {
      return s.workers.getShared(this.$worker, s.rt.toString(key));
    }

    setSharedProperty(key: Value, value: Value): void {
      s.workers.setShared(this.$worker, s.rt.toString(key), value);
    }

    // Flash's own setSharedProperty and getSharedProperty call these.
    "flash.system:Worker::internalGetSharedProperty"(key: Value): Value {
      return s.workers.getShared(this.$worker, s.rt.toString(key));
    }

    "flash.system:Worker::internalSetSharedProperty"(key: Value, value: Value): void {
      s.workers.setShared(this.$worker, s.rt.toString(key), value);
    }

    // workerState is dispatched to the Worker object whoever listens.
    "flash.system:Worker::internalAddEventListener"(): void {}

    "flash.system:Worker::internalRemoveEventListener"(): void {}

    start(): void {
      s.workers.start(this.$worker);
    }

    terminate(): boolean {
      return s.workers.terminate(this.$worker);
    }

    createMessageChannel(receiver: Value): Value {
      if (receiver === null || receiver === undefined) {
        throw s.rt.error("TypeError", 2007, "receiver");
      }

      return s.workers.createChannel(this.$worker, (receiver as AsObject).$worker);
    }
  }

  class WorkerDomainNatives {
    static get isSupported(): boolean {
      return s.workers.supported;
    }

    createWorker(swf: Value): Value {
      return s.workers.create(swf);
    }

    listWorkers(): Value {
      const rt = s.rt;
      const cls = rt.applyType(rt.classNamed("__AS3__.vec::Vector"), [
        rt.classNamed("flash.system::Worker"),
      ]);
      const o = cls.$it.instance();
      o.$a = s.workers.list();
      o.$fixed = false;
      return o;
    }
  }

  // Its addEventListener and removeEventListener are natives in Flash's
  // playerglobal, which only add to EventDispatcher's.
  const dispatcher = eventDispatcherNatives(s);
  const inherited = (name: string) => dispatcher[`flash.events::EventDispatcher#${name}`](s.rt);
  class MessageChannelNatives {
    send(value: Value): void {
      s.workers.send(this as unknown as AsObject, value);
    }

    get messageAvailable(): boolean {
      return s.workers.messageAvailable(this as unknown as AsObject);
    }

    receive(block: Value): Value {
      return s.workers.receive(this as unknown as AsObject, !!block);
    }

    addEventListener(...args: Value[]): Value {
      return inherited("addEventListener").apply(this, args);
    }

    removeEventListener(...args: Value[]): Value {
      return inherited("removeEventListener").apply(this, args);
    }

    close(): void {
      s.workers.close(this as unknown as AsObject);
    }

    get state(): string {
      return s.workers.channelState(this as unknown as AsObject);
    }

    toString(): string {
      return "[object MessageChannel]";
    }
  }

  avm2.registerNativeClass(natives, "flash.system::Worker", WorkerNatives);
  avm2.registerNativeClass(natives, "flash.system::WorkerDomain", WorkerDomainNatives);
  avm2.registerNativeClass(natives, "flash.system::MessageChannel", MessageChannelNatives);
  return natives;
}

/** Worker.current, which the VM keeps in Worker's private static _current: this VM's own worker. */
export function workerHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.system::Worker": {
      created(_rt: avm2.Runtime, cls: AsObject): void {
        avm2.setStaticVar(cls, "_current", s.workers.objectOf(s.workers.id, cls));
      },
    },
  };
}
