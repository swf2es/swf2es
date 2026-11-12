// flash.display.NativeWindow: an AIR application's window, as
// Stage.nativeWindow gives it, over the host's AirWindow (hosts.ts). Its
// bounds are the window's on the screen, its frame included, as AIR's are;
// the stage keeps the size its scale mode gives it. A window a script opens
// itself is not supported. Where the host does not say: adl's values
// (AIR 51.3), but for the system's sizes, a browser's window having no
// least size of its own.
import { avm2 } from "@swf2es/runtime";
import type { WindowBounds } from "../../../hosts.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The window each player's stage is in, made as a script first asks for it. */
const windows = new WeakMap<Scripting, AsObject>();

/** The application's window, Stage.nativeWindow's, or null where the host has none. */
export function nativeWindowOf(s: Scripting): AsObject | null {
  if (!s.application?.window) {
    return null;
  }

  let window = windows.get(s);
  if (!window) {
    window = s.rt.construct(s.rt.classNamed("flash.display::NativeWindow"), null) as AsObject;
    windows.set(s, window);
  }

  return window;
}

/** AIR's largest window, either way. */
const MAX_SIDE = 107374182;

export function nativeWindowNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const prop = (o: Value, name: string) =>
    Number(s.rt.getProperty(o as AsObject, avm2.qname(avm2.publicNs, name)));
  const point = (x: number, y: number) =>
    s.rt.construct(s.rt.classNamed("flash.geom::Point"), x, y);
  let closed = false;
  let alwaysInFront = false;
  let minSize: Value = null;
  let maxSize: Value = null;

  /** The host's window behind `o`, which only the application's window has. */
  const hostOf = (o: unknown) => {
    const window = s.application?.window;
    if (!window || o !== windows.get(s)) {
      throw s.rt.unsupported("a NativeWindow a script opens");
    }

    return window;
  };
  const bounds = (o: unknown): WindowBounds => hostOf(o).bounds();
  const move = (o: unknown, change: Partial<WindowBounds>) => {
    const window = hostOf(o);
    window.setBounds?.({ ...window.bounds(), ...change });
  };

  class NativeWindowNatives {
    static get isSupported(): boolean {
      return s.air;
    }

    static get supportsMenu(): boolean {
      return false;
    }

    static get supportsNotification(): boolean {
      return false;
    }

    static get supportsTransparency(): boolean {
      return false;
    }

    static get systemMinSize(): Value {
      return point(1, 1);
    }

    static get systemMaxSize(): Value {
      return point(MAX_SIDE, MAX_SIDE);
    }

    get stage(): Value {
      hostOf(this);
      return s.stage?.object ?? null;
    }

    get title(): string {
      return hostOf(this).title();
    }

    set title(v: Value) {
      hostOf(this).setTitle?.(String(v));
    }

    get bounds(): Value {
      const b = bounds(this);
      return s.rt.construct(s.rt.classNamed("flash.geom::Rectangle"), b.x, b.y, b.width, b.height);
    }

    set bounds(v: Value) {
      if (v === null) {
        throw s.rt.error("TypeError", 2007, "bounds");
      }

      move(this, {
        x: prop(v, "x"),
        y: prop(v, "y"),
        width: prop(v, "width"),
        height: prop(v, "height"),
      });
    }

    get x(): number {
      return bounds(this).x;
    }

    set x(v: Value) {
      move(this, { x: Number(v) });
    }

    get y(): number {
      return bounds(this).y;
    }

    set y(v: Value) {
      move(this, { y: Number(v) });
    }

    get width(): number {
      return bounds(this).width;
    }

    set width(v: Value) {
      move(this, { width: Number(v) });
    }

    get height(): number {
      return bounds(this).height;
    }

    set height(v: Value) {
      move(this, { height: Number(v) });
    }

    get displayState(): string {
      return hostOf(this).displayState();
    }

    // A stage in full screen leaves it first, with its FullScreenEvent, as in adl.
    minimize(): void {
      s.fullScreen.set("normal");
      hostOf(this).minimize?.();
    }

    maximize(): void {
      hostOf(this).maximize?.();
    }

    restore(): void {
      s.fullScreen.set("normal");
      hostOf(this).restore?.();
    }

    close(): void {
      const window = hostOf(this);
      if (!closed) {
        closed = true;
        window.close?.();
      }
    }

    get closed(): boolean {
      hostOf(this);
      return closed;
    }

    get visible(): boolean {
      return hostOf(this).visible();
    }

    set visible(v: Value) {
      hostOf(this).setVisible?.(!!v);
    }

    get active(): boolean {
      return hostOf(this).active();
    }

    activate(): void {
      hostOf(this).activate?.();
    }

    get systemChrome(): string {
      hostOf(this);
      return "standard";
    }

    get transparent(): boolean {
      hostOf(this);
      return false;
    }

    get type(): string {
      hostOf(this);
      return "normal";
    }

    get minimizable(): boolean {
      hostOf(this);
      return true;
    }

    get maximizable(): boolean {
      hostOf(this);
      return true;
    }

    get resizable(): boolean {
      hostOf(this);
      return true;
    }

    // Moving and resizing by the mouse are the window manager's.
    startMove(): boolean {
      hostOf(this);
      return false;
    }

    startResize(): boolean {
      hostOf(this);
      return false;
    }

    get minSize(): Value {
      hostOf(this);
      minSize ??= point(1, 1);
      return minSize;
    }

    set minSize(v: Value) {
      hostOf(this);
      minSize = v;
    }

    get maxSize(): Value {
      hostOf(this);
      maxSize ??= point(MAX_SIDE, MAX_SIDE);
      return maxSize;
    }

    set maxSize(v: Value) {
      hostOf(this);
      maxSize = v;
    }

    get alwaysInFront(): boolean {
      hostOf(this);
      return alwaysInFront;
    }

    set alwaysInFront(v: Value) {
      hostOf(this);
      alwaysInFront = !!v;
    }

    // One window: nothing to order it among.
    orderToFront(): boolean {
      hostOf(this);
      return false;
    }

    orderToBack(): boolean {
      hostOf(this);
      return false;
    }

    orderInFrontOf(_window: Value): boolean {
      hostOf(this);
      return false;
    }

    orderInBackOf(_window: Value): boolean {
      hostOf(this);
      return false;
    }

    /** A point of the stage's on the screen: past the window's corner and its frame's border and title bar. */
    globalToScreen(p: Value): Value {
      const window = hostOf(this);
      const b = window.bounds();
      const offset = window.stageOffset();
      return point(b.x + offset.x + prop(p, "x"), b.y + offset.y + prop(p, "y"));
    }

    get menu(): Value {
      hostOf(this);
      return null;
    }

    set menu(_v: Value) {
      hostOf(this);
    }

    notifyUser(_type: Value): void {
      hostOf(this);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::NativeWindow", NativeWindowNatives);
  return natives;
}
