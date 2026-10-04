// flash.events.KeyboardEvent's native fields: the character, and the
// modifier keys held, which playerglobal's constructor sets through them;
// and TextEvent's one native, which a clone copies IME data through.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function keyboardEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class KeyboardEventNatives {
    declare $charCode: number | undefined;
    declare $ctrlKey: boolean | undefined;
    declare $altKey: boolean | undefined;
    declare $shiftKey: boolean | undefined;
    declare $commandKey: boolean | undefined;

    get charCode(): number {
      return this.$charCode ?? 0;
    }

    set charCode(value: Value) {
      this.$charCode = s.rt.toUint(value);
    }

    get ctrlKey(): boolean {
      return this.$ctrlKey ?? false;
    }

    set ctrlKey(value: Value) {
      this.$ctrlKey = !!value;
    }

    get altKey(): boolean {
      return this.$altKey ?? false;
    }

    set altKey(value: Value) {
      this.$altKey = !!value;
    }

    get shiftKey(): boolean {
      return this.$shiftKey ?? false;
    }

    set shiftKey(value: Value) {
      this.$shiftKey = !!value;
    }

    get commandKey(): boolean {
      return this.$commandKey ?? false;
    }

    set commandKey(value: Value) {
      this.$commandKey = !!value;
    }

    updateAfterEvent(): void {
      s.updates++;
    }
  }

  avm2.registerNativeClass(natives, "flash.events::KeyboardEvent", KeyboardEventNatives);

  class TextEventNatives {
    "flash.events:TextEvent::copyNativeData"(_from: Value): void {
      // A text input's IME data, which the player has none of.
    }
  }

  avm2.registerNativeClass(natives, "flash.events::TextEvent", TextEventNatives);
  return natives;
}
