// AVM1's names of display objects: their dot and slash paths from their
// level, children by instance name in either case, and a path found again.
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
  const levelOf = (d: DisplayObject) => (d === root ? 0 : null);
  return { root, a, b, shape, levelOf };
}

test("a display object's dot path starts at _level0, its slash path at /", () => {
  const { root, a, b, levelOf } = tree();

  assert.equal(pathOf(root, levelOf), "_level0");
  assert.equal(pathOf(b, levelOf), "_level0.a.Bee");
  assert.equal(slashPathOf(root, levelOf), "/");
  assert.equal(slashPathOf(b, levelOf), "/a/Bee");
  assert.equal(slashPathOf(a, levelOf), "/a");
});

test("below another level, the dot path starts at its _levelN and the slash path with its name", () => {
  const { root, a, b } = tree();
  const levelOf = (d: DisplayObject) => (d === root ? 2 : null);

  assert.equal(pathOf(root, levelOf), "_level2");
  assert.equal(pathOf(b, levelOf), "_level2.a.Bee");
  assert.equal(slashPathOf(root, levelOf), "/");
  assert.equal(slashPathOf(b, levelOf), "_level2/a/Bee");
  a.removeChild(b);
  assert.equal(pathOf(b, levelOf), "_level0.Bee");
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
  const level = (n: number) => (n === 0 ? root : null);

  assert.equal(atPath("_level0.a.Bee", level, true), b);
  assert.equal(atPath("_level0.a.bee", level, true), null);
  assert.equal(atPath("_level1.a", level, true), null);
  assert.equal(
    atPath("_level1.a", (n) => (n === 1 ? root : null), true),
    a,
  );
  assert.ok(under(b, root));
  a.removeChild(b);
  assert.ok(!under(b, root));
});
