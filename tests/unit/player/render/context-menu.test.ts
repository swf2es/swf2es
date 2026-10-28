// The context menu's own last item, which names the host's build where it gives one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutCaption } from "../../../../packages/player/dist/render/context-menu.js";

test("About names the host's build, and only where it gives one", () => {
  assert.equal(aboutCaption("0123456789ab"), "About swf2es (0123456789ab)");
  assert.equal(aboutCaption(null), "About swf2es");
  assert.equal(aboutCaption(""), "About swf2es");
});
