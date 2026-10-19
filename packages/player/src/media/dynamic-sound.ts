// SampleDataEvent's bytes belong to the script; only detached float buffers reach the audio host.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import type { StreamingSound } from "./audio.js";
import { type ChannelState, mixerMix, outputMix } from "./sounds.js";

export interface DynamicChannel {
  position(): number;
  pump(): void;
  complete(): boolean;
}

export function startDynamicSound(
  s: Scripting,
  owner: avm2.AsObject,
  state: ChannelState,
  onFailure: (error: unknown) => void,
): void {
  const data = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray"));
  const bytes = avm2.bytesOf(s.rt, data);
  let generated = 0;
  let requestOffset = 0;
  let finished = false;
  let requesting = false;
  let ready = false;
  let starting = true;
  let stream: StreamingSound | undefined;
  const position = () =>
    stream?.positionMs ?? Math.min((generated * 1000) / 44100, s.timers.now - state.started);
  const request = () => {
    // AIR preserves the ByteArray's contents and endian, resetting only its write cursor.
    bytes.position = 0;
    const event = s.rt.construct(
      s.rt.classNamed("flash.events::SampleDataEvent"),
      "sampleData",
      false,
      false,
      generated + requestOffset,
      data,
    );
    dispatchEvent(s, owner, event);
    if (state.stopped) {
      return;
    }

    const frames = Math.floor(bytes.position / 8);
    if (frames > 8192 || bytes.position > bytes.length) {
      finished = true;
      stream?.finish();
      s.reportUncaught(
        frames > 8192 ? s.rt.error("RangeError", 2004) : s.rt.error("flash.errors::EOFError", 2030),
      );
      return;
    }

    if (frames > 0) {
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < 2; c++) {
          const sample = bytes.view.getFloat32(i * 8 + c * 4, bytes.littleEndian);
          channels[c][i] = Number.isFinite(sample) ? sample : 0;
        }
      }

      generated += frames;
      stream?.append(channels);
    }

    if (frames < 2048) {
      finished = true;
      stream?.finish();
    }
  };
  const pump = () => {
    if (!ready || requesting || finished || state.stopped) {
      return;
    }

    requesting = true;
    try {
      if (generated - (position() * 44100) / 1000 < 8192) {
        request();
      }
    } catch (error) {
      if (starting) {
        throw error;
      }

      finished = true;
      onFailure(error);
    } finally {
      requesting = false;
    }
  };
  state.dynamic = {
    position: () => state.start + position(),
    pump,
    complete: () => finished && (stream ? stream.ended === true : position() >= generated / 44.1),
  };
  stream = s.audio?.stream?.(outputMix(state.mix, mixerMix(s)), pump);
  state.playing = stream ?? null;
  ready = true;
  pump();
  // AIR fills another buffer synchronously when the first supplied the full 8192 frames.
  if (!finished && !state.stopped && generated === 8192) {
    requesting = true;
    try {
      request();
    } finally {
      requesting = false;
    }
  }

  // AIR applies startTime to later request positions, after its synchronous initial fill.
  requestOffset = Math.floor(state.start * 44.1);
  starting = false;
}
