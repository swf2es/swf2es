// Where Electron and the built app are, for launch.ts and the smoke test.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The Electron binary, or null where `pnpm install` skipped its download. */
export function electronBinary(): string | null {
  try {
    // electron's index.js gives the binary's path, and throws if it was never downloaded.
    const path = createRequire(import.meta.url)("electron") as string;
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
