import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${here}out/`;
mkdirSync(out, { recursive: true });
libraryAbcs();
const scripts = compileScripts(
  ["Triangle", "Composition"].map((name) => ({
    name,
    source: readFileSync(`${here}${name}.as`, "utf8"),
  })),
  out,
);
for (const name of ["Triangle", "Composition"]) {
  const abc = scripts.get(name);
  assert.ok(abc);
  const size = name === "Triangle" ? 64 : 96;
  writeFileSync(`${out}${name}.swf`, bare(abc, 1, name, size, size));
}
if (!process.argv.includes("--build-only")) {
  const reference: string[] = JSON.parse(readFileSync(`${here}reference.json`, "utf8"));
  await withPage(
    "runSwf",
    async (evaluate, send) => {
      for (const mode of ["enabled", "fallback", "cancel"]) {
        const result = await evaluate<{ trace: string[]; presented: string[]; contexts: number }>(
          `import("/repo/tests/context3d/page.ts").then(m => m.triangle(${JSON.stringify(mode)}))`,
        );
        assert.equal(result.exception, null, JSON.stringify(result));
        assert.ok(result.value);
        if (mode === "enabled") {
          assert.deepEqual(result.value.trace, reference);
          assert.deepEqual(
            result.value.presented,
            ["ffff0000", "ff336699"],
            "presented buffer changed after clear",
          );
          assert.equal(result.value.contexts, 1);
        } else {
          assert.equal(result.value.contexts, 0);
          assert.deepEqual(result.value.trace, [
            "request",
            "request-returned null",
            ...(mode === "fallback" ? ["context-error 3702"] : []),
          ]);
        }
        console.log(`context3d: ${mode} ok`);
      }
      const result = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.lifetime())',
      );
      assert.equal(result.exception, null, JSON.stringify(result));
      assert.equal(result.value?.passed, true);
      console.log("context3d: ownership, failed uploads, resize, disposal and context loss ok");
      const composition: { points: number[][]; samples: string[][] } = JSON.parse(
        readFileSync(`${here}composition-reference.json`, "utf8"),
      );
      try {
        const started = await evaluate(
          'import("/repo/tests/context3d/page.ts").then(m => m.composition())',
        );
        assert.equal(started.exception, null, JSON.stringify(started));
        for (let step = 0; step < composition.samples.length; step++) {
          const advanced = await evaluate(
            `import("/repo/tests/context3d/page.ts").then(m => m.compositionStep(${step}))`,
          );
          assert.equal(advanced.exception, null, JSON.stringify(advanced));
          const capture = (await send("Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width: 96, height: 96, scale: 1 },
          })) as { data: string };
          const png = Buffer.from(capture.data, "base64");
          writeFileSync(`${out}composition-${step}.png`, png);
          const image = decodePng(png);
          assert.equal(image.width, 96);
          assert.equal(image.height, 96);
          for (let point = 0; point < composition.points.length; point++) {
            const [x, y] = composition.points[point];
            const expected = Buffer.from(composition.samples[step][point], "hex");
            const actual = image.data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4);
            for (let channel = 0; channel < 4; channel++) {
              assert.ok(
                Math.abs(actual[channel] - expected[channel]) <= 1,
                `composition step ${step}, (${x}, ${y}): ${actual} != ${expected}`,
              );
            }
          }
        }

        console.log("context3d: Stage3D composition matches AIR (9 states, 8 points each)");
      } finally {
        const closed = await evaluate(
          'import("/repo/tests/context3d/page.ts").then(m => m.closeComposition())',
        );
        assert.equal(closed.exception, null, JSON.stringify(closed));
      }
    },
    false,
    {
      mounts: [
        ["/repo/", root],
        ["/context3d/", out],
      ],
    },
  );
}
