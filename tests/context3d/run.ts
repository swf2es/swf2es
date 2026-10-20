import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${here}out/`;
mkdirSync(out, { recursive: true });
libraryAbcs();
const abc = compileScripts(
  [{ name: "Triangle", source: readFileSync(`${here}Triangle.as`, "utf8") }],
  out,
).get("Triangle");
assert.ok(abc);
writeFileSync(`${out}Triangle.swf`, bare(abc, 1, "Triangle", 64, 64));
if (!process.argv.includes("--build-only")) {
  const reference: string[] = JSON.parse(readFileSync(`${here}reference.json`, "utf8"));
  await withPage(
    "runSwf",
    async (evaluate) => {
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
