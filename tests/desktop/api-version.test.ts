// --api-version (apps/desktop/src/main/api-version.ts): the API version the
// desktop app's SWFs play at, read from the command line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiVersionArgument } from "../../apps/desktop/src/main/api-version.ts";

test("--api-version reads root, latest and SWF versions, the last winning", () => {
  assert.deepEqual(apiVersionArgument(["file.swf"]), { apiVersion: "latest" });
  assert.deepEqual(apiVersionArgument(["--api-version=root"]), { apiVersion: "root" });
  assert.deepEqual(apiVersionArgument(["--API-VERSION=Latest"]), { apiVersion: "latest" });
  assert.deepEqual(apiVersionArgument(["--api-version=12", "file.swf"]), { apiVersion: 12 });
  assert.deepEqual(apiVersionArgument(["--api-version=root", "--api-version=30"]), {
    apiVersion: 30,
  });
});

test("--api-version refuses what does not read", () => {
  for (const arg of [
    "--api-version",
    "--api-version=",
    "--api-version=0",
    "--api-version=1.5",
    "--api-version=newest",
  ]) {
    assert.ok("error" in apiVersionArgument([arg]), arg);
  }
});
