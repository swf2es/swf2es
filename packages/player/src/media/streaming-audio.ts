// Chunks share a mixer and are scheduled against the device clock, without quantizing float PCM.
import type { SoundMix, StreamingSound } from "./audio.js";

export function browserStream(
  context: AudioContext,
  mix: SoundMix,
  refill: () => void,
  release: () => void,
): StreamingSound {
  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);
  const gains = Array.from({ length: 4 }, () => context.createGain());
  splitter.connect(gains[0], 0);
  splitter.connect(gains[1], 0);
  splitter.connect(gains[2], 1);
  splitter.connect(gains[3], 1);
  gains[0].connect(merger, 0, 0);
  gains[1].connect(merger, 0, 1);
  gains[2].connect(merger, 0, 0);
  gains[3].connect(merger, 0, 1);
  merger.connect(context.destination);

  const nodes = new Map<AudioBufferSourceNode, { at: number; from: number; frames: number }>();
  let next = context.currentTime;
  let submitted = 0;
  let played = 0;
  let finished = false;
  let ended = false;
  let stoppedAt = 0;
  const position = () => {
    let frames = played;
    for (const block of nodes.values()) {
      if (context.currentTime >= block.at) {
        frames = Math.max(
          frames,
          block.from + Math.min(block.frames, (context.currentTime - block.at) * 44100),
        );
      }
    }

    return (frames * 1000) / 44100;
  };
  const setMix = (next: SoundMix) => {
    gains[0].gain.value = next.volume * next.leftToLeft;
    gains[1].gain.value = next.volume * next.leftToRight;
    gains[2].gain.value = next.volume * next.rightToLeft;
    gains[3].gain.value = next.volume * next.rightToRight;
  };
  const cleanup = (notify = true) => {
    ended = true;
    clearInterval(timer);
    splitter.disconnect();
    merger.disconnect();
    for (const gain of gains) {
      gain.disconnect();
    }

    if (notify) {
      release();
    }
  };
  // Request on the device's cadence even if the SWF has a very low frame rate.
  const timer = setInterval(() => {
    if (!finished && !ended) {
      refill();
    }
  }, 20);
  try {
    setMix(mix);
    void context.resume().catch(() => {});
  } catch (error) {
    cleanup(false);
    throw error;
  }

  return {
    append(channels) {
      if (finished || ended || channels[0].length === 0) {
        return;
      }

      const frames = channels[0].length;
      const buffer = context.createBuffer(2, frames, 44100);
      for (let c = 0; c < 2; c++) {
        buffer.getChannelData(c).set(channels[c]);
      }

      const source = context.createBufferSource();
      const at = Math.max(next, context.currentTime);
      const block = { at, from: submitted, frames };
      nodes.set(source, block);
      source.onended = () => {
        source.disconnect();
        nodes.delete(source);
        played = Math.max(played, block.from + block.frames);
        if (finished && nodes.size === 0 && !ended) {
          stoppedAt = position();
          cleanup();
        }
      };
      try {
        source.buffer = buffer;
        source.connect(splitter);
        source.start(at);
      } catch (error) {
        source.onended = null;
        nodes.delete(source);
        source.disconnect();
        throw error;
      }

      submitted += frames;
      next = at + frames / 44100;
    },
    finish() {
      finished = true;
      clearInterval(timer);
      if (nodes.size === 0 && !ended) {
        stoppedAt = position();
        cleanup();
      }
    },
    stop() {
      if (ended) {
        return;
      }

      stoppedAt = position();
      for (const source of nodes.keys()) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // A device failure must not leave other sources or the refill timer alive.
        }
        source.disconnect();
      }

      nodes.clear();
      cleanup();
    },
    setMix,
    get positionMs() {
      return ended ? stoppedAt : position();
    },
    get ended() {
      return ended;
    },
  };
}
