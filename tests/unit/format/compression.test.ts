import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompressedDataError,
  decompressSwf,
  decompressSwfPrefix,
  deflateCompress,
  fileAttributes,
  lzmaByteArrayCompress,
  lzmaByteArrayUncompress,
  readSwfHeader,
  zlibCompress,
  zlibUncompress,
} from "@swf2es/format";

/** An uncompressed SWF: its 8-byte header, then `body`. */
function fws(body: Uint8Array, version = 10): Uint8Array {
  const swf = new Uint8Array(8 + body.length);
  swf.set([0x46, 0x57, 0x53, version]);
  new DataView(swf.buffer).setUint32(4, swf.length, true);
  swf.set(body, 8);
  return swf;
}

/** `swf` as CWS: its body a zlib stream. */
function cws(swf: Uint8Array): Uint8Array {
  const body = zlibCompress(swf.subarray(8));
  const out = new Uint8Array(8 + body.length);
  out.set(swf.subarray(0, 8));
  out[0] = 0x43;
  out.set(body, 8);
  return out;
}

/** `swf` as ZWS: after the header, the LZMA stream's length, its 5 property bytes, and the stream. */
function zws(swf: Uint8Array): Uint8Array {
  const lzma = lzmaByteArrayCompress(swf.subarray(8));
  const stream = lzma.subarray(13);
  const out = new Uint8Array(17 + stream.length);
  out.set(swf.subarray(0, 8));
  out[0] = 0x5a;
  new DataView(out.buffer).setUint32(8, stream.length, true);
  out.set(lzma.subarray(0, 5), 12);
  out.set(stream, 17);
  return out;
}

const body = new TextEncoder().encode("a small SWF body, ".repeat(40));

test("an FWS, a CWS and a ZWS SWF all read as the same uncompressed SWF", () => {
  const plain = fws(body);
  assert.equal(decompressSwf(plain), plain);
  for (const compressed of [cws(plain), zws(plain)]) {
    assert.ok(compressed.length < plain.length);
    const out = decompressSwf(compressed);
    assert.deepEqual(out, plain);
    assert.equal(readSwfHeader(out).compression, "none");
  }
});

test("a SWF's start decompresses alone, as far as asked", () => {
  const plain = fws(body);
  for (const swf of [plain, cws(plain), zws(plain)]) {
    assert.deepEqual(decompressSwfPrefix(swf, 40), plain.subarray(0, 40));
    assert.deepEqual(decompressSwfPrefix(swf, 1 << 20), plain);
  }
});

test("FileAttributes reads from a SWF's start, compressed or not", () => {
  // A 1-bit rect (all zero), the rate, the count, then FileAttributes: AS3 and UseNetwork.
  const attributed = fws(new Uint8Array([0, 0, 24, 1, 0, 0x44, 0x11, 0x09, 0, 0, 0, 0x40, 0]));
  for (const swf of [attributed, cws(attributed), zws(attributed)]) {
    assert.equal(fileAttributes(swf), 0x09);
  }

  assert.equal(fileAttributes(fws(body)), 0);
});

test("neither a SWF nor its start trusts a header that names 4 GB", () => {
  // 30 bytes of ZWS whose header gives the file 4 GB and the dictionary 4 GB, and
  // whose LZMA stream, all zeros, decodes to zeros for as long as it is asked:
  // decompressed whole, it took 4.27 GB and 10.6 s.
  const bomb = new Uint8Array(30);
  bomb.set([
    0x5a, 0x57, 0x53, 10, 0xff, 0xff, 0xff, 0xff, 13, 0, 0, 0, 0x5d, 0xff, 0xff, 0xff, 0xff,
  ]);
  const start = performance.now();
  assert.throws(() => decompressSwf(bomb), CompressedDataError);
  const prefix = decompressSwfPrefix(bomb, 64);
  assert.ok(prefix.length <= 64);
  fileAttributes(bomb);
  assert.ok(performance.now() - start < 1000, `${performance.now() - start} ms`);
});

test("a SWF whose body is not the length its header says is refused", () => {
  const swf = cws(fws(body));
  new DataView(swf.buffer).setUint32(4, 8 + body.length + 1, true);
  assert.throws(() => decompressSwf(swf), CompressedDataError);
});

test("zlib stops at its stream's end, as zlib does, and refuses what is corrupt", () => {
  const z = zlibCompress(body);
  assert.deepEqual([z[0], z[1]], [0x78, 0xda]);
  assert.deepEqual(zlibUncompress(new Uint8Array([...z, 9, 9, 9])), body);
  assert.throws(() => zlibUncompress(z.subarray(0, z.length - 2)), CompressedDataError);
  const bad = z.slice();
  bad[bad.length - 1] ^= 1;
  assert.throws(() => zlibUncompress(bad), /incorrect data check/);
  assert.throws(() => zlibUncompress(new Uint8Array([1, 2, 3])), /incorrect header check/);
  assert.deepEqual(zlibUncompress(deflateCompress(body), true), body);
});

test("compressing twice gives the same bytes: pako's options are not left changed", () => {
  // pako's deflateRaw sets raw on the options it is given; a later zlib stream must keep its header.
  const first = zlibCompress(body);
  deflateCompress(body);
  assert.deepEqual(zlibCompress(body), first);
});

test("ByteArray's LZMA holds its length, which must be what the stream holds", () => {
  const l = lzmaByteArrayCompress(body);
  assert.equal(new DataView(l.buffer, l.byteOffset).getUint32(5, true), body.length);
  assert.deepEqual(lzmaByteArrayUncompress(l), body);
  const wrong = l.slice();
  wrong[5] ^= 1;
  assert.throws(() => lzmaByteArrayUncompress(wrong), CompressedDataError);
});
