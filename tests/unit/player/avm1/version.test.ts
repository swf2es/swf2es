// AIR's adl with the SWF as the application's main content: the usual
// Flash harness loads an AVM1Movie, which has no initial $version.
import assert from "node:assert/strict";
import { test } from "node:test";
import { platformCapabilities } from "../../../../packages/player/dist/hosts.js";
import { play, take } from "./network.ts";

const source = `
var original = $version;
trace("type " + typeof original);
trace("root " + (_root.$version == original));
trace("absolute " + (getVersion() == original));
trace("global " + typeof _global.$version);
trace("function " + typeof getVersion);
trace("prototype " + typeof MovieClip.prototype.$version);
trace("case " + ($VERSION == original));
var seen = false;
for (var k in this) { if (k == "$version") { seen = true; } }
trace("enumerated " + seen);
function localVersion() {
  var $version = "local";
  trace("local " + $version);
  trace("absolute in function " + (getVersion() == original));
}
localVersion();
$version = "changed";
trace("write " + getVersion());
trace("delete " + delete $version);
trace("after " + typeof $version);
trace("absolute after " + typeof getVersion());
`;

for (const version of [5, 6, 7, 8]) {
  test(`SWF ${version} reads, shadows, writes and deletes the main timeline's $version`, async () => {
    const played = await play(source, {}, version);
    assert.deepEqual(take(played), [
      "type string",
      "root true",
      "absolute true",
      "global undefined",
      "function undefined",
      "prototype undefined",
      `case ${version <= 6}`,
      "enumerated true",
      "local local",
      "absolute in function true",
      "write changed",
      "delete true",
      "after undefined",
      "absolute after undefined",
    ]);
    played.player.destroy();
  });
}

for (const version of [4, 5, 6, 7, 8]) {
  test(`SWF ${version} reports the same platform and player version as AS3`, async () => {
    const played = await play(`trace($version); trace(getVersion());`, {}, version);
    assert.deepEqual(take(played), Array(2).fill(platformCapabilities().version));
    played.player.destroy();
  });
}

test("child clips have no own $version, while getVersion reads the main timeline", async () => {
  const played = await play(`
var child = createEmptyMovieClip("child", 1);
trace(typeof child.$version);
trace(this.hasOwnProperty("$version"));
trace(child.hasOwnProperty("$version"));
child.$version = "child";
tellTarget("child") {
  trace($version);
  trace(getVersion() == _level0.$version);
}
trace($version != child.$version);
`);
  assert.deepEqual(take(played), ["undefined", "true", "false", "child", "true", "true"]);
  played.player.destroy();
});
