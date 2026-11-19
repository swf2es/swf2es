// The SWFs of the tests of instance names (scripting.test.ts and
// scripting/loads.test.ts), as Flash Player 32 and adl played them.
import { flashAssembler, script } from "../../../avm1-script.ts";
import { bare } from "../../../player/cases.ts";
import type { Compile } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

const square = (id: number) =>
  w.shape({
    id,
    bounds: [0, 200, 0, 200],
    fills: [0xff0000],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [200, 0] },
          { line: [200, 200] },
          { line: [0, 200] },
          { line: [0, 0] },
        ],
      },
    ],
  });

/**
 * InstanceNamesTimeline over a first frame of a clip holding a clip of two
 * shapes and a shape, a shape, a clip named `named` of two shapes, and a
 * shape, none but the one named.
 */
export function timelineSwf(compile: Compile): Uint8Array {
  return w.swf({
    width: 200,
    height: 200,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1),
      w.sprite(2, 1, [
        w.place({ depth: 1, character: 1 }),
        w.place({ depth: 2, character: 1 }),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(3, 1, [
        w.place({ depth: 1, character: 2 }),
        w.place({ depth: 2, character: 1 }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(compile("InstanceNamesTimeline"), "InstanceNamesTimeline"),
      w.symbolClass([[0, "InstanceNamesTimeline"]]),
      w.place({ depth: 1, character: 3 }),
      w.place({ depth: 2, character: 1 }),
      w.place({ depth: 3, character: 2, name: "named" }),
      w.place({ depth: 4, character: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** InstanceNamesLoads, and what it loads by name: avm1.swf and as3.swf; missing.swf is not there. */
export function loadsSwfs(compile: Compile): Record<string, Uint8Array> {
  return {
    "test.swf": bare(compile("InstanceNamesLoads"), 1, "InstanceNamesLoads", 200, 200),
    "as3.swf": bare(compile("InstanceNamesChild"), 1, "InstanceNamesChild", 200, 200),
    "avm1.swf": w.swf({
      version: 8,
      width: 200,
      height: 200,
      frameCount: 1,
      tags: [
        w.doAction([...script('trace("avm1 " + this);', 8)(flashAssembler()).end().bytes()]),
        w.showFrame(),
        w.end(),
      ],
    }),
  };
}
