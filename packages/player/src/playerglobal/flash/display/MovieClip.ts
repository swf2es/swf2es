// flash.display.MovieClip: the timeline from a script. Frame scripts
// registered with addFrameScript run when their frame is entered, in the
// frame's script phase; a goto takes the next phase there.
import { avm2 } from "@swf2es/runtime";
import type { MovieClip } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import { displayOf } from "./DisplayObject.js";

const { plain } = avm2;
type AsObject = avm2.AsObject;
type Value = avm2.Value;

function clipOf(o: AsObject): MovieClip {
  return displayOf(o) as MovieClip;
}

export function movieClipNatives(s: Scripting): avm2.Natives {
  // s.rt at call time: the natives are made before the runtime that holds them is.
  /** A frame by number, 1 the first, or by label; the clip's frame if the label is unknown. */
  const frameOf = (clip: MovieClip, frame: Value): number => {
    if (typeof frame === "string" && !/^\d+$/.test(frame)) {
      return clip.timeline.labels.get(frame) ?? clip.currentFrame;
    }

    return s.rt.toInt(frame);
  };

  return {
    "flash.display::MovieClip#addFrameScript": plain(function (this: AsObject, ...args: Value[]) {
      const clip = clipOf(this);
      for (let i = 0; i + 1 < args.length; i += 2) {
        const frame = s.rt.toInt(args[i]) + 1;
        if (args[i + 1] === null || args[i + 1] === undefined) {
          clip.frameScripts.delete(frame);
        } else {
          clip.frameScripts.set(frame, args[i + 1]);
        }
      }
    }),
    "flash.display::MovieClip#get:currentFrame": plain(function (this: AsObject) {
      return Math.max(1, clipOf(this).currentFrame);
    }),
    "flash.display::MovieClip#get:totalFrames": plain(function (this: AsObject) {
      return clipOf(this).totalFrames;
    }),
    "flash.display::MovieClip#get:framesLoaded": plain(function (this: AsObject) {
      return clipOf(this).totalFrames;
    }),
    "flash.display::MovieClip#get:currentLabel": plain(function (this: AsObject) {
      const clip = clipOf(this);
      // The nearest label at or before the frame.
      let label: string | null = null;
      let at = 0;
      for (const [name, frame] of clip.timeline.labels) {
        if (frame <= clip.currentFrame && frame >= at) {
          label = name;
          at = frame;
        }
      }

      return label;
    }),
    "flash.display::MovieClip#get:currentFrameLabel": plain(function (this: AsObject) {
      const clip = clipOf(this);
      for (const [name, frame] of clip.timeline.labels) {
        if (frame === clip.currentFrame) {
          return name;
        }
      }

      return null;
    }),
    "flash.display::MovieClip#get:isPlaying": plain(function (this: AsObject) {
      return clipOf(this).playing;
    }),
    "flash.display::MovieClip#play": plain(function (this: AsObject) {
      clipOf(this).playing = true;
    }),
    "flash.display::MovieClip#stop": plain(function (this: AsObject) {
      clipOf(this).playing = false;
    }),
    "flash.display::MovieClip#nextFrame": plain(function (this: AsObject) {
      const clip = clipOf(this);
      clip.gotoFrame(clip.currentFrame + 1);
      clip.playing = false;
    }),
    "flash.display::MovieClip#prevFrame": plain(function (this: AsObject) {
      const clip = clipOf(this);
      clip.gotoFrame(clip.currentFrame - 1);
      clip.playing = false;
    }),
    "flash.display::MovieClip#gotoAndPlay": plain(function (this: AsObject, frame: Value) {
      const clip = clipOf(this);
      clip.gotoFrame(frameOf(clip, frame));
      clip.playing = true;
    }),
    "flash.display::MovieClip#gotoAndStop": plain(function (this: AsObject, frame: Value) {
      const clip = clipOf(this);
      clip.gotoFrame(frameOf(clip, frame));
      clip.playing = false;
    }),
    "flash.display::MovieClip#get:enabled": plain(function (this: AsObject) {
      return this.$enabled ?? true;
    }),
    "flash.display::MovieClip#set:enabled": plain(function (this: AsObject, v: Value) {
      this.$enabled = !!v;
    }),
    "flash.display::MovieClip#get:trackAsMenu": plain(() => false),
    "flash.display::MovieClip#set:trackAsMenu": plain(() => undefined),
  };
}
