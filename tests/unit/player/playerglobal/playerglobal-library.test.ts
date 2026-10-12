import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { build, GENERATED, generated } from "../../../../tools/playerglobal.ts";

// Its own: node runs test files at once, and a build empties its folder first.
const out = fileURLToPath(new URL("../../out/player-playerglobal-library/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

test("playerglobal-library.ts is what as3/playerglobal compiles to", { skip }, () => {
  assert.equal(readFileSync(GENERATED, "utf8"), generated(build(out)), "run pnpm as3:playerglobal");
});
