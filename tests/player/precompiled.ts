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

/** `name`'s source compiled, its SWF of `frames` frames, and the swf2es command's modules of it. */
function precompile(name: string, body: string, frames: number): { swf: Uint8Array; dir: string } {
  const abc = compileScripts([{ name, source: body }]).get(name) as Uint8Array;
  const bytes = bare(abc, frames, name);
  writeFileSync(`${out}${name}.swf`, bytes);
  const into = `${out}${name}/`;
  const command = spawnSync(
    process.execPath,
    [
      cli,
      `${out}${name}.swf`,
      "-o",
      into,
      "--emit-libraries",
      "-q",
      ...libraryFiles(libraries).flatMap((file) => ["--lib", file]),
    ],
    { encoding: "utf8" },
  );
  assert.equal(command.status, 0, command.stderr);
  return { swf: bytes, dir: into };
}

/**
 * A SWF whose primordial starts a worker on `bytes`, an expression of its
 * own SWF's bytes, `loaderInfo.bytes` or another ByteArray.
 */
const workerSource = (name: string, bytes: string) => `package {
import flash.display.Sprite; import flash.system.*; import flash.utils.ByteArray;
public class ${name} extends Sprite {
  public function ${name}() {
    if (Worker.current.isPrimordial) {
      trace("primordial", m(2));
      WorkerDomain.current.createWorker(${bytes}).start();
    } else {
      trace("background", m(4), "zzmark");
    }
  }
  public function m(x:int):int { return x * 5; }
  public function patched():ByteArray {
    var b:ByteArray = new ByteArray();
    b.writeBytes(loaderInfo.bytes);
    for (var i:int = 0; i < b.length - 6; i++) {
      if (b[i] == 0x7a && b[i + 1] == 0x7a && b[i + 2] == 0x6d && b[i + 5] == 0x6b) {
        b[i + 5] = 0x4b;
      }
    }
    return b;
  }
} }`;

// A background worker on the same SWF, under that policy, its script
// served with it too: it imports the modules the primordial imported, and
// would fail to compile any of its own.
const same = precompile("AotWorker", workerSource("AotWorker", "loaderInfo.bytes"), 3);
const workerRun = await playPrecompiled(same.swf, same.dir, true, 3, csp);
assert.equal(workerRun.error, null);
assert.equal(workerRun.evalRefused, true);
assert.equal(workerRun.compiled, 0);
assert.deepEqual(workerRun.trace, ["primordial 10", "background 20 zzmark"]);

// One on an ABC the primordial did not compile, a string of its changed,
// compiles it, which the policy refuses in the worker.
const other = precompile("AotWorkerOther", workerSource("AotWorkerOther", "patched()"), 3);
const otherRun = await playPrecompiled(other.swf, other.dir, true, 3, csp);
assert.match(otherRun.error ?? "", /a background worker: EvalError/);
assert.deepEqual(otherRun.trace, ["primordial 10"]);

// Evaluated under that policy, a module is refused, and so is its compile.
const refused = await playPrecompiled(swf, dir, false, 3, csp);
assert.match(refused.error ?? "", /EvalError/);
console.log("precompiled modules: ok");
