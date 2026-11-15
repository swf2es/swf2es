// What a page's connections say to it, gathered into one IPC message a
// millisecond at most: each message is serialized, posted and run as a
// task of the page's on its own, so a socket read or a WebSocket message
// apiece cost a page with busy connections tens of thousands a second.
// Apart from Electron so that node runs it in the tests
// (tests/desktop/relay.test.ts).

/** Each connection's events, by its id, in the order they came. */
export type Batch<E> = [id: number, event: E][];

/**
 * A batch that holds this many bytes goes at once, not when it would: a
 * busy socket is not kept from its page, and neither the main process nor
 * one message grows past it by more than a read.
 */
export const FLUSH_AT = 256 * 1024;

/**
 * The least time between two batches, in milliseconds. The first event
 * after a quiet spell goes at the end of its turn, so that a request's
 * answer waits for nothing; what follows within the window waits for its
 * end, and goes with the rest that came by then. Socket reads that cost
 * little come many to a millisecond, each with a few bytes: a turn's
 * batch alone left one message for most of them. On Windows the timer
 * may wait for the system's resolution, about 16 ms: docs/architecture/
 * desktop.md says why that does.
 */
export const WINDOW = 1;

interface Joining<E> {
  /** Where its event is in the batch. */
  at: number;
  chunks: Uint8Array[];
  length: number;
  wrap: (bytes: Uint8Array) => E;
}

export class Relay<E> {
  private readonly send: (batch: Batch<E>) => void;
  private readonly flushAt: number;
  private batch: Batch<E> = [];
  private size = 0;
  /** Each connection's bytes, while nothing else of it has come after them in the batch. */
  private readonly joining = new Map<number, Joining<E>>();
  private readonly window: number;
  private immediate: ReturnType<typeof setImmediate> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the last batch went, by performance.now(). */
  private sent = Number.NEGATIVE_INFINITY;

  /** `send` takes each batch, never an empty one. */
  constructor(send: (batch: Batch<E>) => void, flushAt = FLUSH_AT, window = WINDOW) {
    this.send = send;
    this.flushAt = flushAt;
    this.window = window;
  }

  /** `event` for `id`, after whatever came for it before; `size` of its bytes count to FLUSH_AT. */
  push(id: number, event: E, size = 0): void {
    this.seal(id);
    this.batch.push([id, event]);
    this.added(size);
  }

  /**
   * Bytes read for `id`, which it no longer holds: one event, as `wrap`
   * makes it, with the bytes read for it before them in this batch.
   */
  bytes(id: number, chunk: Uint8Array, wrap: (bytes: Uint8Array) => E): void {
    const joining = this.joining.get(id);
    if (joining) {
      joining.chunks.push(chunk);
      joining.length += chunk.length;
    } else {
      this.joining.set(id, { at: this.batch.length, chunks: [chunk], length: chunk.length, wrap });
      this.batch.push([id, wrap(chunk)]);
    }

    this.added(chunk.length);
  }

  /** Send what is gathered now. */
  flush(): void {
    this.unschedule();
    if (this.batch.length === 0) {
      return;
    }

    for (const id of this.joining.keys()) {
      this.seal(id);
    }

    const batch = this.batch;
    this.batch = [];
    this.size = 0;
    this.sent = performance.now();
    this.send(batch);
  }

  /** Forget what is gathered: its page is gone, and the next numbers its connections from 1. */
  drop(): void {
    this.unschedule();
    this.batch = [];
    this.size = 0;
    this.joining.clear();
  }

  private added(size: number): void {
    this.size += size;
    if (this.size >= this.flushAt) {
      this.flush();
      return;
    }

    if (this.immediate || this.timer) {
      return;
    }

    const wait = this.sent + this.window - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(this.flushing, wait);
    } else {
      this.immediate = setImmediate(this.flushing);
    }
  }

  private readonly flushing = () => {
    this.immediate = null;
    this.timer = null;
    this.flush();
  };

  private unschedule(): void {
    if (this.immediate) {
      clearImmediate(this.immediate);
      this.immediate = null;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * `id`'s bytes as one event, the chunks joined where there are more than
   * one: a second copy of theirs, but one event for the SWF rather than one
   * for each read, which costs it far more than the copy.
   */
  private seal(id: number): void {
    const joining = this.joining.get(id);
    if (!joining) {
      return;
    }

    this.joining.delete(id);

    if (joining.chunks.length > 1) {
      const bytes = new Uint8Array(joining.length);
      let offset = 0;
      for (let i = 0; i < joining.chunks.length; i++) {
        bytes.set(joining.chunks[i], offset);
        offset += joining.chunks[i].length;
      }

      this.batch[joining.at][1] = joining.wrap(bytes);
    }
  }
}
