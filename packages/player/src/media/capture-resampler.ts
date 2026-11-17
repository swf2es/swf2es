// Windowed-sinc low-pass conversion; history and fractional phase survive worklet blocks.
// A causal 48-input-sample delay avoids looking into a block that has not arrived yet.
const TAPS = 96;
const PHASES = 256;

export class CaptureResampler {
  private readonly kernels = new Float64Array(TAPS * PHASES);
  private history = new Float32Array(TAPS);
  private received = 0;
  private produced = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {
    const cutoff = 0.45 * Math.min(1, outputRate / inputRate);
    for (let phase = 0; phase < PHASES; phase++) {
      let sum = 0;
      for (let tap = 0; tap < TAPS; tap++) {
        const x = tap - 47 - phase / PHASES;
        const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        const window =
          0.42 -
          0.5 * Math.cos((2 * Math.PI * tap) / (TAPS - 1)) +
          0.08 * Math.cos((4 * Math.PI * tap) / (TAPS - 1));
        const weight = sinc * window;
        this.kernels[phase * TAPS + tap] = weight;
        sum += weight;
      }
      for (let tap = 0; tap < TAPS; tap++) {
        this.kernels[phase * TAPS + tap] /= sum;
      }
    }
  }

  push(samples: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) {
      return samples.slice();
    }

    const end = this.received + samples.length;
    const count = Math.ceil((end * this.outputRate) / this.inputRate) - this.produced;
    const result = new Float32Array(count);
    const input = new Float32Array(TAPS + samples.length);
    input.set(this.history);
    input.set(samples, TAPS);
    const base = this.received - TAPS;
    for (let i = 0; i < count; i++) {
      const at = ((this.produced + i) * this.inputRate) / this.outputRate;
      const whole = Math.floor(at);
      const phase = Math.min(PHASES - 1, Math.floor((at - whole) * PHASES));
      const start = whole - 95 - base;
      let value = 0;
      for (let tap = 0; tap < TAPS; tap++) {
        value += input[start + tap] * this.kernels[phase * TAPS + tap];
      }
      result[i] = Math.max(-1, Math.min(1, value));
    }
    this.history = input.slice(-TAPS);
    this.received = end;
    this.produced += count;
    return result;
  }
}

export const microphoneRates = new Map([
  [5, 5512.5],
  [8, 8000],
  [11, 11025],
  [16, 16000],
  [22, 22050],
  [44, 44100],
]);
