import { test } from "node:test";
import assert from "node:assert/strict";
import { readSwfHeader } from "@swf2es/format";

const header = (sig: string, version: number, length: number): Uint8Array => {
  const b = new Uint8Array(8);
  b.set([...sig].map(c => c.charCodeAt(0)));
  b[3] = version;
  new DataView(b.buffer).setUint32(4, length, true);
  return b;
};

test("reads each SWF compression signature", () => {
  assert.deepEqual(readSwfHeader(header("FWS", 10, 1234)), { compression: "none", version: 10, fileLength: 1234 });
  assert.equal(readSwfHeader(header("CWS", 9, 8)).compression, "zlib");
  assert.equal(readSwfHeader(header("ZWS", 13, 8)).compression, "lzma");
});

test("rejects short input and unknown signatures", () => {
  assert.throws(() => readSwfHeader(new Uint8Array(4)), RangeError);
  assert.throws(() => readSwfHeader(header("GIF", 1, 8)), TypeError);
});
