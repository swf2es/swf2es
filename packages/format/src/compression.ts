/**
 * Compression as SWF files and ByteArray use it, synchronously and with no
 * platform API, through @swf2es/compress: zlib itself for zlib and raw
 * deflate, the LZMA SDK's encoder for LZMA, and an LZMA decoder after the
 * SDK's specification.
 */
import {
  CORRUPT,
  type Decoded,
  DICTIONARY,
  DONE,
  deflate,
  FULL,
  inflate,
  lzmaDecode,
  lzmaEncode,
  TRUNCATED,
} from "@swf2es/compress";

/** Data a decompressor cannot read: corrupt, truncated, or not what it says. */
export class CompressedDataError extends Error {}

/**
 * Data whose output does not fit: more than the decompressor's memory, or
 * the page's, can hold. avmplus' ByteArray fails such an uncompress with
 * MemoryError 1000, where it fails corrupt data with IOError 2058.
 */
export class CompressedDataTooLargeError extends CompressedDataError {}

/** A deflate level: 0 stores, 1 is fastest, 9 smallest. */
export type ZlibLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** `data` as a zlib stream, as zlib's deflate writes it at `level`, 9 by default, as avmplus' ByteArray. */
export function zlibCompress(data: Uint8Array, level: ZlibLevel = 9): Uint8Array {
  return deflate(data, level, false);
}

/** `data` as a raw deflate stream, with no zlib header or checksum. */
export function deflateCompress(data: Uint8Array): Uint8Array {
  return deflate(data, 9, true);
}

/** The most an inflate may write: as much as a wasm32 memory holds. */
const NO_LIMIT = 2 ** 32 - 1;

/** A failed decode's status as a CompressedDataError. */
function failure(result: Decoded): CompressedDataError {
  switch (result.status) {
    case TRUNCATED:
      return new CompressedDataError("truncated");
    case CORRUPT:
      return new CompressedDataError(result.message ?? "corrupt");
    case DICTIONARY:
      return new CompressedDataError("needs a preset dictionary");
    default:
      return new CompressedDataTooLargeError("out of memory");
  }
}

/**
 * The bytes of a zlib stream (or, `raw`, of a raw deflate stream), up to its
 * end: anything after is left, as zlib's inflate leaves it. The header is
 * checked here, so that every way it can be wrong reads as avmplus' does.
 */
export function zlibUncompress(data: Uint8Array, raw = false): Uint8Array {
  if (!raw) {
    if (data.length < 2) {
      throw new CompressedDataError("truncated");
    }

    const cmf = data[0];
    const flg = data[1];
    if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0) {
      throw new CompressedDataError("incorrect header check");
    }

    if (flg & 0x20) {
      throw new CompressedDataError("needs a preset dictionary");
    }
  }

  const result = inflate(data, raw, NO_LIMIT);
  if (result.status !== DONE) {
    throw failure(result);
  }

  return result.bytes;
}

/** The size of an LZMA header: its 5 property bytes and the 8-byte length of what it holds. */
export const LZMA_HEADER = 13;

/** `data` as ByteArray's LZMA: the 5 property bytes, its length in 8 bytes, little-endian, and the stream. */
export function lzmaByteArrayCompress(data: Uint8Array): Uint8Array {
  return lzmaEncode(data);
}

/**
 * ByteArray's LZMA, as avmplus reads it: the length its header gives must
 * be what the stream holds. A length past 32 bits is not read here; the
 * caller checks it first, as avmplus fails it before trying.
 */
export function lzmaByteArrayUncompress(data: Uint8Array): Uint8Array {
  const length = (data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24)) >>> 0;
  if (length > MAX_LZMA_RATIO * (data.length - LZMA_HEADER) + 4096) {
    throw new CompressedDataError(`${length} bytes in a stream of ${data.length}`);
  }

  const result = lzmaDecode(data, 0, LZMA_HEADER, length);
  if (result.status !== DONE) {
    throw failure(result);
  }

  if (result.bytes.length !== length) {
    throw new CompressedDataError("length mismatch");
  }

  return result.bytes;
}

