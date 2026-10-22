// A button whose states own different clips, and a clip shared at the same
// depth across all three states. Native Flash recreates only the former.
import { flashAssembler, script } from "./avm1-script.ts";
import * as w from "./swf-writer.ts";

export function buttonStatesMovie(version = 6, separateShared = false): Uint8Array {
  const actions = (source: string) =>
    w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);
  const records = new w.BitWriter().u16(5).u8(0).u16(0);
  for (const [flags, id, depth, tx] of [
    [1, 2, 1, 0],
    [2, 3, 1, 0],
    [4, 4, 1, 0],
    [separateShared ? 3 : 7, 6, 2, 1200],
    ...(separateShared ? [[4, 6, 2, 1200]] : []),
    [8, 1, 1, 0],
  ]) {
    records.u8(flags).u16(id).u16(depth);
    w.matrix(records, { tx });
    records.ub(1, 0).ub(1, 0).ub(4, 0).align();
  }

  records.u8(0);
  return w.swf({
    version,
    width: 150,
    height: 80,
    frameRate: 12,
    frameCount: 1,
    tags: [
      w.shape({
        id: 1,
        bounds: [0, 800, 0, 800],
        fills: [0xff7700],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [800, 0] },
              { line: [800, 800] },
              { line: [0, 800] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.defineSound(11, { rate: 1, samples: 1102 }, new Uint8Array(1102).fill(128)),
      ...[2, 3, 4, 6].map((id, i) =>
        w.sprite(id, 2, [
          w.place({ depth: 1, character: 1 }),
          ...(id === 4 ? [w.startSound(11, { outPoint: 3000, loops: 8 })] : []),
          actions(`if (_root.events == undefined) { _root.events = ""; }
_root.events += "${["U", "O", "D", "S"][i]}";
this.onEnterFrame = function() { _root.ticks += "${["U", "O", "D", "S"][i]}"; };`),
          w.showFrame(),
          actions("stop();"),
          w.showFrame(),
          w.end(),
        ]),
      ),
      w.tag(34, records.done()),
      w.place({ depth: 1, character: 5, name: "btn" }),
      actions('var ticks = ""; stop();'),
      w.showFrame(),
      w.end(),
    ],
  });
}
