// Reading the commands' inputs and writing their outputs, a failure said
// as such rather than as a stack.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./output.js";

export async function read(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    fail(`cannot read ${what} ${path}: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
}

export async function writing(path: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (e) {
    fail(`cannot write ${path}: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
}

/** The libraries at `paths`, read, each named by its file. */
export function readLibraries(paths: string[]): Promise<{ name: string; abc: Uint8Array }[]> {
  return Promise.all(
    paths.map(async (path) => ({
      name: basename(path, extname(path)),
      abc: await read(path, "library"),
    })),
  );
}

/** The release codegen.wasm, compiled. */
export async function codegenModule(): Promise<WebAssembly.Module> {
  const path = fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"));
  return WebAssembly.compile(await readFile(path));
}
