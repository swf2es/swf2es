// swf2es run: hand-built ABCs run after avmshell's libraries, printing and
// ending as avmshell does, which the oracle checks where it can run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { createRuntime } from "@swf2es/runtime/avm2";
import { containerEngine, runAbcs } from "../../../oracle/oracle.ts";
import { evaluateModule, runShell } from "../../../packages/cli/dist/index.js";
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

// Strings 1 "", 2 Object, 3 A, 4 m, 5 trace; namespace 1 public; multiname k
// public::string k + 1.
const SHARED_OBJECT = 1;
const SHARED_A = 2;
const SHARED_M = 3;
const SHARED_TRACE = 4;
const shared = {
  strings: ["", "Object", "A", "m", "trace"],
  namespaces: [[0x16, ...u30(1)]],
  multinames: [1, 2, 3, 4].map((k) => [0x07, ...u30(1), ...u30(k + 1)]),
};
// A slot named m, or setter 4, then method 3, which returns 42, of that name.
const SHARED_METHOD = { name: SHARED_M, kind: 1, index: 3 };
const SHARED_TRAITS = [{ name: SHARED_M, kind: 0 }, SHARED_METHOD];
const SHARED_SETTER = [{ name: SHARED_M, kind: 3, index: 4 }, SHARED_METHOD];
/** findpropstrict trace, `value`, callpropvoid trace 1. */
const traced = (value: number[]) => [0x5d, SHARED_TRACE, ...value, 0x4f, SHARED_TRACE, 1];

/**
 * Class A with SHARED_TRAITS where `on` says (its instances', its own or
 * its script's), or SHARED_SETTER its instances', whose script defines A,
 * then runs `code`. A's instance initializer sets its slot 1 to 7.
 */
function sharedName(on: "instance" | "static" | "script" | "setter", code: number[]): Uint8Array {
  const traits = (where: string) =>
    on === where ? SHARED_TRAITS : on === "setter" && where === "instance" ? SHARED_SETTER : [];
  // As ASC: newclass 0 with Object on the scope chain, then initproperty A.
  const define = [0xd0, 0x30, 0xd0, 0x60, SHARED_OBJECT, 0x30, 0x60, SHARED_OBJECT, 0x58, 0];
  define.push(0x1d, 0x68, SHARED_A);
  // getlocal0, pushbyte 7, setslot 1.
  const setSlot = on === "instance" ? [0xd0, 0x24, 7, 0x6d, 1] : [];

  return abc(
    shared,
    tables({
      methods: [{}, {}, {}, {}, { params: [0] }],
      classes: [
        {
          instance: {
            name: SHARED_A,
            base: SHARED_OBJECT,
            init: 0,
            traits: traits("instance"),
          },
          init: 1,
          traits: traits("static"),
        },
      ],
      scripts: [{ init: 2, traits: [{ name: SHARED_A, kind: 4, index: 0 }, ...traits("script")] }],
      bodies: [
        {
          method: 0,
          maxStack: 2,
          initScopeDepth: 2,
          maxScopeDepth: 3,
          // getlocal0, pushscope, getlocal0, constructsuper 0, then the slot set.
          code: [0xd0, 0x30, 0xd0, 0x49, 0, ...setSlot, RETURNVOID],
        },
        { method: 1, initScopeDepth: 2, maxScopeDepth: 3 },
        {
          method: 2,
          maxStack: 4,
          localCount: 2,
          maxScopeDepth: 2,
          code: [...define, ...code, RETURNVOID],
        },
        // pushbyte 42, returnvalue.
        { method: 3, code: [0x24, 42, 0x48] },
        { method: 4, localCount: 2 },
      ],
    }),
  );
}

// Each traces typeof m, m(), and the slot's value where there is one; the
// instance's then set m, which is a method's name.
const sharedNames = {
  instance: sharedName("instance", [
    ...[0x60, SHARED_A, 0x42, 0, 0xd5],
    ...traced([0xd1, 0x66, SHARED_M, 0x95]),
    ...traced([0xd1, 0x46, SHARED_M, 0]),
    ...traced([0xd1, 0x6c, 1]),
    ...[0xd1, 0x24, 5, 0x61, SHARED_M],
  ]),
  static: sharedName("static", [
    ...traced([0x60, SHARED_A, 0x66, SHARED_M, 0x95]),
    ...traced([0x60, SHARED_A, 0x46, SHARED_M, 0]),
  ]),
  setter: sharedName("setter", [
    ...[0x60, SHARED_A, 0x42, 0, 0xd5],
    ...traced([0xd1, 0x66, SHARED_M, 0x95]),
    ...traced([0xd1, 0x46, SHARED_M, 0]),
    ...[0xd1, 0x24, 5, 0x61, SHARED_M],
  ]),
  script: sharedName("script", [
    ...traced([0x60, SHARED_M, 0x95]),
    ...traced([0x5d, SHARED_M, 0x46, SHARED_M, 0]),
    ...traced([0xd0, 0x6c, 2]),
  ]),
};

