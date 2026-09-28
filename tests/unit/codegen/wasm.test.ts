import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPILER_VERSION, cacheKey, createCodegen } from "@swf2es/codegen";

const wasmPath = fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"));
const module = await WebAssembly.compile(await readFile(wasmPath));

test("codegen.wasm imports nothing but abort", () => {
  // Purity is what makes JIT and AOT output identical: the compiler can't
  // reach a clock, randomness or the host environment if it can't import them.
  assert.deepEqual(
    WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
    ["env.abort"],
  );
});

test("wrapper and wasm agree on the compiler version", async () => {
  await createCodegen(module); // throws on a mismatch
  assert.equal(cacheKey("abc123"), `swf2es@${COMPILER_VERSION}:abc123`);
  assert.equal(cacheKey("abc123", ["b1", "s2"]), `swf2es@${COMPILER_VERSION}:b1+s2+abc123`);
});

test("reads the ABC version header", async () => {
  const codegen = await createCodegen(module);
  // Flash Player 9+ ABC: minor 16, major 46 (both little-endian u16).
  assert.deepEqual(codegen.abcVersion(new Uint8Array([16, 0, 46, 0, 0xff])), {
    major: 46,
    minor: 16,
  });
  assert.equal(codegen.abcVersion(new Uint8Array([16, 0, 46])), null);
});
