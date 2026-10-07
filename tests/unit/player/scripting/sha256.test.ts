// The player's own SHA-256, for a page with no crypto.subtle, against
// node's, which the AOT side fingerprints with: the same digest, or a
// module compiled in the browser could never meet one compiled ahead.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256, sha256Here } from "../../../../packages/player/dist/scripting/sha256.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const nodes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("the fallback SHA-256 matches node's at every padding boundary and on a long input", async () => {
  // Lengths around the block boundaries, where the padding's length word moves blocks.
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      bytes[i] = (i * 131 + 7) & 0xff;
    }

    assert.equal(hex(sha256Here(bytes)), nodes(bytes), `${n} bytes`);
  }

  // The chosen path, crypto.subtle's here, agrees too.
  const bytes = new TextEncoder().encode("abc");
  assert.equal(await sha256(bytes), nodes(bytes));
  assert.equal(
    await sha256(bytes),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
