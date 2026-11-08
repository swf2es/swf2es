// What the published packages carry besides their code: the repository's
// LICENSE and the notices of what each holds from elsewhere, as
// tools/notices.ts writes them, a `license` that says as much, and the
// avmplus ABCs embedded in them as the submodule has them
// (tools/avmplus-libraries.ts). tests/packages packs and installs them.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtinLibrary } from "@swf2es/runtime/avm2";
import { shellToplevelLibrary } from "../../packages/cli/dist/shell-toplevel-library.js";
import { abcOf, embedded, LIBRARIES } from "../../tools/avmplus-libraries.ts";
import {
  expected,
  type Origin,
  origins,
  PUBLIC_PACKAGES,
  spdx,
  THREAD_PACKAGES,
} from "../../tools/notices.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const skip = !existsSync(`${root}oracle/avmplus/generated/builtin.abc`) && "oracle/avmplus missing";
const packageJson = (name: string) =>
  JSON.parse(readFileSync(`${root}packages/${name}/package.json`, "utf8"));

test("every package is published, and tools/notices.ts knows them all", () => {
  const packages = readdirSync(`${root}packages`).filter((name) =>
    existsSync(`${root}packages/${name}/package.json`),
  );
  assert.deepEqual(packages.sort(), [...PUBLIC_PACKAGES].sort());
  for (const name of PUBLIC_PACKAGES) {
    assert.ok(!packageJson(name).private, name);
  }
});

test("each package's LICENSE and LICENSE.third-party are tools/notices.ts's", { skip }, () => {
  for (const [path, text] of expected()) {
    const file = root + path;
    assert.ok(
      existsSync(file) && readFileSync(file, "utf8") === text,
      `${path} is stale: run node tools/notices.ts --update`,
    );
  }
});

test("each package's license names what it holds, and it ships its notices", { skip }, () => {
  for (const name of PUBLIC_PACKAGES) {
    const pkg = packageJson(name);
    assert.equal(pkg.license, spdx(name), name);
    assert.equal(
      pkg.files.includes("LICENSE.third-party"),
      existsSync(`${root}packages/${name}/LICENSE.third-party`),
      name,
    );
    assert.deepEqual(
      pkg.repository,
      {
        type: "git",
        url: "git+https://github.com/swf2es/swf2es.git",
        directory: `packages/${name}`,
      },
      name,
    );
  }
});

// What a file's header says it comes from.
const MARKERS: [Origin, RegExp][] = [
  ["avmplus", /mozilla\.org\/MPL\/2\.0/],
  ["ruffle", /Ruffle[\s/*]*LLC/],
  ["w3c", /W3C®/],
];

function headerOrigins(dir: string): Set<Origin> {
  const found = new Set<Origin>();
  if (!existsSync(dir)) {
    return found;
  }

  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!/\.(ts|zig|c)$/.test(file)) {
      continue;
    }

    const text = readFileSync(join(dir, file), "utf8");
    for (const [origin, marker] of MARKERS) {
      if (marker.test(text)) {
        found.add(origin);
      }
    }
  }

  return found;
}

// codegen's assembly/ is compiled into codegen.wasm, which it ships.
const sourcesOf = (name: string) => [
  `${root}packages/${name}/src`,
  ...(name === "codegen" ? [`${root}packages/codegen/assembly`] : []),
];

test("each package's notices cover what its files' headers say came from elsewhere", () => {
  // native's notices are its build's, which checks them against what it compiles.
  for (const name of PUBLIC_PACKAGES.filter((n) => n !== "native")) {
    // player-hosts' dist/thread/ holds the modules of the others.
    const held =
      name === "player-hosts" ? [name, ...THREAD_PACKAGES.filter((n) => n !== "native")] : [name];
    const found = new Set(held.flatMap(sourcesOf).flatMap((dir) => [...headerOrigins(dir)]));
    for (const origin of found) {
      assert.ok(origins(name).includes(origin), `${name} holds ${origin}'s code but no notice`);
    }
  }

  assert.ok(origins("player-hosts").includes("native"));
});

test("player-hosts' dist/thread/ holds the packages whose notices it carries", () => {
  const thread = `${root}packages/player-hosts/dist/thread`;
  const held = readdirSync(thread).filter((name) => name !== "player-hosts");
  assert.deepEqual(held.sort(), [...THREAD_PACKAGES].sort());
});

test("the embedded avmplus ABCs are the submodule's", { skip }, () => {
  for (const library of LIBRARIES) {
    const source = readFileSync(root + library.module, "utf8");
    assert.ok(
      Buffer.from(embedded(source)).equals(abcOf(library)),
      `${library.module} is stale: run node tools/avmplus-libraries.ts --update`,
    );
  }

  assert.ok(Buffer.from(builtinLibrary).equals(abcOf(LIBRARIES[0])));
  assert.ok(Buffer.from(shellToplevelLibrary).equals(abcOf(LIBRARIES[1])));
});
