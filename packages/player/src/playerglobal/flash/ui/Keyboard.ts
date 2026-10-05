// flash.ui.Keyboard's statics of the keyboard itself: a desktop's,
// alphanumeric, not virtual, its locks reported off, as a browser keeps
// their state from a page until a key event carries it.
import { avm2 } from "@swf2es/runtime";

export function keyboardNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class KeyboardNatives {
    static get capsLock(): boolean {
      return false;
    }

    static get numLock(): boolean {
      return false;
    }

    static get hasVirtualKeyboard(): boolean {
      return false;
    }

    static get physicalKeyboardType(): string {
      return "alphanumeric";
    }

    /** Whether the keys may be read: no screen reader is in the way. */
    static isAccessible(): boolean {
      return true;
    }
  }

  avm2.registerNativeClass(natives, "flash.ui::Keyboard", KeyboardNatives);
  return natives;
}
