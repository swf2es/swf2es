// Full screen as a SWF's Stage has it: displayState, which a script sets
// and the host's window or element follows, the FullScreenEvent each change
// dispatches, and fullScreenSourceRect, the part of the stage a host draws
// over the screen while it is in full screen. As adl (AIR 51.3) has them:
// the state has changed and the event is dispatched before the setter
// returns, and a change between "fullScreen" and "fullScreenInteractive"
// dispatches none.
import type { FullScreenHost } from "../hosts.js";
import type { Scripting } from "../scripting.js";
import { dispatchTo, heard } from "./events.js";

/** flash.display.StageDisplayState's values. */
export type DisplayState = "normal" | "fullScreen" | "fullScreenInteractive";

/** A rectangle of the stage, in its pixels. */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class FullScreen {
  /** Stage.displayState. */
  state: DisplayState = "normal";
  /** Stage.fullScreenSourceRect, kept in any state. */
  sourceRect: SourceRect | null = null;
  /** The last source rect set that has an area, which the host draws by. */
  private drawn: SourceRect | null = null;
  /** Stage.mouseLock, which only full screen holds. */
  mouseLock = false;
  /**
   * How many times a script has taken the stage into or out of full
   * screen: a key in whose events it did is the SWF's own key for it,
   * which a host keeps from its own (see KeyboardInput.handle).
   */
  asked = 0;

  constructor(
    private readonly s: Scripting,
    readonly host: FullScreenHost | null,
  ) {}

  /** Whether the stage is in full screen, either kind. */
  get active(): boolean {
    return this.state !== "normal";
  }

  /**
   * The part of the stage a host draws in place of the whole, scaled to
   * the screen: fullScreenSourceRect while in full screen.
   */
  get rect(): SourceRect | null {
    return this.active ? this.drawn : null;
  }

  /**
   * A script sets Stage.displayState to `state`. Without a host nothing
   * can cover a screen, and the state stays as it is; one that refuses
   * throws SecurityError #2152, as Flash Player does outside a user's
   * click or key and without allowFullScreen.
   */
  set(state: DisplayState): void {
    const host = this.host;
    if (state === this.state || !host) {
      return;
    }

    if (state === "normal") {
      this.asked++;
      host.exit();
      this.change(state);
      return;
    }

    const interactive = state === "fullScreenInteractive";
    // From one kind of full screen to the other: nothing the screen shows changes.
    if (this.active) {
      if (!host.allowed(interactive)) {
        throw this.s.rt.error("SecurityError", 2152);
      }

      this.state = state;
      return;
    }

    if (!host.allowed(interactive) || !host.request(interactive)) {
      throw this.s.rt.error("SecurityError", 2152);
    }

    this.asked++;
    this.change(state);
  }

  /**
   * A script sets Stage.fullScreenSourceRect, which a stage in full screen
   * is drawn by at once. One with no area is reported but leaves what is
   * drawn as it was, the rect before it still in force, as in adl.
   */
  setSourceRect(rect: SourceRect | null): void {
    this.sourceRect = rect;
    if (!rect || (rect.width > 0 && rect.height > 0)) {
      this.drawn = rect;
    }

    if (this.active) {
      this.s.onStageLayout?.();
    }
  }

  /**
   * The host is in full screen, or no longer, without a script having
   * asked: the user's Esc, a window manager's key, or a request the system
   * turned down after the host took it.
   */
  hostChanged(fullScreen: boolean): void {
    if (fullScreen === this.active) {
      return;
    }

    this.change(fullScreen ? "fullScreen" : "normal");
  }

  /**
   * Into or out of full screen, in adl's order: the stage placed where the
   * host's box has changed already, whose RESIZE in noScale still reads the
   * state before; then the state and its FullScreenEvent; then the stage
   * placed by the new state, with or without the source rect. A host whose
   * box changes later, as a window does, places it again then.
   */
  private change(state: DisplayState): void {
    const s = this.s;
    s.onStageLayout?.();
    this.state = state;
    if (!this.active) {
      this.mouseLock = false;
    }

    const stage = s.stage?.object;
    if (stage && heard(stage, "fullScreen")) {
      // `interactive` is false in AIR whichever state was asked for; Flash Player's tells the keys' state.
      const interactive = !s.air && state === "fullScreenInteractive";
      dispatchTo(
        s,
        stage,
        s.rt.construct(
          s.rt.classNamed("flash.events::FullScreenEvent"),
          "fullScreen",
          false,
          false,
          this.active,
          interactive,
        ),
      );
    }

    s.onStageLayout?.();
  }
}
