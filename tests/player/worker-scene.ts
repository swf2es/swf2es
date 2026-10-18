import * as w from "../swf-writer.ts";

export function workerScene(): Uint8Array {
  const shape = (id: number, color: number) =>
    w.shape({
      id,
      bounds: [0, 600, 0, 600],
      fills: [color],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [600, 0] },
            { curve: [800, 600, 0, 600] },
            { line: [0, 0] },
          ],
        },
      ],
    });

  return w.swf({
    width: 160,
    height: 120,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      shape(1, 0xcc3300),
      shape(2, 0x3366cc),
      w.sprite(3, 1, [
        w.place({ depth: 1, character: 1 }),
        w.place({ depth: 2, character: 2, matrix: { tx: 350, ty: 200 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ depth: 1, character: 3, matrix: { tx: 400, ty: 400 } }),
      w.place({ depth: 2, character: 3, matrix: { a: -1, d: 0.8, tx: 2600, ty: 1200 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}
