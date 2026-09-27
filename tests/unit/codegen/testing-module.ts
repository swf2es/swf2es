// Loads the test build of codegen (packages/codegen/assembly/testing.ts).
import { readFile } from "node:fs/promises";

const dir = new URL("../../../packages/codegen/dist-test/", import.meta.url);
const { instantiate } = await import(new URL("testing.js", dir).href);
const module = await WebAssembly.compile(await readFile(new URL("testing.wasm", dir)));

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export const testing: any = await instantiate(module, { env: {} });
