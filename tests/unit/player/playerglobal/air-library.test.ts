import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { compileAirLibrary, GENERATED, generated } from "../../../player/air-library.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../out/player-air-library/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

test("air-library.ts is what its .as files compile to", { skip }, () => {
  assert.equal(
    readFileSync(GENERATED, "utf8"),
    generated(compileAirLibrary(out)),
    "run node tests/player/air-library.ts --update",
  );
});
