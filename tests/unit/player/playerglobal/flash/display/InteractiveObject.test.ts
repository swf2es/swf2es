import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { playerNatives } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

// A menu or a request set reads back, and anything else throws #1034: the
// `small-natives` player case, which needs the classes loaded.
test("an object's contextMenu, and a menu's link, are null at first and after null or undefined", async () => {
  const s = new Scripting(await createCodegen(wasm));
  const natives = playerNatives(s);
  for (const [cls, name] of [
    ["flash.display::InteractiveObject", "contextMenu"],
    ["flash.ui::ContextMenu", "link"],
  ]) {
    const get = natives[`${cls}#get:${name}`](s.rt);
    const set = natives[`${cls}#set:${name}`](s.rt);
    const o = {};
    assert.equal(get.call(o), null);
    set.call(o, undefined);
    assert.equal(get.call(o), null);
    set.call(o, null);
    assert.equal(get.call(o), null);
  }
});
