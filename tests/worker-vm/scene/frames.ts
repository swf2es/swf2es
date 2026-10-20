// One producer and one consumer. Only a slot's owner may touch its payload;
// publishing READY and acquiring it with Atomics makes the non-atomic bytes visible.
const FREE = 0;
const WRITING = 1;
const READY = 2;
const READING = 3;
const WORDS = 3;
const MAX_SEQUENCE = 0x7fffffff;

export interface SharedFrames {
  control: SharedArrayBuffer;
  payload: SharedArrayBuffer;
  capacity: number;
  slots: number;
}

export function sharedFrames(capacity: number, slots = 3): SharedFrames {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isInteger(slots) || slots < 2) {
    throw new RangeError("shared frames need a positive byte capacity and at least two slots");
  }

  return {
    control: new SharedArrayBuffer((1 + slots * WORDS) * 4),
    payload: new SharedArrayBuffer(capacity * slots),
    capacity,
    slots,
  };
}

class Frames {
  protected readonly control: Int32Array<SharedArrayBuffer>;
  protected readonly payloads: Uint8Array<SharedArrayBuffer>[];

  constructor(frames: SharedFrames) {
    const { capacity, slots, control, payload } = frames;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      !Number.isInteger(slots) ||
      slots < 2 ||
      !(control instanceof SharedArrayBuffer) ||
      !(payload instanceof SharedArrayBuffer) ||
      control.byteLength !== (1 + slots * WORDS) * 4 ||
      payload.byteLength !== capacity * slots
    ) {
      throw new RangeError("invalid shared frame buffers");
    }

    this.control = new Int32Array(control);
    this.payloads = Array.from(
      { length: slots },
      (_, i) => new Uint8Array(payload, i * capacity, capacity),
    );
  }
}

export class FrameWriter extends Frames {
  /**
   * Encode a complete snapshot synchronously. Null means all slots are occupied:
   * retain the source state and try its latest snapshot later, without waiting.
   */
  write(encode: (bytes: Uint8Array<SharedArrayBuffer>) => number): number | null {
    for (let slot = 0; slot < this.payloads.length; slot++) {
      const at = 1 + slot * WORDS;
      if (Atomics.compareExchange(this.control, at, FREE, WRITING) !== FREE) {
        continue;
      }

      try {
        const bytes = this.payloads[slot];
        const length = encode(bytes);
        if (!Number.isInteger(length) || length < 0 || length > bytes.length) {
          throw new RangeError("shared frame exceeds its slot capacity");
        }

        const sequence = Atomics.load(this.control, 0) + 1;
        if (sequence > MAX_SEQUENCE) {
          throw new RangeError("shared frame sequence exhausted; replace the buffers");
        }

        Atomics.store(this.control, 0, sequence);
        Atomics.store(this.control, at + 1, length);
        Atomics.store(this.control, at + 2, sequence);
        Atomics.store(this.control, at, READY);

        return sequence;
      } catch (error) {
        Atomics.store(this.control, at, FREE);
        throw error;
      }
    }

    return null;
  }
}

export interface ReadFrame {
  readonly bytes: Uint8Array<SharedArrayBuffer>;
  readonly sequence: number;
  /** Release only after all payload reads, including asynchronous work, are done. */
  release(): void;
}

export class FrameReader extends Frames {
  private reading = false;

  /** Take the newest complete snapshot; older unconsumed presentations can be discarded. */
  take(): ReadFrame | null {
    if (this.reading) {
      throw new Error("release the previous shared frame before taking another");
    }

    let chosen = -1;
    let sequence = 0;
    for (let slot = 0; slot < this.payloads.length; slot++) {
      const at = 1 + slot * WORDS;
      if (Atomics.load(this.control, at) === READY) {
        const candidate = Atomics.load(this.control, at + 2);
        if (candidate > sequence) {
          chosen = slot;
          sequence = candidate;
        }
      }
    }

    if (chosen < 0) {
      return null;
    }

    const at = 1 + chosen * WORDS;
    if (Atomics.compareExchange(this.control, at, READY, READING) !== READY) {
      return null;
    }

    for (let slot = 0; slot < this.payloads.length; slot++) {
      const other = 1 + slot * WORDS;
      if (
        slot !== chosen &&
        Atomics.load(this.control, other) === READY &&
        Atomics.load(this.control, other + 2) < sequence
      ) {
        Atomics.compareExchange(this.control, other, READY, FREE);
      }
    }

    this.reading = true;
    let released = false;

    return {
      bytes: this.payloads[chosen].subarray(0, Atomics.load(this.control, at + 1)),
      sequence,
      release: () => {
        if (released) {
          throw new Error("shared frame already released");
        }

        released = true;
        this.reading = false;
        Atomics.store(this.control, at, FREE);
      },
    };
  }
}
