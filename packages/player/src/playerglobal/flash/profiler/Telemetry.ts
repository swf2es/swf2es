// flash.profiler.Telemetry: no profiler is ever connected, so metrics go
// nowhere and no command handler is called. Crossbridge sends metrics as it
// runs.
import { avm2 } from "@swf2es/runtime";

type Value = avm2.Value;

export function telemetryNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class TelemetryNatives {
    static get connected(): boolean {
      return false;
    }

    static get spanMarker(): number {
      return 0;
    }

    static sendMetric(_name: Value, _value: Value): void {}

    static sendSpanMetric(_name: Value, _start: Value, _value: Value): void {}

    static registerCommandHandler(_name: Value, _f: Value): boolean {
      return false;
    }

    static unregisterCommandHandler(_name: Value): boolean {
      return false;
    }
  }

  avm2.registerNativeClass(natives, "flash.profiler::Telemetry", TelemetryNatives);
  return natives;
}
