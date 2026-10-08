// MouseEvent through playerglobal's AS3 constructor and native accessors.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import { Container, ShapeObject } from "../../../../../../packages/player/dist/display/display.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../../../player/libraries.ts";

const out = fileURLToPath(new URL("../../../../out/player-mouse-event/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

test("MouseEvent's native coordinates follow its target while its local point stays put", {
  skip,
}, async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const s = new Scripting(await createCodegen(wasm));
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const rt = s.rt;
  const cls = rt.classNamed("flash.events::MouseEvent");
  const get = (event: avm2.AsObject, key: string) => rt.getProperty(event, rt.publicName(key));
  const set = (event: avm2.AsObject, key: string, value: avm2.Value) =>
    rt.setProperty(event, rt.publicName(key), value);

  const empty = rt.construct(cls, "fake") as avm2.AsObject;
  assert.ok(Number.isNaN(get(empty, "localX")));
  assert.ok(Number.isNaN(get(empty, "stageX")));
  assert.equal(get(empty, "movementX"), 0);

  const event = rt.construct(cls, "click", false, true, 50, 50) as avm2.AsObject;
  assert.equal(get(event, "stageX"), 0);
  assert.equal(get(event, "stageY"), 0);

  const stage = new Container();
  const display = new ShapeObject(null);
  stage.addChildAt(display, 0);
  s.stage = stage;
  event.$target = { $display: display } as avm2.AsObject;
  set(event, "localX", 1);
  set(event, "localY", 2);
  display.setMatrix({ a: 1, b: 2, c: 3, d: 4, tx: 5, ty: 6 });
  assert.deepEqual([get(event, "stageX"), get(event, "stageY")], [12, 16]);
  assert.deepEqual([get(event, "localX"), get(event, "localY")], [1, 2]);
});
