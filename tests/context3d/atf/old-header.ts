// A version 3 ATF rewritten with the old header, which png2atf no longer
// writes but older content holds: a 24-bit length after the signature, no
// version, 24-bit block lengths and no ETC2 blocks.

/** Blocks each level holds in version 3, and how many of them are ETC2's. */
const BLOCKS: Record<number, [number, number]> = {
  0: [1, 0],
  1: [1, 0],
  2: [11, 3],
  3: [4, 1],
  4: [16, 6],
  5: [4, 1],
};

export function oldHeader(atf: Uint8Array): Uint8Array {
  if (atf[6] !== 0xff || atf[7] !== 3) {
    throw new Error("not a version 3 ATF");
  }

  const view = new DataView(atf.buffer, atf.byteOffset, atf.byteLength);
  const [blocks, etc2] = BLOCKS[atf[12] & 0x7f];
  const parts: Uint8Array[] = [atf.subarray(12, 16)];
  let at = 16;
  for (let face = 0; face < (atf[12] & 0x80 ? 6 : 1); face++) {
    for (let level = 0; level < atf[15]; level++) {
      for (let block = 0; block < blocks; block++) {
        const length = view.getUint32(at);
        if (block < blocks - etc2) {
          parts.push(new Uint8Array([length >> 16, length >> 8, length]));
          parts.push(atf.subarray(at + 4, at + 4 + length));
        }

        at += 4 + length;
      }
    }
  }

  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(6 + length);
  out.set([0x41, 0x54, 0x46, length >> 16, length >> 8, length]);
  let to = 6;
  for (const part of parts) {
    out.set(part, to);
    to += part.length;
  }

  return out;
}
