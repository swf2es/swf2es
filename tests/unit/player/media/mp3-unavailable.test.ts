// An engine that cannot compile the MP3 decoder, such as one without wasm
// SIMD: node runs each test file in a process of its own, and this one's
// WebAssembly.compile rejects that module alone.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { binary } from "../../../../packages/mp3/dist/binary.js";
import { mp3Available } from "../../../../packages/mp3/dist/index.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const mp3Length = atob(binary).length;
const compile = WebAssembly.compile;
WebAssembly.compile = (bytes: BufferSource) =>
  bytes.byteLength === mp3Length
    ? Promise.reject(new WebAssembly.CompileError("SIMD unsupported"))
    : compile(bytes);

const out = fileURLToPath(new URL("../../out/mp3-unavailable/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("without the MP3 decoder a SWF still loads and extract writes no samples", async () => {
  const abc = compiler(out)(
    "NoMp3Root",
    "package { import flash.display.Sprite; public class NoMp3Root extends Sprite {} }",
  );
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    audio: null,
    onUncaught: (error) => errors.push(error),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  assert.equal(mp3Available(), false);

  const player = new Player(bare(abc, 1, "NoMp3Root"), s);
  await player.start();
  try {
    const rt = s.rt;
    const call = (o: avm2.AsObject, name: string, ...args: avm2.Value[]) =>
      rt.callProperty(o, rt.publicName(name), ...args);
    const sound = rt.construct(rt.classNamed("flash.media::Sound"));
    const source = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    const bytes = avm2.bytesOf(rt, source);
    bytes.write(
      new Uint8Array(await readFile(new URL("../../../player/sounds/tone.mp3", import.meta.url))),
    );
    bytes.position = 0;
    call(sound, "loadCompressedDataFromByteArray", source, bytes.length);
    const target = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    assert.equal(call(sound, "extract", target, 100000), 0);
    assert.equal(avm2.bytesOf(rt, target).length, 0);
    assert.deepEqual(errors, []);
  } finally {
    player.destroy();
    s.destroy();
  }
});
