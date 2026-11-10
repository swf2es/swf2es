import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import {
  remoteArguments,
  remoteMessages,
  remotePacket,
  remoteValue,
} from "../../../../../../packages/player/dist/playerglobal/flash/net/remoting.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../../../player/libraries.ts";

const out = fileURLToPath(new URL("../../../../out/player-remoting/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

async function runtime() {
  const scripting = new Scripting(await createCodegen(wasm));
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  return scripting.rt;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// What adl POSTed for two calls of one frame, each packet as it sent it:
// call("svc.a", r, ...) with a header H of {x: 1}, then call("svc.b", r, ...).
const ADL_AMF0 =
  "00000001000148000000001003000178003ff0000000000000000009000200057376632e6100022f3100" +
  "00003e0a0000000602000173003ff80000000000000101030001730200067368617265640000090a0000" +
  "0003003ff000000000000002000374776f07000007000000057376632e6200022f32000000050a00000000";
const ADL_AMF3 =
  "000300010001480100000009110a0b010378040101000200057376632e6100022f31000000490a000000" +
  "0a02000173003ff800000000000000401c0000000000000101110a0b010373060d736861726564011109" +
  "07010401060774776f0a00110a000506110801000000000000000000057376632e6200022f3200000009" +
  "0a0000000102000173";

test("a remoting packet in AMF0 is adl's: the arguments' first object is reference 0", async () => {
  const rt = await runtime();
  const shared = rt.newObject(["s", "shared"]);
  const list = rt.newArray([1, "two", shared]);
  const header = {
    name: "H",
    mustUnderstand: false,
    value: remoteValue(rt, rt.newObject(["x", 1]), 0),
  };
  const packet = remotePacket(
    0,
    [header],
    [
      {
        method: "svc.a",
        id: 1,
        body: remoteArguments(rt, ["s", 1.5, true, shared, list, shared], 0),
      },
      { method: "svc.b", id: 2, body: remoteArguments(rt, [], 0) },
    ],
  );
  assert.equal(hex(packet), ADL_AMF0);
});

test("a remoting packet in AMF3 is adl's: primitives in AMF0, the rest after 0x11 in shared tables", async () => {
  const rt = await runtime();
  const shared = rt.newObject(["s", "shared"]);
  const list = rt.newArray([1, "two", shared]);
  const date = rt.construct(rt.classNamed("Date"), 0);
  const header = {
    name: "H",
    mustUnderstand: true,
    value: remoteValue(rt, rt.newObject(["x", 1]), 3),
  };
  const packet = remotePacket(
    3,
    [header],
    [
      {
        method: "svc.a",
        id: 1,
        body: remoteArguments(
          rt,
          ["s", 1.5, 7, true, shared, list, shared, null, undefined, date],
          3,
        ),
      },
      { method: "svc.b", id: 2, body: remoteArguments(rt, ["s"], 3) },
    ],
  );
  assert.equal(hex(packet), ADL_AMF3);
});

test("an answer's messages are read in either encoding; anything else is a bad version", async () => {
  const rt = await runtime();
  // Version 3, no headers, an AMF3 string and an AMF3 object {a: 1, b: "x"}, each after 0x11,
  // as the gateway that adl read them from answered.
  const answer = Buffer.from(
    "000300000002000b2f312f6f6e526573756c7400046e756c6c0000000611060" +
      "76f6b33000b2f322f6f6e526573756c7400046e756c6c0000000e110a0b01036104010" +
      "36206037801",
    "hex",
  );
  const messages = remoteMessages(rt, new Uint8Array(answer));
  assert.ok(messages !== "version");
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map(([target]) => target),
    ["/1/onResult", "/2/onResult"],
  );
  assert.equal(messages[0][1], "ok3");
  const object = messages[1][1] as Parameters<typeof rt.getProperty>[0];
  assert.equal(rt.getProperty(object, rt.publicName("a")), 1);
  assert.equal(rt.getProperty(object, rt.publicName("b")), "x");

  assert.equal(remoteMessages(rt, new TextEncoder().encode("not amf")), "version");
  assert.equal(remoteMessages(rt, Uint8Array.of(0, 0, 0)), "version");
});
