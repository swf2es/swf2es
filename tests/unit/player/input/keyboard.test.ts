// Keys to the focused object or the stage, an input field's editing, and focus moving.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Container,
  type DisplayObject,
  TextObject,
} from "../../../../packages/player/dist/display/display.js";
import {
  KeyboardInput,
  restrictText,
  setFocus,
} from "../../../../packages/player/dist/input/keyboard.js";
import type { Scripting } from "../../../../packages/player/dist/scripting.js";

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

// What Flash keeps of TYPED under each restrict, from Ruffle's corpus
// (avm2/edittext_restrict, recorded in Flash), which the corpus runner
// cannot type into.
const TYPED = "abcABC012^\\-* &ąδłĄΔŁß";
const RESTRICTED: [string | null, string][] = [
  [null, "abcABC012^\\-* &ąδłĄΔŁß"],
  [null, "abcABC012^\\-* &ąδłĄΔŁß"],
  ["", ""],
  ["false", "aa"],
  ["1", "1"],
  ["true", ""],
  ["0.1", "01"],
  ["NaN", "aa"],
  ["[object Object]", "bcbc "],
  ["aB*Δ", "aBaB*Δ"],
  ["aa", "aa"],
  ["a-z", "abcabc"],
  ["A-Z", "ABCABC"],
  ["a-bA", "abAb"],
  ["a-", "aa"],
  ["-b", "abCABC012^\\-* &"],
  ["b-a", "bb"],
  ["A-z", "abcABC^\\"],
  ["-", ""],
  ["--", ""],
  ["---", ""],
  ["----", ""],
  ["-----", ""],
  ["-----b", "abCABC012^\\-* &"],
  ["b-----", "bb"],
  ["a-b-c", "abcABC012^\\-* &"],
  ["a-b-A", "abAb012-* &"],
  ["a-a-b", "abCABC012^\\-* &"],
  ["\\\\-\\^", "^\\"],
  ["\\^-\\\\", "^"],
  ["^", "abcABC012^\\-* &ąδłĄΔŁß"],
  ["^^", "abcABC012^\\-* &ąδłĄΔŁß"],
  ["\\^a", "aa^"],
  ["^\\^", "abcABC012\\-* &ąδłĄΔŁß"],
  ["^aą", "AbcABC012^\\-* &δłĄΔŁß"],
  ["a^b^c", "acac"],
  ["a^b^c^A^B", "aBcaBc"],
  ["a-zA-Z^bC", "aBcABc"],
  ["a-zA-Z^", "abcABC"],
  ["\\-", "-"],
  ["a\\-z", "aa-"],
  ["\\\\", "\\"],
  ["\\^", "^"],
  ["\\ab", "abab"],
  ["a\\", "aa"],
  [" -~", "abcABC012^\\-* &"],
  ["α-ω", "δ"],
];

test("restrict keeps what Flash keeps: ranges, ^ switching, escapes, a letter in its other case", () => {
  for (const [restrict, kept] of RESTRICTED) {
    assert.equal(restrictText(restrict, TYPED), kept, `restrict ${JSON.stringify(restrict)}`);
  }
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

  // A character restrict refuses still goes to listeners, and the field still changes (none put in).
  heard.length = 0;
  field.restrict = "a-z";
  type("Y1");
  assert.equal(field.model.text, "aby");
  assert.deepEqual(heard, ["text Y", "change", "text 1", "change"]);
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

test("maxChars cuts what is typed to the room left, and a full field hears nothing", () => {
  const { fields, scripting, heard, listen, type } = setUp("name");
  const [field] = fields;
  setFocus(scripting, field);
  field.maxChars = 3;
  listen(field, "textInput", () => heard.push("text"));
  type("abcd");
  assert.equal(field.model.text, "abc");
  assert.deepEqual(heard, ["text", "text", "text"]);
});

test("Ctrl with Alt, as AltGr types, is typing, not a shortcut", () => {
  const { fields, scripting, keyboard } = setUp("name");
  const [field] = fields;
  setFocus(scripting, field);
  keyboard.handle("down", { keyCode: 50, charCode: 64, ctrlKey: true, altKey: true });
  keyboard.handle("down", { keyCode: 65, charCode: 97, ctrlKey: true });
  assert.equal(field.model.text, "@");
  assert.deepEqual(field.selection, [0, 1]);
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

test("tab moves by tabIndex where any has one, else by place, after a keyFocusChange a listener may cancel", () => {
  const { fields, scripting, keyboard, listen } = setUp("a", "b", "c");
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

  // Cancelled where focus is, Tab moves nothing.
  listen(a, "keyFocusChange", (e) => {
    e.$prevented = true;
  });
  tab();
  assert.equal(scripting.focus, a);
});

test("a click focuses a field after a mouseFocusChange, and the stage's click takes it away", () => {
  const { stage, fields, scripting, keyboard, heard, listen } = setUp("a");
  const [a] = fields;
  listen(stage, "mouseFocusChange", (e) => heard.push(`change ${e.args[0] === a.object}`));
  keyboard.pressed(a, 0, 0);
  assert.equal(scripting.focus, a);
  // The stage's: a change on the field, bubbling to the stage, naming nothing.
  keyboard.pressed(stage, 0, 0);
  assert.equal(scripting.focus, null);
  assert.deepEqual(heard, ["change true", "change false"]);
});

test("an object taken off its parent, or hidden, loses focus", () => {
  const { stage, fields, scripting } = setUp("a", "b");
  const [a, b] = fields;
  setFocus(scripting, a);
  stage.removeChild(a);
  assert.equal(scripting.focus, null);

  setFocus(scripting, b);
  b.applyPlace({
    matrix: null,
    colorTransform: null,
    name: null,
    visible: false,
    clipDepth: null,
    blendMode: null,
    filters: null,
  } as never);
  assert.equal(scripting.focus, null);
});

test("a drag selects from the press, by characters, or by words and lines after a double or triple click", () => {
  const { fields, keyboard } = setUp("name");
  const [field] = fields;
  field.multiline = true;
  field.model.setText("one two\rthree");
  // Just inside index i's character, on its line: the point a press there makes.
  const at = (i: number): [number, number] => {
    const line = field.layout.lines.find((l) => i < l.end) ?? field.layout.lines[0];
    const c = line.chars[i - line.start];
    return [(c.x + 1) / 20, (line.y + line.ascent) / 20];
  };

  keyboard.pressed(field, ...at(1));
  keyboard.dragged(field, ...at(6));
  assert.deepEqual([field.anchor, field.caret], [1, 6]);
  keyboard.dragged(field, ...at(0));
  assert.deepEqual([field.anchor, field.caret], [1, 0]);

  keyboard.pressed(field, ...at(5), 2);
  assert.deepEqual(field.selection, [4, 7]);
  keyboard.dragged(field, ...at(1));
  assert.deepEqual(field.selection, [0, 7]);

  keyboard.pressed(field, ...at(9), 3);
  assert.deepEqual(field.selection, [8, 13]);

  field.selectable = false;
  keyboard.pressed(field, ...at(1));
  keyboard.dragged(field, ...at(6));
  assert.deepEqual(field.selection, [8, 13]);
});