test("a method that takes a slot's or a setter's name has it, as in avmshell", {
  skip,
}, () => {
  const expected = {
    instance: [1, "function\n42\n7\nReferenceError: Error #1037\n"],
    static: [0, "function\n42\n"],
    setter: [1, "function\n42\nReferenceError: Error #1037\n"],
    script: [0, "function\n42\nundefined\n"],
  };
  const names = Object.keys(sharedNames) as (keyof typeof sharedNames)[];
  for (const name of names) {
    const r = swf2es(write(`shared-${name}.abc`, sharedNames[name]));
    assert.deepEqual([r.status, r.stdout], expected[name], `${name}: ${r.stderr}`);
  }

  if (noOracle) {
    return;
  }

  const avmshell = runAbcs(
    names.map((n) => sharedNames[n]),
    `${out}shared-oracle`,
  );
  for (const [i, name] of names.entries()) {
    assert.deepEqual([avmshell[i].exitCode, avmshell[i].output], expected[name], name);
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

// root reads every file, so an unreadable one cannot be made.
const asRoot = process.getuid?.() === 0 && "running as root";

test("run's File cannot open what it cannot read, as avmshell's", { skip: skip || asRoot }, () => {
  // Strings 1 avmplus, 2 File, 3 read, 4 secret, 5 "". Namespaces 1 avmplus, 2 public.
  // Multinames 1 avmplus::File, 2 read. getlex File, pushstring "secret", callpropvoid read 1.
  const readSecret = abc(
    {
      strings: ["avmplus", "File", "read", "secret", ""],
      namespaces: [
        [0x16, ...u30(1)],
        [0x16, ...u30(5)],
      ],
      multinames: [
        [0x07, ...u30(1), ...u30(2)],
        [0x07, ...u30(2), ...u30(3)],
      ],
    },
    tables({
      methods: [{}],
      scripts: [{ init: 0 }],
      bodies: [
        {
          method: 0,
          code: [0xd0, 0x30, 0x60, 1, 0x2c, 4, 0x4f, 2, 1, RETURNVOID],
          maxStack: 2,
          maxScopeDepth: 2,
        },
      ],
    }),
  );
  const file = write("read-secret.abc", readSecret);
  const dir = `${out}unreadable/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}secret`, "hidden");
  chmodSync(`${dir}secret`, 0);
  try {
    const r = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8", cwd: dir });
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "Error: Error #1500\n", ""]);
  } finally {
    chmodSync(`${dir}secret`, 0o644);
  }
});

test("run runs ABCs at the version --api names", { skip }, () => {
  // Strings 1 trace, 2 "", 3 avmplus, 4 System, 5 apiVersion; namespaces 1
  // public, 2 avmplus; multinames 1 trace, 2 avmplus::System, 3 apiVersion.
  const traceVersion = abc(
    {
      strings: ["trace", "", "avmplus", "System", "apiVersion"],
      namespaces: [
        [0x16, ...u30(2)],
        [0x16, ...u30(3)],
      ],
      multinames: [
        [0x07, ...u30(1), ...u30(1)],
        [0x07, ...u30(2), ...u30(4)],
        [0x07, ...u30(1), ...u30(5)],
      ],
    },
    tables({
      methods: [{}],
      scripts: [{ init: 0 }],
      bodies: [
        {
          method: 0,
          // findpropstrict trace, getlex System, getproperty apiVersion, callpropvoid trace 1.
          code: [0xd0, 0x30, 0x5d, 1, 0x60, 2, 0x66, 3, 0x4f, 1, 1, RETURNVOID],
          maxStack: 3,
          maxScopeDepth: 2,
        },
      ],
    }),
  );
  const file = write("version.abc", traceVersion);
  const outputs = [[], ["--api", "latest"], ["--api", "12"], ["--api", "9"]].map((args) => {
    const r = swf2es(file, ...args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.deepEqual(outputs, ["50\n", "50\n", "12\n", "0\n"]);

  // A root's version is a SWF's, which an ABC has none of.
  const root = swf2es(file, "--api", "root");
  assert.equal(root.status, 2);
  assert.match(root.stderr, /--api takes latest or a SWF version, not "root"/);
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

test("run evaluates a module strict, as a module is", () => {
  // A sloppy function would see the string it is called on boxed, an object.
  const kind = evaluateModule(
    'export default (function () { return typeof this; }).call("s");',
    "strict.js",
  );
  assert.equal(kind, "string");
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
