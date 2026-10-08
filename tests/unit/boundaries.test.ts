import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Package boundaries (docs/architecture.md). pnpm only links the packages a
// package.json lists, so the build already rejects imports that are not
// declared; this test guards the declarations themselves.
const allowed: Record<string, string[]> = {
  format: [],
  codegen: ["format"],
  runtime: ["format"],
  player: ["codegen", "format", "runtime"],
  "player-hosts": ["player"],
  web: ["codegen", "format", "player", "player-hosts"],
  cli: ["codegen", "format"],
};

// These run in browsers, workers and node alike, so they must not see DOM or
// node types; without them the build rejects `node:` imports and DOM globals.
const portable = ["format", "codegen", "runtime"];

const root = new URL("../../packages/", import.meta.url);
const appsRoot = new URL("../../apps/", import.meta.url);
const readJson = (path: string, base = root) =>
  JSON.parse(readFileSync(new URL(path, base), "utf8"));
// tsconfig.json may contain comments.
const readJsonc = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8").replace(/^\s*\/\/.*$/gm, ""));

/** The @swf2es/ names a package.json lists, without the scope. */
function internalDependencies(pkg: Record<string, Record<string, string> | undefined>): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]
    .filter((d) => d.startsWith("@swf2es/"))
    .map((d) => d.slice("@swf2es/".length))
    .sort();
}

for (const [name, deps] of Object.entries(allowed)) {
  test(`${name} depends only on ${deps.join(", ") || "nothing"}`, () => {
    assert.deepEqual(internalDependencies(readJson(`${name}/package.json`)), deps);
  });
}

// Apps (apps/*) may use any package, and no package may use an app.
const apps = readdirSync(appsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

test("every package is in the table", () => {
  const packages = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(packages, Object.keys(allowed).sort());
});

for (const app of apps) {
  test(`app ${app} depends only on packages`, () => {
    const pkg = readJson(`${app}/package.json`, appsRoot);
    assert.ok(pkg.private, "an app is not published");
    for (const dep of internalDependencies(pkg)) {
      assert.ok(
        Object.hasOwn(allowed, dep),
        `${app} depends on @swf2es/${dep}, which is not a package`,
      );
    }
  });
}

test("no package depends on an app", () => {
  const appNames = new Set(
    apps.map((app) =>
      String(readJson(`${app}/package.json`, appsRoot).name).slice("@swf2es/".length),
    ),
  );
  for (const name of Object.keys(allowed)) {
    const used = internalDependencies(readJson(`${name}/package.json`)).filter((d) =>
      appNames.has(d),
    );
    assert.deepEqual(used, [], `${name} depends on an app`);
  }
});

for (const name of portable) {
  test(`${name} has no DOM or node types`, () => {
    const { compilerOptions } = readJsonc(`${name}/tsconfig.json`);
    assert.deepEqual(compilerOptions.types, []);
    assert.ok(
      !compilerOptions.lib.some((lib: string) => /^dom/i.test(lib)),
      `lib: ${compilerOptions.lib}`,
    );
  });
}

// Inside the player, playerglobal/ is AS3's bindings only: it imports the
// player, and the player imports it once, where Scripting registers its
// natives and hooks (docs/architecture.md, "Source layout").
const playerSrc = fileURLToPath(new URL("player/src/", root));
const registration = "scripting.ts -> playerglobal/index.ts";

test("the player imports playerglobal only to register it", () => {
  const files = readdirSync(playerSrc, { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts") && !file.startsWith("playerglobal/"));
  assert.ok(files.length > 0);

  const imports: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(playerSrc, file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]*)"/g)) {
      const target = relative(playerSrc, join(playerSrc, dirname(file), specifier))
        .replaceAll("\\", "/")
        .replace(/\.js$/, ".ts");
      if (target.startsWith("playerglobal/")) {
        imports.push(`${file} -> ${target}`);
      }
    }
  }

  assert.deepEqual(imports, [registration]);
});
