// SharedObject's AS2 face in node: the .sol file it writes is the one Flash
// (adl) wrote for the same script, byte for byte, and reading it back gives
// the values; getLocal's names and paths; and the flush as a player goes.
// The date's zone offset is the zone's: adl ran in Helsinki's.
process.env.TZ = "Europe/Helsinki";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

const as1 = (source: string) => w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]);
const swfOf = (source: string) =>
  w.swf({
    version: 8,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [as1(source), w.showFrame(), w.end()],
  });

function memory() {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    storage: {
      get: (key: string) => stored.get(key) ?? null,
      set: (key: string, bytes: Uint8Array) => {
        stored.set(key, bytes.slice());
      },
      remove: (key: string) => {
        stored.delete(key);
      },
    },
  };
}

async function play(
  source: string,
  storage: ReturnType<typeof memory>["storage"],
  url = "file:///C:/so-test.swf",
) {
  const lines: string[] = [];
  const player = new Player(
    swfOf(source),
    null,
    new Avm1(codegen, { print: (l) => lines.push(l), url, storage }),
  );
  await player.start();
  return { lines, player };
}

const writer = `
var so = SharedObject.getLocal("probe");
var d = so.data;
d.n = 1.5; d.i = 42; d.neg = -0; d.nan = NaN; d.s = "hello"; d.e = ""; d.u = "\u00e4\u20ac";
d.t = true; d.f = false; d.z = null; d.un = undefined;
var a = [1, "two"]; a[3] = 4; a.name = "named"; d.a = a;
d.plain = [5, 6];
var o = {x: 1, y: {deep: "yes"}}; d.o = o; d.again = o;
d.date = new Date(1700000000000);
d.fn = function () { return 1; };
function Point() {} Object.registerClass("PointClass", Point);
var p = new Point(); p.px = 3; d.p = p;
var long = ""; for (var k = 0; k < 70; k++) { long += "0123456789"; } d.long = long;
trace("flush " + so.flush());
trace("size " + so.getSize());
trace("same " + (SharedObject.getLocal("probe") == so));
`;

test("a SharedObject's .sol file is Flash's, byte for byte, and reads back as it was", async () => {
  const { stored, storage } = memory();
  const { lines } = await play(writer, storage);
  assert.deepEqual(lines, ["flush true", "size 1047", "same true"]);
  const flash = new Uint8Array(
    await readFile(new URL("fixtures/shared-object-flash.sol", import.meta.url)),
  );
  assert.deepEqual(stored.get("/C:/so-test.swf/probe"), flash);

  const { lines: read } = await play(
    `var d = SharedObject.getLocal("probe").data;
    var out = []; for (var k in d) out.push(k);
    trace(out.join(","));
    trace(d.n + " " + d.i + " " + d.nan + " " + d.s + " [" + d.e + "] " + d.u + " " + d.t + " " + d.f + " " + d.z + " " + d.un);
    trace(d.a.length + " " + d.a[1] + " " + d.a[2] + " " + d.a[3] + " " + d.a.name + " " + (d.a instanceof Array));
    trace(d.plain.length + " " + d.o.y.deep + " " + (d.again == d.o) + " " + d.date.getTime() + " " + (d.date instanceof Date));
    trace(typeof d.fn + " " + d.p.px + " " + d.long.length);`,
    storage,
  );
  assert.deepEqual(read, [
    "long,p,date,again,o,plain,a,un,z,f,t,u,e,s,nan,neg,i,n",
    "1.5 42 NaN hello [] \u00e4\u20ac true false null undefined",
    "4 two undefined 4 named true",
    "2 yes true 1700000000000 true",
    "undefined 3 700",
  ]);
});

test("getLocal refuses a bad name, a secure one off HTTPS and a path that does not lead to the SWF", async () => {
  const { storage } = memory();
  const { lines } = await play(
    `trace(SharedObject.getLocal("a b") + " " + SharedObject.getLocal("x%y") + " " + SharedObject.getLocal(""));
    trace(SharedObject.getLocal("s", undefined, true));
    trace(SharedObject.getLocal("p", "/elsewhere") + " " + typeof SharedObject.getLocal("p", "/games") + " " + typeof SharedObject.getLocal("p", "/"));
    trace(typeof SharedObject.getLocal("p").data);`,
    storage,
    "http://example.test/games/game.swf",
  );
  assert.deepEqual(lines, ["null null null", "null", "null object object", "object"]);
});

test("an empty SharedObject writes nothing, clear removes its file, and a destroyed player writes what changed", async () => {
  const { stored, storage } = memory();
  const { lines, player } = await play(
    `var so = SharedObject.getLocal("save");
    trace(so.flush() + " " + so.getSize());
    so.data.level = 3; so.flush();
    so.clear();
    trace(so.getSize() + " " + so.data.level);
    so.data.coins = 7;`,
    storage,
  );
  assert.deepEqual(lines, ["true 0", "0 undefined"]);
  assert.equal(stored.size, 0);

  player.destroy();
  assert.equal(stored.size, 1);
  const { lines: read } = await play(`trace(SharedObject.getLocal("save").data.coins);`, storage);
  assert.deepEqual(read, ["7"]);
});

