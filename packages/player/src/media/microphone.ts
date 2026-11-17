import { avm2 } from "@swf2es/runtime";
import type { CaptureDevice, MicrophoneCapture, MicrophoneMode } from "../hosts.js";
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import type { SoundMix, StreamingSound } from "./audio.js";
import { CaptureResampler, microphoneRates } from "./capture-resampler.js";
import { CaptureStatus } from "./capture-status.js";
import { mixerMix, mixOf, outputMix } from "./sounds.js";

export const microphoneStates = new WeakMap<avm2.AsObject, MicrophoneState>();

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
  private queued: { samples: Float32Array; position: number }[] = [];
  private queuedSamples = 0;

  constructor(
    private readonly s: Scripting,
    private readonly object: avm2.AsObject,
    readonly device: CaptureDevice,
    readonly index: number,
  ) {
    this.consent = new CaptureStatus(s, object, "Microphone");
    s.captureLifetime.signal.addEventListener(
      "abort",
      () => {
        this.stop();
        this.consent.set(true);
      },
      { once: true },
    );
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
    this.queued = [];
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
    if (!this.loopback && !heard(this.object, "sampleData")) {
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

  unavailable(): void {
    this.stop();
    this.consent.unavailable();
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
    this.queued = [];
    this.queuedSamples = 0;
    this.pending = false;
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
    if (activating !== this.activating) {
      this.activating = activating;
      const generation = this.generation;
      if (this.activityEventGeneration !== generation) {
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

    if (this.loopback && this.s.audio?.stream) {
      if (!this.loopResampler || this.loopResampler.inputRate !== rate) {
        this.loopResampler = new CaptureResampler(rate, 44100);
      }
      const loop = this.loopResampler.push(samples);
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
    if (
      !this.resampler ||
      this.resampler.inputRate !== rate ||
      this.resampler.outputRate !== targetRate
    ) {
      this.resampler = new CaptureResampler(rate, targetRate);
    }
    const data = this.resampler.push(samples);
    if (data.length === 0) {
      return;
    }
    this.queued.push({ samples: data, position: this.position });
    this.position += data.length;
    this.queuedSamples += data.length;
    while (this.queuedSamples > 16384 && this.queued.length > 1) {
      this.queuedSamples -= this.queued[0].samples.length;
      this.queued.shift();
    }
    if (!this.pending) {
      this.pending = true;
      const generation = this.generation;
      this.s.loads.deferHostEvent(() => {
        if (!this.active || this.s.destroyed || generation !== this.generation) {
          return;
        }
        this.pending = false;
        const blocks = this.queued;
        const count = this.queuedSamples;
        this.queued = [];
        this.queuedSamples = 0;
        if (!heard(this.object, "sampleData") || !count) {
          return;
        }
        const object = this.s.rt.construct(this.s.rt.classNamed("flash.utils::ByteArray"));
        const bytes = avm2.bytesOf(this.s.rt, object);
        bytes.setLength(count * 4);
        let offset = 0;
        for (const block of blocks) {
          for (let i = 0; i < block.samples.length; i++) {
            bytes.view.setFloat32(offset, block.samples[i], bytes.littleEndian);
            offset += 4;
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
            blocks[0].position,
            object,
          ),
        );
      });
    }
  }
}
