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
