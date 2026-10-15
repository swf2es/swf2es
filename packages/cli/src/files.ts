// Reading the commands' inputs and writing their outputs, a failure said
// as such rather than as a stack; and where the repository keeps the
// libraries a command takes when given none.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, USAGE_ERROR } from "./output.js";

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

const repository = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/**
 * The libraries named `names`, from the first of the repository's
 * directories `dirs` that has them all; with none, a usage error that
 * says what to pass, as `missing` explains.
 */
export function defaultLibraries(names: string[], dirs: string[], missing: string): string[] {
  for (const dir of dirs) {
    const paths = names.map((n) => repository(dir) + n);
    if (paths.every((p) => existsSync(p))) {
      return paths;
    }
  }

  fail(missing, USAGE_ERROR);
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
