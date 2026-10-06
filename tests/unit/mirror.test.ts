import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The player's unit tests mirror its sources (docs/architecture.md, "Source
// layout"): tests/unit/player/<path>.test.ts tests packages/player/src/<path>.ts,
// so that a module's tests are where its path says.
const tests = fileURLToPath(new URL("player/", import.meta.url));
const sources = fileURLToPath(new URL("../../packages/player/src/", import.meta.url));

// Tests that mirror no one file, each with why.
const crossCutting: Record<string, string> = {
  "time.test.ts": "the player's clock and pacing, apart from player.test.ts's frame counts",
  "display/transform.test.ts": "a display object's scales and rotation, apart from display.test.ts",
  "media/timeline-sounds.test.ts": "timeline sounds through the timeline, audio.ts and the player",
};

test("each test under tests/unit/player mirrors a source of the player", () => {
  const files = readdirSync(tests, { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".test.ts"));
  assert.ok(files.length > 0);

  const strays = files.filter(
    (file) =>
      !(file in crossCutting) && !existsSync(`${sources}${file.replace(/\.test\.ts$/, ".ts")}`),
  );
  assert.deepEqual(strays, []);

  const gone = Object.keys(crossCutting).filter((file) => !files.includes(file));
  assert.deepEqual(gone, [], "an allowed test that no longer exists");
});
