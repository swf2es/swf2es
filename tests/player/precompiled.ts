// Modules compiled ahead of time in Chrome: a SWF compiled by the swf2es
// command, its libraries with it, plays from them through
// player-hosts/precompiled with nothing compiled, evaluated or imported;
// and imported, on a page whose Content-Security-Policy has no
// 'unsafe-eval', where evaluating them fails. The keys and fallbacks are
// tested in node (tests/unit/player-hosts/precompiled.test.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "./cases.ts";
import { playPrecompiled } from "./chrome.ts";
import { libraryAbcs, libraryFiles } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";
import { importMapSource } from "./serve.ts";

const out = fileURLToPath(new URL("out/precompiled/", import.meta.url));
const libraries = fileURLToPath(new URL("out/libraries/", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/main.js", import.meta.url));

libraryAbcs();
const methods = Array.from(
  { length: 50 },
  (_, i) => `public function m${i}(x:Number):Number { return x * ${i}; }`,
);
const source = `package { import flash.display.Sprite; public class AotCsp extends Sprite {
  public function AotCsp() {
    graphics.beginFill(0xff0000);
    graphics.drawRect(10, 10, 30, 20);
    trace("AotCsp", m2(3));
    addEventListener("enterFrame", function (e:*):void { trace("frame", m3(2)); });
  }
  ${methods.join("\n  ")}
} }`;
const abc = compileScripts([{ name: "AotCsp", source }]).get("AotCsp") as Uint8Array;
const swf = bare(abc, 3, "AotCsp");
mkdirSync(out, { recursive: true });
writeFileSync(`${out}AotCsp.swf`, swf);
const dir = `${out}AotCsp/`;
const compiled = spawnSync(
  process.execPath,
  [
    cli,
    `${out}AotCsp.swf`,
    "-o",
    dir,
    "--emit-libraries",
    "-q",
    ...libraryFiles(libraries).flatMap((file) => ["--lib", file]),
  ],
  { encoding: "utf8" },
);
assert.equal(compiled.status, 0, compiled.stderr);

// No 'unsafe-eval': WebAssembly may compile, codegen still replays the
// modules' logs, and the page's own import map is allowed by its hash.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${importMapSource}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
].join("; ");
const expected = ["AotCsp 6", "frame 6", "frame 6"];

const evaluated = await playPrecompiled(swf, dir, false, 3);
assert.equal(evaluated.error, null);
assert.equal(evaluated.evalRefused, false);
assert.equal(evaluated.compiled, 0);
assert.deepEqual(evaluated.trace, expected);
assert.ok(evaluated.image);

const imported = await playPrecompiled(swf, dir, true, 3, csp);
assert.equal(imported.error, null);
assert.equal(imported.evalRefused, true);
assert.equal(imported.compiled, 0);
assert.deepEqual(imported.trace, expected);
assert.equal(imported.image, evaluated.image);

// AIR's supplemental builtin must be loaded in the same order by JIT and AOT.
const floatAbc = new Uint8Array(readFileSync(new URL("fixtures/AirFloat.abc", import.meta.url)));
const floatSwf = bare(floatAbc, 2, "AirFloat");
writeFileSync(`${out}AirFloat.swf`, floatSwf);
const floatDir = `${out}AirFloat/`;
const floatCompiled = spawnSync(
  process.execPath,
  [
    cli,
    `${out}AirFloat.swf`,
    "-o",
    floatDir,
    "--emit-libraries",
    "-q",
    ...libraryFiles(libraries).flatMap((file) => ["--lib", file]),
  ],
  { encoding: "utf8" },
);
assert.equal(floatCompiled.status, 0, floatCompiled.stderr);
const floatResult = await playPrecompiled(floatSwf, floatDir, true, 2, csp);
assert.equal(floatResult.error, null);
assert.equal(floatResult.compiled, 0);
assert.deepEqual(
  floatResult.trace,
  readFileSync(new URL("references/air-float/trace.txt", import.meta.url), "utf8")
    .trimEnd()
    .split("\n"),
);

// Evaluated under that policy, a module is refused, and so is its compile.
const refused = await playPrecompiled(swf, dir, false, 3, csp);
assert.match(refused.error ?? "", /EvalError/);
console.log("precompiled modules: ok");
