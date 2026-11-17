import { avm2 } from "@swf2es/runtime";
import type { Library } from "../display/timeline.js";
import type { CaptureDevice, MicrophoneCapture, MicrophoneMode } from "../hosts.js";
import { removeListenersWhere } from "../playerglobal/flash/events/EventDispatcher.js";
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import type { SoundMix, StreamingSound } from "./audio.js";
import { CaptureResampler, microphoneRates } from "./capture-resampler.js";
import { CaptureStatus } from "./capture-status.js";
import { mixerMix, mixOf, outputMix } from "./sounds.js";

const nativeLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export const microphoneStates = new WeakMap<avm2.AsObject, MicrophoneState>();
const captures = new WeakMap<Scripting, Set<WeakRef<MicrophoneState>>>();

export function stopMicrophones(s: Scripting, library: Library): void {
  for (const ref of captures.get(s) ?? []) {
    const microphone = ref.deref();
    if (!microphone) {
      captures.get(s)?.delete(ref);
    } else {
      microphone.stopForLibrary(library);
    }
  }
}

/** With-device defaults follow Adobe's documentation, not the device-free adl oracle. */
export class MicrophoneState {
  gain = 50;
  rate = 8;
  codec = "NellyMoser";
  framesPerPacket = 2;
  encodeQuality = 6;
  enableVAD = true;
  noiseSuppressionLevel = -30;
  useEchoSuppression = false;
  enhanced = false;
  disabled = false;
  enhancedMode = "fullDuplex";
  silenceLevel = 10;
  silenceTimeout = 2000;
  activityLevel = -1;
  private readonly consent: CaptureStatus;

  get muted(): boolean {
    return this.consent.muted;
  }

