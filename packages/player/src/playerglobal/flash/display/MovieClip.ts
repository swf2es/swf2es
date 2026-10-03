// flash.display.MovieClip and FrameLabel: the timeline from a script, its
// scenes and labels. Frame scripts registered with addFrameScript run when
// their frame is entered, in the frame's script phase; a goto takes the
// next phase there.
import { avm2 } from "@swf2es/runtime";
import type { MovieClip } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import type { FrameName } from "../../../timeline.js";

type Value = avm2.Value;

export function movieClipNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  // s.rt at call time: the natives are made before the runtime that holds them is.
  /** The scene the clip's frame is in, by its index in the timeline's scenes. */
  const sceneIndex = (clip: MovieClip): number => {
    const scenes = clip.timeline.scenes;
    const frame = Math.max(1, clip.currentFrame);
    let i = 0;
    while (i + 1 < scenes.length && scenes[i + 1].frame <= frame) {
      i++;
    }

    return i;
  };
  /** A scene's first frame, and the first after it. */
  const sceneFrames = (clip: MovieClip, i: number): [number, number] => {
    const scenes = clip.timeline.scenes;
    return [scenes[i].frame, i + 1 < scenes.length ? scenes[i + 1].frame : clip.totalFrames + 1];
  };
  /** Labels in a scene; the last scene's run on past the last frame, as a label after it may. */
  const inScene = (clip: MovieClip, i: number, labels: FrameName[]): FrameName[] => {
    const [first, after] = sceneFrames(clip, i);
    const last = i + 1 === clip.timeline.scenes.length;
    return labels.filter((l) => l.frame >= first && (last || l.frame < after));
  };
  /** A flash.display.Scene, made anew on each read as Flash does: its labels' frames count from its first. */
  const sceneObject = (clip: MovieClip, i: number): Value => {
    const [first, after] = sceneFrames(clip, i);
    const labelClass = s.rt.classNamed("flash.display::FrameLabel");
    const labels = inScene(clip, i, clip.timeline.labels).map((l) =>
      s.rt.construct(labelClass, l.name, l.frame - first + 1),
    );
    return s.rt.construct(
      s.rt.classNamed("flash.display::Scene"),
      clip.timeline.scenes[i].name,
      s.rt.array(labels),
      after - first,
    );
  };
  /**
   * The frame a goto names, on the whole timeline: a number counts from the
   * scene's first frame, the named scene's or the clip's own, and a label is
   * looked for in that scene alone. A scene of that name must exist (2108),
   * and in a named scene, or one of several, as only scene data makes, a
   * label in it (2109); in a timeline's one unnamed scene an unknown label
   * is a number, 0, which takes Flash to frame 1.
   */
  const frameOf = (clip: MovieClip, frame: Value, scene: Value): number => {
    const scenes = clip.timeline.scenes;
    let i = sceneIndex(clip);
    if (scene !== null && scene !== undefined) {
      const name = s.rt.toString(scene);
      i = scenes.findIndex((x) => x.name === name);
      if (i < 0) {
        throw s.rt.error("ArgumentError", 2108, name);
      }
    }

    const first = sceneFrames(clip, i)[0];
    if (typeof frame === "string" && !/^\d+$/.test(frame)) {
      const label = inScene(clip, i, clip.timeline.gotoLabels).find((l) => l.name === frame);
      if (label) {
        return label.frame;
      }

      if (scenes[i].name !== "" || scenes.length > 1) {
        throw s.rt.error("ArgumentError", 2109, frame, scenes[i].name);
      }
    }

    return first + s.rt.toInt(frame) - 1;
  };
  /** Jump to `frame`: at once, or when the frame script asking returns, as Flash defers a goto from one. */
  const goto = (clip: MovieClip, frame: number) => {
    if ((clip.library.version ?? 10) <= 9) {
      clip.skipsNextFrame = true;
    }

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

    /** The frame in its scene, 1 the scene's first. */
    get currentFrame(): number {
      const clip = this.$display;
      return Math.max(1, clip.currentFrame) - sceneFrames(clip, sceneIndex(clip))[0] + 1;
    }

    get totalFrames(): number {
      return this.$display.totalFrames;
    }

    get framesLoaded(): number {
      return this.$display.totalFrames;
    }

    /** The nearest label at or before the frame, whatever scene it is in. */
    get currentLabel(): Value {
      const clip = this.$display;
      let label: string | null = null;
      for (const l of clip.timeline.labels) {
        if (l.frame > clip.currentFrame) {
          break;
        }

        label = l.name;
      }

      return label;
    }

    /** A FrameLabel tag on this very frame, which Flash reads even where the scene data has none. */
    get currentFrameLabel(): Value {
      return this.$display.timeline.frameLabels.get(this.$display.currentFrame) ?? null;
    }

    get scenes(): Value {
      const clip = this.$display;
      return s.rt.array(clip.timeline.scenes.map((_, i) => sceneObject(clip, i)));
    }

    get currentScene(): Value {
      const clip = this.$display;
      return sceneObject(clip, sceneIndex(clip));
    }

    /** The scene before's first frame, playing; in the first scene, its own. */
    prevScene(): void {
      const clip = this.$display;
      goto(clip, sceneFrames(clip, Math.max(0, sceneIndex(clip) - 1))[0]);
      clip.playing = true;
    }

    /** The next scene's first frame, playing; in the last scene, its own. */
    nextScene(): void {
      const clip = this.$display;
      const i = sceneIndex(clip);
      goto(clip, sceneFrames(clip, Math.min(clip.timeline.scenes.length - 1, i + 1))[0]);
      clip.playing = true;
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

    gotoAndPlay(frame: Value, scene: Value = null): void {
      const clip = this.$display;
      goto(clip, frameOf(clip, frame, scene));
      clip.playing = true;
    }

    gotoAndStop(frame: Value, scene: Value = null): void {
      const clip = this.$display;
      goto(clip, frameOf(clip, frame, scene));
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

  class FrameLabelNatives {
    declare $name: string;
    declare $frame: number;

    "flash.display:FrameLabel::ctor"(name: Value, frame: Value): void {
      this.$name = s.rt.toString(name);
      this.$frame = s.rt.toInt(frame);
    }

    get name(): string {
      return this.$name;
    }

    get frame(): number {
      return this.$frame;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::FrameLabel", FrameLabelNatives);
  return natives;
}
