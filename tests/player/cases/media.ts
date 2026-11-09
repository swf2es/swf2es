// The player's sound cases (cases.ts): timeline and event sounds,
// extraction, the mixer, and the camera and microphone.
import { readFileSync } from "node:fs";
import { tags } from "../../../packages/format/dist/index.js";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";
import { bare, type PlayerCase, toneScript } from "./common.ts";

function soundSymbols(compile: Compile): Uint8Array {
  const pcm = new Uint8Array(11025).fill(128);
  const sound = new w.BitWriter()
    .u16(1)
    .u8((1 << 2) | 0)
    .u32(pcm.length)
    .raw(pcm)
    .done();
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.tag(tags.DefineSound, sound),
      w.doAbc(
        compile("Tone", "package { import flash.media.Sound; public class Tone extends Sound {} }"),
        "Tone",
      ),
      w.doAbc(compile("SoundSymbols")),
      w.symbolClass([
        [0, "SoundSymbols"],
        [1, "Tone"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Sound.extract of Nellymoser (scripts/SoundExtractNellymoser.as): FFmpeg's
// encoding of two tones (sounds/tone22.nelly) as format 6 with the rate
// flags of 22 and 11 kHz, and as formats 4 and 5, which play at 16 and 8
// kHz but extract at their flags' 44 and 5.5 kHz.
function extractNellymoser(compile: Compile): Uint8Array {
  const nelly = soundFile("tone22.nelly");
  const samples = (nelly.length / 64) * 256;
  const sounds: [string, Uint8Array][] = [
    ["Nelly22", w.defineSound(1, { format: 6, rate: 2, sixteen: true, samples }, nelly)],
    ["Nelly11", w.defineSound(2, { format: 6, rate: 1, sixteen: true, samples }, nelly)],
    ["Nelly16", w.defineSound(3, { format: 4, rate: 3, sixteen: true, samples }, nelly)],
    ["Nelly8", w.defineSound(4, { format: 5, rate: 0, sixteen: true, samples }, nelly)],
  ];
  const script = "SoundExtractNellymoser";
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      ...sounds.map(([, tag]) => tag),
      ...sounds.map(([name]) =>
        w.doAbc(
          compile(
            name,
            `package { import flash.media.Sound; public class ${name} extends Sound {} }`,
          ),
          name,
        ),
      ),
      w.doAbc(compile(script)),
      w.symbolClass([
        [0, script],
        ...sounds.map(([name, tag]): [number, string] => [tag[6] | (tag[7] << 8), name]),
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A sound the tests made (sounds/README.md). */
const soundFile = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../sounds/${name}`, import.meta.url)));

/** 16-bit little-endian samples, as uncompressed DefineSound data. */
function pcm16(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (const [i, v] of samples.entries()) {
    view.setInt16(i * 2, v, true);
  }

  return out;
}

const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

const ADPCM_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/**
 * SWF's 4-bit ADPCM of 16-bit samples, a list a channel: the code size,
 * then packets of each channel's sample and step index and 4095 codes, as
 * a decoder steps through them.
 */
function adpcm(channels: number[][]): Uint8Array {
  const bytes: number[] = [];
  let acc = 0;
  let count = 0;
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++count === 8) {
        bytes.push(acc);
        acc = 0;
        count = 0;
      }
    }
  };

  put(2, 2);
  const frames = channels[0].length;
  const sample = channels.map(() => 0);
  const index = channels.map(() => 0);
  for (let i = 0; i < frames; i++) {
    if (i % 4096 === 0) {
      for (const [c, channel] of channels.entries()) {
        sample[c] = channel[i];
        index[c] = Math.min(index[c], 63);
        put(sample[c] & 0xffff, 16);
        put(index[c], 6);
      }

      continue;
    }

    for (const [c, channel] of channels.entries()) {
      const step = ADPCM_STEPS[index[c]];
      let diff = channel[i] - sample[c];
      const sign = diff < 0 ? 8 : 0;
      diff = Math.abs(diff);
      let code = 0;
      let delta = step >> 3;
      for (const [bit, part] of [
        [4, step],
        [2, step >> 1],
        [1, step >> 2],
      ]) {
        if (diff >= part) {
          code |= bit;
          diff -= part;
          delta += part;
        }
      }

      sample[c] = Math.max(-32768, Math.min(32767, sign ? sample[c] - delta : sample[c] + delta));
      index[c] = Math.max(0, Math.min(ADPCM_STEPS.length - 1, index[c] + ADPCM_INDEX[code]));
      put(code | sign, 4);
    }
  }

  if (count) {
    bytes.push(acc << (8 - count));
  }

  return new Uint8Array(bytes);
}

/** `n` samples of a sine of `period` samples, `amplitude` high. */
const sine = (n: number, period: number, amplitude: number) =>
  Array.from({ length: n }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * i) / period)));

/**
 * Sounds to extract (scripts/<script>.as): uncompressed ramps at three
 * rates and both sizes, ADPCM sines mono and stereo, the MP3s of sounds/
 * as DefineSounds, one with seekSamples, and the 44.1 kHz one's bytes,
 * plain and with a LAME header, as ByteArrays, bound to classes by name.
 */
const extractSounds =
  (script: string) =>
  (compile: Compile): Uint8Array => {
    const ramp = (n: number, step: number, from = 0) =>
      Array.from({ length: n }, (_, i) => from + i * step);
    const stereo = ramp(100, 300, -15000).flatMap((v) => [v, -v / 2]);
    const mp3 = (bytes: Uint8Array, seek: number) => {
      const out = new Uint8Array(bytes.length + 2);
      new DataView(out.buffer).setInt16(0, seek, true);
      out.set(bytes, 2);
      return out;
    };
    const tone = soundFile("tone.mp3");
    const tone22 = soundFile("tone22.mp3");
    const sounds: [string, Uint8Array][] = [
      ["Pcm8", w.defineSound(1, { rate: 0, samples: 32 }, new Uint8Array(ramp(32, 8)))],
      [
        "Pcm16Stereo",
        w.defineSound(2, { rate: 3, sixteen: true, stereo: true, samples: 100 }, pcm16(stereo)),
      ],
      [
        "Pcm11",
        w.defineSound(3, { rate: 1, sixteen: true, samples: 50 }, pcm16(ramp(50, 600, -15000))),
      ],
      [
        "Pcm22",
        w.defineSound(4, { rate: 2, sixteen: true, samples: 50 }, pcm16(ramp(50, 600, -15000))),
      ],
      [
        "Mp3",
        w.defineSound(
          5,
          { format: 2, rate: 3, sixteen: true, stereo: true, samples: 11025 },
          mp3(tone, 1105),
        ),
      ],
      [
        "Mp3Whole",
        w.defineSound(
          6,
          { format: 2, rate: 3, sixteen: true, stereo: true, samples: 12672 },
          mp3(tone, 0),
        ),
      ],
      [
        "Mp3Mono22",
        w.defineSound(7, { format: 2, rate: 2, sixteen: true, samples: 5513 }, mp3(tone22, 0)),
      ],
    ];
    sounds.push(
      [
        "Adpcm22",
        w.defineSound(
          8,
          { format: 1, rate: 2, sixteen: true, samples: 9000 },
          adpcm([sine(9000, 50, 12000)]),
        ),
      ],
      [
        "Adpcm11Stereo",
        w.defineSound(
          9,
          { format: 1, rate: 1, sixteen: true, stereo: true, samples: 3000 },
          adpcm([sine(3000, 40, 9000), sine(3000, 25, -5000)]),
        ),
      ],
    );
    const tags = sounds.map(([, tag]) => tag);
    const classes = sounds.map(([name]) =>
      compile(name, `package { import flash.media.Sound; public class ${name} extends Sound {} }`),
    );
    return w.swf({
      width: 20,
      height: 20,
      frameRate: 24,
      frameCount: 3,
      tags: [
        w.fileAttributes(true),
        ...tags,
        w.binaryData(20, tone),
        w.binaryData(21, soundFile("tone-tagged.mp3")),
        w.doAbc(
          compile(
            "Mp3Tagged",
            "package { import flash.utils.ByteArray; public class Mp3Tagged extends ByteArray {} }",
          ),
          "Mp3Tagged",
        ),
        ...classes.map((abc, i) => w.doAbc(abc, sounds[i][0])),
        w.doAbc(
          compile(
            "Mp3Bytes",
            "package { import flash.utils.ByteArray; public class Mp3Bytes extends ByteArray {} }",
          ),
          "Mp3Bytes",
        ),
        w.doAbc(compile(script)),
        w.symbolClass([
          [0, script],
          // Each DefineSound's id, after its long tag header.
          ...sounds.map(([name, tag]): [number, string] => [tag[6] | (tag[7] << 8), name]),
          [20, "Mp3Bytes"],
          [21, "Mp3Tagged"],
        ]),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ],
    });
  };

/**
 * Timeline sounds (scripts/TimelineSounds.as): Tone, a second of silence
 * at 5.5 kHz bound to a class, started from the root's frames 2 to 5 with
 * each sync; the child "streamer", eight frames of a stream of silence, a
 * block on each.
 */
function timelineSounds(compile: Compile): Uint8Array {
  const block = 230;
  const streamer: Uint8Array[] = [w.soundStreamHead({ rate: 0, samplesPerBlock: block })];
  for (let f = 0; f < 8; f++) {
    streamer.push(w.soundStreamBlock(new Uint8Array(block).fill(128)), w.showFrame());
  }

  const root: Uint8Array[][] = Array.from({ length: 40 }, () => []);
  root[0].push(w.place({ depth: 1, character: 10, name: "streamer" }));
  root[1].push(w.startSound(1, { noMultiple: true }));
  root[2].push(w.startSound(1, { stop: true }));
  root[4].push(w.startSound(1, { loops: 2, inPoint: 4410, outPoint: 22050 }));
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: root.length,
    tags: [
      w.fileAttributes(true),
      w.defineSound(1, { rate: 0, samples: 5512 }, new Uint8Array(5512).fill(128)),
      w.sprite(10, 8, [...streamer, w.end()]),
      w.doAbc(
        compile("Tone", "package { import flash.media.Sound; public class Tone extends Sound {} }"),
        "Tone",
      ),
      w.doAbc(compile("TimelineSounds"), "TimelineSounds"),
      w.symbolClass([
        [0, "TimelineSounds"],
        [1, "Tone"],
      ]),
      ...root.flatMap((frame) => [...frame, w.showFrame()]),
      w.end(),
    ],
  });
}

export const mediaCases: PlayerCase[] = [
  {
    name: "sprite-sound",
    swf: (abc) => bare(abc, 1, "SpriteSound"),
    script: "SpriteSound",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "dynamic-sound",
    swf: (abc) => bare(abc, 1, "DynamicSound"),
    script: "DynamicSound",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-extract-sync",
    build: extractSounds("SoundExtractSync"),
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-extract",
    build: extractSounds("SoundExtract"),
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-extract-nellymoser",
    build: extractNellymoser,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-symbols",
    build: soundSymbols,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-loops",
    build: toneScript("SoundLoops"),
    frames: 50,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-mixer",
    build: toneScript("MixerState"),
    frames: 50,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "camera-microphone",
    swf: (abc) => bare(abc, 1, "CameraMicrophone"),
    script: "CameraMicrophone",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "timeline-sounds",
    build: timelineSounds,
    frames: 33,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];
