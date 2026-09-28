import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Package boundaries (docs/architecture.md). pnpm only links the packages a
// package.json lists, so the build already rejects imports that are not
// declared; this test guards the declarations themselves.
const allowed: Record<string, string[]> = {
  format: [],
  codegen: ["format"],
  runtime: ["format"],
  player: ["codegen", "format", "runtime"],
  cli: ["codegen", "format"],
};

// These run in browsers, workers and node alike, so they must not see DOM or
// node types; without them the build rejects `node:` imports and DOM globals.
const portable = ["format", "codegen", "runtime"];

const root = new URL("../../packages/", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
// tsconfig.json may contain comments.
const readJsonc = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8").replace(/^\s*\/\/.*$/gm, ""));

for (const [name, deps] of Object.entries(allowed)) {
  test(`${name} depends only on ${deps.join(", ") || "nothing"}`, () => {
    const pkg = readJson(`${name}/package.json`);
    const internal = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]
      .filter((d) => d.startsWith("@swf2es/"))
      .map((d) => d.slice("@swf2es/".length))
      .sort();
    assert.deepEqual(internal, deps);
  });
}

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
