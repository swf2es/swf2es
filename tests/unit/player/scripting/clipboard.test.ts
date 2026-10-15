// The clipboard's rules: writes in a gesture reach the host once it ends,
// a copy's are the event's to carry, and a host's failure stays its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Clipboard } from "../../../../packages/player/dist/scripting/clipboard.js";

test("a gesture's writes reach the host once the outermost ends; a copy's do not", () => {
  const written: unknown[] = [];
  const clipboard = new Clipboard({ write: (data) => written.push(data) });
  clipboard.gesture(() => {
    clipboard.gesture(() => clipboard.set("air:text", "one"));
    assert.deepEqual(written, []);
  });
  assert.deepEqual(written, [{ text: "one" }]);

  assert.deepEqual(
    clipboard.collect(() => clipboard.set("air:text", "two")),
    { text: "two" },
  );
  assert.equal(written.length, 1);
});

test("a host whose write throws leaves the gesture's result as it was", () => {
  const clipboard = new Clipboard({
    write: () => {
      throw new Error("refused");
    },
  });
  assert.equal(
    clipboard.gesture(() => {
      clipboard.set("air:text", "one");
      return 7;
    }),
    7,
  );
  assert.equal(clipboard.data.text, "one");
});
