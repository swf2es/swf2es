// The Web Workers' script tree (packages/player-hosts/build-thread.ts):
// every module it imports is in it by a relative path, so that a worker,
// which sees no import map, loads it wherever the package is served.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tree = fileURLToPath(new URL("../../../packages/player-hosts/dist/thread/", import.meta.url));

function modules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? modules(join(dir, entry.name))
      : entry.name.endsWith(".js")
        ? [join(dir, entry.name)]
        : [],
  );
}

test("the worker script's modules import one another by relative paths within the tree", () => {
  assert.ok(existsSync(join(tree, "player-hosts/web-worker.js")), "no dist/thread/: pnpm build");
  const files = modules(tree);
  assert.ok(files.some((f) => f.endsWith("player/workers/thread.js")));

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Statements alone: a comment may quote a "from".
    for (const [, specifier] of source.matchAll(
      /^(?:import|export|})[^"\n]*\bfrom\s*"([^"]+)"/gm,
    )) {
      assert.match(specifier, /^\.\.?\//, `${file} imports ${specifier}`);
      const target = resolve(dirname(file), specifier);
      assert.ok(target.startsWith(tree), `${file} imports ${specifier}, outside the tree`);
      assert.ok(existsSync(target), `${file} imports ${specifier}, which is not there`);
    }

    assert.doesNotMatch(source, /sourceMappingURL/, file);
  }
});
