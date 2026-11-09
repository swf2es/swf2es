// flash.desktop.NativeApplication, AIR's one application object, over the
// host's AirApplication (hosts.ts): its descriptor, its window and its
// launch, which adl hands each InvokeEvent listener once it listens. A
// listener added in the document class's constructor has it before the
// first frame's ENTER_FRAME; one added in a frame's scripts, at that
// frame's end; each once, those that had it before not again, with the
// directory it was launched from as a File. Without a host the application
// has no window and was launched with no arguments, from nowhere.
// What the values are where no host says: adl's (AIR 51.3).
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent, dispatchToListener } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { nativeWindowOf } from "../display/NativeWindow.js";
import { addListener, removeListener } from "../events/EventDispatcher.js";
import { fileAt } from "../filesystem/File.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** NativeApplication.runtimeVersion, and its patch level: the AIR these natives follow. */
const AIR_RUNTIME_VERSION = "51.3.1.2";
const AIR_PATCH_LEVEL = 2;

const INVOKE = "invoke";

export function nativeApplicationNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let application: AsObject | null = null;
  /** InvokeEvent listeners added since the launch was last handed out, in the order added. */
  const awaiting: Value[] = [];
  let autoExit = true;
  let idleThreshold = 300;
  let systemIdleMode = "normal";
  let executeInBackground = false;

  /** The launch, to each listener added since it was last handed out, at the frame's end. */
  const handOut = () => {
    const app = application as AsObject;
    const listening = app.$listeners?.get(INVOKE) ?? [];
    for (const fn of awaiting.splice(0)) {
      // Taken off again before the frame ended, it hears nothing.
      if (!listening.some((l: { fn: Value; capture: boolean }) => l.fn === fn && !l.capture)) {
        continue;
      }

      const event = s.rt.construct(
        s.rt.classNamed("flash.events::InvokeEvent"),
        INVOKE,
        false,
        false,
        s.application?.currentDirectory ? fileAt(s, s.application.currentDirectory) : null,
        s.rt.array([...(s.application?.arguments ?? [])]),
        "standard",
      ) as AsObject;
      dispatchToListener(s, app, event, fn);
    }
  };

  class NativeApplicationNatives {
    static get nativeApplication(): Value {
      application ??= s.rt.construct(
        s.rt.classNamed("flash.desktop::NativeApplication"),
      ) as AsObject;
      return application;
    }

    // A browser's or Electron's window has no menu, dock or tray of AIR's.
    static get supportsMenu(): boolean {
      return false;
    }

    static get supportsDockIcon(): boolean {
      return false;
    }

    static get supportsSystemTrayIcon(): boolean {
      return false;
    }

    static get supportsDefaultApplication(): boolean {
      return false;
    }

    static get supportsStartAtLogin(): boolean {
      return false;
    }

    addEventListener(type: Value, fn: Value, useCapture: Value, priority: Value): void {
      const added = addListener(s, this as unknown as AsObject, type, fn, useCapture, priority);
      if (added && type === INVOKE && !useCapture) {
        if (awaiting.length === 0) {
          s.afterExitFrame.push(handOut);
        }

        awaiting.push(fn);
      }
    }

    removeEventListener(type: Value, fn: Value, useCapture: Value): void {
      removeListener(s, this as unknown as AsObject, type, fn, useCapture);
    }

    dispatchEvent(event: Value): boolean {
      return dispatchEvent(s, this as unknown as AsObject, event as AsObject);
    }

    exit(code: Value): void {
      s.application?.exit?.(Number(code) | 0);
    }

    get runtimeVersion(): string {
      return AIR_RUNTIME_VERSION;
    }

    get runtimePatchLevel(): number {
      return AIR_PATCH_LEVEL;
    }

    get applicationID(): string {
      return s.application?.id ?? "";
    }

    get publisherID(): string {
      return "";
    }

    get applicationDescriptor(): Value {
      const text = s.application?.descriptor;
      return text ? s.rt.constructClass(s.rt.builtinClass("XML"), [text]) : null;
    }

    get menu(): Value {
      return null;
    }

    set menu(_v: Value) {}

    get icon(): Value {
      return null;
    }

    get autoExit(): boolean {
      return autoExit;
    }

    set autoExit(v: Value) {
      autoExit = !!v;
    }

    get idleThreshold(): number {
      return idleThreshold;
    }

    set idleThreshold(v: Value) {
      idleThreshold = Number(v) | 0;
    }

    get timeSinceLastUserInput(): number {
      return 0;
    }

    get systemIdleMode(): string {
      return systemIdleMode;
    }

    set systemIdleMode(v: Value) {
      systemIdleMode = String(v);
    }

    get executeInBackground(): boolean {
      return executeInBackground;
    }

    set executeInBackground(v: Value) {
      executeInBackground = !!v;
    }

    // adl refuses it, being no installed application; so does a host.
    get startAtLogin(): boolean {
      throw s.rt.error("Error", 2014);
    }

    set startAtLogin(_v: Value) {
      throw s.rt.error("Error", 2014);
    }

    get activeWindow(): Value {
      const window = nativeWindowOf(s);
      return window && s.application?.window?.active() ? window : null;
    }

    get openedWindows(): Value {
      const window = nativeWindowOf(s);
      return s.rt.array(window ? [window] : []);
    }

    activate(_window: Value): void {
      s.application?.window?.activate?.();
    }

    // The edit commands go to the focused text, which the player's keyboard handles itself.
    copy(): boolean {
      return false;
    }

    cut(): boolean {
      return false;
    }

    paste(): boolean {
      return false;
    }

    clear(): boolean {
      return false;
    }

    selectAll(): boolean {
      return false;
    }

    getDefaultApplication(_extension: Value): Value {
      return null;
    }

    isSetAsDefaultApplication(_extension: Value): boolean {
      return false;
    }

    setAsDefaultApplication(_extension: Value): void {
      throw s.rt.error("Error", 2014);
    }

    removeAsDefaultApplication(_extension: Value): void {
      throw s.rt.error("Error", 2014);
    }
  }

  avm2.registerNativeClass(natives, "flash.desktop::NativeApplication", NativeApplicationNatives);
  return natives;
}
