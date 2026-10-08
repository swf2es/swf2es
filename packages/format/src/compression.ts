/**
 * Compression as SWF files and ByteArray use it, synchronously and with no
 * platform API: zlib and raw deflate through pako, a port of zlib whose
 * output is zlib's byte for byte, and LZMA through lzma1.
 */
import { compress as lzmaCompress, decompress as lzmaDecompress } from "lzma1";
import pako from "pako";

/** Data a decompressor cannot read: corrupt, truncated, or not what it says. */
export class CompressedDataError extends Error {}

/**
 * zlib's settings as avmplus' ByteArray.compress uses them: the best
 * compression, 8 for memory. A new object each time: pako's deflateRaw sets
 * `raw` on the one it is given.
 */
const zlibOptions = (level: ZlibLevel = 9) => ({ level, memLevel: 8 as const });

/** A deflate level: 0 stores, 1 is fastest, 9 smallest. */
export type ZlibLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** `data` as a zlib stream, as zlib's deflate writes it at `level`, 9 by default. */
export function zlibCompress(data: Uint8Array, level: ZlibLevel = 9): Uint8Array {
  return pako.deflate(data, zlibOptions(level));
}

/** `data` as a raw deflate stream, with no zlib header or checksum. */
export function deflateCompress(data: Uint8Array): Uint8Array {
  return pako.deflateRaw(data, zlibOptions());
}

/**
 * The bytes of a zlib stream (or, `raw`, of a raw deflate stream), up to its
 * end: anything after is left, as zlib's inflate leaves it. pako, given a
 * zlib stream, would read what follows as another; so the deflate stream
 * inside is inflated raw, where pako stops at its end, and the header and
 * the Adler-32 after it are checked here.
 */
export function zlibUncompress(data: Uint8Array, raw = false): Uint8Array {
  let start = 0;
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

    start = 2;
  }

  const inflator = new pako.Inflate({ raw: true });
  inflator.push(data.subarray(start), true);

  // Ended at the stream's end; its types leave `ended` and `strm` out.
  const state = inflator as unknown as { ended: boolean; strm: { next_in: number } };
  if (inflator.err || !state.ended) {
    throw new CompressedDataError(inflator.msg || "truncated");
  }

  const bytes = (inflator.result as Uint8Array | undefined) ?? new Uint8Array(0);
  if (!raw) {
    const end = start + state.strm.next_in;
    if (end + 4 > data.length) {
      throw new CompressedDataError("truncated");
    }

    const check =
      ((data[end] << 24) | (data[end + 1] << 16) | (data[end + 2] << 8) | data[end + 3]) >>> 0;
    if (check !== adler32(bytes)) {
      throw new CompressedDataError("incorrect data check");
    }
  }

  return bytes;
}

/** The Adler-32 checksum of `data`, as zlib's trailer holds it. */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;

  for (let i = 0; i < data.length; ) {
    // 5552 bytes at most before the modulo keep the sums exact, as zlib's
    // NMAX; eight at a time, then the rest.
    const end = Math.min(i + 5552, data.length);
    const unrolledEnd = end - ((end - i) % 8);
    for (; i < unrolledEnd; i += 8) {
      // The eight steps of b += a at once: each byte counted once for each
      // step after it.
      const x0 = data[i];
      const x1 = data[i + 1];
      const x2 = data[i + 2];
      const x3 = data[i + 3];
      const x4 = data[i + 4];
      const x5 = data[i + 5];
      const x6 = data[i + 6];
      const x7 = data[i + 7];
      b += 8 * a + 8 * x0 + 7 * x1 + 6 * x2 + 5 * x3 + 4 * x4 + 3 * x5 + 2 * x6 + x7;
      a += x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7;
    }

    for (; i < end; i++) {
      a += data[i];
      b += a;
    }

    a %= 65521;
    b %= 65521;
  }

  return ((b << 16) | a) >>> 0;
}

/** The size of an LZMA header: its 5 property bytes and the 8-byte length of what it holds. */
export const LZMA_HEADER = 13;

/** `data` as ByteArray's LZMA: the 5 property bytes, its length in 8 bytes, little-endian, and the stream. */
export function lzmaByteArrayCompress(data: Uint8Array): Uint8Array {
  return lzmaCompress(data, 9);
}

