// flash.display.Stage: the stage's size and frame rate, invalidate, which
// asks for a RENDER event before the frame is drawn, focus, which keys go
// to (input/keyboard.ts), and the two container methods Stage declares native
// again, which do as a container's do.
import { avm2 } from "@swf2es/runtime";
import { setFocus } from "../../../input/keyboard.js";
import type { Scripting } from "../../../scripting.js";
import { displayOf } from "./DisplayObject.js";
import { containerNatives } from "./DisplayObjectContainer.js";

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

    set frameRate(v: Value) {
      s.frameRate = Math.max(0.01, Math.min(1000, Number(v)));
    }

    get stageWidth(): number {
      return s.stageWidth;
    }

    get stageHeight(): number {
      return s.stageHeight;
    }

    invalidate(): void {
      s.invalidated = true;
    }

    get scaleMode(): string {
      return "showAll";
    }

    set scaleMode(_v: Value) {
      // The stage is the SWF's size; nothing to scale yet.
    }

    get align(): string {
      return "";
    }

    set align(_v: Value) {
      // As scaleMode.
    }

    get quality(): string {
      return s.quality;
    }

    set quality(v: Value) {
      s.quality = String(v).toUpperCase();
    }

    get displayState(): string {
      return "normal";
    }

    set displayState(_v: Value) {
      // No full screen.
    }

    get focus(): Value {
      return s.focus?.object ?? null;
    }

    // A field given focus keeps its selection (the corpus's edittext_focus_selection).
    set focus(v: Value) {
      setFocus(s, v ? (displayOf(v as avm2.AsObject) ?? null) : null);
    }

    get showDefaultContextMenu(): boolean {
      return true;
    }

    set showDefaultContextMenu(_v: Value) {
      // No context menu.
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

    get allowsFullScreen(): boolean {
      return true;
    }

    get allowsFullScreenInteractive(): boolean {
      return false;
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

    get fullScreenSourceRect(): Value {
      return fullScreenSource;
    }

    set fullScreenSourceRect(v: Value) {
      fullScreenSource = v ?? null;
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

    // Kept: the pointer is not locked, which only full screen allows.
    get mouseLock(): boolean {
      return mouseLock;
    }

    set mouseLock(v: Value) {
      mouseLock = !!v;
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
  let fullScreenSource: Value = null;
  let colorCorrection = "default";
  let mouseLock = false;
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

  return natives;
}
