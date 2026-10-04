// flash.display.InteractiveObject: what it keeps about input, kept as
// fields with Flash's defaults until input reaches the player.
import { avm2 } from "@swf2es/runtime";
import { tabEnabledDefault } from "../../../keyboard.js";
import type { Scripting } from "../../../scripting.js";
import { displayOf } from "./DisplayObject.js";

type Value = avm2.Value;

export function interactiveObjectNatives(_s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class InteractiveObjectNatives {
    declare $tabEnabled: boolean | undefined;
    declare $tabIndex: number | undefined;
    declare $focusRect: Value;
    declare $mouseEnabled: boolean | undefined;
    declare $doubleClickEnabled: boolean | undefined;
    declare $accessibility: Value;
    declare $softKeyboardArea: Value;
    declare $needsSoftKeyboard: boolean | undefined;

    get tabEnabled(): boolean {
      return this.$tabEnabled ?? tabEnabledDefault(displayOf(this as unknown as avm2.AsObject));
    }

    set tabEnabled(v: Value) {
      this.$tabEnabled = !!v;
    }

    get tabIndex(): number {
      return this.$tabIndex ?? -1;
    }

    set tabIndex(v: Value) {
      this.$tabIndex = Number(v) | 0;
    }

    get focusRect(): Value {
      return this.$focusRect ?? null;
    }

    set focusRect(v: Value) {
      this.$focusRect = v;
    }

    get mouseEnabled(): boolean {
      return this.$mouseEnabled ?? true;
    }

    set mouseEnabled(v: Value) {
      this.$mouseEnabled = !!v;
    }

    get doubleClickEnabled(): boolean {
      return this.$doubleClickEnabled ?? false;
    }

    set doubleClickEnabled(v: Value) {
      this.$doubleClickEnabled = !!v;
    }

    get accessibilityImplementation(): Value {
      return this.$accessibility ?? null;
    }

    set accessibilityImplementation(v: Value) {
      this.$accessibility = v;
    }

    get softKeyboardInputAreaOfInterest(): Value {
      return this.$softKeyboardArea ?? null;
    }

    set softKeyboardInputAreaOfInterest(v: Value) {
      this.$softKeyboardArea = v;
    }

    get needsSoftKeyboard(): boolean {
      return this.$needsSoftKeyboard ?? false;
    }

    set needsSoftKeyboard(v: Value) {
      this.$needsSoftKeyboard = !!v;
    }

    requestSoftKeyboard(): boolean {
      return false;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::InteractiveObject", InteractiveObjectNatives);
  return natives;
}