test("the data inside itself is written unsupported and a getter never called, as Flash writes them", async () => {
  const fixture = async (name: string) =>
    new Uint8Array(await readFile(new URL(`fixtures/shared-object-${name}.sol`, import.meta.url)));
  const { stored, storage } = memory();
  const { lines } = await play(
    `var s = SharedObject.getLocal("selfq"); s.data.me = s.data; s.data.n = 1;
    trace(s.getSize() + " " + s.flush());
    var h = SharedObject.getLocal("selfq2"); h.data.me = h.data; h.data.holes = new Array(5); var o = {}; o.back = h.data; h.data.o = o;
    h.flush();
    var g = SharedObject.getLocal("getq"); var proto = {};
    proto.addProperty("v", function () { _root.called = 1; return 7; }, null);
    var go = {}; go.__proto__ = proto; g.data.go = go; g.data.ownv = 1;
    g.data.addProperty("own", function () { _root.called = 1; return 8; }, null);
    g.flush();
    trace(_root.called);`,
    storage,
  );
  assert.deepEqual(lines, ["46 true", "undefined"]);
  assert.deepEqual(stored.get("/C:/so-test.swf/selfq"), await fixture("self"));
  assert.deepEqual(stored.get("/C:/so-test.swf/getq"), await fixture("getters"));
  // adl's file of the second is named selfq: only its name differs.
  assert.deepEqual(
    stored.get("/C:/so-test.swf/selfq2")?.subarray(24),
    (await fixture("holes")).subarray(23),
  );

  const { lines: read } = await play(
    `var d = SharedObject.getLocal("selfq2").data;
    trace(typeof d.me + " " + d.holes.length + " " + typeof d.o.back);`,
    storage,
  );
  assert.deepEqual(read, ["undefined 5 undefined"]);
});

test("a stored file that cannot be read starts empty, and one read back runs no setter", async () => {
  const { stored, storage } = memory();
  const header = [0x00, 0xbf, 0, 0, 0, 14, 0x54, 0x43, 0x53, 0x4f, 0, 4, 0, 0, 0, 0];
  stored.set("/C:/so-test.swf/short", Uint8Array.from([...header, 0, 9, 0x61]));
  stored.set("/C:/so-test.swf/long", Uint8Array.from([...header, 0xff, 0xff, 0x61, 0x62, 0, 0]));
  // A property "__proto__" holding the number 1, then "x" holding 2.
  const proto = [
    0,
    9,
    ...new TextEncoder().encode("__proto__"),
    0,
    0x3f,
    0xf0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  stored.set(
    "/C:/so-test.swf/set",
    Uint8Array.from([
      ...header,
      0,
      3,
      0x73,
      0x65,
      0x74,
      0,
      0,
      0,
      0,
      ...proto,
      0,
      1,
      0x78,
      0,
      0x40,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]),
  );
  const { lines } = await play(
    `var out = [];
    out.push(typeof SharedObject.getLocal("short").data + SharedObject.getLocal("short").getSize());
    out.push(typeof SharedObject.getLocal("long").data);
    Object.prototype.addProperty("x", function () { return "getter"; }, function () { _root.set = 1; });
    var d = SharedObject.getLocal("set").data;
    out.push(d.x + " " + _root.set + " " + (d.__proto__ == Object.prototype));
    trace(out.join(" | "));`,
    storage,
  );
  assert.deepEqual(lines, ["object0 | object | 2 undefined true"]);
});

test("a typed object is written by the name last registered for its constructor, in its case, no getter called", async () => {
  // Up to SWF 6 the names fold for lookups, but the .sol keeps the case given (the corpus's
  // amf_swf6_case_insensitive_typed_objects writes the same names over NetConnection); a
  // __constructor__ that is a getter types nothing and is not called.
  const { stored, storage } = memory();
  const source = `function C() {} Object.registerClass("My.First", C); Object.registerClass("My.Class", C);
var d = SharedObject.getLocal("typed").data; d.p = new C();
var q = {}; q.addProperty("__constructor__", function () { trace("called"); return C; }, null); d.q = q;
trace("flush " + SharedObject.getLocal("typed").flush());`;
  const lines: string[] = [];
  const tags = [w.doAction([...script(source, 6)(flashAssembler()).end().bytes()]), w.showFrame()];
  const player = new Player(
    w.swf({ version: 6, width: 10, height: 10, frameCount: 1, tags: [...tags, w.end()] }),
    null,
    new Avm1(codegen, { print: (l) => lines.push(l), url: "file:///C:/so-test.swf", storage }),
  );
  await player.start();

  assert.deepEqual(lines, ["flush true"]);
  const text = Buffer.from([...stored.values()][0]).toString("latin1");
  assert.ok(text.includes("\x00\x01p\x10\x00\x08My.Class"), JSON.stringify(text));
  assert.ok(text.includes("\x00\x01q\x03"), JSON.stringify(text));
});
