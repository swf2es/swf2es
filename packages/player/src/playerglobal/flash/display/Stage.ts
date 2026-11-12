// flash.display.Stage: the stage's size and frame rate, invalidate, which
// asks for a RENDER event before the frame is drawn, focus, which keys go
// to (input/keyboard.ts), and the two container methods Stage declares native
// again, which do as a container's do.
import { avm2 } from "@swf2es/runtime";
import { setFocus } from "../../../input/keyboard.js";
import type { Scripting } from "../../../scripting.js";
import { stageAlignment } from "../../../stage.js";
import type { As3 } from "../../as3-types.js";
import { displayOf } from "./DisplayObject.js";
import { containerNatives } from "./DisplayObjectContainer.js";
import { nativeWindowOf } from "./NativeWindow.js";

type Value = avm2.Value;

export function stageNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class StageNatives {
    "flash.display:Stage::requireOwnerPermissions"(): void {
      // One owner: the SWF the player runs.
    }

    get frameRate(): number {
      return s.frameRate;
    }

    /** The AIR application's window the stage is in; null outside AIR, or where the host has none. */
    get nativeWindow(): Value {
      return nativeWindowOf(s);
    }

    set frameRate(v: Value) {
      s.frameRate = Math.max(0.01, Math.min(1000, Number(v)));
    }

    get stageWidth(): number {
      return s.stageWidth;
    }

    /** The embedding page sizes the stage: a SWF's own sizes are taken and dropped, as in Ruffle. */
    set stageWidth(_v: Value) {}

    get stageHeight(): number {
      return s.stageHeight;
    }

    set stageHeight(_v: Value) {}

    /** Undocumented; null in AIR's adl, and in Flash Player as Ruffle found it. */
    get displayContextInfo(): Value {
      return null;
    }

    invalidate(): void {
      s.invalidated = true;
    }

    get scaleMode(): string {
      return s.stageScaleMode;
    }

    set scaleMode(v: Value) {
      if (v == null) {
        throw s.rt.error("TypeError", 2007, "scaleMode");
      }

      const value = s.rt.toString(v);
      switch (value) {
        case "showAll":
        case "noScale":
        case "noBorder":
        case "exactFit":
          break;
        default:
          throw s.rt.error("ArgumentError", 2008, "scaleMode");
      }

      s.stageScaleModeSet = true;
      if (value !== s.stageScaleMode) {
        s.stageScaleMode = value;
        s.onStageLayout?.();
      }
    }

    get align(): string {
      return s.stageAlign;
    }

    set align(v: Value) {
      if (v == null) {
        throw s.rt.error("TypeError", 2007, "align");
      }

      const value = stageAlignment(s.rt.toString(v));
      s.stageAlignSet = true;
      if (value !== s.stageAlign) {
        s.stageAlign = value;
        s.onStageLayout?.();
      }
    }

    get quality(): string {
      return s.quality;
    }

    set quality(v: Value) {
      s.quality = String(v).toUpperCase();
    }

    get displayState(): string {
      return s.fullScreen.state;
    }

    /** As adl: full screen, and its FullScreenEvent dispatched, before it returns (scripting/full-screen.ts). */
    set displayState(v: Value) {
      if (v == null) {
        throw s.rt.error("TypeError", 2007, "displayState");
      }

      const value = s.rt.toString(v);
      switch (value) {
        case "normal":
        case "fullScreen":
        case "fullScreenInteractive":
          s.fullScreen.set(value);
          break;
        default:
          throw s.rt.error("ArgumentError", 2008, "displayState");
      }
    }

    get focus(): Value {
      return s.focus?.object ?? null;
    }

    // A field given focus keeps its selection (the corpus's edittext_focus_selection).
    set focus(v: Value) {
      setFocus(s, v ? (displayOf(v as avm2.AsObject) ?? null) : null);
    }

    get showDefaultContextMenu(): boolean {
      return s.showDefaultContextMenu;
    }

    set showDefaultContextMenu(v: Value) {
      s.showDefaultContextMenu = s.rt.toBoolean(v);
    }

    // Kept, though no focus rectangle is drawn.
    get stageFocusRect(): boolean {
      return focusRect;
    }

    set stageFocusRect(v: Value) {
      focusRect = !!v;
    }

    /** The background, opaque: what a SWF's SetBackgroundColor gave until set, the alpha set ignored. */
    get color(): number {
      return ((s.stageColor ?? 0xffffff) | 0xff000000) >>> 0;
    }

    set color(v: Value) {
      s.stageColor = s.rt.toUint(v) & 0xffffff;
      // A redraw asked for: a host that reads Player.background as it draws shows it.
      s.updates++;
    }

    /** The embedding's allowFullScreen; true where no host says, as before there was one. */
    get allowsFullScreen(): boolean {
      return s.fullScreen.host?.allowed(false) ?? true;
    }

    /** The embedding's allowFullScreenInteractive; false in adl, which goes interactive all the same. */
    get allowsFullScreenInteractive(): boolean {
      return !s.air && (s.fullScreen.host?.allowed(true) ?? false);
    }

    get browserZoomFactor(): number {
      return 1;
    }

    get contentsScaleFactor(): number {
      return 1;
    }

    get fullScreenWidth(): number {
      return s.screenCapabilities.screenResolutionX;
    }

    get fullScreenHeight(): number {
      return s.screenCapabilities.screenResolutionY;
    }

    /** A Rectangle of its own each time, as adl gives: changing it changes nothing. */
    get fullScreenSourceRect(): Value {
      const r = s.fullScreen.sourceRect;
      return (
        r && s.rt.construct(s.rt.classNamed("flash.geom::Rectangle"), r.x, r.y, r.width, r.height)
      );
    }

    set fullScreenSourceRect(v: Value) {
      if (v == null) {
        s.fullScreen.setSourceRect(null);
        return;
      }

      const r = v as As3<"flash.geom::Rectangle">;
      const read = (k: "x" | "y" | "width" | "height") => s.rt.toNumber(s.rt.prop(r, k));
      s.fullScreen.setSourceRect({
        x: read("x"),
        y: read("y"),
        width: read("width"),
        height: read("height"),
      });
    }

    get colorCorrection(): string {
      return colorCorrection;
    }

    set colorCorrection(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "colorCorrection");
      }

      colorCorrection = s.rt.toString(v);
    }

    get colorCorrectionSupport(): string {
      return "unsupported";
    }

    // Kept while in full screen, which alone allows it and whose end clears it; the pointer is not locked.
    get mouseLock(): boolean {
      return s.fullScreen.mouseLock;
    }

    set mouseLock(v: Value) {
      // Outside full screen even false throws, as in adl.
      if (!s.fullScreen.active) {
        throw s.rt.error("Error", 3707);
      }

      s.fullScreen.mouseLock = s.rt.toBoolean(v);
    }

    get wmodeGPU(): boolean {
      return false;
    }

    get softKeyboardRect(): Value {
      return s.rt.construct(s.rt.classNamed("flash.geom::Rectangle"), 0, 0, 0, 0);
    }

    get orientation(): string {
      return "unknown";
    }

    get deviceOrientation(): string {
      return "unknown";
    }

    get autoOrients(): boolean {
      return false;
    }

    "flash.display:Stage::setAutoOrients"(_v: Value): void {}

    get supportedOrientations(): Value {
      const strings = s.rt.resolve(s.rt.vector("String")).$it.instance();
      strings.$a = [];
      return strings;
    }

    static get supportsOrientationChange(): boolean {
      return false;
    }

    isFocusInaccessible(): boolean {
      return false;
    }

    /** No StageVideo: the vector is empty. */
    get stageVideos(): Value {
      return vectorOf("flash.media::StageVideo", []);
    }

    /** Flash's four, each of which fails to get a Context3D, as Flash without a GPU (Stage3D.ts). */
    get stage3Ds(): Value {
      stage3Ds ??= [0, 1, 2, 3].map(() =>
        s.rt.construct(s.rt.classNamed("flash.display::Stage3D")),
      );
      return vectorOf("flash.display::Stage3D", stage3Ds, true);
    }
  }

  let focusRect = true;
  let colorCorrection = "default";
  let stage3Ds: Value[] | null = null;

  /** A Vector of the named class holding `values`. */
  const vectorOf = (name: string, values: Value[], fixed = false): Value => {
    const cls = s.rt.applyType(s.rt.classNamed("__AS3__.vec::Vector"), [s.rt.classNamed(name)]);
    const o = cls.$it.instance();
    o.$a = [...values];
    o.$fixed = fixed;
    return o;
  };

  avm2.registerNativeClass(natives, "flash.display::Stage", StageNatives);
  const container = containerNatives(s);
  for (const name of ["removeChildAt", "swapChildrenAt"]) {
    natives[`flash.display::Stage#${name}`] =
      container[`flash.display::DisplayObjectContainer#${name}`];
  }

  // Undocumented accessors Stage declares: null, and a write that changes
  // nothing, as adl gives them. A JavaScript class cannot spell them.
  natives["flash.display::Stage#get:constructor"] = avm2.plain(() => null);
  natives["flash.display::Stage#set:constructor"] = avm2.plain(() => undefined);

  return natives;
}
