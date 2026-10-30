import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type Avmshell,
  compatibility,
  isAirVersion,
  ownerOf,
  PACKAGE_LEVEL,
  playerglobalAbc,
  readUnimplemented,
  type Standing,
  scoreApi,
  scoreCorpus,
  scoreTamarin,
} from "../../../apps/site/compatibility.ts";
import { AIR_KEPT, AIR_ONLY } from "../../../tools/playerglobal-air.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const abc = playerglobalAbc(
  readFileSync(`${root}packages/player/src/playerglobal/playerglobal-library.ts`, "utf8"),
);
const allowlist = JSON.parse(
  readFileSync(`${root}tests/unit/player/playerglobal/unimplemented-natives.json`, "utf8"),
);

const shell = (passed: number | null, failed: number | null, exitCode = 0): Avmshell => ({
  compiled: true,
  exitCode,
  passed,
  failed,
});
const ours = (passed: number, failed: number, exitCode: number | null = 0, error = null) => ({
  passed,
  failed,
  exitCode,
  error,
});

test("Tamarin is scored as swf2es.ts scores it, the uncompared and varying tests left out", () => {
  const relaxed = { ...ours(1, 0), passed: null, failed: null };
  const score = scoreTamarin(
    {
      "ecma3/a": shell(3, 0),
      "ecma3/b": shell(3, 1),
      "ecma3/Date/c": shell(null, null),
      "as3/d": shell(2, 0, 1),
      "as3/e": shell(5, 0),
      "e4x/f": shell(4, 0),
      "mmgc/g": shell(1, 0),
      "misc/h": shell(1, 0),
      "spidermonkey/i": shell(1, 0),
      "regress/j": { compiled: false, exitCode: null, passed: 0, failed: 0 },
      "regress/k": shell(4, 0),
      "regress/l": shell(2, 0),
    },
    {
      "ecma3/a": ours(3, 0),
      // Other checks failed.
      "ecma3/b": ours(3, 2),
      "ecma3/Date/c": ours(9, 9),
      // Ended otherwise.
      "as3/d": ours(2, 0, 0),
      // Fewer checks passed.
      "as3/e": ours(4, 0),
      "e4x/f": { ...ours(4, 0, null), error: "RangeError: Invalid array length" },
      "mmgc/g": ours(1, 0),
      "misc/h": ours(1, 0),
      "spidermonkey/i": null,
      // Its counts relaxed, so not compared: it ended as avmshell did.
      "regress/k": relaxed,
      // regress/l is not in the baseline, which swf2es.ts fails a run for.
    },
  );

  assert.deepEqual(score.all, { done: 4, of: 9 });
  assert.equal(score.compiled, 11);
  assert.deepEqual(score.uncounted, ["ecma3/Date/c"]);
  assert.deepEqual(score.varying, ["spidermonkey/i"]);
  assert.deepEqual(score.unrecorded, ["regress/l"]);
  assert.deepEqual(
    score.suites.map((s) => [s.name, s.tests.done, s.tests.of]),
    [
      ["ecma3", 1, 2],
      ["as3", 0, 2],
      ["e4x", 0, 1],
      ["regress", 1, 2],
      ["other", 2, 2],
    ],
  );
  assert.deepEqual(score.suites.at(-1)?.dirs, ["misc", "mmgc"]);
  assert.equal(score.reasons.length, 5);
  assert.ok(score.reasons.every((r) => r.tests === 1));
  assert.ok(score.reasons.some((r) => r.reason === "Not in swf2es' baseline"));
});

test("the corpus: a test passes only when every line matched and nothing more was traced", () => {
  const entry = (matched: number, lines: number, traced: number, error: string | null = null) =>
    ({ matched, lines, traced, error }) satisfies Standing;
  const unimplemented = readUnimplemented({
    "//": "a comment",
    shaders: { why: "Pixel Bender.", natives: ["flash.display::ShaderJob#start"] },
    flash: {
      why: "Small ones.",
      natives: ["flash.desktop::Clipboard#flash.desktop:Clipboard::getString"],
    },
  });
  const stop = (native: string) => `Error: swf2es: native ${native} is not supported yet`;
  const score = scoreCorpus(
    {
      "avm1/a": entry(3, 3, 3),
      "avm1/b": entry(3, 3, 4),
      "avm2/c": entry(2, 2, 2, "TypeError: Error #1009"),
      "avm2/d": entry(1, 5, 1, stop("flash.display::ShaderJob#start")),
      "avm2/e": entry(0, 5, 0, stop("flash.display::ShaderJob#start")),
      "avm2/f": entry(0, 1, 0, stop("flash.desktop::Clipboard#flash.desktop:Clipboard::getString")),
      "avm2/g": entry(
        0,
        1,
        0,
        "Error: swf2es: NetConnection.call, Flash Remoting is not supported yet",
      ),
      "timeline/h": entry(0, 2, 2),
      "timeline/i": null,
      // An empty error is none, as run.ts's passed() reads it.
      "timeline/j": entry(1, 1, 1, ""),
    },
    unimplemented,
  );

  assert.deepEqual(score.all, { tests: { done: 2, of: 9 }, lines: { done: 10, of: 23 } });
  assert.equal(score.varying, 1);
  assert.deepEqual(
    score.areas.map((a) => [a.name, a.tests.done, a.tests.of, a.lines.done, a.lines.of]),
    [
      ["avm1", 1, 2, 6, 6],
      ["avm2", 0, 5, 3, 14],
      ["timeline", 1, 2, 1, 3],
    ],
  );
  assert.deepEqual(score.stoppers, [
    {
      group: "shaders",
      why: "Pixel Bender.",
      tests: 2,
      classes: [["flash.display::ShaderJob", 2]],
    },
    { group: "flash", why: "Small ones.", tests: 1, classes: [["flash.desktop::Clipboard", 1]] },
  ]);
  assert.equal(score.otherUnsupported, 1);
});

