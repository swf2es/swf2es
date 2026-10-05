import { avm2 } from "@swf2es/runtime";

export function numberParseResultNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class NumberParseResultNatives {
    declare $numberValue: number;
    declare $startIndex: number;
    declare $endIndex: number;

    "flash.globalization:NumberParseResult::ctor"(
      value: number,
      startIndex: number,
      endIndex: number,
    ): void {
      this.$numberValue = value;
      this.$startIndex = startIndex;
      this.$endIndex = endIndex;
    }

    get value(): number {
      return this.$numberValue;
    }

    get startIndex(): number {
      return this.$startIndex;
    }

    get endIndex(): number {
      return this.$endIndex;
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.globalization::NumberParseResult",
    NumberParseResultNatives,
  );
  return natives;
}
