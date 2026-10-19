// Scripted masks stay hidden as artwork, move between clips, and can be cleared.
import { flashAssembler, script } from "./avm1-script.ts";
import * as w from "./swf-writer.ts";

export function maskSwf(): Uint8Array {
  const square = (id: number, color: number, width: number) =>
    w.shape({
      id,
      bounds: [0, width, 0, 800],
      fills: [color],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [width, 0] },
            { line: [width, 800] },
            { line: [0, 800] },
            { line: [0, 0] },
          ],
        },
      ],
    });
  const frames = [
    'trace(typeof a.setMask); trace(a.setMask()); trace(a.setMask(c)); trace(a.setMask("missing")); trace(a.setMask());',
    'trace(a.setMask(null)); trace(a.setMask("c"));',
    "trace(a.setMask(undefined)); trace(a.setMask(7));",
    "trace(a.setMask(c)); trace(b.setMask(c));",
    "trace(b.setMask(null)); stop();",
  ];
  return w.swf({
    version: 8,
    width: 160,
    height: 70,
    frameCount: frames.length,
    tags: [
      square(1, 0xff0000, 1200),
      square(2, 0x0033cc, 400),
      w.sprite(3, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(4, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 3, name: "a", matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 3, name: "b", matrix: { tx: 1600, ty: 200 } }),
      w.place({ depth: 3, character: 4, name: "c", matrix: { tx: 600, ty: 200 } }),
      ...frames.flatMap((source) => [
        w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
        w.showFrame(),
      ]),
      w.end(),
    ],
  });
}
