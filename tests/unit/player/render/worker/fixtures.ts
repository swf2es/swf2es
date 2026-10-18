import assert from "node:assert/strict";
import { readSwf } from "../../../../../packages/format/dist/index.js";
import { readLibrary } from "../../../../../packages/player/dist/display/timeline.js";
import {
  readSharedLibrary,
  shareLibrary,
} from "../../../../../packages/player/dist/render/worker/libraries.js";
import { workerContentScene } from "../../../../player/worker-scene.ts";

export function library() {
  const bytes = workerContentScene();
  const source = readLibrary(readSwf(bytes));
  const bitmap = source.characters.get(9);
  assert.equal(bitmap?.type, "bitmap");
  if (bitmap?.type === "bitmap") {
    // The host's authoritative decode may differ from the browser's decoder.
    bitmap.pixels = {
      width: 3,
      height: 2,
      transparent: true,
      pixels: Uint32Array.of(0xff112233, 0x80402010, 0, 0xffffffff, 0xffaabbcc, 0xff445566),
    };
  }
  const asset = shareLibrary(bytes, source);
  return { bytes, source, asset, target: readSharedLibrary(asset) };
}
