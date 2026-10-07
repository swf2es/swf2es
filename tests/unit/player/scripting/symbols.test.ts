// What SymbolClass binds and the libraries share: a sound's decode, made
// on first play and shared by the identical sounds of every library alive.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createCodegen } from "@swf2es/codegen";
import { readSwf, type Sound, tags } from "../../../../packages/format/dist/index.js";
import {
  readLibrary,
  type SoundCharacter,
} from "../../../../packages/player/dist/display/timeline.js";
import type { DecodedSound } from "../../../../packages/player/dist/media/audio.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { BitWriter, end, showFrame, swf, tag } from "../../../swf-writer.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

test("identical sounds in separate SWF libraries share one decode per player", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const clip: DecodedSound = { durationMs: 1000, play: () => null };
  let decodes = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: {
      async decode() {
        decodes++;
        return clip;
      },
    },
  });
  const definition: Sound = {
    id: 1,
    format: 2,
    sampleRate: 11025,
    sampleSize: 16,
    channels: 1,
    sampleCount: 11025,
    seekSamples: 0,
    data: new Uint8Array([1, 2, 3]),
  };
  const first: SoundCharacter = { type: "sound", id: 1, definition };
  const second: SoundCharacter = {
    type: "sound",
    id: 8,
    definition: { ...definition, id: 8, data: definition.data.slice() },
  };
  assert.equal(await scripting.symbols.soundClip(first), clip);
  assert.equal(await scripting.symbols.soundClip(second), clip);
  assert.equal(decodes, 1);

  const changed: SoundCharacter = {
    type: "sound",
    id: 9,
    definition: { ...definition, data: new Uint8Array([1, 2, 4]) },
  };
  await scripting.symbols.soundClip(changed);
  assert.equal(decodes, 2);
});

test("a live sound keeps its decoded audio across garbage collection", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  let decodes = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: {
      async decode() {
        decodes++;
        return { durationMs: 1000, play: () => null };
      },
    },
  });
  const character: SoundCharacter = {
    type: "sound",
    id: 1,
    definition: {
      id: 1,
      format: 2,
      sampleRate: 11025,
      sampleSize: 16,
      channels: 1,
      sampleCount: 11025,
      seekSamples: 0,
      data: new Uint8Array([1, 2, 3]),
    },
  };

  await scripting.symbols.soundClip(character);
  // The decoded clip's first promise must have settled before collection.
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  await scripting.symbols.soundClip(character);
  assert.equal(decodes, 1);
});

test("a SWF with an unused embedded sound starts without decoding it", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  let decodes = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: {
      async decode() {
        decodes++;
        return { durationMs: 1000, play: () => null };
      },
    },
  });
  const definition = new BitWriter()
    .u16(1)
    .u8(1 << 2)
    .u32(1)
    .raw([128])
    .done();
  const movie = readSwf(
    swf({
      width: 1,
      height: 1,
      frameRate: 24,
      frameCount: 1,
      tags: [tag(tags.DefineSound, definition), showFrame(), end()],
    }),
  );
  const library = readLibrary(movie);
  await scripting.loadSwf(movie, library);
  assert.equal(decodes, 0);

  const character = library.characters.get(1);
  assert.equal(character?.type, "sound");
  await scripting.symbols.soundClip(character as SoundCharacter);
  assert.equal(decodes, 1);
});
