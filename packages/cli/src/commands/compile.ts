// swf2es compile: a SWF's or an ABC's modules, ahead of time, as the player
// compiles them for its main movie, with a manifest; an AVM1 SWF's one
// module of its action blocks.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { COMPILER_VERSION, createCodegen } from "@swf2es/codegen";
import { apiVersionOf } from "@swf2es/format";
import { airLibrary, builtinLibrary, playerglobalLibrary } from "@swf2es/player/libraries";
import {
  AIR_API_VERSION,
  API_VERSION,
  type Avm1Input,
  compileActionsAhead,
  compileAhead,
  InputError,
  type Module,
  RejectedError,
  readInput,
  sha256,
} from "../aot.js";
import { apiVersionArgument, COMMON_OPTIONS, COMMON_USAGE, type Command, parse } from "../args.js";
import { codegenModule, read, readLibraries, writing } from "../files.js";
import { fail, usageError } from "../output.js";

const USAGE = `usage: swf2es compile <file.swf|file.abc> [options]
       swf2es <file.swf|file.abc> [options]

Compiles the ABCs of a SWF (its DoABC and DoABC2 tags, in order), or a bare
ABC, to ES modules as the player compiles them for a SWF it loads as its
main movie, byte for byte. Writes a .js file per ABC, a .log file of what
its compile fixed, which the player replays in its place, and a
manifest.json naming them, their ABCs' hashes, the keys the player's
module cache looks them up by, and the compiler. An AVM1 SWF (one whose
FileAttributes has no ActionScript 3 flag) compiles to one module of its
action blocks, avm1.js, which takes no library.

options:
  -o, --out <dir>      where to write (default: <file name>.swf2es)
  --lib <file.abc>     a library the code links against, loaded into the
                       root domain in the order given; repeat for each.
                       Default: what the player loads, which swf2es ships:
                       avmplus' builtin.abc and the player's playerglobal,
                       and with --air AIR's library after them
  --emit-libraries     write the libraries' modules too
  --air                compile for a player that plays the SWF as AIR does
                       (its \`air\` option), AIR's API defined; a player
                       in the other mode looks none of the modules up.
                       Refused for an AVM1 SWF, which has no API versions
  --api <version>      the API version to compile at, as the player's
                       apiVersion: latest (the default), every class and
                       member whatever the SWF's version; root, the SWF's
                       own, from its header, as a player of apiVersion
                       "root" plays it as its main movie; or a SWF version,
                       a root of that version's, for a SWF such a root
                       loads. A player at another version looks none of
                       the modules up; an AIR application plays at the
                       latest with root, at a number's version with a
                       number. Refused for an AVM1
                       SWF but latest, and root for an ABC, which has no
                       header
  -q, --quiet          print nothing but errors
${COMMON_USAGE}

exit status: 0 on success, 2 for a mistake in the command line, 1 for
anything else (an unreadable or rejected input or library, or an output
that cannot be written)`;

const OPTIONS = {
  out: { type: "string", short: "o" },
  lib: { type: "string", multiple: true },
  "emit-libraries": { type: "boolean" },
  air: { type: "boolean" },
  api: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  ...COMMON_OPTIONS,
} as const;

/**
 * manifest.json's format: 2 added each module's log, key and lengths, and
 * named the compiler by its stamped identity rather than its file's hash.
 * An AVM1 SWF's `avm1` entry, which a reader of the ABCs' entries need not
 * know, came later without a new version.
 */
const MANIFEST_VERSION = 2;

/** What a previous run wrote to `out`, as its manifest names it, so that no stale module stays beside a new manifest. */
async function removeModules(out: string): Promise<void> {
  let old: { libraries?: unknown; abcs?: unknown; avm1?: unknown } | null;
  try {
    old = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  } catch {
    return;
  }

  const entries = [old?.libraries, old?.abcs, [old?.avm1]].flatMap((list) =>
    Array.isArray(list) ? list : [],
  );
  // Only names this command writes: a manifest edited by hand names nothing else to delete.
  for (const entry of entries) {
    const name = (entry as { module?: unknown } | null)?.module;
    if (typeof name === "string" && /^((abc|lib)-\d+|avm1)\.js$/.test(name)) {
      for (const file of [name, name.replace(/\.js$/, ".log")]) {
        await writing(join(out, file), () => rm(join(out, file), { force: true }));
      }
    }
  }
}

/**
 * The libraries the player loads, as @swf2es/web gives them, AIR's after
 * the rest for an AIR player; the manifest's names tell swf2es's
 * playerglobal from Flash Player's.
 */
function playerLibraries(air = false): { name: string; abc: Uint8Array }[] {
  const libraries = [
    { name: "builtin", abc: builtinLibrary },
    { name: "playerglobal-swf2es", abc: playerglobalLibrary },
  ];
  return air ? [...libraries, { name: "air", abc: airLibrary }] : libraries;
}

