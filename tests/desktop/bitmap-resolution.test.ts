// The desktop app's --bitmap-resolution (apps/desktop/src/main/bitmap-resolution.ts), read from
// the command line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bitmapResolutionArgument } from "../../apps/desktop/src/main/bitmap-resolution.ts";

test("--bitmap-resolution reads display and stage, the last winning", () => {
  assert.deepEqual(bitmapResolutionArgument(["file.swf"]), { bitmapResolution: null });
  assert.deepEqual(bitmapResolutionArgument(["--bitmap-resolution=display", "file.swf"]), {
    bitmapResolution: "display",
  });
  assert.deepEqual(bitmapResolutionArgument(["--BITMAP-RESOLUTION=Stage"]), {
    bitmapResolution: "stage",
  });
  assert.deepEqual(
    bitmapResolutionArgument(["--bitmap-resolution=display", "--bitmap-resolution=stage"]),
    { bitmapResolution: "stage" },
  );
  assert.deepEqual(bitmapResolutionArgument(["--bitmap-resolutions=display"]), {
    bitmapResolution: null,
  });
});

test("--bitmap-resolution refuses what does not read", () => {
  for (const arg of ["--bitmap-resolution", "--bitmap-resolution=", "--bitmap-resolution=high"]) {
    assert.ok("error" in bitmapResolutionArgument([arg]), arg);
  }
});
