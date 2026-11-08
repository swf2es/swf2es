// Sets the version of every published package (tools/notices.ts'
// PUBLIC_PACKAGES) at once, as they are released together: a page or a
// project takes them all at one version.
//
//   node tools/version.ts <version>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PACKAGES } from "./notices.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = process.argv[2] ?? "";
// Semver's form, a prerelease's or build's suffix included.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node tools/version.ts <version>, as 0.1.1 or 0.2.0-beta.1");
  process.exit(2);
}

for (const name of PUBLIC_PACKAGES) {
  const path = join(root, `packages/${name}/package.json`);
  const text = readFileSync(path, "utf8");
  // In place, so that the file keeps its layout and nothing else changes.
  const next = text.replace(/^(\s*"version": )"[^"]*"/m, `$1"${version}"`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error(`packages/${name}/package.json has no version to set`);
  }

  writeFileSync(path, next);
}

console.log(`${PUBLIC_PACKAGES.length} packages at ${version}`);
