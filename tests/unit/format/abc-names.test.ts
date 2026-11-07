// abcReferences: the qualified names an ABC's constant pool may refer to,
// from QNames in a package and from Multinames, once for each package in
// their sets, in Flash's layout and in AIR's, whose floats come after the
// doubles; and what an ABC cut short still names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { abcReferences } from "@swf2es/format";

const u30 = (n: number): number[] => {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>>= 7;
  } while (n > 0);

  return out;
};
const string = (s: string) => [...u30(s.length), ...new TextEncoder().encode(s)];

/** An ABC of `minor` (major 47) whose pools name flash.desktop::NativeApplication by QName and Shape by Multiname. */
function abc(minor: number): Uint8Array {
  return Uint8Array.from([
    minor,
    0,
    47,
    0,
    ...u30(2), // ints: one
    ...u30(5),
    ...u30(0), // uints: none
    ...u30(2), // doubles: one
    ...[0, 0, 0, 0, 0, 0, 0xf0, 0x3f],
    ...(minor >= 16 ? [...u30(2), 0, 0, 0x80, 0x3f] : []), // AIR's floats: one
    ...u30(6), // strings
    ...string("flash.desktop"),
    ...string("NativeApplication"),
    ...string("flash.display"),
    ...string("Shape"),
    ...string("private"),
    ...u30(4), // namespaces: two packages and a private one
    0x16,
    ...u30(1),
    0x16,
    ...u30(3),
    0x05,
    ...u30(5),
    ...u30(2), // namespace sets: the private one and flash.display
    ...u30(2),
    ...u30(3),
    ...u30(2),
    ...u30(4), // multinames
    0x07,
    ...u30(1),
    ...u30(2),
    0x09,
    ...u30(4),
    ...u30(1),
    0x07,
    ...u30(3),
    ...u30(2),
  ]);
}

test("an ABC's QNames and Multinames name their packages' definitions", () => {
  for (const minor of [12, 16]) {
    assert.deepEqual([...abcReferences(abc(minor))].sort(), [
      "flash.desktop::NativeApplication",
      "flash.display::Shape",
    ]);
  }
});

test("an ABC cut short names what came before the cut", () => {
  const whole = abc(16);
  assert.deepEqual(
    [...abcReferences(whole.subarray(0, whole.length - 3))],
    ["flash.desktop::NativeApplication", "flash.display::Shape"],
  );
  assert.deepEqual([...abcReferences(whole.subarray(0, 10))], []);
});
