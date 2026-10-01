// flash.system.System: statics about the player's memory and clipboard, of
// which there is nothing here to tell or do.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function systemNatives(_s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let useCodePage = false;

  class SystemNatives {
    static get ime(): Value {
      return null;
    }

    static setClipboard(_text: Value): void {
      // No clipboard.
    }

    static get totalMemoryNumber(): number {
      return 0;
    }

    static get freeMemory(): number {
      return 0;
    }

    static get privateMemory(): number {
      return 0;
    }

    static get processCPUUsage(): number {
      return 0;
    }

    static get useCodePage(): boolean {
      return useCodePage;
    }

    static set useCodePage(v: Value) {
      useCodePage = !!v;
    }

    static get vmVersion(): string {
      return "swf2es";
    }

    static pause(): void {
      // Nothing to pause.
    }

    static resume(): void {
      // Nothing to resume.
    }

    static exit(_code: Value): void {
      // A browser's page does not exit.
    }

    static gc(): void {
      // JavaScript's collector decides.
    }

    static pauseForGCIfCollectionImminent(_imminence: Value): void {
      // JavaScript's collector decides.
    }
  }

  avm2.registerNativeClass(natives, "flash.system::System", SystemNatives);
  return natives;
}
