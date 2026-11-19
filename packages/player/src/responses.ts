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
  // One buffer that grows as it fills, sized at the length told, up to a bound a lying header
  // cannot push it past: no list of the pieces beside it.
  let bytes = new Uint8Array(Math.min(declared, 1 << 24) || 65536);
  let length = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (length + value.length > bytes.length) {
      const grown = new Uint8Array(Math.max(length + value.length, bytes.length * 2));
      grown.set(bytes.subarray(0, length));
      bytes = grown;
    }

    bytes.set(value, length);
    length += value.length;
    progress.data(value);
  }

  return length === bytes.length ? bytes : bytes.slice(0, length);
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