test("a native belongs to its class, whatever its namespace, or is its own outside one", () => {
  assert.equal(ownerOf("flash.display::ShaderJob#get:shader"), "flash.display::ShaderJob");
  assert.equal(
    ownerOf("flash.display::Stage.get:supportsOrientationChange"),
    "flash.display::Stage",
  );
  assert.equal(
    ownerOf("flash.desktop::Clipboard#flash.desktop:Clipboard::getString"),
    "flash.desktop::Clipboard",
  );
  assert.equal(ownerOf("flash.sampler::getSize"), "flash.sampler::getSize");
  assert.equal(ownerOf("adobe.utils::MMExecute"), "adobe.utils::MMExecute");
});

test("API versions: Flash Player's and AIR's interleave as avmplus numbers them", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 7, 8, 10, 11, 14, 15].map(isAirVersion), [
    false,
    true,
    false,
    true,
    false,
    false,
    true,
    false,
    true,
    false,
    true,
  ]);
});

test("the API: with no native listed every member is implemented, AIR's left out", () => {
  const score = scoreApi(abc, readUnimplemented({}));

  assert.ok(score.members.of > 2000);
  assert.deepEqual(score.members.done, score.members.of);
  assert.deepEqual(score.classes.done, score.classes.of);
  assert.ok(score.air > 0);
  const names = score.packages.flatMap((p) => p.rows.map((r) => `${p.name}::${r.name}`));
  for (const air of AIR_ONLY) {
    assert.ok(!names.includes(air), `${air} is AIR's`);
  }

  // Kept on the web, so scored as a SWF there sees them.
  for (const kept of AIR_KEPT) {
    assert.ok(names.includes(kept), `${kept} is the web's`);
  }

  assert.ok(!names.some((n) => n.startsWith("flash.filesystem::")), "flash.filesystem is AIR's");
  assert.ok(names.includes("flash.display::Sprite"));
});

test("the API: each listed native is declared, and leaves its member missing", () => {
  const unimplemented = readUnimplemented(allowlist);
  const score = scoreApi(abc, unimplemented);
  const row = (pkg: string, name: string) =>
    score.packages.find((p) => p.name === pkg)?.rows.find((r) => r.name === name);

  assert.deepEqual(score.unmatched, []);
  assert.deepEqual(row("flash.display", "Sprite")?.missing.sort(), [
    "startTouchDrag",
    "stopTouchDrag",
  ]);
  // A static getter and a property's two accessors are one member each.
  const job = row("flash.printing", "PrintJob");
  assert.ok(job?.missing.includes("static isSupported"));

  for (const p of score.packages) {
    for (const r of p.rows) {
      assert.equal(new Set(r.missing).size, r.missing.length, `${p.name}::${r.name} once each`);
    }
  }

  assert.equal(row("flash.geom", "Matrix")?.missing.length, 0);
  assert.ok(row("flash.net", PACKAGE_LEVEL));

  // Every native listed but AIR's is a member counted missing somewhere.
  const missing = score.packages.reduce((n, p) => n + p.members.of - p.members.done, 0);
  const listed = [...unimplemented.group.values()].filter((g) => g !== "air").length;
  assert.ok(missing > 0 && missing <= listed, `${missing} missing, ${listed} listed`);
  assert.deepEqual(
    score.members.of - score.members.done,
    missing,
    "the packages add up to the whole",
  );
});

test("every figure the page shows comes out of the repository", () => {
  const c = compatibility(root);

  assert.ok(c.tamarin.all.done > 0 && c.tamarin.all.done <= c.tamarin.all.of);
  assert.deepEqual(
    c.tamarin.suites.map((s) => s.name),
    ["ecma3", "spidermonkey", "as3", "e4x", "regress", "other"],
  );
  assert.deepEqual(
    c.corpus.areas.map((a) => a.name),
    ["avm1", "avm2", "timeline"],
  );
  assert.ok(c.corpus.all.tests.done > 0);
  assert.ok(c.api.members.done > 0);
  assert.ok(c.groups.textEngine.natives > 0);
});
