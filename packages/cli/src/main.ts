#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMPILER_VERSION, createCodegen } from "@swf2es/codegen";
import {
  API_VERSION,
  compileAhead,
  InputError,
  type Module,
  RejectedError,
  readInput,
  sha256,
} from "./aot.js";

const USAGE = `usage: swf2es <file.swf|file.abc> [options]

Compiles the ABCs of a SWF (its DoABC and DoABC2 tags, in order), or a bare
ABC, to ES modules as the player compiles them for a SWF it loads as its
main movie, byte for byte. Writes a .js file per ABC and a manifest.json
naming them, their ABCs' hashes and the compiler.

options:
  -o, --out <dir>      where to write (default: <file name>.swf2es)
  --lib <file.abc>     a library the code links against, loaded into the
                       root domain in the order given; repeat for each.
                       Default: builtin.abc and playerglobal.abc from the
                       repository's tests/player/out/libraries/, if there
  --emit-libraries     write the libraries' modules too
  -q, --quiet          print nothing but errors
  -h, --help           show this
  -v, --version        print the compiler's version

exit status: 0 on success, 2 for a mistake in the command line or missing
default libraries, 1 for anything else (an unreadable, AVM1 or rejected
input or library, or an output that cannot be written)`;

/** Where the repository's tests keep Adobe's libraries, which cannot ship with the package. */
const REPO_LIBRARIES = fileURLToPath(
  new URL("../../../tests/player/out/libraries/", import.meta.url),
);
const DEFAULT_LIBRARIES = ["builtin.abc", "playerglobal.abc"].map((n) => REPO_LIBRARIES + n);

const HINT = "run swf2es --help for usage";

/** The exit status for a mistake in how the command was run. */
const USAGE_ERROR = 2;

function fail(message: string, status = 1): never {
  process.stderr.write(`swf2es: ${message}\n`);
  process.exit(status);
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      lib: { type: "string", multiple: true },
      "emit-libraries": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

async function read(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    fail(`cannot read ${what} ${path}: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
}

async function writing(path: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (e) {
    fail(`cannot write ${path}: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
}

/** What a previous run wrote to `out`, as its manifest names it, so that no stale module stays beside a new manifest. */
async function removeModules(out: string): Promise<void> {
  let old: { libraries?: unknown; abcs?: unknown } | null;
  try {
    old = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  } catch {
    return;
  }

  const entries = [old?.libraries, old?.abcs].flatMap((list) => (Array.isArray(list) ? list : []));
  // Only names this command writes: a manifest edited by hand names nothing else to delete.
  for (const entry of entries) {
    const name = (entry as { module?: unknown } | null)?.module;
    if (typeof name === "string" && /^(abc|lib)-\d+\.js$/.test(name)) {
      await writing(join(out, name), () => rm(join(out, name), { force: true }));
    }
  }
}

async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    fail(`${(e as Error).message}\n${HINT}`, USAGE_ERROR);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.version) {
    console.log(`swf2es ${COMPILER_VERSION}`);
    return;
  }

  if (positionals.length !== 1) {
    fail(`expected one input file, got ${positionals.length}\n${HINT}`, USAGE_ERROR);
  }

  const file = positionals[0];
  const libraries = values.lib ?? DEFAULT_LIBRARIES;
  if (!values.lib && !libraries.every((p) => existsSync(p))) {
    fail(
      "no --lib given, and no builtin.abc and playerglobal.abc in the repository's\n" +
        "tests/player/out/libraries/. Pass Adobe's builtin.abc and playerglobal.abc with\n" +
        "--lib (swf2es cannot ship them), or run the player's tests once, which copy them there.",
      USAGE_ERROR,
    );
  }

  const bytes = await read(file, "input");
  const libs = await Promise.all(
    libraries.map(async (path) => ({
      name: basename(path, extname(path)),
      abc: await read(path, "library"),
    })),
  );
  let input: ReturnType<typeof readInput>;
  try {
    input = readInput(bytes);
  } catch (e) {
    fail(e instanceof InputError ? `${file}: ${e.message}` : String((e as Error).stack ?? e));
  }

  if (input.abcs.length === 0) {
    fail(`${file}: no DoABC or DoABC2 tag, so no ActionScript 3 to compile`);
  }

  const wasm = await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
  const codegen = await createCodegen(await WebAssembly.compile(wasm));
  const started = performance.now();
  let compiled: ReturnType<typeof compileAhead>;
  try {
    compiled = compileAhead(codegen, libs, input.abcs, values["emit-libraries"]);
  } catch (e) {
    if (!(e instanceof RejectedError)) {
      fail(String((e as Error).stack ?? e));
    }

    fail(e.library ? e.message : `${file}: ${e.message}`);
  }

  const ms = performance.now() - started;
  const out = values.out ?? `${basename(file, extname(file))}.swf2es`;
  await writing(out, () => mkdir(out, { recursive: true }));
  await removeModules(out);
  let size = 0;
  const write = async (path: string, m: Module) => {
    await writing(join(out, path), () => writeFile(join(out, path), m.module));
    size += Buffer.byteLength(m.module);
    return path;
  };

  // The compiler is named by its version and its binary's hash, so that a
  // host can refuse what another build wrote; an ABC by its hash, as its
  // module names it, with the ABCs it was linked against.
  const manifest = {
    compiler: { name: "swf2es", version: COMPILER_VERSION, wasm: sha256(wasm) },
    apiVersion: API_VERSION,
    input: {
      file: basename(file),
      kind: input.kind,
      version: input.version,
      sha256: sha256(bytes),
    },
    libraries: await Promise.all(
      libs.map(async ({ name, abc }, i) => {
        const m = compiled.libraries[i];
        const entry = { name, sha256: sha256(abc) };
        return m ? { ...entry, module: await write(`lib-${i}.js`, m) } : entry;
      }),
    ),
    abcs: await Promise.all(
      compiled.abcs.map(async (m, i) => ({
        name: m.name,
        sha256: m.hash,
        lazy: m.lazy,
        module: await write(`abc-${i}.js`, m),
      })),
    ),
  };
  const manifestPath = join(out, "manifest.json");
  await writing(manifestPath, () =>
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
  );
  if (!values.quiet) {
    const count = compiled.abcs.length + compiled.libraries.length;
    console.log(
      `${file}: ${count} module${count === 1 ? "" : "s"}, ${size} bytes, ` +
        `compiled in ${Math.round(ms)} ms, in ${out}`,
    );
  }
}

await main(process.argv.slice(2));
