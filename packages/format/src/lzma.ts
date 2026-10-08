/**
 * An LZMA decoder, as the LZMA SDK's specification decoder (LzmaSpec.cpp,
 * Igor Pavlov, public domain) describes one, for the SWF bodies and
 * ByteArrays swf2es reads. lzma1, which still compresses, decoded them
 * before, but read the properties' first byte as signed, so 128 and more
 * asked it for up to 2^30 literal coders, and went on decoding after its
 * input had ended, for as long as the header's length asked: 30 bytes of
 * zeros naming 4 GB decoded 4 GB. This one refuses both: properties past
 * 224, which no encoder writes, and any read past the input's end, which a
 * whole stream never makes.
 */

/** A stream this decoder cannot read: corrupt, truncated, or not LZMA. */
export class LzmaError extends Error {}

const TOP = 1 << 24;
const PROB_INIT = 1024;
const STATES = 12;
const POS_BITS_MAX = 4;
const LEN_TO_POS_STATES = 4;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;

// A length decoder's probabilities, in one array: choice, choice2, the
// low and mid trees (3 bits) for each of 16 position states, the high tree (8 bits).
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + (16 << 3);
const LEN_HIGH = LEN_MID + (16 << 3);
const LEN_SIZE = LEN_HIGH + 256;

const probabilities = (n: number) => new Uint16Array(n).fill(PROB_INIT);

/** The literal context bits, the literal position bits and the position bits of a properties byte. */
export function lzmaProperties(byte: number): { lc: number; lp: number; pb: number } {
  if (byte >= 9 * 5 * 5) {
    throw new LzmaError(`properties byte ${byte}`);
  }

  return { lc: byte % 9, lp: Math.floor(byte / 9) % 5, pb: Math.floor(byte / 45) };
}

/**
 * Decode an LZMA stream, `input` from `start`, of the properties in its
 * 5 bytes at `properties` of `input`, to `length` bytes, or to its end
 * marker if it has one first: the bytes it decoded, fewer than `length`
 * after a marker. The output grows as it is written, never past `length`.
 */
