import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { abc, string, u30 } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

const dump = (bytes: Uint8Array): string[] =>
  (testing.poolDump(bytes) as string).split("\n").filter(Boolean);
const error = (bytes: Uint8Array): string | undefined =>
  dump(bytes).find((l) => l.startsWith("error"));

const PACKAGE = 0x16;
const QNAME = 0x07;
const MULTINAME = 0x09;
const RTQNAME_L = 0x11;
const TYPENAME = 0x1d;

test("parses the pool ASC 2.0 wrote for vector-sort.as", async () => {
  const bytes = await readFile(new URL("fixtures/vector-sort.abc", import.meta.url));
  // Sizes match abcdump's: strings count 14, namespaces 5, nssets 2, names 10.
  assert.deepEqual(dump(new Uint8Array(bytes)), [
    "string 1 v",
    "string 2 ",
    "string 3 Vector",
    "string 4 __AS3__.vec",
    "string 5 int",
    "string 6 vector-sort.as$0:anonymous",
    "string 7 push",
    "string 8 FilePrivateNS:vector-sort",
    "string 9 sort",
    "string 10 trace",
    "string 11 ,",
    "string 12 join",
    "string 13 length",
    "ns 1 0x17 2",
    "ns 2 0x16 4",
    "ns 3 0x16 2",
    "ns 4 0x05 8",
    "nsset 1 3,1,4",
    "mn 1 0x07 1 1",
    "mn 2 0x1d 3 4",
    "mn 3 0x07 2 3",
    "mn 4 0x07 3 5",
    "mn 5 0x09 1 7",
    "mn 6 0x09 1 9",
    "mn 7 0x07 3 10",
    "mn 8 0x09 1 12",
    "mn 9 0x07 3 13",
  ]);
});

test("reads ints as s32 bit patterns, uints and doubles", () => {
  const bytes = abc({ ints: [7, -5 >>> 0], uints: [0xffffffff], doubles: [1.5, -0.25] });
  assert.deepEqual(dump(bytes), [
    "int 1 7",
    "int 2 -5",
    "uint 1 4294967295",
    "double 1 1.5",
    "double 2 -0.25",
  ]);
});

test("empty pools parse to nothing", () => {
  assert.deepEqual(dump(abc({})), []);
});

test("decodes UTF-8 strings without validating them", () => {
  assert.deepEqual(dump(abc({ strings: ["", "ä€"] })), ["string 1 ", "string 2 ä€"]);
});

test("a count larger than the bytes left is corrupt", () => {
  assert.equal(error(new Uint8Array([16, 0, 46, 0, ...u30(1000), 0])), "error 1107");
});

test("a string may not end at the end of the ABC", () => {
  const upToStrings = [16, 0, 46, 0, 0, 0, 0, ...u30(2), ...string("abc")];
  assert.equal(error(new Uint8Array(upToStrings)), "error 1107");
  assert.equal(error(abc({ strings: ["abc"] }, [])), undefined);
});

test("a string length with either top bit set is corrupt", () => {
  const bytes = new Uint8Array([16, 0, 46, 0, 0, 0, 0, 2, 0x80, 0x80, 0x80, 0x80, 0x04, 0]);
  assert.equal(error(bytes), "error 1107");
});

test("namespaces need a namespace kind and a string in range", () => {
  assert.equal(error(abc({ strings: ["a"], namespaces: [[PACKAGE, ...u30(1)]] })), undefined);
  assert.equal(error(abc({ namespaces: [[QNAME, ...u30(0)]] })), "error 1033");
  assert.equal(error(abc({ strings: ["a"], namespaces: [[PACKAGE, ...u30(2)]] })), "error 1032");
});

test("namespace sets may not contain namespace 0 or one out of range", () => {
  const namespaces = [[PACKAGE, 0]];
  assert.deepEqual(dump(abc({ namespaces, nsSets: [[1, 1]] })).slice(1), ["nsset 1 1,1"]);
  assert.equal(error(abc({ namespaces, nsSets: [[0]] })), "error 1080");
  assert.equal(error(abc({ namespaces, nsSets: [[2]] })), "error 1032");
});

test("multinames check their namespace, set and name indices", () => {
  const base = { strings: ["a"], namespaces: [[PACKAGE, 0]], nsSets: [[1]] };
  const mn = (entry: number[]) => error(abc({ ...base, multinames: [entry] }));

  assert.equal(mn([QNAME, ...u30(1), ...u30(1)]), undefined);
  assert.equal(mn([QNAME, ...u30(2), ...u30(1)]), "error 1032");
  assert.equal(mn([QNAME, ...u30(1), ...u30(2)]), "error 1032");
  assert.equal(mn([MULTINAME, ...u30(1), ...u30(1)]), undefined);
  assert.equal(mn([MULTINAME, ...u30(1), ...u30(0)]), "error 1032");
  assert.equal(mn([RTQNAME_L]), undefined);
  assert.equal(mn([0x42]), "error 1033");
});

test("type names: one parameter, a plain base, no cycles", () => {
  const strings = ["Vector", "int"];
  const namespaces = [[PACKAGE, 0]];
  const vector = [QNAME, ...u30(1), ...u30(1)];
  const int = [QNAME, ...u30(1), ...u30(2)];
  const typeName = (base: number, param: number, count = 1) => [
    TYPENAME,
    ...u30(base),
    ...u30(count),
    ...u30(param),
  ];
  const check = (multinames: number[][]) => error(abc({ strings, namespaces, multinames }));

  assert.equal(check([vector, int, typeName(1, 2)]), undefined);
  assert.equal(check([vector, typeName(1, 0)]), undefined, "Vector.<*>");
  assert.equal(check([typeName(2, 3), vector, int]), undefined, "forward references");
  assert.equal(check([vector, int, typeName(1, 4), typeName(1, 2)]), undefined, "nested");
  assert.equal(check([vector, int, typeName(1, 2, 2)]), "error 1107");
  assert.equal(check([vector, typeName(0, 1)]), "error 1032");
  assert.equal(check([vector, typeName(5, 1)]), "error 1032");
  assert.equal(check([vector, typeName(1, 1), typeName(2, 1)]), "error 1107", "base is a TypeName");
  assert.equal(check([vector, typeName(1, 3), typeName(1, 2)]), "error 1107", "cycle");
});

test("truncated input is corrupt", () => {
  const bytes = abc({ strings: ["hello"], namespaces: [[PACKAGE, ...u30(1)]] });
  for (let length = 5; length < bytes.length - 2; length++) {
    assert.equal(error(bytes.slice(0, length)), "error 1107", `length ${length}`);
  }
});
