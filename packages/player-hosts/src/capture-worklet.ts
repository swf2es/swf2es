// The output stays silent: loopback uses the player's existing audio host.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private block = new Float32Array(2048);
  private used = 0;
  private readonly free: Float32Array<ArrayBuffer>[] = [];
  private readonly message = { samples: this.block, rate: sampleRate };
  private readonly transfer: ArrayBuffer[] = [this.block.buffer];

  constructor() {
    super();
    // Eight queued blocks cover about 340 ms at 48 kHz without growing while suspended.
    for (let i = 0; i < 8; i++) {
      this.free.push(new Float32Array(2048));
    }

    this.port.onmessage = ({ data }: MessageEvent<Float32Array<ArrayBuffer>>) => {
      this.free.push(data);
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      this.block[this.used++] = input[i];
      if (this.used === this.block.length) {
        const next = this.free.pop();
        if (next) {
          this.message.samples = this.block;
          this.transfer[0] = this.block.buffer;
          this.port.postMessage(this.message, this.transfer);
          this.block = next;
        }
        this.used = 0;
      }
    }

    return true;
  }
}
registerProcessor("swf2es-capture", CaptureProcessor);

export {};
