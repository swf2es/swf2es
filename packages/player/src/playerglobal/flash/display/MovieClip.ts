// flash.display.MovieClip: the timeline from a script. Frame scripts
// registered with addFrameScript run when their frame is entered, in the
// frame's script phase; a goto takes the next phase there.
import { avm2 } from "@swf2es/runtime";
import type { MovieClip } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function movieClipNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  // s.rt at call time: the natives are made before the runtime that holds them is.
  /** A frame by number, 1 the first, or by label; the clip's frame if the label is unknown. */
  const frameOf = (clip: MovieClip, frame: Value): number => {
    if (typeof frame === "string" && !/^\d+$/.test(frame)) {
      return clip.timeline.labels.get(frame) ?? clip.currentFrame;
    }

    return s.rt.toInt(frame);
  };
  /** Jump to `frame`: at once, or when the frame script asking returns, as Flash defers a goto from one. */
  const goto = (clip: MovieClip, frame: number) => {
    if (s.inFrameScript === clip) {
      clip.queuedGoto = frame;
    } else {
      clip.gotoFrame(frame);
    }
  };

  class MovieClipNatives {
    declare $display: MovieClip;
    declare $enabled: boolean | undefined;

    addFrameScript(...args: Value[]): void {
      const clip = this.$display;
      for (let i = 0; i + 1 < args.length; i += 2) {
        const frame = s.rt.toInt(args[i]) + 1;
        if (args[i + 1] === null || args[i + 1] === undefined) {
          clip.frameScripts.delete(frame);
        } else {
          clip.frameScripts.set(frame, args[i + 1]);
        }
      }
    }

    get currentFrame(): number {
      return Math.max(1, this.$display.currentFrame);
    }

    get totalFrames(): number {
      return this.$display.totalFrames;
    }

    get framesLoaded(): number {
      return this.$display.totalFrames;
    }

    /** The nearest label at or before the frame. */
    get currentLabel(): Value {
      const clip = this.$display;
      let label: string | null = null;
      let at = 0;
      for (const [name, frame] of clip.timeline.labels) {
        if (frame <= clip.currentFrame && frame >= at) {
          label = name;
          at = frame;
        }
      }

      return label;
    }

    get currentFrameLabel(): Value {
      const clip = this.$display;
      for (const [name, frame] of clip.timeline.labels) {
        if (frame === clip.currentFrame) {
          return name;
        }
      }

      return null;
    }

    get isPlaying(): boolean {
      return this.$display.playing;
    }

    play(): void {
      this.$display.playing = true;
    }

    stop(): void {
      this.$display.playing = false;
    }

    nextFrame(): void {
      const clip = this.$display;
      goto(clip, clip.currentFrame + 1);
      clip.playing = false;
    }

    prevFrame(): void {
      const clip = this.$display;
      goto(clip, clip.currentFrame - 1);
      clip.playing = false;
    }

    gotoAndPlay(frame: Value): void {
      const clip = this.$display;
      goto(clip, frameOf(clip, frame));
      clip.playing = true;
    }

    gotoAndStop(frame: Value): void {
      const clip = this.$display;
      goto(clip, frameOf(clip, frame));
      clip.playing = false;
    }

    get enabled(): boolean {
      return this.$enabled ?? true;
    }

    set enabled(v: Value) {
      this.$enabled = !!v;
    }

    get trackAsMenu(): boolean {
      return false;
    }

    set trackAsMenu(_v: Value) {
      // No menus.
    }
  }

  avm2.registerNativeClass(natives, "flash.display::MovieClip", MovieClipNatives);
  return natives;
}
