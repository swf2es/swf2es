// --api-version=root|latest|<SWF version>: the API version the SWFs play
// at (the player's apiVersion), for this run alone. "latest", the default,
// shows every class and member whatever a SWF's version; "root" runs them
// at the root SWF's, as Flash did, which hides what its version predates;
// a number, at a root of that SWF version's. An AIR application stays at
// the latest with "root".
import type { ApiVersion } from "../shared/api.ts";

/** The switch's value from `argv`, the last given winning; an error for one that does not read. */
export function apiVersionArgument(
  argv: readonly string[],
): { apiVersion: ApiVersion } | { error: string } {
  let apiVersion: ApiVersion = "latest";
  for (const arg of argv) {
    const match = /^--api-version(=(.*))?$/i.exec(arg);
    if (!match) {
      continue;
    }

    const value = (match[2] ?? "").trim().toLowerCase();
    if (value === "latest" || value === "root") {
      apiVersion = value;
    } else if (/^\d+$/.test(value) && Number(value) >= 1) {
      apiVersion = Number(value);
    } else {
      return {
        error: `--api-version takes root, latest or a SWF version, as --api-version=root, not ${JSON.stringify(match[2] ?? "")}`,
      };
    }
  }

  return { apiVersion };
}
