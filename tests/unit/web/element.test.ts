import assert from "node:assert/strict";
import { test } from "node:test";
import { defineElement } from "../../../packages/web/dist/element.js";

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
