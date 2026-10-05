import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

interface TabStopData {
  alignment: string;
  position: number;
  decimalAlignmentToken: string;
}

function data(o: AsObject): TabStopData {
  if (!o.$tabStop) {
    o.$tabStop = { alignment: "start", position: 0, decimalAlignmentToken: "" };
  }

  return o.$tabStop;
}

export function tabStopNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TabStopNatives {
    get alignment(): string {
      return data(this as AsObject).alignment;
    }

    set alignment(value: Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "alignment");
      }

      const alignment = s.rt.toString(value);
      if (!["start", "center", "end", "decimal"].includes(alignment)) {
        throw s.rt.error("ArgumentError", 2008, "alignment");
      }

      data(this as AsObject).alignment = alignment;
    }

    get position(): number {
      return data(this as AsObject).position;
    }

    set position(value: Value) {
      const position = Number(value);
      if (position < 0) {
        throw s.rt.error("ArgumentError", 2004);
      }

      data(this as AsObject).position = position;
    }

    get decimalAlignmentToken(): string {
      return data(this as AsObject).decimalAlignmentToken;
    }

    set decimalAlignmentToken(value: Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "decimalAlignmentToken");
      }

      data(this as AsObject).decimalAlignmentToken = s.rt.toString(value);
    }
  }

  avm2.registerNativeClass(natives, "flash.text.engine::TabStop", TabStopNatives);
  return natives;
}
