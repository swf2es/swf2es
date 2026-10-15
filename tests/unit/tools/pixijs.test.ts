import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BROWSER_EXPORTS } from "../../../tools/pixijs.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// What the browser loads with Pixi's bundle: the packages' builds and the test page.
const browserSources = ["packages/player/src", "packages/web/src", "tests/player/page.ts"];

function sources(path: string): string[] {
  if (path.endsWith(".ts")) {
    return [path];
  }

  return readdirSync(join(root, path), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(path, file));
}

/** The names a file imports from "pixi.js" as values, `import type` and `type` members left out. */
function valueImports(text: string): string[] {
  const names: string[] = [];
  for (const [, typeOnly, list] of text.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"pixi\.js"/g,
  )) {
    if (typeOnly) {
      continue;
    }

    for (const member of list.split(",")) {
      const name = member.trim();
      if (name !== "" && !name.startsWith("type ")) {
        names.push(name.split(/\s+as\s+/)[0]);
      }
    }
  }

  return names;
}

test("the Pixi bundle exports just what the browser's sources import from pixi.js", () => {
  const imported = new Set<string>();
  for (const file of browserSources.flatMap(sources)) {
    const text = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(
      text,
      /import\s+\*\s+as\s+\w+\s+from\s+"pixi\.js"|from\s+"pixi\.js\//,
      `${file} imports pixi.js in a way the bundle's list cannot follow`,
    );
    for (const name of valueImports(text)) {
      imported.add(name);
    }
  }

  assert.deepEqual([...BROWSER_EXPORTS].sort(), [...imported].sort());
});
