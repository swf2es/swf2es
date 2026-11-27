// View › Sharp Bitmaps, kept in the settings, or --bitmap-resolution=display|stage
// for one run: whether vector art a SWF draws into a BitmapData is kept at the
// screen's resolution rather than Flash's (the renderer's bitmapResolution),
// so that a bitmap the stage's size shown in a large window stays as sharp as
// the stage's own art. Scripts read the same pixels either way.
import type { BitmapResolution } from "../shared/api.ts";

/**
 * --bitmap-resolution's value from `argv`, the last given winning, or null
 * for none; an error for one that does not read.
 */
export function bitmapResolutionArgument(
  argv: readonly string[],
): { bitmapResolution: BitmapResolution | null } | { error: string } {
  let bitmapResolution: BitmapResolution | null = null;
  for (const arg of argv) {
    const match = /^--bitmap-resolution(=(.*))?$/i.exec(arg);
    if (!match) {
      continue;
    }

    const value = (match[2] ?? "").trim().toLowerCase();
    if (value !== "display" && value !== "stage") {
      return {
        error: `--bitmap-resolution takes display or stage, as --bitmap-resolution=display, not ${JSON.stringify(match[2] ?? "")}`,
      };
    }

    bitmapResolution = value;
  }

  return { bitmapResolution };
}
