// An authored AVM1 movie for picks, hover and the cursor across an AS3
// Loader (tests/unit/player/input/avm1-picks.test.ts) and native Flash probes.
import { flashAssembler, script } from "./avm1-script.ts";
import * as w from "./swf-writer.ts";

/** A rectangle of `width` by `height` pixels in `color`. */
function rect(id: number, color: number, width: number, height: number): Uint8Array {
  const [x, y] = [width * 20, height * 20];
  return w.shape({
    id,
    bounds: [0, x, 0, y],
    fills: [color],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [x, 0] },
          { line: [x, y] },
          { line: [0, y] },
          { line: [0, 0] },
        ],
      },
    ],
  });
}

/**
 * An authored AVM1 movie for picks across an AS3 Loader (LoadedAvm1Picks):
 * a button b at (10, 10), a clip c with press handlers at (100, 10), a
 * clip n at (190, 10) whose child inner alone has handlers, a clip p with
 * handlers at (100, 60) over a child q with its own, and a drawn clip a
 * at (10, 60) with none, each 60 by 30 but q, 30 by 15; below them, at
 * (10, 110) and (100, 110), a clip h whose useHandCursor is false and a
 * clip e whose enabled is false. Each handler, and Mouse's listeners, log
 * their events.
 */
export function picksMovie(): Uint8Array {
  const handlers = (name: string) =>
    [
      "onRollOver",
      "onRollOut",
      "onPress",
      "onRelease",
      "onReleaseOutside",
      "onDragOver",
      "onDragOut",
    ]
      .map((h) => `${name}.${h} = function() { log("${name}.${h}"); };`)
      .join("\n");
  const source = `
function log(s) { trace("avm1:" + s); }
var m = {};
m.onMouseDown = function() { log("mouseDown " + _root._xmouse + "," + _root._ymouse); };
m.onMouseUp = function() { log("mouseUp"); };
Mouse.addListener(m);
${handlers("b")}
${handlers("c")}
${handlers("n.inner")}
${handlers("p")}
${handlers("p.q")}
${handlers("h")}
${handlers("e")}
h.useHandCursor = false;
e.enabled = false;
stop();
log("ready");`;
  return w.swf({
    version: 8,
    width: 320,
    height: 240,
    frameCount: 1,
    tags: [
      rect(1, 0x2266cc, 60, 30),
      rect(2, 0x22aa77, 30, 15),
      w.button2(3, 1),
      w.sprite(4, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(5, 1, [w.place({ depth: 1, character: 4, name: "inner" }), w.showFrame(), w.end()]),
      w.sprite(6, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.sprite(7, 1, [
        w.place({ depth: 1, character: 1 }),
        w.place({ depth: 2, character: 6, name: "q" }),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ depth: 1, character: 3, name: "b", matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 4, name: "c", matrix: { tx: 2000, ty: 200 } }),
      w.place({ depth: 3, character: 5, name: "n", matrix: { tx: 3800, ty: 200 } }),
      w.place({ depth: 4, character: 7, name: "p", matrix: { tx: 2000, ty: 1200 } }),
      w.place({ depth: 5, character: 4, name: "a", matrix: { tx: 200, ty: 1200 } }),
      w.place({ depth: 6, character: 4, name: "h", matrix: { tx: 200, ty: 2200 } }),
      w.place({ depth: 7, character: 4, name: "e", matrix: { tx: 2000, ty: 2200 } }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}
