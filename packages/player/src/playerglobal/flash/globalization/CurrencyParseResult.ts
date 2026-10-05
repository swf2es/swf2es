import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function currencyParseResultNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class CurrencyParseResultNatives {
    declare $currencyValue: number;
    declare $currencyString: string | null;

    "flash.globalization:CurrencyParseResult::ctor"(value: number, symbol: string | null): void {
      if (symbol === null) {
        throw s.rt.error("TypeError", 2007, "symbol");
      }

      this.$currencyValue = value;
      this.$currencyString = symbol;
    }

    get value(): number {
      return this.$currencyValue;
    }

    get currencyString(): string | null {
      return this.$currencyString;
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.globalization::CurrencyParseResult",
    CurrencyParseResultNatives,
  );
  return natives;
}
