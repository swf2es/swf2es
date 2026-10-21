// Regenerate and compare AIR-only bytecode cases with the installed SDK.
// CI plays the checked-in ABC against the recorded AIR trace instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runFlash } from "../../oracle/flash.ts";
import { readDoAbc, readSwf, tags } from "../../packages/format/dist/index.js";
import { runPlayer } from "../player/chrome.ts";
import { u30 as encodeU30 } from "../unit/codegen/abc-builder.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/air/`;
const fixture = `${here}../player/fixtures/AirFloat.abc`;
const reference = `${here}../player/references/air-float/trace.txt`;
mkdirSync(out, { recursive: true });
const compiled = spawnSync(
  "amxmlc",
  [
    "-compiler.float=true",
    "-strict=false",
    "-debug=false",
    "-omit-trace-statements=false",
    "-output",
    `${out}AirFloat.swf`,
    `${here}cases/air/AirFloat.as`,
  ],
  { encoding: "utf8" },
);
assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stdout + compiled.stderr);
const swf = new Uint8Array(readFileSync(`${out}AirFloat.swf`));
const parsed = readSwf(swf);
const tag = parsed.tags.find((tag) => tag.code === tags.DoABC2);
assert.ok(tag);
const abc = stableSourcePaths(readDoAbc(parsed.bytes, tag).abc);
const [air] = await runFlash([{ swf, frames: 2, capture: [] }]);
assert.deepEqual(air.errors, []);
assert.equal(air.incomplete, false);
if (process.argv.includes("--update")) {
  mkdirSync(`${here}../player/references/air-float/`, { recursive: true });
  writeFileSync(fixture, abc);
  writeFileSync(reference, `${air.output.join("\n")}\n`);
} else {
  assert.deepEqual(abc, new Uint8Array(readFileSync(fixture)), "regenerate with --update");
  assert.equal(`${air.output.join("\n")}\n`, readFileSync(reference, "utf8"));
}

const results = await runPlayer(
  [false, true].map((lazyCompilation) => ({
    swf,
    frames: 2,
    capture: [],
    lazyCompilation,
  })),
);
for (const result of results) {
  assert.equal(result.error, null);
  assert.deepEqual(result.trace, air.output);
}
console.log(`AIR float: ${air.output.length} lines match, eager and lazy`);

/** AIR retains source paths even with debug=false; keep the fixture independent of its checkout. */
function stableSourcePaths(abc: Uint8Array): Uint8Array {
  let at = 4;
  const readU30 = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = abc[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 128) {
        return value;
      }
    }

    throw new Error("invalid constant pool count");
  };
  for (let kind = 0; kind < 2; kind++) {
    const count = readU30();
    for (let i = 1; i < count; i++) {
      readU30();
    }
  }

  const doubles = readU30();
  at += Math.max(0, doubles - 1) * 8;
  const floats = readU30();
  at += Math.max(0, floats - 1) * 4;
  const count = readU30();
  const stringsAt = at;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const strings: number[] = [];
  for (let i = 1; i < count; i++) {
    const length = readU30();
    const text = decoder
      .decode(abc.subarray(at, at + length))
      .replaceAll(root, "/swf2es/")
      .replaceAll(root.replaceAll("\\", "/"), "/swf2es/");
    at += length;
    const bytes = encoder.encode(text);
    strings.push(...encodeU30(bytes.length), ...bytes);
  }

  return new Uint8Array([...abc.subarray(0, stringsAt), ...strings, ...abc.subarray(at)]);
}
