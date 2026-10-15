// Where Electron and the built app are, for launch.ts and the smoke test.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The Electron binary, or null where `pnpm install` skipped its download.
 * Read from the package's path.txt and dist/, not by requiring it: its
 * index.js downloads the binary when it is missing, which would make a
 * check for it the download it is meant to avoid.
 */
export function electronBinary(): string | null {
  try {
    const root = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
    const name = readFileSync(join(root, "path.txt"), "utf8");
    const path = join(root, "dist", name);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Why the app cannot start yet, or null. */
export function missing(): string | null {
  if (!electronBinary()) {
    return "Electron is not downloaded: run `pnpm --filter @swf2es/desktop fetch-electron` once.";
  }

  if (!existsSync(`${here}dist/main/main.js`)) {
    return "The app is not built: run `pnpm build`.";
  }

  return null;
}
