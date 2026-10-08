// flash.system.System: statics about the player's memory, of which there
// is nothing here to tell or do, and setClipboard.
import { avm2 } from "@swf2es/runtime";
import { TEXT } from "../../../scripting/clipboard.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function systemNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let useCodePage = false;

  class SystemNatives {
    static get ime(): Value {
      return null;
    }

    /**
     * The clipboard's text alone, in place of all it held, while a user's
     * event is handled; outside one Error #2176, as Ruffle has the plug-in
     * throw it, and TypeError #2007 for null, as Ruffle's does.
     */
    static setClipboard(text: Value): void {
      if (text === null || text === undefined) {
        throw s.rt.error("TypeError", 2007, "text");
      }

      const clipboard = s.clipboard;
      if (!clipboard.writable) {
        throw s.rt.error("Error", 2176);
      }

      clipboard.clear();
      clipboard.set(TEXT, s.rt.toString(text));
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

    static disposeXML(_node: Value): void {
      // It frees an XML tree early, which JavaScript's collector does once nothing refers to it.
    }
  }

  avm2.registerNativeClass(natives, "flash.system::System", SystemNatives);
  return natives;
}
