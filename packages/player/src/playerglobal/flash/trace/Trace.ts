// Release Flash Player does not expose its trace listener or levels to SWFs.
import { avm2 } from "@swf2es/runtime";

type Value = avm2.Value;

export function traceNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class TraceNatives {
    static setLevel(_level: number, _target: number): void {}

    static getLevel(_target: number): number {
      return 0;
    }

    static setListener(_listener: Value): void {}

    static getListener(): null {
      return null;
    }
  }

  avm2.registerNativeClass(natives, "flash.trace::Trace", TraceNatives);
  return natives;
}