export const compile: Command = {
  name: "compile",
  summary: "compile a SWF's or an ABC's modules ahead of time, with a manifest",
  usage: USAGE,
  async main(argv) {
    const parsed = parse(compile, () =>
      parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }),
    );
    if (!parsed) {
      return;
    }

    const { values, positionals } = parsed;
    if (positionals.length !== 1) {
      usageError(`expected one input file, got ${positionals.length}`, "compile");
    }

    const file = positionals[0];
    const bytes = await read(file, "input");
    let input: ReturnType<typeof readInput>;
    try {
      input = readInput(bytes);
    } catch (e) {
      fail(e instanceof InputError ? `${file}: ${e.message}` : String((e as Error).stack ?? e));
    }

    const out = values.out ?? `${basename(file, extname(file))}.swf2es`;
    const api = apiVersionArgument(values.api, "compile");
    if (input.avm1) {
      // AVM1 has no API versions: its module is the same for every player.
      if (values.air || api !== "latest") {
        usageError(
          `${file} is an AVM1 SWF, which ${values.air ? "--air" : "--api"} does not apply to`,
          "compile",
        );
      }

      await compileAvm1(file, bytes, input.avm1, out, values.quiet ?? false);
      return;
    }

    if (api === "root" && input.kind === "abc") {
      usageError(`${file} is an ABC, whose version --api root has no header to take`, "compile");
    }

    const air = values.air ?? false;
    // A player's apiVersion, as Scripting reads it of its main movie.
    const apiVersion =
      api === "latest"
        ? air
          ? AIR_API_VERSION
          : API_VERSION
        : apiVersionOf(api === "root" ? input.version : api, air);
    const libs = values.lib ? await readLibraries(values.lib) : playerLibraries(air);
    if (input.abcs.length === 0) {
      fail(`${file}: no DoABC or DoABC2 tag, so no ActionScript 3 to compile`);
    }

    const codegen = await createCodegen(await codegenModule());
    const started = performance.now();
    let compiled: ReturnType<typeof compileAhead>;
    try {
      compiled = compileAhead(codegen, libs, input.abcs, values["emit-libraries"], apiVersion);
    } catch (e) {
      if (!(e instanceof RejectedError)) {
        fail(String((e as Error).stack ?? e));
      }

      fail(e.library ? e.message : `${file}: ${e.message}`);
    }

    const ms = performance.now() - started;
    await writing(out, () => mkdir(out, { recursive: true }));
    await removeModules(out);
    let size = 0;
    const write = async (file: string, text: string) => {
      await writing(join(out, file), () => writeFile(join(out, file), text));
      size += Buffer.byteLength(text);
      return file;
    };
    // A module, its log beside it, and what a host's precompiled module cache
    // looks it up by and checks it with: the key and the two's lengths.
    const entry = async (name: string, m: Module) => {
      const module = await write(`${name}.js`, m.module);
      if (m.log === null || m.key === null) {
        return { module };
      }

      const log = await write(`${name}.log`, m.log);
      return { module, log, key: m.key, lengths: [m.module.length, m.log.length] };
    };

    // The compiler is named by the identity stamped into its binary, which
    // the keys name too, so that a host can tell what another build wrote;
    // an ABC by its hash, as its module names it, with the ABCs it was
    // linked against.
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      compiler: { name: "swf2es", version: COMPILER_VERSION, identity: codegen.identity },
      // The version the modules were compiled at, which their keys name too.
      apiVersion: codegen.apiVersion,
      input: {
        file: basename(file),
        kind: input.kind,
        version: input.version,
        sha256: sha256(bytes),
      },
      libraries: await Promise.all(
        compiled.libraryInputs.map(async ({ name, abc }, i) => {
          const m = compiled.libraries[i];
          const lib = { name, sha256: sha256(abc) };
          return m ? { ...lib, ...(await entry(`lib-${i}`, m)) } : lib;
        }),
      ),
      abcs: await Promise.all(
        compiled.abcs.map(async (m, i) => ({
          name: m.name,
          sha256: m.hash,
          lazy: m.lazy,
          ...(await entry(`abc-${i}`, m)),
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
  },
};

/**
 * An AVM1 SWF's module, avm1.js, and its manifest: the module's key, as
 * the player's module cache is to look it up, the SHA-256 of the SWF's
 * decompressed bytes it names, its length and how many blocks it has.
 */
async function compileAvm1(
  file: string,
  bytes: Uint8Array,
  avm1: Avm1Input,
  out: string,
  quiet: boolean,
): Promise<void> {
  const codegen = await createCodegen(await codegenModule());
  const started = performance.now();
  const compiled = compileActionsAhead(codegen, avm1);
  const ms = performance.now() - started;
  await writing(out, () => mkdir(out, { recursive: true }));
  await removeModules(out);
  const module = "avm1.js";
  await writing(join(out, module), () => writeFile(join(out, module), compiled.module));
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    compiler: { name: "swf2es", version: COMPILER_VERSION, identity: codegen.identity },
    apiVersion: API_VERSION,
    input: {
      file: basename(file),
      kind: "swf",
      version: avm1.actions.version,
      sha256: sha256(bytes),
    },
    libraries: [],
    abcs: [],
    avm1: {
      module,
      sha256: compiled.hash,
      blocks: compiled.blocks,
      ...(compiled.key === null ? {} : { key: compiled.key, length: compiled.module.length }),
    },
  };
  const manifestPath = join(out, "manifest.json");
  await writing(manifestPath, () =>
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
  );
  if (!quiet) {
    const size = Buffer.byteLength(compiled.module);
    const blocks = `${compiled.blocks} AVM1 block${compiled.blocks === 1 ? "" : "s"}`;
    console.log(
      `${file}: ${blocks}, 1 module, ${size} bytes, compiled in ${Math.round(ms)} ms, in ${out}`,
    );
  }
}