/**
 * ByteArray's LZMA, as avmplus reads it: the length its header gives must
 * be what the stream holds. A length past 32 bits is not read here; the
 * caller checks it first, as avmplus fails it before trying.
 */
export function lzmaByteArrayUncompress(data: Uint8Array): Uint8Array {
  const length = (data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24)) >>> 0;
  let bytes: Uint8Array;

  try {
    bytes = lzmaDecompress(data);
  } catch (e) {
    throw new CompressedDataError(String(e));
  }

  if (bytes.length !== length) {
    throw new CompressedDataError("length mismatch");
  }

  return bytes;
}

/**
 * More than LZMA can expand a byte to. Its best case, a long run of one
 * byte, is matches of 273 bytes that cost some 14 coded bits, each at the
 * 0.022 bits of LZMA's likeliest probability, about 7000:1, which lzma1
 * reaches on 32 MB of zeros (6959:1); this leaves several times that.
 */
const MAX_LZMA_RATIO = 32768;

/**
 * A ZWS SWF's body in the .lzma layout lzma1 reads: the properties, the
 * length it holds, `length`, and the stream. The dictionary is no larger
 * than that length, which no match reaches past, so that a header naming
 * a dictionary of 4 GB does not make the decoder allocate one.
 */
function swfLzma(swf: Uint8Array, length: number): Uint8Array {
  const lzma = new Uint8Array(LZMA_HEADER + swf.length - 17);
  lzma.set(swf.subarray(12, 17), 0);
  const view = new DataView(lzma.buffer);
  view.setUint32(1, Math.min(view.getUint32(1, true), Math.max(length, 4096)), true);
  view.setUint32(5, length, true);
  lzma.set(swf.subarray(17), LZMA_HEADER);
  return lzma;
}

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
  let body: Uint8Array = new Uint8Array(0);
  if (signature === "CWS") {
    const chunks: Uint8Array[] = [];
    let have = 0;
    const inflator = new pako.Inflate({ chunkSize: 4096 });
    inflator.onData = (chunk: Uint8Array) => {
      chunks.push(chunk);
      have += chunk.length;
    };
    // A little input at a time: a kilobyte of deflate inflates to a megabyte at most.
    for (let at = 8; at < swf.length && have < want && !inflator.err; at += 1024) {
      inflator.push(swf.subarray(at, at + 1024), false);
    }

    body = new Uint8Array(have);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.length;
    }
  } else if (signature === "ZWS" && swf.length >= 17) {
    const fileLength = new DataView(swf.buffer, swf.byteOffset, swf.byteLength).getUint32(4, true);
    try {
      body = lzmaDecompress(swfLzma(swf, Math.min(want, Math.max(0, fileLength - 8))));
    } catch {
      // Corrupt: no body to read.
    }
  }

  const out = new Uint8Array(8 + Math.min(want, body.length));
  out.set(swf.subarray(0, 8), 0);
  out[0] = 0x46; // F
  out.set(body.subarray(0, out.length - 8), 8);
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
  let body: Uint8Array;
  if (signature === "CWS") {
    body = zlibUncompress(swf.subarray(8));
  } else if (signature === "ZWS") {
    if (swf.length < 17) {
      throw new CompressedDataError("truncated");
    }

    // LZMA decodes for as long as the length asks, whatever its input; a
    // length no stream that short can hold is refused before it runs.
    if (fileLength - 8 > MAX_LZMA_RATIO * (swf.length - 17) + 4096) {
      throw new CompressedDataError(`a body of ${fileLength - 8} bytes in ${swf.length} of SWF`);
    }

    body = lzmaDecompress(swfLzma(swf, fileLength - 8));
  } else {
    throw new TypeError(`Not a SWF file (signature ${JSON.stringify(signature)})`);
  }

  if (body.length !== fileLength - 8) {
    throw new CompressedDataError(
      `body of ${body.length} bytes where the header says ${fileLength - 8}`,
    );
  }

  const out = new Uint8Array(fileLength);
  out.set(swf.subarray(0, 8), 0);
  out[0] = 0x46; // F
  out.set(body, 8);
  return out;
}
