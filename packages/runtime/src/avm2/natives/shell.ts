// avmshell's own classes, which a player has not: its System.
import type { Runtime, Value } from "../runtime.js";
import { elements, type Natives, registerNativeClass } from "./define.js";

const started = Date.now();

/** System's natives, for `rt`: all static, as avmshell has them. */
export function shellNatives(rt: Runtime): Natives {
  const natives: Natives = {};

  // biome-ignore lint/complexity/noStaticOnlyClass: the class is how System's natives are written, and all of System's are static
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

  registerNativeClass(natives, "avmplus::System", SystemNatives);
  return natives;
}
