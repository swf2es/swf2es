// The generated code's digests (digests.json): what the compiler makes of
// the libraries the player ships, the unit tests' hand-built ABCs, the
// conformance cases and AVM1 blocks, each a SHA-256 of its module, source
// map, entries and context, or of its rejection. Behaviour tests show what
// code does, not that it changed: a change that means to move the
// generated code updates the digests with it, and one that does not is
// caught here.
//
//   node tests/golden/run.ts            the digests compared with digests.json
//   node tests/golden/run.ts --update   digests.json written again
//
// The conformance cases (with ASC's -d too, for line maps) and as3pb are
// built by ASC in the oracle's image, which does not build them alike every
// time, so their ABCs are kept in abcs/ (--abcs builds them again, as after
// a new case). LZ4, which Crossbridge builds differently each time, is left
// out. The oracle's own libraries (tests/libraries') are read from its
// image; without podman or docker their digests are left out of the
// comparison, but in CI that fails, and --update refuses.
//
//   node tests/golden/run.ts --abcs --update   the ABCs built again, and the digests
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AIR_API_VERSION, API_VERSION, createCodegen } from "@swf2es/codegen";
import { airLibrary, builtinLibrary, playerglobalLibrary } from "@swf2es/player/libraries";
import { containerEngine, libraries, runOracle } from "../../oracle/oracle.ts";
import { shellToplevelLibrary } from "../../packages/cli/dist/shell-toplevel-library.js";
import { avm1Swfs } from "../conformance/determinism-avm1.ts";
import { structuredAbcs } from "../fuzz/bodies.ts";
import { as3pb } from "../programs/jobs.ts";
import { linkAbcs } from "../unit/codegen/link-abc.ts";
import { linkCases, resolveCases } from "../unit/codegen/link-cases.ts";
import { richAbc } from "../unit/codegen/rich-abc.ts";
import { typedCases } from "../unit/codegen/typed-cases.ts";
import { verifyCases } from "../unit/codegen/verify-cases.ts";
import { verifyErrorAbcs } from "../unit/codegen/verify-errors.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const digestsFile = `${here}digests.json`;
const update = process.argv.includes("--update");

const sha256 = (...parts: (string | Uint8Array)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) {
    // Each part's length first, so that no two splits of the same bytes agree.
    const bytes = typeof part === "string" ? Buffer.from(part) : part;
    hash.update(`${bytes.length}:`).update(bytes);
  }

  return hash.digest("hex");
};

const codegen = await createCodegen(
  await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);
const digests: Record<string, string> = {};

/** ABC `index`'s module, source map, entries and context, as the player compiles it. */
function compiled(hashes: string[], index: number): string {
  const { module, sourceMap, entries } = codegen.compile(hashes, index);
  const context = codegen.context(index);
  return sha256(
    module,
    sourceMap,
    JSON.stringify([...entries].sort(([a], [b]) => a - b)),
    JSON.stringify(context),
  );
}

interface Base {
  version: number;
  libraries: [string, Uint8Array][];
}

const PLAYER: Base = {
  version: API_VERSION,
  libraries: [
    ["builtin", builtinLibrary],
    ["playerglobal", playerglobalLibrary],
  ],
};
const AIR: Base = {
  version: AIR_API_VERSION,
  libraries: [...PLAYER.libraries, ["air", airLibrary]],
};
const SHELL: Base = {
  version: API_VERSION,
  libraries: [
    ["builtin", builtinLibrary],
    ["shell_toplevel", shellToplevelLibrary],
  ],
};

/** A domain of `base`'s libraries alone, with their hashes. */
function reset(base: Base): string[] {
  codegen.reset(base.version);
  const hashes: string[] = [];
  for (const [name, abc] of base.libraries) {
    const error = codegen.add(abc, true);
    if (error !== 0) {
      throw new Error(`${name} did not link: ${error}`);
    }

    hashes.push(sha256(abc));
  }

  return hashes;
}

// The libraries, each compiled in the domain the player makes of them.
for (const [name, base] of Object.entries({ player: PLAYER, air: AIR, shell: SHELL })) {
  const hashes = reset(base);
  for (const [index, [library]] of base.libraries.entries()) {
    digests[`library/${name}/${library}`] = compiled(hashes, index);
  }
}

/** `abc` added to a child of `base`'s domain: its compile, or its rejection. */
function user(key: string, base: Base, abc: Uint8Array): void {
  const hashes = reset(base);
  const error = codegen.add(abc, false, codegen.childDomain(0));
  digests[key] =
    error === 0 ? compiled([...hashes, sha256(abc)], hashes.length) : sha256(`rejected ${error}`);
}

// The unit tests' hand-built ABCs, edges of the format, the linker and the
// verifier, and structured bodies, each after the player's libraries.
const tests: [string, Uint8Array][] = [
  ...[...verifyCases, ...linkCases, ...resolveCases, ...typedCases].map(
    (c): [string, Uint8Array] => [c.name, c.abc],
  ),
  ...Object.entries(linkAbcs()).map(([name, abc]): [string, Uint8Array] => [`link ${name}`, abc]),
  ...verifyErrorAbcs(),
  ["rich 47.16", richAbc(true)],
  ["rich", richAbc(false)],
  ...structuredAbcs(40, 1).map((abc, i): [string, Uint8Array] => [`structured ${i}`, abc]),
];
const fixtures = `${root}tests/unit/codegen/fixtures/`;
for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".abc"))) {
  tests.push([`fixtures/${file}`, new Uint8Array(readFileSync(`${fixtures}${file}`))]);
}