export function lzmaDecode(
  input: Uint8Array,
  properties: number,
  start: number,
  length: number,
): Uint8Array {
  const { lc, lp, pb } = lzmaProperties(input[properties]);
  const dictionary =
    (input[properties + 1] |
      (input[properties + 2] << 8) |
      (input[properties + 3] << 16) |
      (input[properties + 4] << 24)) >>>
    0;
  // As the SDK's decoder, a dictionary of at least 4 KB, whatever the header says.
  const dictSize = Math.max(dictionary, 4096);

  let pos = start;
  const end = input.length;
  const readByte = (): number => {
    if (pos >= end) {
      throw new LzmaError("truncated");
    }

    return input[pos++];
  };

  // The range decoder: the first byte is 0, then the code's 4.
  if (readByte() !== 0) {
    throw new LzmaError("corrupt");
  }

  let range = 0xffffffff;
  let code = 0;
  for (let i = 0; i < 4; i++) {
    code = ((code << 8) | readByte()) >>> 0;
  }

  if (code === range) {
    throw new LzmaError("corrupt");
  }

  const bit = (probs: Uint16Array, i: number): number => {
    const v = probs[i];
    const bound = (range >>> 11) * v;
    let symbol: number;
    if (code < bound) {
      probs[i] = v + ((2048 - v) >>> 5);
      range = bound;
      symbol = 0;
    } else {
      probs[i] = v - (v >>> 5);
      code -= bound;
      range -= bound;
      symbol = 1;
    }

    if (range < TOP) {
      range = (range * 256) >>> 0;
      code = ((code * 256) | readByte()) >>> 0;
    }

    return symbol;
  };

  const directBits = (count: number): number => {
    let result = 0;
    for (let i = 0; i < count; i++) {
      range >>>= 1;
      let b = 0;
      if (code >= range) {
        code -= range;
        b = 1;
      }

      result = result * 2 + b;
      if (range < TOP) {
        range = (range * 256) >>> 0;
        code = ((code * 256) | readByte()) >>> 0;
      }
    }

    return result;
  };

  const tree = (probs: Uint16Array, offset: number, bits: number): number => {
    let m = 1;
    for (let i = 0; i < bits; i++) {
      m = (m << 1) + bit(probs, offset + m);
    }

    return m - (1 << bits);
  };

  const reverseTree = (probs: Uint16Array, offset: number, bits: number): number => {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const b = bit(probs, offset + m);
      m = (m << 1) + b;
      symbol |= b << i;
    }

    return symbol;
  };

  const lenDecode = (probs: Uint16Array, posState: number): number => {
    if (bit(probs, LEN_CHOICE) === 0) {
      return tree(probs, LEN_LOW + (posState << 3), 3);
    }

    if (bit(probs, LEN_CHOICE2) === 0) {
      return 8 + tree(probs, LEN_MID + (posState << 3), 3);
    }

    return 16 + tree(probs, LEN_HIGH, 8);
  };

  const literals = probabilities(0x300 << (lc + lp));
  const posSlots = probabilities(LEN_TO_POS_STATES << 6);
  const posDecoders = probabilities(1 + FULL_DISTANCES - END_POS_MODEL_INDEX);
  const align = probabilities(1 << ALIGN_BITS);
  const isMatch = probabilities(STATES << POS_BITS_MAX);
  const isRep = probabilities(STATES);
  const isRepG0 = probabilities(STATES);
  const isRepG1 = probabilities(STATES);
  const isRepG2 = probabilities(STATES);
  const isRep0Long = probabilities(STATES << POS_BITS_MAX);
  const lens = probabilities(LEN_SIZE);
  const repLens = probabilities(LEN_SIZE);

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let out = new Uint8Array(Math.min(length, 1 << 16));
  let outPos = 0;
  /** Room for `n` more bytes, the buffer doubled as it fills, never past `length`. */
  const room = (n: number) => {
    if (outPos + n > out.length) {
      const grown = new Uint8Array(Math.min(length, Math.max(out.length * 2, outPos + n)));
      grown.set(out.subarray(0, outPos));
      out = grown;
    }
  };

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  while (outPos < length) {
    const posState = outPos & pbMask;
    if (bit(isMatch, (state << POS_BITS_MAX) + posState) === 0) {
      const prev = outPos > 0 ? out[outPos - 1] : 0;
      const base = 0x300 * (((outPos & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[outPos - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const b = bit(literals, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) {
            break;
          }
        } while (symbol < 0x100);
      }

      while (symbol < 0x100) {
        symbol = (symbol << 1) | bit(literals, base + symbol);
      }

      room(1);
      out[outPos++] = symbol - 0x100;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (bit(isRep, state) !== 0) {
      if (outPos === 0) {
        throw new LzmaError("corrupt");
      }

      if (bit(isRepG0, state) === 0) {
        if (bit(isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          room(1);
          out[outPos] = out[outPos - rep0 - 1];
          outPos++;
          continue;
        }
      } else {
        let distance: number;
        if (bit(isRepG1, state) === 0) {
          distance = rep1;
        } else {
          if (bit(isRepG2, state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }

          rep2 = rep1;
        }

        rep1 = rep0;
        rep0 = distance;
      }

      len = lenDecode(repLens, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDecode(lens, posState);
      state = state < 7 ? 7 : 10;

      const lenState = Math.min(len, LEN_TO_POS_STATES - 1);
      const posSlot = tree(posSlots, lenState << 6, 6);
      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const bits = (posSlot >>> 1) - 1;
        let distance = (2 | (posSlot & 1)) * 2 ** bits;
        if (posSlot < END_POS_MODEL_INDEX) {
          distance += reverseTree(posDecoders, distance - posSlot, bits);
        } else {
          distance += directBits(bits - ALIGN_BITS) * 16;
          distance += reverseTree(align, 0, ALIGN_BITS);
        }

        rep0 = distance;
      }

      // The end marker.
      if (rep0 === 0xffffffff) {
        break;
      }

      if (rep0 >= dictSize || rep0 >= outPos) {
        throw new LzmaError("corrupt");
      }
    }

    // A match past the length ends the output there, as a prefix asks.
    len = Math.min(len + MATCH_MIN_LEN, length - outPos);
    room(len);
    for (let i = 0; i < len; i++) {
      out[outPos] = out[outPos - rep0 - 1];
      outPos++;
    }
  }

  return outPos === out.length ? out : out.subarray(0, outPos);
}
