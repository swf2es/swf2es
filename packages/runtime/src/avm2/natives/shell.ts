// avmshell's own classes, which a player has not: its System.
import type { Value } from "../runtime.js";
import { elements, type Natives, plain } from "./define.js";

const started = Date.now();

export const shellNatives: Natives = {
  // avmshell's System
  // avmshell's console skips NUL characters, which strings may hold.
  "avmplus::System.trace": (rt) => (args: Value) => {
    rt.print(
      elements(args)
        .map((v) => rt.toString(v))
        .join(" ")
        .replaceAll("\0", ""),
    );
  },
  "avmplus::System.write": (rt) => (s: Value) => {
    rt.print(rt.toString(s).replaceAll("\0", ""));
  },
  "avmplus::System.avmplus:System::getArgv": (rt) => () => rt.array([]),
  "avmplus::System.getAvmplusVersion": plain(() => "swf2es"),
  "avmplus::System.get:swfVersion": plain(() => 31),
  "avmplus::System.get:apiVersion": plain(() => 50),
  "avmplus::System.getTimer": plain(() => Date.now() - started),
  "avmplus::System.getRunmode": plain(() => "jit"),
  "avmplus::System.isDebugger": (rt) => () => rt.debugger,
  "avmplus::System.exit": plain(() => undefined),
};