const named = new Map<string, number>();
for (const [name, abc] of tests) {
  // Names repeat across the case lists: the second of a name is "name #2".
  const n = (named.get(name) ?? 0) + 1;
  named.set(name, n);
  user(`abc/${n > 1 ? `${name} #${n}` : name}`, PLAYER, abc);
}

user(
  "abc/AirFloat",
  AIR,
  new Uint8Array(readFileSync(`${root}tests/player/fixtures/AirFloat.abc`)),
);

// AVM1: the determinism checks' blocks, Ruffle's corpus left out.
for (const swf of avm1Swfs(false)) {
  const blocks = [...swf.offsets].map((offset, k) => ({ offset, length: swf.lengths[k] }));
  const { module, entries, units } = codegen.compileActions(swf.bytes, {
    version: swf.version,
    blocks,
  });
  digests[`avm1/${swf.name}`] = sha256(
    module,
    JSON.stringify(entries),
    JSON.stringify([...units].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

// The conformance cases, compiled by ASC as the conformance runner compiles
// them, and again with -d, as the determinism check does, so that their
// source maps have lines; and as3pb, as the programs runner builds it. ASC
// does not build them alike every time (with -d, a body's stack and scope
// sizes now and then), so the ABCs are kept in abcs/, built again by
// --abcs, and digested from there, each after avmshell's libraries.
const cases = `${root}tests/conformance/cases/`;
const abcs = `${here}abcs/`;
const sources = readdirSync(cases)
  .filter((f) => f.endsWith(".as"))
  .map((f) => f.replace(/\.as$/, ""))
  .sort();
const kept = [
  ...sources.flatMap((name) => [`conformance/${name}`, `lines/${name}`]),
  "program/as3pb",
];

// What the oracle's image builds: the ABCs above, again with --abcs, and its
// own libraries, digested where podman or docker is, which CI must have.
let oracle = true;
try {
  containerEngine();
} catch (e) {
  oracle = false;
  if (process.env.CI) {
    console.log(`golden: the oracle is needed in CI (${(e as Error).message})`);
    process.exit(1);
  }

  console.log(`golden: what the oracle builds left out (${(e as Error).message})`);
}

if (process.argv.includes("--abcs")) {
  if (!oracle) {
    console.log("golden: --abcs needs the oracle");
    process.exit(1);
  }

  const results = runOracle(
    [
      ...sources.map((name) => ({ source: `${cases}${name}.as`, ascArgs: ["-md"] })),
      ...sources.map((name) => ({
        source: `${cases}${name}.as`,
        name: `lines/${name}`,
        ascArgs: ["-md", "-d"],
      })),
      as3pb(),
    ],
    `${here}out`,
    { run: false },
  );
  rmSync(abcs, { recursive: true, force: true });
  for (const result of results) {
    if (!result.compiled) {
      throw new Error(`${result.name} did not compile:\n${result.compileLog}`);
    }

    const name = result.name.replace(/^.*\//, "");
    const key = result.name.startsWith("lines/")
      ? `lines/${name}`
      : result.name.startsWith("as3pb/")
        ? "program/as3pb"
        : `conformance/${name}`;
    mkdirSync(dirname(`${abcs}${key}.abc`), { recursive: true });
    copyFileSync(`${here}out/${result.name}.abc`, `${abcs}${key}.abc`);
  }
}

const missing = kept.filter((key) => !existsSync(`${abcs}${key}.abc`));
if (missing.length > 0) {
  console.log(
    `golden: ${missing.length} ABCs not in tests/golden/abcs/ (${missing.slice(0, 3).join(", ")}): ` +
      "run node tests/golden/run.ts --abcs --update",
  );
  process.exit(1);
}

for (const key of kept) {
  user(key, SHELL, new Uint8Array(readFileSync(`${abcs}${key}.abc`)));
}

if (oracle) {
  // The oracle's libraries, as tests/libraries reads them: avmshell's, and
  // Flash Player's and AIR's from its image, each after builtin.
  const [builtin, ...others] = libraries(
    ["builtin", "shell_toplevel", "playerglobal", "airglobal"],
    `${here}out/lib`,
  );
  for (const library of others) {
    const version = library.name === "airglobal" ? AIR_API_VERSION : API_VERSION;
    const base: Base = {
      version,
      libraries: [
        ["builtin", builtin.abc],
        [library.name, library.abc],
      ],
    };
    const hashes = reset(base);
    digests[`oracle-library/${library.name}`] = compiled(hashes, 1);
  }

  digests["oracle-library/builtin"] = compiled(
    reset({ version: API_VERSION, libraries: [["builtin", builtin.abc]] }),
    0,
  );
}

const sorted = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : 1)));
if (update) {
  if (!oracle) {
    console.log("golden: --update needs the oracle, for its libraries");
    process.exit(1);
  }

  writeFileSync(digestsFile, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`golden: ${Object.keys(sorted).length} digests written to ${digestsFile}`);
  process.exit(0);
}

const recorded: Record<string, string> = JSON.parse(readFileSync(digestsFile, "utf8"));
const compared = (key: string) => oracle || !key.startsWith("oracle-library/");
const moved: string[] = [];
for (const key of Object.keys({ ...recorded, ...sorted })
  .filter(compared)
  .sort()) {
  if (recorded[key] !== sorted[key]) {
    moved.push(key in recorded ? (key in sorted ? `changed ${key}` : `gone ${key}`) : `new ${key}`);
  }
}

const count = Object.keys(sorted).length;
if (moved.length > 0) {
  console.log(moved.slice(0, 40).join("\n"));
  if (moved.length > 40) {
    console.log(`... and ${moved.length - 40} more`);
  }

  console.log(
    `golden: ${moved.length} of ${count} digests are not digests.json's. If the change means ` +
      "to move the generated code, run node tests/golden/run.ts --update and commit " +
      "digests.json with it.",
  );
  process.exit(1);
}

console.log(`golden: ${count} digests, all digests.json's`);
