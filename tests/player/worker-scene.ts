import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { encodePng } from "../../packages/player/dist/bitmap/png.js";
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

/** A second SWF deliberately reuses shape 1 and supplies text/image assets. */
export function workerContentScene(): Uint8Array {
  const bitmap = new BitmapStore(3, 2, true, 0xffcc9900);
  bitmap.setPixel32(1, 0, 0x804080c0);
  bitmap.setPixel32(2, 1, 0xff336699);
  const png = encodePng(bitmap, { x: 0, y: 0, width: 3, height: 2 }, true);
  return w.swf({
    width: 160,
    height: 120,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.shape({
        id: 1,
        bounds: [0, 400, 0, 400],
        fills: [0x00aa44],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [400, 0] },
              { line: [400, 400] },
              { line: [0, 400] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.font3({
        id: 4,
        name: "WorkerFont",
        ascent: 800,
        descent: 200,
        glyphs: [
          { char: " ", advance: 300, boxes: [] },
          { char: "A", advance: 600, boxes: [[0, -700, 500, 0]] },
          { char: "b", advance: 500, boxes: [[50, -600, 400, 0]] },
        ],
      }),
      w.staticText({
        id: 5,
        bounds: [0, 1200, 0, 500],
        records: [
          {
            font: 4,
            height: 360,
            color: 0x3355aa,
            x: 0,
            y: 360,
            glyphs: [
              [1, 230],
              [2, 200],
            ],
          },
        ],
      }),
      w.editText(6, "Ab Ab\rAb", 1800, 680, 0, {
        font: 4,
        fontHeight: 320,
        useOutlines: true,
        multiline: true,
        wordWrap: true,
      }),
      w.tag(21, new Uint8Array([9, 0, ...png]), true),
      w.shape({
        id: 8,
        bounds: [0, 400, 0, 400],
        fills: [{ type: 0x42, bitmap: 9, matrix: { a: 60, d: 60 } }],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [400, 0] },
              { line: [400, 400] },
              { line: [0, 400] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 5, matrix: { tx: 500 } }),
      w.place({ depth: 3, character: 6, matrix: { tx: 400, ty: 360 } }),
      w.place({ depth: 4, character: 8, matrix: { tx: 2300 } }),
      w.place({ depth: 5, character: 9, matrix: { a: 6, d: 6, tx: 2300, ty: 450 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}
