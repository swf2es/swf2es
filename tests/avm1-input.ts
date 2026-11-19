// An authored AVM1 movie for AS3 Loader input tests and native Flash probes.
import { flashAssembler, script } from "./avm1-script.ts";
import * as w from "./swf-writer.ts";

export function mouseMovie(id: string): Uint8Array {
  const source = `
function log(s) {
  trace("${id}:" + s);
  if (flash.external.ExternalInterface.available) {
    flash.external.ExternalInterface.call("record", "${id}:" + s);
  }
}
var m = {};
m.onMouseMove = function() { log("move:" + _root._xmouse + "," + _root._ymouse); };
m.onMouseDown = function() { log("down"); };
m.onMouseUp = function() { log("up"); };
Mouse.addListener(m);
b.onRollOver = function() { log("over"); };
b.onRollOut = function() { log("out"); };
b.onDragOver = function() { log("dragOver"); };
b.onDragOut = function() { log("dragOut"); };
b.onPress = function() { log("press"); };
b.onRelease = function() { log("release"); };
b.onReleaseOutside = function() { log("outside"); };
stop();
log("ready");`;
  return w.swf({
    version: 8,
    width: 100,
    height: 80,
    frameCount: 1,
    tags: [
      w.shape({
        id: 1,
        bounds: [0, 800, 0, 600],
        fills: [0x22aa77],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [800, 0] },
              { line: [800, 600] },
              { line: [0, 600] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.button2(2, 1),
      w.place({ depth: 1, character: 2, name: "b" }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A square of 60 by 30 pixels in `color`. */
const square = (id: number, color: number) =>
  w.shape({
    id,
    bounds: [0, 1200, 0, 600],
    fills: [color],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [1200, 0] },
          { line: [1200, 600] },
          { line: [0, 600] },
          { line: [0, 0] },
        ],
      },
    ],
  });

/**
 * An authored AVM1 movie for an AS3 Loader's keyboard: two bordered input
 * fields, f over g, a button b beside f that Tab passes by, and a drawn
 * clip s beside g. It logs Key's listeners, the fields' changes and focus,
 * and b's presses; `focused`, it focuses f itself as it starts. `id` names
 * its lines, avm1 by default, `tabButton` lets Tab focus b, and `swap`
 * moves b under a press at the stage's bottom right in Mouse's
 * onMouseDown, before the press is picked.
 */
export function keysMovie(
  focused = false,
  options: { id?: string; tabButton?: boolean; swap?: boolean } = {},
): Uint8Array {
  const source = `
function log(s) { trace("${options.id ?? "avm1"}:" + s); }
function nameOf(o) { if (o == null) { return "null"; } return o._name; }
f.border = true;
g.border = true;
${options.tabButton ? "" : "b.tabEnabled = false;"}
b.onPress = function() { log("b.onPress"); };
${
  options.swap
    ? `var m = {};
m.onMouseDown = function() { if (_xmouse > 270 && _ymouse > 180) { b._x = 250; b._y = 190; log("swap"); } };
Mouse.addListener(m);`
    : ""
}
var k = {};
k.onKeyDown = function() { log("keyDown " + Key.getCode()); };
k.onKeyUp = function() { log("keyUp " + Key.getCode()); };
Key.addListener(k);
f.onChanged = function() { log("changed f=" + f.text); };
g.onChanged = function() { log("changed g=" + g.text); };
f.onSetFocus = function(o) { log("f.onSetFocus " + nameOf(o)); };
f.onKillFocus = function(o) { log("f.onKillFocus " + nameOf(o)); };
g.onSetFocus = function(o) { log("g.onSetFocus " + nameOf(o)); };
g.onKillFocus = function(o) { log("g.onKillFocus " + nameOf(o)); };
${focused ? "Selection.setFocus(f);" : ""}
stop();
log("ready");`;
  return w.swf({
    version: 8,
    width: 320,
    height: 240,
    frameCount: 1,
    tags: [
      w.editText(1, "", 3000, 500, 0, { at: [200, 200] }),
      w.editText(2, "", 3000, 500, 0, { at: [200, 1000] }),
      square(3, 0xff0000),
      w.button2(4, 3),
      square(5, 0x00aa00),
      w.sprite(6, 1, [w.place({ depth: 1, character: 5 }), w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 1, name: "f" }),
      w.place({ depth: 2, character: 2, name: "g" }),
      w.place({ depth: 3, character: 4, name: "b", matrix: { tx: 4000, ty: 200 } }),
      w.place({ depth: 4, character: 6, name: "s", matrix: { tx: 4000, ty: 1000 } }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/**
 * An authored AVM1 movie for focus across an AS3 host and the movies it
 * loads: two bordered input fields, f over g, 150 by 25 pixels at (10, 10)
 * and (10, 50). It logs, as `id`, its fields' onSetFocus and onKillFocus
 * and Selection's listener, each object named by its `_name`, `start`
 * runs as it starts, and each of `keys` runs as its key code goes down.
 */
export function focusMovie(
  options: { id?: string; start?: string; keys?: Record<number, string> } = {},
): Uint8Array {
  const id = options.id ?? "avm1";
  const keys = Object.entries(options.keys ?? {})
    .map(([code, source]) => `if (Key.getCode() == ${code}) { ${source} }`)
    .join("\n");
  const source = `
function log(s) { trace("${id}:" + s); }
function nameOf(o) { if (o === null) { return "null"; } if (o === undefined) { return "undefined"; } return o._name; }
function selection() {
  log("getFocus " + Selection.getFocus() + " begin " + Selection.getBeginIndex() + " end " + Selection.getEndIndex() + " caret " + Selection.getCaretIndex());
}
f.border = true;
g.border = true;
f.text = "abcdef";
g.text = "ghijkl";
f.onSetFocus = function(o) { log("f.onSetFocus " + nameOf(o)); };
f.onKillFocus = function(o) { log("f.onKillFocus " + nameOf(o)); };
g.onSetFocus = function(o) { log("g.onSetFocus " + nameOf(o)); };
g.onKillFocus = function(o) { log("g.onKillFocus " + nameOf(o)); };
f.onChanged = function() { log("changed f=" + f.text); };
var sel = {};
sel.onSetFocus = function(o, n) { log("Selection.onSetFocus " + nameOf(o) + " " + nameOf(n)); };
Selection.addListener(sel);
var k = {};
k.onKeyDown = function() {
${keys}
};
Key.addListener(k);
${options.start ?? ""}
stop();
log("ready");`;
  return w.swf({
    version: 8,
    width: 200,
    height: 100,
    frameCount: 1,
    tags: [
      w.editText(1, "", 3000, 500, 0, { at: [200, 200] }),
      w.editText(2, "", 3000, 500, 0, { at: [200, 1000] }),
      w.place({ depth: 1, character: 1, name: "f" }),
      w.place({ depth: 2, character: 2, name: "g" }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}