  loopback = false;
  /** Every SWF that turned loopback on; it stays on while one is loaded, or once player code did. */
  private loopOwners: WeakRef<Library>[] = [];
  private loopUnowned = false;
  private readonly loopChannels: Float32Array[] = [];
  mix: SoundMix = mixOf(null);
  private capture: MicrophoneCapture | null = null;
  private active = false;
  private generation = 0;
  private resampler: CaptureResampler | null = null;
  private loopResampler: CaptureResampler | null = null;
  private output: StreamingSound | null = null;
  private submitted = 0;
  private position = 0;
  private time = 0;
  private lastSound = -1;
  private activating = false;
  private reportedActivity = false;
  private activityEventGeneration = 0;
  private pending = false;
  private readonly queued = new Float32Array(16384);
  private queuedSamples = 0;
  private deliveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly s: Scripting,
    private readonly object: avm2.AsObject,
    readonly device: CaptureDevice,
    readonly index: number,
  ) {
    this.consent = new CaptureStatus(s, object, "Microphone");
    let states = captures.get(s);
    if (!states) {
      states = new Set();
      captures.set(s, states);
    }

    states.add(new WeakRef(this));
    s.captureLifetime.signal.addEventListener(
      "abort",
      () => {
        const opened = this.active;
        this.stop();
        this.consent.revoke(opened);
      },
      { once: true },
    );
  }

  setLoopback(enabled: boolean): void {
    this.loopback = enabled;
    if (!enabled) {
      this.loopOwners = [];
      this.loopUnowned = false;
    } else {
      const library = this.s.code.runningLibrary();
      if (!library) {
        this.loopUnowned = true;
      } else if (!this.loopOwners.some((owner) => owner.deref() === library)) {
        this.loopOwners.push(new WeakRef(library));
      }
    }

    this.sync();
  }

  stopForLibrary(library: Library): void {
    let changed = false;
    const owners = this.loopOwners.filter((owner) => owner.deref() !== library);
    if (owners.length !== this.loopOwners.length) {
      this.loopOwners = owners;
      if (owners.length === 0 && !this.loopUnowned) {
        this.loopback = false;
        changed = true;
      }
    }

    // Taking a sampleData listener resyncs the device itself.
    removeListenersWhere(
      this.s,
      this.object,
      (fn) => this.s.code.calledLibrary(fn, null) === library,
    );
    if (changed && this.active) {
      this.sync();
    }
  }

  private mode(): MicrophoneMode {
    return {
      gain: this.gain,
      echoCancellation: this.enhanced ? this.enhancedMode !== "off" : this.useEchoSuppression,
      noiseSuppression:
        this.enhanced && this.enhancedMode !== "off" && this.noiseSuppressionLevel !== 0,
    };
  }

  setRate(rate: number): void {
    if (rate === this.rate) {
      return;
    }

    this.rate = rate;
    this.resampler = null;
    // Never expose a buffer containing samples recorded at different rates.
    this.queuedSamples = 0;
  }

  settings(): void {
    this.capture?.setMode(this.mode());
    this.output?.setMix(outputMix(this.mix, mixerMix(this.s)));
  }

  sync(): void {
    if (this.disabled || this.s.destroyed || this.s.captureLifetime.signal.aborted) {
      return;
    }

    if (!this.loopback) {
      this.output?.stop();
      this.output = null;
      this.loopResampler = null;
      this.submitted = 0;
    }

    if (!(this.loopback && this.s.audio?.stream) && !heard(this.object, "sampleData")) {
      this.stop();
      return;
    }

    const host = this.s.capture;
    if (this.active || !host?.openMicrophone) {
      return;
    }

    this.active = true;
    const generation = ++this.generation;
    const current = () => !this.s.destroyed && generation === this.generation;
    const state = (value: "granted" | "denied" | "ended" | "unavailable") => {
      if (!current()) {
        return;
      }
      if (value !== "granted") {
        this.stop(false);
      }

      if (value === "unavailable") {
        this.consent.unavailable();
      } else {
        this.consent.set(value !== "granted");
      }
    };
    try {
      const capture = host.openMicrophone(
        this.device,
        this.mode(),
        {
          state,
          samples: (samples, rate) => {
            if (current() && this.active && !this.muted) {
              this.samples(samples, rate);
            }
          },
        },
        this.s.captureLifetime.signal,
      );
      if (current() && this.active) {
        this.capture = capture;
      } else {
        capture.close();
      }
    } catch {
      state("unavailable");
    }
  }

  /** Adobe: the other microphones stop providing audio and are told; idle ones have nothing to stop. */
  unavailable(): void {
    const opened = this.active;
    this.stop();
    if (opened) {
      this.consent.unavailable();
    }
  }

  private stop(invalidate = true): void {
    if (invalidate) {
      this.generation++;
    }
    this.active = false;
    this.capture?.close();
    this.capture = null;
    this.output?.stop();
    this.output = null;
    this.submitted = 0;
    this.resampler = null;
    this.loopResampler = null;
    this.queuedSamples = 0;
    this.pending = false;
    if (this.deliveryTimer !== null) {
      clearTimeout(this.deliveryTimer);
      this.deliveryTimer = null;
    }

    this.activityLevel = -1;
    this.activating = false;
    this.lastSound = -1;
    this.time = 0;
    this.position = 0;
  }

  private samples(samples: Float32Array, rate: number): void {
    if (!(rate > 0) || !Number.isFinite(rate) || samples.length === 0) {
      return;
    }

    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
      samples[i] = value;
      energy += value * value;
    }

    this.time += (samples.length * 1000) / rate;
    this.activityLevel = Math.min(100, Math.sqrt(energy / samples.length) * 100);
    const sound = this.silenceLevel < 100 && this.activityLevel >= this.silenceLevel;
    if (sound) {
      this.lastSound = this.time;
    }

    const activating =
      this.silenceLevel < 100 &&
      (sound || (this.lastSound >= 0 && this.time - this.lastSound < this.silenceTimeout));
    const observing = heard(this.object, "activity");
    if (!observing) {
      this.reportedActivity = false;
    }
    if (activating !== this.activating || (observing && activating !== this.reportedActivity)) {
      this.activating = activating;
      const generation = this.generation;
      if (observing && this.activityEventGeneration !== generation) {
        this.activityEventGeneration = generation;
        this.s.loads.deferHostEvent(() => {
          if (this.activityEventGeneration === generation) {
            this.activityEventGeneration = 0;
          }
          if (
            !this.s.destroyed &&
            this.active &&
            generation === this.generation &&
            this.silenceLevel < 100 &&
            heard(this.object, "activity") &&
            this.reportedActivity !== this.activating
          ) {
            this.reportedActivity = this.activating;
            dispatchEvent(
              this.s,
              this.object,
              this.s.rt.construct(
                this.s.rt.classNamed("flash.events::ActivityEvent"),
                "activity",
                false,
                false,
                this.activating,
              ),
            );
          }
        });
      }
    }

    let loop: Float32Array | null = null;
    if (this.loopback && this.s.audio?.stream) {
      if (!this.loopResampler || this.loopResampler.inputRate !== rate) {
        this.loopResampler = new CaptureResampler(rate, 44100);
      }
      loop = this.loopResampler.push(samples);
      this.output ??= this.s.audio.stream(outputMix(this.mix, mixerMix(this.s)), () => {
        this.output?.setMix(outputMix(this.mix, mixerMix(this.s)));
      });
      // Never queue more than 200 ms while autoplay holds the output device.
      const played = this.output.positionMs * 44.1;
      if (this.submitted - (Number.isFinite(played) ? played : 0) < 8820) {
        this.output.append([loop, loop]);
        this.submitted += loop.length;
      }
    }
    if (!heard(this.object, "sampleData")) {
      return;
    }
    const targetRate = microphoneRates.get(this.rate) ?? 8000;
    let data: Float32Array;
    if (loop && targetRate === 44100) {
      this.resampler = this.loopResampler;
      data = loop;
    } else {
      if (
        !this.resampler ||
        this.resampler.inputRate !== rate ||
        this.resampler.outputRate !== targetRate
      ) {
        this.resampler = new CaptureResampler(rate, targetRate);
      }

      data = this.resampler.push(samples, true);
    }
    if (data.length === 0) {
      return;
    }
    this.position += data.length;
    const kept = Math.min(data.length, this.queued.length);
    const discard = Math.max(0, this.queuedSamples + kept - this.queued.length);
    if (discard) {
      this.queued.copyWithin(0, discard, this.queuedSamples);
      this.queuedSamples -= discard;
    }

    this.queued.set(data.subarray(data.length - kept), this.queuedSamples);
    this.queuedSamples += kept;
    if (!this.pending) {
      this.pending = true;
      const generation = this.generation;
      this.s.loads.deferHostEvent(() => {
        if (generation !== this.generation) {
          return;
        }

        this.pending = false;
        this.deliver();
      });
    }

    // Worklet messages still arrive when hidden-page timers are throttled.
    if (this.s.timers.realTime && this.queuedSamples >= targetRate / 10) {
      try {
        this.deliver();
      } catch (error) {
        this.s.reportUncaught(error);
      }
      return;
    }

    // Sample delivery cannot wait a whole low-rate movie frame. Hand-stepped hosts stay deterministic.
    if (this.deliveryTimer === null && this.s.timers.realTime) {
      this.deliveryTimer = setTimeout(() => {
        this.deliveryTimer = null;
        try {
          this.deliver();
        } catch (error) {
          this.s.reportUncaught(error);
        }
      }, 100);
    }
  }

  private deliver(): void {
    if (this.deliveryTimer !== null) {
      clearTimeout(this.deliveryTimer);
      this.deliveryTimer = null;
    }

    // Samples wait, bounded by the queue, until the script has heard Microphone.Unmuted.
    if (!this.consent.unmutedReported) {
      return;
    }

    const count = this.queuedSamples;
    this.queuedSamples = 0;
    if (!this.active || this.s.destroyed || !heard(this.object, "sampleData") || count === 0) {
      return;
    }

    const object = this.s.rt.construct(this.s.rt.classNamed("flash.utils::ByteArray"));
    const bytes = avm2.bytesOf(this.s.rt, object);
    bytes.setLength(count * 4);
    const floats = new Float32Array(bytes.buffer.buffer, bytes.buffer.byteOffset, count);
    floats.set(this.queued.subarray(0, count));
    if (bytes.littleEndian !== nativeLittleEndian) {
      const words = new Uint32Array(bytes.buffer.buffer, bytes.buffer.byteOffset, count);
      for (let i = 0; i < count; i++) {
        const word = words[i];
        words[i] =
          (word >>> 24) | ((word >>> 8) & 0xff00) | ((word << 8) & 0xff0000) | (word << 24);
      }
    }

    dispatchEvent(
      this.s,
      this.object,
      this.s.rt.construct(
        this.s.rt.classNamed("flash.events::SampleDataEvent"),
        "sampleData",
        false,
        false,
        this.position - count,
        object,
      ),
    );
  }
}
