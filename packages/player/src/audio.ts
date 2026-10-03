// Browser audio behind a small host boundary. A player can run without an
// audio device, as the trace tests do, and an embedding page may supply one.
import type { Sound } from "@swf2es/format";

export interface SoundMix {
  volume: number;
  leftToLeft: number;
  leftToRight: number;
  rightToLeft: number;
  rightToRight: number;
}

export interface PlayingSound {
  stop(): void;
  setMix(mix: SoundMix): void;
}

export interface DecodedSound {
  durationMs: number;
  play(startMs: number, loops: number, mix: SoundMix): PlayingSound | null;
}

export interface AudioHost {
  decode(source: Sound | Uint8Array): Promise<DecodedSound>;
}

/** The browser's decoder handles MP3; SWF's two uncompressed forms need no codec. */
export function browserAudioHost(): AudioHost | null {
  const Context = globalThis.AudioContext;
  if (!Context) {
    return null;
  }

  let context: AudioContext | null = null;
  const getContext = () => (context ??= new Context());
  return {
    async decode(source) {
      const ctx = getContext();
      let buffer: AudioBuffer;
      if (source instanceof Uint8Array || source.format === 2) {
        const data = source instanceof Uint8Array ? source : source.data;
        buffer = await ctx.decodeAudioData(data.slice().buffer);
      } else if (source.format === 0 || source.format === 3) {
        buffer = ctx.createBuffer(source.channels, source.sampleCount, source.sampleRate);
        const view = new DataView(
          source.data.buffer,
          source.data.byteOffset,
          source.data.byteLength,
        );
        const channels = Array.from({ length: source.channels }, (_, i) =>
          buffer.getChannelData(i),
        );
        const bytesPerFrame = source.channels * (source.sampleSize / 8);
        const frames = Math.min(
          source.sampleCount,
          Math.floor(source.data.byteLength / bytesPerFrame),
        );
        if (source.sampleSize === 8) {
          for (let i = 0; i < frames; i++) {
            for (let channel = 0; channel < source.channels; channel++) {
              channels[channel][i] = (view.getUint8(i * bytesPerFrame + channel) - 128) / 128;
            }
          }
        } else {
          for (let i = 0; i < frames; i++) {
            for (let channel = 0; channel < source.channels; channel++) {
              channels[channel][i] = view.getInt16(i * bytesPerFrame + channel * 2, true) / 32768;
            }
          }
        }
      } else {
        throw new Error(`Unsupported SWF sound format ${source.format}`);
      }

      return {
        durationMs: buffer.duration * 1000,
        play(startMs, loops, mix) {
          const offset = Math.max(0, startMs / 1000);
          if (offset >= buffer.duration) {
            return null;
          }

          const sourceNode = ctx.createBufferSource();
          let ended = false;
          const finish = () => {
            if (ended) {
              return;
            }

            ended = true;
            sourceNode.disconnect();
            splitter.disconnect();
            for (const gain of gains) {
              gain.disconnect();
            }

            merger.disconnect();
          };
          sourceNode.buffer = buffer;
          const splitter = ctx.createChannelSplitter(2);
          const merger = ctx.createChannelMerger(2);
          const gains = Array.from({ length: 4 }, () => ctx.createGain());
          sourceNode.onended = finish;
          sourceNode.connect(splitter);
          splitter.connect(gains[0], 0);
          splitter.connect(gains[1], 0);
          splitter.connect(gains[2], buffer.numberOfChannels === 1 ? 0 : 1);
          splitter.connect(gains[3], buffer.numberOfChannels === 1 ? 0 : 1);
          gains[0].connect(merger, 0, 0);
          gains[1].connect(merger, 0, 1);
          gains[2].connect(merger, 0, 0);
          gains[3].connect(merger, 0, 1);
          merger.connect(ctx.destination);
          const setMix = (next: SoundMix) => {
            gains[0].gain.value = next.volume * next.leftToLeft;
            gains[1].gain.value = next.volume * next.leftToRight;
            gains[2].gain.value = next.volume * next.rightToLeft;
            gains[3].gain.value = next.volume * next.rightToRight;
          };
          setMix(mix);
          sourceNode.loop = loops > 1;
          sourceNode.loopStart = offset;
          sourceNode.loopEnd = buffer.duration;
          sourceNode.start(0, offset);
          if (loops > 1) {
            sourceNode.stop(ctx.currentTime + (buffer.duration - offset) * loops);
          }

          void ctx.resume().catch(() => {});
          return {
            stop: () => {
              if (!ended) {
                sourceNode.stop();
                finish();
              }
            },
            setMix,
          };
        },
      };
    },
  };
}
