import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";
import { byteArrayNatives } from "../../../../../../packages/player/dist/playerglobal/flash/utils/ByteArray.js";
import type { Scripting } from "../../../../../../packages/player/dist/scripting.js";

function setup(data: Uint8Array) {
  const rt = {
    defaultObjectEncoding: 3,
    toUint: (value: avm2.Value) => Number(value) >>> 0,
    toString: String,
    error: (_name: string, id: number) => new Error(`Error #${id}`),
  } as unknown as avm2.Runtime;
  const natives = byteArrayNatives({ rt } as Scripting);
  const owner: avm2.AsObject = {};
  const bytes = avm2.bytesOf(rt, owner);
  bytes.write(data);
  bytes.position = 0;
  const read = natives["flash.utils::ByteArray#readMultiByte"](rt).bind(owner);
  return { read, bytes };
}

test("large Latin-1 and UTF-16 reads preserve code units without argument limits", () => {
  const data = new Uint8Array(65537).fill(0xe9);
  data[65536] = 0;
  const latin = setup(data);
  assert.equal(latin.read(data.length, "iso-8859-1"), "é".repeat(65536));
  assert.equal(latin.bytes.position, data.length);

  const wide = new Uint8Array(65537);
  const view = new DataView(wide.buffer);
  for (let at = 0; at + 1 < wide.length; at += 2) {
    view.setUint16(at, 0xd800, true);
  }

  const utf16 = setup(wide);
  assert.equal(utf16.read(wide.length, "utf-16"), "\ud800".repeat(32768));
  assert.equal(utf16.bytes.position, wide.length - 1);
  assert.equal(utf16.bytes.available, 1);
});

test("cached decoders keep each read independent and EOF leaves the cursor alone", () => {
  const { read, bytes } = setup(new Uint8Array([0xe2, 0x82, 0xac, 65]));
  assert.equal(read(2, "utf-8"), "\ufffd");
  assert.equal(read(1, "utf-8"), "\ufffd");
  assert.throws(() => read(2, "utf-8"), /2030/);
  assert.equal(bytes.position, 3);
  assert.equal(read(1, "utf-8"), "A");

  const another = setup(new Uint8Array([0xac]));
  assert.equal(another.read(1, "utf-8"), "\ufffd");
});

test("Shift-JIS replacements agree across the browser and node decoders", () => {
  const { read } = setup(new Uint8Array([0xff, 0x80, 0xa0, 0xfd, 0x82, 0x20, 0x82]));
  assert.equal(read(7, "shift_jis"), "\uf8f3\u0080\uf8f0\uf8f1\u30fb\u30fb");
});

test("unknown charset churn and oversized labels cannot poison cached decoders", () => {
  const { read, bytes } = setup(new Uint8Array([0x80]));
  for (let i = 0; i < 100; i++) {
    bytes.position = 0;
    assert.equal(read(1, `unknown-${i}`), "€");
  }

  bytes.position = 0;
  assert.equal(read(1, "unknown".repeat(10000)), "€");
  bytes.position = 0;
  assert.equal(read(1, "iso-8859-1"), "\u0080");
  bytes.position = 0;
  assert.equal(read(1, "windows-1252"), "€");
});
