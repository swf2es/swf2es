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

  progress.open(head, declaredLength(response));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    length += value.length;
    progress.data(value);
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  return bytes;
}

/**
 * The length a response's headers tell, as Flash's bytesTotal: 0 where
 * they tell none, or where its body was encoded, which the browser
 * decodes to another length.
 */
function declaredLength(response: Response): number {
  const coding = response.headers.get("content-encoding");
  if (coding !== null && coding.trim().toLowerCase() !== "identity") {
    return 0;
  }

  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}
