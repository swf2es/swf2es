// Which clips the pointer takes as buttons (avm1/input.ts' buttonMode):
// one with onPress or another of the pointer's methods, its own, a
// prototype's however it came by it, or a child of that name, in any case
// up to SWF 6; none once it is deleted, nor the root. The runtime marks
// the objects ever given one of the names, and buttonMode asks only them:
// these hold whichever object along the chain gains or loses one, and
// when.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MovieClip } from "../../../../packages/player/dist/display/display.js";
import { play } from "./network.ts";

/** Whether clip `name` is a button once `source` has run after clips c0 and c1 are made, in a SWF of `version`. */
async function button(source: string, name = "c0", version = 8): Promise<boolean> {
  const p = await play(
    `_root.createEmptyMovieClip("c0", 0); _root.createEmptyMovieClip("c1", 1);
    ${source}
    stop();`,
    {},
    version,
  );
  assert.deepEqual(p.errors, []);
  const clip =
    name === "_root" ? p.player.root : p.player.root.children.find((d) => d.name === name);
  assert.ok(clip);
  return p.avm1.input.buttonMode(clip as MovieClip);
}

test("a clip's own pointer methods make it a button, until they are deleted", async () => {
  assert.equal(await button(""), false);
  assert.equal(await button("c0.onRelease = function() {};"), true);
  assert.equal(await button("c0.onRelease = function() {}; delete c0.onRelease;"), false);
  // Another clip's do not.
  assert.equal(await button("c1.onPress = function() {};"), false);
  // The root is never one.
  assert.equal(await button("_root.onPress = function() {};", "_root"), false);
});

test("a prototype's pointer methods make a clip a button, whenever it gains them", async () => {
  assert.equal(await button("var plain = {}; c0.__proto__ = plain;"), false);
  assert.equal(
    await button("var plain = {}; c0.__proto__ = plain; plain.onPress = function() {};"),
    true,
  );
  assert.equal(
    await button("var marked = {onRollOver: function() {}}; c0.__proto__ = marked;"),
    true,
  );
  assert.equal(
    await button(
      "var marked = {onRollOver: 1}; c0.__proto__ = marked; c0.__proto__ = MovieClip.prototype;",
    ),
    false,
  );
  // MovieClip's prototype, for every clip; then gone again.
  assert.equal(await button("MovieClip.prototype.onDragOut = function() {};", "c1"), true);
  assert.equal(
    await button(
      "MovieClip.prototype.onDragOut = function() {}; delete MovieClip.prototype.onDragOut;",
      "c1",
    ),
    false,
  );
});

test("a child named as a pointer method makes a clip a button", async () => {
  assert.equal(await button('c0.createEmptyMovieClip("onPress", 1);'), true);
  assert.equal(await button('c0.createEmptyMovieClip("pressed", 1);'), false);
});

test("names are exact from SWF 7, and of any case up to SWF 6", async () => {
  assert.equal(await button("c0.ONRELEASE = function() {};"), false);
  assert.equal(await button('c0.createEmptyMovieClip("ONPRESS", 1);'), false);
  assert.equal(await button("c0.ONRELEASE = function() {};", "c0", 6), true);
  assert.equal(await button('c0.createEmptyMovieClip("OnPress", 1);', "c0", 6), true);
  assert.equal(await button("var shouty = {ONROLLOUT: 1}; c0.__proto__ = shouty;", "c0", 6), true);
  assert.equal(await button("", "c0", 6), false);
});
