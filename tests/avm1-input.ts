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
