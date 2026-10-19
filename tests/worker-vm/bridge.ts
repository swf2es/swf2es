// A bounded, reentrant RPC experiment, not a player host. Only the diagnostic
// main endpoint spins; the worker sleeps and services nested requests.
const SLOTS = 16;
const CAPACITY = 16 * 1024;
const STRIDE = CAPACITY + 8;
const FREE = 0;
const REQUEST = 1;
const RUNNING = 2;
const RESPONSE = 3;
const FAILED = 4;

export interface Channel {
  signal: SharedArrayBuffer;
  main: SharedArrayBuffer;
  worker: SharedArrayBuffer;
}

export function channel(): Channel {
  return {
    signal: new SharedArrayBuffer(8),
    main: new SharedArrayBuffer(SLOTS * STRIDE),
    worker: new SharedArrayBuffer(SLOTS * STRIDE),
  };
}

export class Bridge {
  private readonly signal: Int32Array;
  private readonly incoming: SharedArrayBuffer;
  private readonly outgoing: SharedArrayBuffer;
  private readonly encode = new TextEncoder();
  private readonly decode = new TextDecoder("utf-8", { fatal: true });
  private readonly policy: "worker" | "diagnostic-spin" | "reject";
  private readonly notify: () => void;
  private readonly dispatch: (method: string, body: string) => string;
  private readonly timeout: number;
  private depth = 0;
  calls = 0;
  waits = 0;
  spins = 0;

  constructor(
    shared: Channel,
    policy: "worker" | "diagnostic-spin" | "reject",
    notify: () => void,
    dispatch: (method: string, body: string) => string,
    timeout = 2000,
  ) {
    this.policy = policy;
    this.notify = notify;
    this.dispatch = dispatch;
    this.timeout = timeout;
    this.signal = new Int32Array(shared.signal);
    this.incoming = policy === "worker" ? shared.main : shared.worker;
    this.outgoing = policy === "worker" ? shared.worker : shared.main;
  }

  private wake(): void {
    Atomics.add(this.signal, 0, 1);
    Atomics.notify(this.signal, 0);
  }

  close(): void {
    Atomics.store(this.signal, 1, 1);
    this.wake();
  }

  private checkOpen(): void {
    if (Atomics.load(this.signal, 1)) {
      throw new Error("bridge closed");
    }
  }

  private write(buffer: SharedArrayBuffer, slot: number, text: string, state: number): void {
    const bytes = this.encode.encode(text);
    if (bytes.length > CAPACITY) {
      throw new RangeError("bridge payload exceeds 16 KiB");
    }

    const at = slot * STRIDE;
    const header = new Int32Array(buffer, at, 2);
    new Uint8Array(buffer, at + 8, bytes.length).set(bytes);
    Atomics.store(header, 1, bytes.length);
    Atomics.store(header, 0, state);
    this.wake();
  }

  private read(buffer: SharedArrayBuffer, slot: number): string {
    const at = slot * STRIDE;
    const length = Atomics.load(new Int32Array(buffer, at, 2), 1);
    if (length < 0 || length > CAPACITY) {
      throw new RangeError("invalid bridge payload length");
    }

    // TextDecoder accepts an ordinary buffer, not a shared view.
    return this.decode.decode(new Uint8Array(buffer, at + 8, length).slice());
  }

  pump(): void {
    this.checkOpen();
    for (let slot = 0; slot < SLOTS; slot++) {
      const header = new Int32Array(this.incoming, slot * STRIDE, 2);
      if (Atomics.compareExchange(header, 0, REQUEST, RUNNING) !== REQUEST) {
        continue;
      }

      let answer: string;
      let state = RESPONSE;
      try {
        const [method, body] = JSON.parse(this.read(this.incoming, slot)) as [string, string];
        answer = this.dispatch(method, body);
        if (this.encode.encode(answer).length > CAPACITY) {
          throw new RangeError("bridge response exceeds 16 KiB");
        }
      } catch (error) {
        answer = String(error).slice(0, 1024);
        state = FAILED;
      }

      // A timed-out endpoint is never reused, including by a late response.
      this.checkOpen();
      this.write(this.incoming, slot, answer, state);
    }
  }

  call(method: string, body: string): string {
    this.checkOpen();
    if (this.policy === "reject") {
      throw new Error("synchronous page-to-worker callback requires blocking main");
    }
    if (this.depth === SLOTS) {
      throw new RangeError("bridge nesting exceeds 16 calls per direction");
    }

    const slot = this.depth++;
    const header = new Int32Array(this.outgoing, slot * STRIDE, 2);
    const deadline = performance.now() + this.timeout;
    try {
      if (Atomics.load(header, 0) !== FREE) {
        throw new Error("bridge slot still owned");
      }

      this.write(this.outgoing, slot, JSON.stringify([method, body]), REQUEST);
      this.calls++;
      this.notify();
      for (;;) {
        // Sample before checking requests/results so no wake can be lost.
        const version = Atomics.load(this.signal, 0);
        this.pump();
        const state = Atomics.load(header, 0);
        if (state === RESPONSE || state === FAILED) {
          const answer = this.read(this.outgoing, slot);
          Atomics.store(header, 0, FREE);
          if (state === FAILED) {
            throw new Error(answer);
          }

          return answer;
        }

        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          this.close();
          throw new Error("bridge timeout; endpoint closed");
        }

        if (this.policy === "worker") {
          this.waits++;
          Atomics.wait(this.signal, 0, version, remaining);
        } else {
          this.spins++;
        }
      }
    } finally {
      this.depth--;
    }
  }
}
