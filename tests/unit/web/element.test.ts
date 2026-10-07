import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defineElement,
  parseColor,
  parseFlashVars,
  scriptAccess,
} from "../../../packages/web/dist/element.js";

test("bgcolor is #RRGGBB or RRGGBB, nothing else", () => {
  assert.equal(parseColor("#FF8000"), 0xff8000);
  assert.equal(parseColor(" 00ff00 "), 0x00ff00);
  assert.equal(parseColor("red"), null);
  assert.equal(parseColor("#fff"), null);
  assert.equal(parseColor(null), null);
});

test("FlashVars are URL-encoded pairs, the last of a name winning", () => {
  assert.deepEqual(parseFlashVars("a=1&b=two%20words&c=x+y&a=3&empty="), {
    a: "3",
    b: "two words",
    c: "x y",
    empty: "",
  });
  assert.deepEqual(parseFlashVars(null), {});
});

test("allowScriptAccess: always, never, and by default the page's own origin", () => {
  const page = "https://site.test/game/index.html";
  assert.equal(scriptAccess("always", "https://cdn.test/a.swf", page), true);
  assert.equal(scriptAccess("NEVER", "a.swf", page), false);
  assert.equal(scriptAccess(null, "movies/a.swf", page), true);
  assert.equal(scriptAccess("sameDomain", "https://site.test/x/a.swf", page), true);
  assert.equal(scriptAccess("samedomain", "https://cdn.test/a.swf", page), false);
  assert.equal(scriptAccess(null, "http://site.test/a.swf", page), false);
  // Opaque origins are "null" both, and are no one's domain.
  assert.equal(scriptAccess(null, "blob:null/1", "blob:null/2"), false);
});

test("the element is not defined where there is no registry, as in an extension's isolated world", () => {
  assert.equal(defineElement(), false);
  const global = globalThis as { customElements?: unknown };
  global.customElements = null;
  try {
    assert.equal(defineElement(), false);
  } finally {
    delete global.customElements;
  }
});
