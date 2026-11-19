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
 * and b's presses; `focused`, it focuses f itself as it starts.
 */
export function keysMovie(focused = false): Uint8Array {
  const source = `
function log(s) { trace("avm1:" + s); }
function nameOf(o) { if (o == null) { return "null"; } return o._name; }
f.border = true;
g.border = true;
b.tabEnabled = false;
b.onPress = function() { log("b.onPress"); };
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
