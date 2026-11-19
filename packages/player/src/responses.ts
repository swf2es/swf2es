// A fetch Response's body for a host's fetch (FetchHost), told to the
// player as it comes where the player asks to hear of it (FetchProgress).
import type { FetchProgress, FetchResult } from "./hosts.js";

/**
 * `response`'s body, read as it comes and each piece told to `progress`
 * after its head, `head` as the host's result will have it; read whole
 * where nothing asks to hear of it.
 */
export async function responseBytes(
  response: Response,
  head: Omit<FetchResult, "bytes">,
  progress?: FetchProgress,
): Promise<Uint8Array> {
  const body = response.body;
  if (!progress || !body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const declared = declaredLength(response);
  progress.open(head, declared);
  const gathered = new Gathered(declared);
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    gathered.add(value);
    progress.data(value);
  }

  return gathered.whole();
}

/** Above this, a buffer for the length told grows to it only as the bytes come. */
const CAP = 1 << 24;

/**
 * A body's bytes as they come, held at twice their size at most: in one
 * buffer of the length told (up to CAP until more comes), or as a list of
 * the pieces joined once at the end where no length was told or more came.
 */
class Gathered {
  private buffer: Uint8Array | null;
  private pieces: Uint8Array[] | null = null;
  private length = 0;

  constructor(private readonly declared: number) {
    this.buffer = declared > 0 ? new Uint8Array(Math.min(declared, CAP)) : null;
    if (this.buffer === null) {
      this.pieces = [];
    }
  }

  add(chunk: Uint8Array): void {
    const end = this.length + chunk.length;
    const buffer = this.buffer;
    if (buffer !== null && end > buffer.length) {
      if (end <= this.declared) {
        const grown = new Uint8Array(this.declared);
        grown.set(buffer.subarray(0, this.length));
        this.buffer = grown;
      } else {
        // More than told: the rest as pieces, after what came.
        this.pieces = [buffer.subarray(0, this.length)];
        this.buffer = null;
      }
    }

    if (this.buffer !== null) {
      this.buffer.set(chunk, this.length);
    } else {
      this.pieces?.push(chunk);
    }

    this.length = end;
  }

  whole(): Uint8Array {
    if (this.buffer !== null) {
      return this.length === this.buffer.length ? this.buffer : this.buffer.slice(0, this.length);
    }

    const pieces = this.pieces ?? [];
    if (pieces.length === 1) {
      return pieces[0];
    }

    const bytes = new Uint8Array(this.length);
    let at = 0;
    for (const piece of pieces) {
      bytes.set(piece, at);
      at += piece.length;
    }

    return bytes;
  }
}

/**
 * The length a response's headers tell, as Flash's bytesTotal: 0 where
 * they tell none, or where its body was encoded, which the browser
 * decodes to another length. Across origins the encoding may be hidden
 * from the page while the length is not: the loads then count the total
 * as unknown once more has come than it told (piecesOf).
 */
function declaredLength(response: Response): number {
  const coding = response.headers.get("content-encoding");
  if (coding !== null && coding.trim().toLowerCase() !== "identity") {
    return 0;
  }

  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}
