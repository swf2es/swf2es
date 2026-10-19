// AVM1 input fields: native focus and edits, variable bindings, and onChanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TextObject } from "../../../../packages/player/dist/display/display.js";
import { play, take } from "./network.ts";

const source = `
createTextField("name", 1, 10, 10, 180, 25);
name.type = "input"; name.variable = "heroName";
name.onChanged = function(t) { trace(t._name + ":" + t.text + ":" + heroName); };
stop();`;

test("a mouse click focuses a blank input field; typing updates its variable before onChanged", async () => {
  const p = await play(source);
  const field = p.player.root.children.find((d) => d.name === "name");
  assert.ok(field instanceof TextObject);
  const pointer = p.player.pointer;
  assert.ok(pointer);
  pointer.handle("down", { x: 20, y: 20 });
  pointer.handle("up", { x: 20, y: 20 });
  assert.equal(p.avm1.focused, field);
  const keyboard = p.player.keyboard;
  assert.ok(keyboard);
  for (const c of "Maximus") {
    keyboard.handle("down", { keyCode: c.toUpperCase().charCodeAt(0), charCode: c.charCodeAt(0) });
  }
  assert.equal(field.model.text, "Maximus");
  assert.equal(take(p).at(-1), "name:Maximus:Maximus");
  keyboard.handle("down", { keyCode: 37, charCode: 0 });
  keyboard.handle("down", { keyCode: 8, charCode: 0 });
  assert.equal(field.model.text, "Maxims");
  assert.deepEqual(take(p), ["name:Maxims:Maxims"]);
  pointer.handle("down", { x: 220, y: 40 });
  pointer.handle("up", { x: 220, y: 40 });
  assert.equal(p.avm1.focused, null);
  keyboard.handle("down", { keyCode: 65, charCode: 97 });
  assert.equal(field.model.text, "Maxims");
  assert.deepEqual(take(p), []);
});

test("separate text events, restrict, maxChars, selection and clipboard share the editor", async () => {
  const p = await play(
    `${source}name.restrict = "A-Z"; name.maxChars = 4; Selection.setFocus(name);`,
  );
  const field = p.avm1.focused;
  assert.ok(field instanceof TextObject);
  const k = p.player.keyboard;
  assert.ok(k);
  k.handle("down", { keyCode: 65, charCode: 97 }, false);
  assert.equal(field.model.text, "");
  k.text({ keyCode: 0, charCode: 97 });
  k.paste({ text: "b1cdEF" });
  assert.equal(field.model.text, "ABCD");
  k.handle("down", { keyCode: 65, charCode: 97, ctrlKey: true });
  assert.deepEqual(k.copy(), { text: "ABCD" });
  assert.deepEqual(k.copy(true), { text: "ABCD" });
  assert.equal(field.model.text, "");
  k.paste({ text: "xy" });
  assert.equal(field.model.text, "XY");
  assert.deepEqual(take(p), ["name:A:A", "name:ABCD:ABCD", "name::", "name:XY:XY"]);
});

test("read-only and password fields protect their text; removed fields take no edits", async () => {
  const p = await play(
    `${source}name.text = "secret"; name.password = true; Selection.setFocus(name);`,
  );
  const field = p.avm1.focused;
  assert.ok(field instanceof TextObject);
  const k = p.player.keyboard;
  assert.ok(k);
  assert.equal(k.copy(), null);
  assert.equal(k.copy(true), null);
  field.type = "dynamic";
  k.handle("down", { keyCode: 65, charCode: 97 });
  assert.equal(k.paste({ text: "abc" }), false);
  assert.equal(field.model.text, "secret");
  field.type = "input";
  p.player.root.removeChild(field);
  k.text({ keyCode: 0, charCode: 97 });
  assert.equal(field.model.text, "secret");
  assert.deepEqual(take(p), []);
});

test("text input accepts Unicode code points and an empty field's vertical caret moves", async () => {
  const p = await play(`${source}Selection.setFocus(name);`);
  const k = p.player.keyboard;
  const field = p.avm1.focused;
  assert.ok(k && field instanceof TextObject);
  k.text({ keyCode: 38, charCode: 0 });
  assert.equal(field.caret, 0);
  for (const char of "ą𐞔") {
    k.text({ keyCode: 0, charCode: char.codePointAt(0) ?? 0 });
  }
  assert.equal(field.model.text, "ą𐞔");
  assert.equal(take(p).at(-1), "name:ą𐞔:ą𐞔");
});
