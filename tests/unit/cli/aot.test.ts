// The JIT/AOT invariant end to end: the swf2es command's modules, byte for
// byte what the player compiles in the browser for the same SWF, here its
// own compile path (Code.link) run in node with the release codegen.wasm.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Codegen, createCodegen } from "@swf2es/codegen";
import { readSwf } from "@swf2es/format";
import { containerEngine, libraries, runOracle } from "../../../oracle/oracle.ts";
import type { Library } from "../../../packages/player/dist/display/timeline.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { cases, scripted } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compileScripts } from "../../player/scripts.ts";
import * as w from "../../swf-writer.ts";

const out = fileURLToPath(new URL("../out/cli/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/dist/main.js", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

function swf2es(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

/** The modules the player compiles for `swf` as its main movie: the libraries' first. */
async function playerModules(swf: Uint8Array, libs: Uint8Array[]): Promise<string[]> {
  const modules: string[] = [];
  const codegen = await createCodegen(wasm);
  const recording: Codegen = Object.create(codegen);
  recording.compileModule = (hashes, index) => {
    const module = codegen.compileModule(hashes, index);
    modules.push(module);
    return module;
  };

  const scripting = new Scripting(recording);
  await scripting.loadLibraries(libs);
  await scripting.code.link(readSwf(swf), scripting.mainDomain, "", {} as Library);
  return modules;
}

/** The command's modules for the file at `path`, the libraries' first, as manifest.json lists them. */
function cliModules(path: string, libs: string[], name: string): Buffer[] {
  const dir = `${out}aot/${name}/`;
  const r = swf2es(path, "-o", dir, "--emit-libraries", "-q", ...libs.flatMap((l) => ["--lib", l]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8"));
  const files = [...manifest.libraries, ...manifest.abcs].map((e: { module: string }) => e.module);
  return files.map((f) => readFileSync(dir + f));
}

function assertSame(cliOut: Buffer[], player: string[]): void {
  assert.equal(cliOut.length, player.length);
  for (const [i, module] of player.entries()) {
    assert.ok(cliOut[i].equals(Buffer.from(module)), `module ${i} differs`);
  }
}

test("the command's modules are the player's for its cases' SWFs", { skip }, async () => {
  const libs = libraryAbcs(`${out}libraries/`);
  const libPaths = ["builtin", "playerglobal"].map((n) => `${out}libraries/${n}.abc`);
  const picked = ["scripted", "events", "init", "goto-children"];
  const chosen = cases.filter((c) => picked.includes(c.name));
  assert.equal(chosen.length, picked.length);
  const abcs = compileScripts(
    chosen.map((c) => c.script as string),
    `${out}scripts`,
  );
  const swfs = chosen.map((c) => ({
    name: c.name,
    swf: (c.swf as (abc: Uint8Array) => Uint8Array)(abcs.get(c.script as string) as Uint8Array),
  }));
  // Two DoABC2s, the second lazy: both added before either compiles.
  swfs.push({
    name: "two-abcs",
    swf: w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.doAbc(abcs.get("Main") as Uint8Array, "Main"),
        w.doAbc(abcs.get("Events") as Uint8Array, "Events", true),
        w.showFrame(),
        w.end(),
      ],
    }),
  });

  mkdirSync(`${out}swfs`, { recursive: true });
  for (const { name, swf } of swfs) {
    const path = `${out}swfs/${name}.swf`;
    writeFileSync(path, swf);
    assertSame(cliModules(path, libPaths, name), await playerModules(swf, libs));
  }
});

test("the command's modules are the player's for as3pb's ABC", { skip }, async () => {
  // avmshell's libraries, which as3pb's code links against.
  const libs = libraries(["builtin", "shell_toplevel"], `${out}shell/`).map((l) => l.abc);
  const libPaths = ["builtin", "shell_toplevel"].map((n) => `${out}shell/${n}.abc`);
  const dir = `${root}tests/programs/as3pb/`;
  const sources = readFileSync(`${dir}runtime/test/bench/shell-sources.txt`, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  const [result] = runOracle(
    [
      {
        source: `${dir}runtime/test/bench/ShellMain.as`,
        name: "as3pb/ShellMain",
        ascArgs: [
          "-AS3",
          "-optimize",
          "-inline",
          "-strict",
          ...sources.flatMap((s) => ["-in", relative(root, `${dir}${s}`)]),
        ],
      },
    ],
    out,
    { run: false },
  );
  assert.ok(result.compiled, result.compileLog);

  // A bare ABC to the command; to the player, the same ABC in a SWF's one DoABC.
  const path = `${out}as3pb/ShellMain.abc`;
  const abc = new Uint8Array(readFileSync(path));
  assertSame(cliModules(path, libPaths, "as3pb"), await playerModules(scripted(abc), libs));
});

test("the command explains what it cannot do", () => {
  mkdirSync(out, { recursive: true });
  const none = swf2es();
  assert.equal(none.status, 2);
  assert.match(none.stderr, /expected one input file/);

  const help = swf2es("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: swf2es/);

  const missing = swf2es(`${out}missing.swf`, "--lib", `${out}missing.abc`);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read input .*missing\.swf: ENOENT/);

  const unknown = swf2es("--frobnicate");
  assert.equal(unknown.status, 2);

  // No DoABC: nothing to compile, said so rather than an empty manifest.
  const empty = `${out}empty.swf`;
  writeFileSync(
    empty,
    w.swf({ width: 10, height: 10, frameRate: 24, frameCount: 1, tags: [w.showFrame(), w.end()] }),
  );
  const noAbc = swf2es(empty, "--lib", empty);
  assert.equal(noAbc.status, 1);
  assert.match(noAbc.stderr, /no DoABC or DoABC2 tag/);
});
