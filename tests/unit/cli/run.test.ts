// swf2es run: hand-built ABCs run after avmshell's libraries, printing and
// ending as avmshell does, which the oracle checks where it can run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { createRuntime } from "@swf2es/runtime/avm2";
import { containerEngine, runAbcs } from "../../../oracle/oracle.ts";
import { runShell } from "../../../packages/cli/dist/index.js";
import * as w from "../../swf-writer.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const out = fileURLToPath(new URL("../out/cli/run/", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/dist/main.js", import.meta.url));
const generated = fileURLToPath(new URL("../../../oracle/avmplus/generated/", import.meta.url));
const skip = !existsSync(`${generated}builtin.abc`) && "oracle/avmplus missing";

let noOracle: string | false = false;
try {
  containerEngine();
} catch (e) {
  noOracle = (e as Error).message;
}

// Strings 1 trace, 2 "", 3 hello, 4 boom. Namespace 1 public. Multiname 1 trace.
const pool = {
  strings: ["trace", "", "hello", "boom"],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [[0x07, ...u30(1), ...u30(1)]],
};

/** An ABC whose script initializer is `code`, after getlocal0 and pushscope. */
const script = (code: number[]) =>
  abc(
    pool,
    tables({
      methods: [{}],
      scripts: [{ init: 0 }],
      bodies: [{ method: 0, code: [0xd0, 0x30, ...code], maxStack: 2, maxScopeDepth: 2 }],
    }),
  );

// findpropstrict trace, pushstring "hello", callpropvoid trace 1.
const TRACE_HELLO = [0x5d, 1, 0x2c, 3, 0x4f, 1, 1];
const RETURNVOID = 0x47;
// pushstring "boom", throw.
const THROW_BOOM = [0x2c, 4, 0x03];

const abcs = {
  hello: script([...TRACE_HELLO, RETURNVOID]),
  throws: script([...TRACE_HELLO, ...THROW_BOOM]),
  // A constant pool cut short in its first count: avmplus rejects the ABC.
  corrupt: new Uint8Array([16, 0, 46, 0, 255]),
};

function write(name: string, bytes: Uint8Array): string {
  mkdirSync(out, { recursive: true });
  writeFileSync(out + name, bytes);
  return out + name;
}

function swf2es(...args: string[]) {
  return spawnSync(process.execPath, [cli, "run", ...args], { encoding: "utf8" });
}

test("run prints what an ABC traces, and the exception nothing caught", { skip }, () => {
  const hello = swf2es(write("hello.abc", abcs.hello));
  assert.deepEqual([hello.status, hello.stdout, hello.stderr], [0, "hello\n", ""]);

  const throws = swf2es(write("throws.abc", abcs.throws));
  assert.deepEqual([throws.status, throws.stdout, throws.stderr], [1, "hello\nboom\n", ""]);

  const corrupt = swf2es(write("corrupt.abc", abcs.corrupt));
  assert.deepEqual([corrupt.status, corrupt.stdout], [1, "VerifyError: Error #1107\n"]);
});

test("run runs its ABCs in order, until one throws", { skip }, () => {
  const [hello, throws] = [write("hello.abc", abcs.hello), write("throws.abc", abcs.throws)];
  const r = swf2es(hello, hello, throws, hello);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "hello\nhello\nhello\nboom\n");
});

test("run ends as avmshell does", { skip: skip || noOracle }, () => {
  const names = Object.keys(abcs) as (keyof typeof abcs)[];
  const avmshell = runAbcs(
    names.map((n) => abcs[n]),
    `${out}oracle`,
  );
  for (const [i, name] of names.entries()) {
    const r = swf2es(write(`${name}.abc`, abcs[name]));
    assert.deepEqual([r.status, r.stdout], [avmshell[i].exitCode, avmshell[i].output], name);
  }
});

test("run takes the libraries --lib names, in their place", { skip }, () => {
  const hello = write("hello.abc", abcs.hello);
  // trace is shell_toplevel's: without it, the name is not found.
  const builtin = swf2es(hello, "--lib", `${generated}builtin.abc`);
  assert.deepEqual([builtin.status, builtin.stdout], [1, "ReferenceError: Error #1065\n"]);
  const libs = ["builtin", "shell_toplevel"].flatMap((n) => ["--lib", `${generated}${n}.abc`]);
  const both = swf2es(hello, ...libs);
  assert.deepEqual([both.status, both.stdout], [0, "hello\n"]);

  const missing = swf2es(hello, "--lib", `${out}missing.abc`);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read library .*missing\.abc: ENOENT/);

  const rejected = swf2es(hello, "--lib", write("corrupt.abc", abcs.corrupt));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /^swf2es: error: library corrupt was rejected: VerifyError #1107/);
});

test("run refuses what is not an ABC", () => {
  const swf = w.swf({
    width: 10,
    height: 10,
    frameRate: 24,
    frameCount: 1,
    tags: [w.fileAttributes(true), w.doAbc(abcs.hello, "A"), w.showFrame(), w.end()],
  });
  const refused = (file: string, message: RegExp) => {
    const r = swf2es(file);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, message);
  };

  refused(write("a.swf", swf), /a\.swf: a SWF; run takes ABCs/);
  refused(write("text.abc", new TextEncoder().encode("trace(1)")), /neither a SWF nor an ABC/);
});

test("runShell runs ABCs for a host, with the release codegen", { skip }, async () => {
  const wasm = readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
  const compiler = await createCodegen(await WebAssembly.compile(wasm));
  const libraries = ["builtin", "shell_toplevel"].map((name) => ({
    name,
    abc: new Uint8Array(readFileSync(`${generated}${name}.abc`)),
  }));
  const lines: string[] = [];
  const run = (...names: (keyof typeof abcs)[]) =>
    runShell(
      libraries,
      names.map((name) => ({ name, abc: abcs[name] })),
      { compiler, createRuntime, print: (line) => lines.push(line) },
    );

  assert.equal(await run("hello", "throws", "hello"), 1);
  assert.deepEqual(lines.splice(0), ["hello", "hello", "boom"]);
  assert.equal(await run("hello"), 0);
  assert.deepEqual(lines, ["hello"]);
});
