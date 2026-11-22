// SHA-256 of an ABC's bytes, the fingerprint the AOT side and the cache
// key name ABCs by: from crypto.subtle where there is one, which only a
// secure context (https, localhost) has, else computed here, so that a
// player on a plain http page loads too, with the same fingerprint.
import { hex, sha256Here } from "@swf2es/codegen";

export { hex, sha256Here };

/** The digest as 64 hex digits. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // The bytes are a view of the SWF's buffer, never a shared one, as digest requires.
    return hex(new Uint8Array(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));
  }

  return hex(sha256Here(bytes));
}
