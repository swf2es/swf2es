// AVM1's names of display objects: their dot and slash paths, children by
// instance name in either case, and a path found again.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atPath,
  childByName,
  pathOf,
  slashPathOf,
  under,
} from "../../../../packages/player/dist/avm1/paths.js";
import { Container, DisplayObject } from "../../../../packages/player/dist/display/display.js";

/** A root with `a` holding `b`, and an unnamed shape. */
function tree() {
  const root = new Container();
  const a = new Container();
  a.name = "a";
  const b = new Container();
  b.name = "Bee";
  const shape = new DisplayObject();
  root.placeAtDepth(a, 1);
  root.placeAtDepth(shape, 2);
  a.placeAtDepth(b, 1);
  return { root, a, b, shape };
}

test("a display object's dot path starts at _level0, its slash path at /", () => {
  const { root, a, b } = tree();

  assert.equal(pathOf(root, root), "_level0");
  assert.equal(pathOf(b, root), "_level0.a.Bee");
  assert.equal(slashPathOf(root, root), "/");
  assert.equal(slashPathOf(b, root), "/a/Bee");
  assert.equal(slashPathOf(a, root), "/a");
});

test("a child is found by its name, in any case where names are not case-sensitive, a nameless one never", () => {
  const { root, a, b } = tree();

  assert.equal(childByName(a, "Bee", true), b);
  assert.equal(childByName(a, "bee", true), null);
  assert.equal(childByName(a, "BEE", false), b);
  assert.equal(childByName(root, "", false), null);
});

test("a path is found again from the root, and what is under the root is on its list", () => {
  const { root, a, b } = tree();

  assert.equal(atPath("_level0.a.Bee", root, true), b);
  assert.equal(atPath("_level0.a.bee", root, true), null);
  assert.equal(atPath("_level1.a", root, true), null);
  assert.ok(under(b, root));
  a.removeChild(b);
  assert.ok(!under(b, root));
});