/**
 * More than LZMA can expand a byte to. Its best case, a long run of one
 * byte, is matches of 273 bytes that each cost 14 decisions, each at least
 * the 0.022 bits of LZMA's likeliest probability (2017/2048): 7090:1,
 * which an encoder nears on 32 MB of zeros (6959:1). A header naming more
 * than this of its stream is refused before decoding; one naming less is
 * decoded, and a decoder that would read past the stream's end fails.
 */
const MAX_LZMA_RATIO = 8192;

/**
 * The first `length` bytes of a SWF as an uncompressed one, or fewer if it
 * has fewer, decompressing only as far as they need: the header and the
 * first tags, without trusting the header's file length, which a SWF of
 * 30 bytes may give as 4 GB. Whatever cannot be read ends it early.
 */
export function decompressSwfPrefix(swf: Uint8Array, length: number): Uint8Array {
  const signature = String.fromCharCode(swf[0], swf[1], swf[2]);
  if (swf.length < 8 || signature === "FWS") {
    return swf.subarray(0, length);
  }

  const want = Math.max(0, length - 8);
  const fileLength = new DataView(swf.buffer, swf.byteOffset, swf.byteLength).getUint32(4, true);
  const options = { offset: 8, partial: true };
  let out: Uint8Array = new Uint8Array(8);
  // A kilobyte of the body first, as a header and the first tags need, and
  // more only while the input runs out before the output: a large SWF is
  // not copied whole for its first bytes. What decoded before any failure
  // is kept, so a SWF cut short still has its start.
  for (let input = 1024; ; input *= 16) {
    const end = Math.min(swf.length, (signature === "ZWS" ? 17 : 8) + input);
    let result: Decoded | null = null;
    if (signature === "CWS") {
      result = inflate(swf.subarray(8, end), false, want, options);
    } else if (signature === "ZWS" && swf.length >= 17) {
      const size = Math.min(want, Math.max(0, fileLength - 8));
      result = lzmaDecode(swf.subarray(0, end), 12, 17, size, options);
    }

    if (result === null) {
      break;
    }

    out = result.bytes;
    if (result.status !== TRUNCATED || end === swf.length) {
      break;
    }
  }

  out.set(swf.subarray(0, 8), 0);
  out[0] = 0x46; // F
  return out;
}

/**
 * A SWF's bytes as an uncompressed one: the header as FWS, then the body,
 * inflated for CWS, and for ZWS decoded from LZMA, whose header SWF writes
 * differently (after the 8 bytes of the SWF header, a 4-byte compressed
 * length and the 5 property bytes, and no 8-byte size).
 */
export function decompressSwf(swf: Uint8Array): Uint8Array {
  const signature = String.fromCharCode(swf[0], swf[1], swf[2]);
  if (signature === "FWS") {
    return swf;
  }

  const fileLength = new DataView(swf.buffer, swf.byteOffset, swf.byteLength).getUint32(4, true);
  if (fileLength < 8 && (signature === "CWS" || signature === "ZWS")) {
    throw new CompressedDataError(`a file length of ${fileLength}, shorter than its header`);
  }

  let result: Decoded;
  if (signature === "CWS") {
    // A byte past the header's length tells a longer body from one that fits.
    result = inflate(swf.subarray(8), false, fileLength - 8 + 1, { offset: 8 });
    if (result.status === FULL) {
      throw new CompressedDataError(
        `a body of more than ${fileLength - 8} bytes where the header says ${fileLength - 8}`,
      );
    }
  } else if (signature === "ZWS") {
    if (swf.length < 17) {
      throw new CompressedDataError("truncated");
    }

    // A length no stream that short can hold is refused before decoding;
    // within it, the decoder stops where the stream does.
    if (fileLength - 8 > MAX_LZMA_RATIO * (swf.length - 17) + 4096) {
      throw new CompressedDataError(`a body of ${fileLength - 8} bytes in ${swf.length} of SWF`);
    }

    result = lzmaDecode(swf, 12, 17, fileLength - 8, { offset: 8 });
  } else {
    throw new TypeError(`Not a SWF file (signature ${JSON.stringify(signature)})`);
  }

  if (result.status !== DONE) {
    throw failure(result);
  }

  const file = result.bytes;
  if (file.length !== fileLength) {
    throw new CompressedDataError(
      `body of ${file.length - 8} bytes where the header says ${fileLength - 8}`,
    );
  }

  file.set(swf.subarray(0, 8), 0);
  file[0] = 0x46; // F
  return file;
}
