// Keys to the focused object or the stage, an input field's editing, and focus moving.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Container,
  type DisplayObject,
  TextObject,
} from "../../../packages/player/dist/display.js";
import { KeyboardInput, restricted, setFocus } from "../../../packages/player/dist/keyboard.js";
import type { Scripting } from "../../../packages/player/dist/scripting.js";

type Event = {
  cls: string;
  $type: string;
  $cancelable: boolean;
  $prevented: boolean;
  $stopped: number;
  args: unknown[];
};

/** A stage with input fields, a scripting that makes events as records, and what each object heard. */
function setUp(...names: string[]) {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  const heard: string[] = [];
  const listen = (d: DisplayObject, type: string, f: (e: Event) => void = () => {}) => {
    const object = d.object as { $listeners?: Map<string, unknown[]> };
    object.$listeners ??= new Map();
    const list = object.$listeners.get(type) ?? [];
    list.push({ fn: { $f: (_: unknown, e: Event) => f(e) }, capture: false, priority: 0 });
    object.$listeners.set(type, list);
  };
  const fields = names.map((name, i) => {
    const field = new TextObject(null);
    field.name = name;
    field.type = "input";
    field.object = { $display: field } as never;
    field.matrix.ty = i * 30;
    stage.addChildAt(field, i);
    return field;
  });
  const scripting = {
    focus: null,
    rt: {
      classNamed: (name: string) => ({ name }),
      construct: (
        cls: { name: string },
        type: string,
        bubbles: boolean,
        cancelable: boolean,
        ...args: unknown[]
      ) => ({
        cls: cls.name.replace(/^.*::/, ""),
        $type: type,
        $bubbles: bubbles,
        $cancelable: cancelable,
        $prevented: false,
        $stopped: 0,
        args,
      }),
      call: (fn: { $f: (self: unknown, event: unknown) => void }, self: unknown, event: unknown) =>
        fn.$f(self, event),
    },
  } as unknown as Scripting;
  const keyboard = new KeyboardInput(stage, scripting);
  const type = (text: string) => {
    for (const c of text) {
      keyboard.handle("down", {
        keyCode: c.toUpperCase().charCodeAt(0),
        charCode: c.charCodeAt(0),
      });
    }
  };
  return { stage, fields, scripting, keyboard, heard, listen, type };
}

test("restrict reads characters, ranges, ^ excluding what follows, and \\ escaping", () => {
  assert.equal(restricted(null, "x"), true);
  assert.equal(restricted("", "x"), false);
  assert.equal(restricted("A-Z", "Q"), true);
  assert.equal(restricted("A-Z", "q"), false);
  assert.equal(restricted("^0-9", "5"), false);
  assert.equal(restricted("^0-9", "a"), true);
  assert.equal(restricted("a-z^q", "q"), false);
  assert.equal(restricted("a-z^q", "r"), true);
  assert.equal(restricted("0-9\\-", "-"), true);
  assert.equal(restricted("0-9\\-", "+"), false);
});

test("a key goes to the focused field and bubbles to the stage; with no focus, to the stage", () => {
  const { stage, fields, scripting, keyboard, heard, listen } = setUp("name");
  const [field] = fields;
  listen(field, "keyDown", (e) => heard.push(`field ${e.args[1]}`));
  listen(stage, "keyDown", () => heard.push("stage"));

  keyboard.handle("down", { keyCode: 65, charCode: 97 });
  setFocus(scripting, field);
  keyboard.handle("down", { keyCode: 66, charCode: 98 });
  assert.deepEqual(heard, ["stage", "field 66", "stage"]);
  assert.equal(field.model.text, "b");
});

test("typing edits the focused field: a TextEvent a listener may cancel, then Event.CHANGE", () => {
  const { fields, scripting, heard, listen, type } = setUp("name");
  const [field] = fields;
  setFocus(scripting, field);
  listen(field, "textInput", (e) => {
    heard.push(`text ${e.args[0]}`);
    if (e.args[0] === "x") {
      e.$prevented = true;
    }
  });
  listen(field, "change", () => heard.push("change"));

  type("axb");
  assert.equal(field.model.text, "ab");
  assert.deepEqual(heard, ["text a", "change", "text x", "text b", "change"]);
  assert.equal(field.caret, 2);
});

test("backspace, delete, the arrows and shift's selection edit as a field's keys do", () => {
  const { fields, scripting, keyboard, type } = setUp("name");
  const [field] = fields;
  setFocus(scripting, field);
  type("abcd");

  keyboard.handle("down", { keyCode: 37, charCode: 0 });
  keyboard.handle("down", { keyCode: 8, charCode: 8 });
  assert.equal(field.model.text, "abd");
  keyboard.handle("down", { keyCode: 46, charCode: 127 });
  assert.equal(field.model.text, "ab");

  keyboard.handle("down", { keyCode: 36, charCode: 0 });
  keyboard.handle("down", { keyCode: 39, charCode: 0, shiftKey: true });
  assert.deepEqual(field.selection, [0, 1]);
  type("z");
  assert.equal(field.model.text, "zb");
});

test("maxChars and restrict keep out what they do not allow", () => {
  const { fields, scripting, type } = setUp("name");
  const [field] = fields;
  setFocus(scripting, field);
  field.maxChars = 3;
  field.restrict = "a-z";
  type("aB1bcd");
  assert.equal(field.model.text, "abc");
});

test("focus moves with focusOut then focusIn, each naming the other", () => {
  const { fields, scripting, heard, listen } = setUp("name", "pass");
  const [name, pass] = fields;
  listen(name, "focusOut", (e) => heard.push(`out ${e.args[0] === pass.object}`));
  listen(pass, "focusIn", (e) => heard.push(`in ${e.args[0] === name.object}`));
  setFocus(scripting, name);
  setFocus(scripting, pass);
  assert.deepEqual(heard, ["out true", "in true"]);
  assert.equal(name.focused, false);
  assert.equal(pass.focused, true);
});

test("tab moves among input fields by tabIndex where they have one, else in reading order", () => {
  const { fields, scripting, keyboard } = setUp("a", "b", "c");
  const [a, b, c] = fields;
  const tab = (shiftKey = false) => keyboard.handle("down", { keyCode: 9, charCode: 9, shiftKey });

  tab();
  assert.equal(scripting.focus, a);
  tab();
  assert.equal(scripting.focus, b);
  tab(true);
  assert.equal(scripting.focus, a);

  // Indices put c first; b, which has none, is left out.
  (c.object as { $tabIndex?: number }).$tabIndex = 1;
  (a.object as { $tabIndex?: number }).$tabIndex = 2;
  tab();
  assert.equal(scripting.focus, c);
  tab();
  assert.equal(scripting.focus, a);
});
