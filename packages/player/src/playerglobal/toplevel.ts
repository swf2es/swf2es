// playerglobal's toplevel: trace, as Flash Player writes it to its log.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";

export function toplevelNatives(_s: Scripting): avm2.Natives {
  return {
    trace:
      (rt) =>
      (...args: avm2.Value[]) => {
        rt.print(args.map((v) => rt.toString(v)).join(" "));
      },
  };
}
