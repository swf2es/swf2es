// Every module codegen writes is ASCII: a character past ASCII, in a string
// constant, a name or a path, is a \u escape (zig/src/output.zig), so that
// the engine keeps a module's source a byte a character. One character past
// U+00FF anywhere in a module made V8 keep all of it two bytes a character.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import {
  airLibrary,
  builtinLibrary,
  playerglobalLibrary,
} from "../../../packages/player/dist/playerglobal/libraries.js";
import { abc, tables, u30 } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

const wasmPath = fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"));
const module = await WebAssembly.compile(await readFile(wasmPath));

/** That `text`, as the host decodes it from codegen's bytes, has none past ASCII. */
function assertAscii(text: string, what: string): void {
  let at = 0;
  while (at < text.length && text.charCodeAt(at) < 0x80) {
    at++;
  }

  if (at === text.length) {
    return;
  }

  assert.fail(
    `${what}: U+${text.charCodeAt(at).toString(16)} at ${at}, ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 40))}`,
  );
}

/** That no byte of `bytes` is past ASCII. */
function assertAsciiBytes(bytes: Uint8Array, what: string): void {
  const at = bytes.findIndex((b) => b >= 0x80);
  assert.equal(at, -1, `${what}: byte ${bytes[at]} at ${at}`);
}

test("the libraries' modules, source maps and methods compiled alone are ASCII", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  for (const [name, library] of [
    ["builtin", builtinLibrary],
    ["playerglobal", playerglobalLibrary],
    ["AIR", airLibrary],
  ] as const) {
    assert.equal(codegen.add(library, true), 0);
    const { module, sourceMap, entries } = codegen.compile();
    assertAscii(module, name);
    assertAscii(sourceMap, `${name}'s source map`);
    for (const [body, entry] of entries) {
      assertAscii(entry, `${name}'s body ${body}`);
    }
  }
});

// What avmplus reads from these 11 bytes, which are not well-formed UTF-8
// (tests/conformance/cases/pool-strings.as): a, a 4-byte sequence cut
// short, b, a surrogate, c, an overlong 2-byte form.
const ILL_FORMED = [0x61, 0xf0, 0x9f, 0x98, 0x62, 0xed, 0xa0, 0x80, 0x63, 0xc0, 0xaf];
const READ = "a\u00f0\u009f\u0098b\ud800c\u00c0\u00af";
const PLACEHOLDER = "PLACEHOLDER";
const NO_BODY = "ƒ\u{1f600}\uf700";
const CONSTANT = 'é€ 日本 \u{1f600} \u2028\u2029"\\ \uf8ff';

/**
 * A script with a function named NO_BODY without a body, and one named
 * "grüßen" whose body, in file "ordner;pkt;Äpfel.as", pushes CONSTANT and
 * the ill-formed string.
 */
function unicodeAbc(): Uint8Array {
  const bytes = abc(
    {
      strings: ["", NO_BODY, "grüßen", CONSTANT, PLACEHOLDER, "ordner;pkt;Äpfel.as"],
      namespaces: [[0x16, ...u30(1)]],
      multinames: [
        [0x07, ...u30(1), ...u30(2)],
        [0x07, ...u30(1), ...u30(3)],
      ],
    },
    tables({
      methods: [{}, {}, {}],
      scripts: [
        {
          init: 0,
          traits: [
            { name: 1, kind: 1, index: 1 },
            { name: 2, kind: 1, index: 2 },
          ],
        },
      ],
      bodies: [
        { method: 0 },
        {
          method: 2,
          // debugfile, debugline 1, the two strings added, returnvalue.
          code: [0xf1, 6, 0xf0, 1, 0x2c, 4, 0x2c, 5, 0xa0, 0x48],
          maxStack: 2,
          localCount: 1,
          maxScopeDepth: 1,
        },
      ],
    }),
  );
  const marker = new TextEncoder().encode(PLACEHOLDER);
  const at = bytes.findIndex((_, i) => marker.every((b, k) => bytes[i + k] === b));
  bytes.set(ILL_FORMED, at);
  return bytes;
}

/** The value of each string literal in `module`. */
function literals(module: string): string[] {
  return (module.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []).map((literal) =>
    new Function(`return ${literal}`)(),
  );
}

test("strings, names and paths past ASCII are escaped and read back as they were", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(builtinLibrary, true), 0);
  assert.equal(codegen.add(unicodeAbc()), 0);
  const { module: compiled, sourceMap, entries } = codegen.compile(["0123"]);
  assertAscii(compiled, "module");
  assertAscii(sourceMap, "source map");
  for (const [body, entry] of entries) {
    assertAscii(entry, `body ${body}`);
  }

  // The constants, the name a missing body's error gives, and the function's identifier.
  const values = literals(compiled);
  assert.ok(values.includes(CONSTANT));
  assert.ok(values.includes(READ));
  assert.ok(values.includes(`global/${NO_BODY}()`));
  assert.ok(compiled.includes("$_global$sgr$x00fc$x00dfen"));
  assert.ok(
    [...entries.values()].some(
      (entry) => literals(entry).includes(CONSTANT) && literals(entry).includes(READ),
    ),
  );
  assert.deepEqual(JSON.parse(sourceMap).sources, ["ordner/pkt/Äpfel.as"]);
});

test("ASCII strings are written as before, with escapes only for what JavaScript needs", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(builtinLibrary, true), 0);
  const ascii = abc(
    {
      strings: ["", "f", 'a "quoted" \\ line\nend\u007f'],
      namespaces: [[0x16, ...u30(1)]],
      multinames: [[0x07, ...u30(1), ...u30(2)]],
    },
    tables({
      methods: [{}, {}],
      scripts: [{ init: 0, traits: [{ name: 1, kind: 1, index: 1 }] }],
      bodies: [
        { method: 0 },
        { method: 1, code: [0x2c, 3, 0x48], maxStack: 1, localCount: 1, maxScopeDepth: 1 },
      ],
    }),
  );
  assert.equal(codegen.add(ascii), 0);
  assert.ok(codegen.compileModule().includes('"a \\"quoted\\" \\\\ line\\x0aend\\x7f"'));
});

test("AVM1 strings past ASCII are escaped, a byte a character up to SWF 5 and UTF-8 after", () => {
  const text = [...new TextEncoder().encode(`${CONSTANT}${NO_BODY}`), ...ILL_FORMED];
  // Push the string, then Trace it.
  const block = Uint8Array.from([
    0x96,
    (text.length + 2) & 0xff,
    (text.length + 2) >> 8,
    0,
    ...text,
    0,
    0x26,
  ]);
  for (const version of [5, 6, 10]) {
    const bytes = testing.actionsModuleBytes(
      block,
      Int32Array.of(0),
      Int32Array.of(block.length),
      version,
      false,
    );
    assertAsciiBytes(bytes, `SWF ${version}`);
  }
});
