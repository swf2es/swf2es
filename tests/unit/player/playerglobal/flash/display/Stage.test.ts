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

async function stage(live = true) {
  const scripting = new Scripting(await createCodegen(wasm));
  scripting.liveStageLayout = live;
  const natives = playerNatives(scripting);
  return {
    scripting,
    get: (name: string) => natives[`flash.display::Stage#get:${name}`](scripting.rt).call(null),
    set: (name: string, value: unknown) =>
      natives[`flash.display::Stage#set:${name}`](scripting.rt).call(null, value as never),
  };
}

test("Stage accepts AIR's scale modes and canonicalizes alignment while invalid settings preserve the view", async () => {
  const { scripting, get, set } = await stage();
  try {
    assert.equal(get("scaleMode"), "showAll");
    assert.equal(get("align"), "");
    let changes = 0;
    scripting.onStageLayout = () => {
      changes++;
    };
    for (const value of ["noScale", "exactFit", "noBorder", "showAll"]) {
      set("scaleMode", value);
      assert.equal(get("scaleMode"), value);
    }
    assert.equal(changes, 4);
    for (const value of ["NOSCALE", "noscale", "", "wat", null, undefined]) {
      assert.throws(() => set("scaleMode", value));
      assert.equal(get("scaleMode"), "showAll");
      assert.equal(changes, 4);
    }
    for (const [value, expected] of [
      ["LT", "TL"],
      ["tl", "TL"],
      ["BOTTOM", "TB"],
      ["LR", "LR"],
      ["LTRB", "TBLR"],
      ["hello", "L"],
      ["N", ""],
    ]) {
      set("align", value);
      assert.equal(get("align"), expected);
    }
    assert.throws(() => set("align", null));
    assert.equal(get("align"), "");
  } finally {
    scripting.destroy();
  }
});

test("Stage script settings override embedding defaults independently, including unchanged assignments", async () => {
  const { scripting, get, set } = await stage();
  scripting.setStageDefaults("exactFit", "lt");
  assert.equal(get("scaleMode"), "exactFit");
  assert.equal(get("align"), "TL");
  set("scaleMode", "exactFit");
  scripting.setStageDefaults("noScale", "BR");
  assert.equal(get("scaleMode"), "exactFit");
  assert.equal(get("align"), "BR");
  set("align", "BR");
  scripting.setStageDefaults("showAll", "TL");
  assert.equal(get("scaleMode"), "exactFit");
  assert.equal(get("align"), "BR");
  scripting.onStageLayout = () => {};
  scripting.destroy();
  assert.equal(scripting.onStageLayout, null);
});

test("default Stage layout retains the dev getters, ignored setters and authored dimensions", async () => {
  const { scripting, get, set } = await stage(false);
  try {
    scripting.stageWidth = 96;
    scripting.stageHeight = 96;
    let changes = 0;
    scripting.onStageLayout = () => {
      changes++;
    };
    scripting.setStageDefaults("noScale", "BR");
    for (const value of ["noScale", "NOSCALE", "", null, undefined]) {
      set("scaleMode", value);
      set("align", value);
    }
    scripting.resizeStage(192, 144);
    assert.equal(get("scaleMode"), "showAll");
    assert.equal(get("align"), "");
    assert.equal(scripting.stageWidth, 96);
    assert.equal(scripting.stageHeight, 96);
    assert.equal(changes, 0);
  } finally {
    scripting.destroy();
  }
});
