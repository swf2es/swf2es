// Authored AVM1 movies for picks, hover, drags and the cursor across an AS3
// Loader (tests/unit/player/input/avm1.test.ts) and native Flash probes.
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

/**
 * An authored AVM1 movie for drags between buttons: buttons a and b at
 * (10, 10) and (100, 10), button m at (190, 10) whose tag tracks it as a
 * menu, and clips n at (10, 60), which a script tracks as a menu, and k at
 * (100, 60), which it does not, and button o at (10, 110), whose tag tracks
 * it as a menu and a script then not, each 60 by 30 with every handler
 * logged.
 */
export function dragsMovie(): Uint8Array {
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
${["a", "b", "m", "n", "k", "o"].map(handlers).join("\n")}
n.trackAsMenu = true;
o.trackAsMenu = false;
stop();
log("ready " + a.trackAsMenu + " " + m.trackAsMenu + " " + n.trackAsMenu);`;
  return w.swf({
    version: 8,
    width: 320,
    height: 240,
    frameCount: 1,
    tags: [
      rect(1, 0x2266cc, 60, 30),
      w.button2(2, 1),
      w.button2(3, 1, [], true),
      w.sprite(4, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 2, name: "a", matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 2, name: "b", matrix: { tx: 2000, ty: 200 } }),
      w.place({ depth: 3, character: 3, name: "m", matrix: { tx: 3800, ty: 200 } }),
      w.place({ depth: 4, character: 4, name: "n", matrix: { tx: 200, ty: 1200 } }),
      w.place({ depth: 5, character: 4, name: "k", matrix: { tx: 2000, ty: 1200 } }),
      w.place({ depth: 6, character: 3, name: "o", matrix: { tx: 200, ty: 2200 } }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/**
 * Presses dragged between dragsMovie's buttons and clips, as the projector
 * was given them: from a onto b and back, from a onto m, from m onto b and
 * onto n, from nothing over m, n and k, from k onto n, from nothing let go
 * over m, n and o, from (200, 70), the host's sprite, onto m, and from o
 * over n. What the press reaches is its own unless it tracks as a menu's,
 * m by its tag and n by a script but not o, whose script says not, or is on
 * nothing, none of the host's objects either: then each menu item crossed
 * hears dragOver and dragOut, the one let go over its release, and the
 * pressed one no releaseOutside. tests/unit/player/input/avm1.test.ts plays
 * them over an AS3 host, tests/unit/player/avm1/pointer.test.ts the movie
 * alone.
 */
export const DRAG_STEPS: (["move" | "down", number, number] | ["up"] | ["wait", number])[] = [
  ["wait", 1500],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 20, 20],
  ["move", 60, 25],
  ["move", 110, 20],
  ["wait", 100],
  ["move", 20, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 20, 20],
  ["move", 200, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 200, 20],
  ["move", 110, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 200, 20],
  ["move", 20, 70],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 300, 220],
  ["move", 200, 20],
  ["wait", 100],
  ["move", 20, 70],
  ["wait", 100],
  ["move", 110, 70],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 110, 70],
  ["move", 20, 70],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 300, 220],
  ["move", 200, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 300, 220],
  ["move", 20, 70],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 300, 220],
  ["move", 20, 120],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 200, 70],
  ["move", 200, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 20, 120],
  ["move", 20, 70],
  ["wait", 100],
  ["move", 300, 220],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["move", 300, 220],
  ["wait", 100],
];

/** What the projector traced over LoadedAvm1Picks. */
export const DRAGS_FLASH = [
  "avm1:ready undefined undefined true",
  "avm1:a.onRollOver",
  "avm1:a.onPress",
  "avm1:a.onDragOut",
  "avm1:a.onDragOver",
  "avm1:a.onRelease",
  "avm1:a.onPress",
  "avm1:a.onDragOut",
  "avm1:a.onReleaseOutside",
  "avm1:m.onRollOver",
  "avm1:m.onPress",
  "avm1:m.onDragOut",
  "avm1:b.onRollOver",
  "avm1:b.onRollOut",
  "avm1:m.onRollOver",
  "avm1:m.onPress",
  "avm1:m.onDragOut",
  "avm1:n.onDragOver",
  "avm1:n.onRelease",
  "avm1:n.onRollOut",
  "as3:mouseDown stage@stage related null",
  "avm1:m.onDragOver",
  "avm1:m.onDragOut",
  "avm1:n.onDragOver",
  "avm1:n.onDragOut",
  "avm1:k.onRollOver",
  "avm1:k.onPress",
  "avm1:k.onDragOut",
  "avm1:k.onReleaseOutside",
  "avm1:n.onRollOver",
  "avm1:n.onRollOut",
  "as3:mouseDown stage@stage related null",
  "avm1:m.onDragOver",
  "avm1:m.onRelease",
  "avm1:m.onRollOut",
  "as3:mouseDown stage@stage related null",
  "avm1:n.onDragOver",
  "avm1:n.onRelease",
  "avm1:n.onRollOut",
  "as3:mouseDown stage@stage related null",
  "avm1:o.onRollOver",
  "avm1:o.onRollOut",
  "as3:rollOver box@box related null",
  "as3:mouseOver box@stage related null",
  "as3:mouseDown box@stage related null",
  "as3:mouseOut box@stage related null",
  "as3:rollOut box@box related null",
  "avm1:m.onRollOver",
  "avm1:m.onRollOut",
  "avm1:o.onRollOver",
  "avm1:o.onPress",
  "avm1:o.onDragOut",
  "avm1:o.onReleaseOutside",
  "as3:mouseUp stage@stage related null",
];

/** What the projector traced of the movie alone. */
export const DRAGS_ALONE = [
  "avm1:ready undefined undefined true",
  "avm1:a.onRollOver",
  "avm1:a.onPress",
  "avm1:a.onDragOut",
  "avm1:a.onDragOver",
  "avm1:a.onRelease",
  "avm1:a.onPress",
  "avm1:a.onDragOut",
  "avm1:a.onReleaseOutside",
  "avm1:m.onRollOver",
  "avm1:m.onPress",
  "avm1:m.onDragOut",
  "avm1:b.onRollOver",
  "avm1:b.onRollOut",
  "avm1:m.onRollOver",
  "avm1:m.onPress",
  "avm1:m.onDragOut",
  "avm1:n.onDragOver",
  "avm1:n.onRelease",
  "avm1:n.onRollOut",
  "avm1:m.onDragOver",
  "avm1:m.onDragOut",
  "avm1:n.onDragOver",
  "avm1:n.onDragOut",
  "avm1:k.onRollOver",
  "avm1:k.onPress",
  "avm1:k.onDragOut",
  "avm1:k.onReleaseOutside",
  "avm1:n.onRollOver",
  "avm1:n.onRollOut",
  "avm1:m.onDragOver",
  "avm1:m.onRelease",
  "avm1:m.onRollOut",
  "avm1:n.onDragOver",
  "avm1:n.onRelease",
  "avm1:n.onRollOut",
  "avm1:o.onRollOver",
  "avm1:o.onRollOut",
  "avm1:m.onDragOver",
  "avm1:m.onRelease",
  "avm1:m.onRollOut",
  "avm1:o.onRollOver",
  "avm1:o.onPress",
  "avm1:o.onDragOut",
  "avm1:o.onReleaseOutside",
];
