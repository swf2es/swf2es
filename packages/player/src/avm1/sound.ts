// An AVM1 movie's sound, what Sound and the timeline's sounds play by: the
// transforms Sound gives clips and the movie, each sound decoded once for
// the device, and the Sounds whose sound ended, whose onSoundComplete runs
// after the frame's actions.
// Sound's state follows Ruffle's (https://github.com/ruffle-rs/ruffle): MIT
// OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
import type { avm1 } from "@swf2es/runtime";
import type { DisplayObject, MovieClip } from "../display/display.js";
import type { SoundCharacter } from "../display/timeline.js";
import type { AudioHost, DecodedSound } from "../media/audio.js";
import { type SoundHost, updateMixes } from "../media/sounds.js";
import type { Avm1 } from "./avm1.js";
import {
  type Avm1SoundTransform,
  FULL,
  mixOfTransform,
  type SoundClassHost,
} from "./globals/Sound.js";
import { asciiLower } from "./paths.js";
import { NO_ARGS } from "./queue.js";

/** The movie's sounds, as Sound and the timeline's sounds see them. */
export class Avm1Sounds implements SoundClassHost {
  /** What the timeline's sounds, and Sound's, play by. */
  readonly sounds: SoundHost;
  /** The frames played, which the timeline's sounds count by. */
  frames = 0;
  /** Each sound decoded once for the device. */
  private readonly decodes = new WeakMap<SoundCharacter, Promise<DecodedSound>>();
  /** The transforms Sound gave clips, and the global one. */
  private readonly soundTransforms = new WeakMap<DisplayObject, Avm1SoundTransform>();
  private globalSoundTransform: Avm1SoundTransform = FULL;
  /** The Sounds whose sound ended, for their onSoundComplete after the frame's actions. */
  private completed: avm1.Avm1Object[] = [];

  constructor(
    private readonly movie: Avm1,
    readonly audio: AudioHost | null,
  ) {
    const media = this;
    this.sounds = {
      get audio() {
        return media.audio;
      },
      get now() {
        return movie.timers.now();
      },
      get frames() {
        return media.frames;
      },
      get frameRate() {
        return movie.frameRate;
      },
      soundClip: (character) => this.soundClip(character),
      ownMix: (d) => {
        const t = this.soundTransforms.get(d);
        return t === undefined ? undefined : mixOfTransform(t);
      },
      get mixer() {
        return mixOfTransform(media.globalSoundTransform);
      },
      scriptSounds: () => 0,
    };
  }

  get realm(): avm1.Realm {
    return this.movie.realm;
  }

  resolve(value: avm1.Value, version: number): DisplayObject | null {
    return this.movie.resolve(value, version);
  }

  /** The DefineSound ExportAssets named `name`, any case, as attachSound finds it. */
  exportedSound(name: string): SoundCharacter | null {
    const swf = this.movie.currentSwf();
    const id = swf.exports.get(asciiLower(name));
    const character = id === undefined ? undefined : swf.library?.characters.get(id);
    return character?.type === "sound" ? character : null;
  }

  soundTransform(d: DisplayObject | null): Avm1SoundTransform {
    return d === null ? this.globalSoundTransform : (this.soundTransforms.get(d) ?? FULL);
  }

  setSoundTransform(d: DisplayObject | null, transform: Avm1SoundTransform): void {
    if (d === null) {
      this.globalSoundTransform = transform;
    } else {
      this.soundTransforms.set(d, transform);
    }

    updateMixes(this.sounds);
  }

  /** A Sound's sound has ended: its onSoundComplete runs once the frame's actions have. */
  complete(o: avm1.Avm1Object): void {
    this.completed.push(o);
  }

  /** Each ended Sound's onSoundComplete, in the root's activation: whether any ran. */
  soundsCompleted(): boolean {
    const completed = this.completed;
    this.completed = [];
    const movie = this.movie;
    const root = movie.root as MovieClip | null;
    if (completed.length === 0 || root === null) {
      return false;
    }

    const cx = movie.activationOf(root);
    for (const o of completed) {
      if (cx !== null && !movie.halted) {
        movie.rt.callMethod(cx, o, "onSoundComplete", NO_ARGS, movie.version);
      }
    }

    return true;
  }

  soundClip(character: SoundCharacter): Promise<DecodedSound> | null {
    const audio = this.audio;
    if (audio === null) {
      return null;
    }

    let clip = this.decodes.get(character);
    if (clip === undefined) {
      clip = Promise.resolve().then(() => audio.decode(character.definition));
      this.decodes.set(character, clip);
    }

    return clip;
  }
}
