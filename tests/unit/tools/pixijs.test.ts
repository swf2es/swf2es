import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BROWSER_EXPORTS } from "../../../tools/pixijs.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const sourceFile = /\.[cm]?ts$/;

// What the browser may load with Pixi's bundle: every package's and app's
// sources, as a new file anywhere in them is one the player or the desktop
// app's renderer may import, and the test pages.
const browserSources = [
  ...["packages", "apps"].flatMap((dir) =>
    readdirSync(join(root, dir)).map((name) => join(dir, name, "src")),
  ),
  "tests/player/page.ts",
  "tests/web/page.ts",
];

function sources(path: string): string[] {
  if (sourceFile.test(path)) {
    return [path];
  }

  return readdirSync(join(root, path), { recursive: true, encoding: "utf8" })
    .filter((file) => sourceFile.test(file))
    .map((file) => join(path, file));
}

/**
 * The names a file imports or re-exports from "pixi.js" as values, `type`
 * ones left out.
 */
function valueImports(text: string): string[] {
  const names: string[] = [];
  for (const [, typeOnly, list] of text.matchAll(
    /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*"pixi\.js"/g,
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
      /(?:import|export)\s+\*(?:\s+as\s+\w+)?\s+from\s+"pixi\.js"|from\s+"pixi\.js\/|import\(\s*"pixi\.js/,
      `${file} imports pixi.js in a way the bundle's list cannot follow`,
    );
    for (const name of valueImports(text)) {
      imported.add(name);
    }
  }

  assert.deepEqual([...BROWSER_EXPORTS].sort(), [...imported].sort());
});
