// The transform table's runs (render/table.ts) in one frame: a run long
// enough for a multi-draw that takes its rows in uniforms, then short runs
// drawn from the atlas a call a draw by the same program, each draw told
// its row, with filters ending each run. Drawn with the table and without
// it, under software GL and on the GPU, the frames must be the same pixels:
// a draw reading another's row, as one would if gl_DrawID were left from
// the multi-draw before it, puts a shape in another's place.
import assert from "node:assert/strict";
import * as w from "../swf-writer.ts";
import { runPlayer } from "./chrome.ts";
import { decodePng } from "./image.ts";

/** A closed ring of `n` curves round the origin, `r` twips out: drawn alone, not batched. */
function ring(r: number, n: number): w.PathCommand[] {
  const at = (a: number, k: number): [number, number] => [
    Math.round(Math.cos(a) * r * k),
    Math.round(Math.sin(a) * r * k),
  ];
  const commands: w.PathCommand[] = [{ move: at(0, 1) }];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) * 2 * Math.PI) / n;
    const b = ((i + 1) * 2 * Math.PI) / n;
    commands.push({ curve: [...at(a, i % 2 ? 1.2 : 0.8), ...at(b, 1)] });
  }

  return commands;
}

const colors = [0x3366cc, 0xcc3333, 0x33aa55, 0xddaa22, 0x8844cc, 0x22aaaa];
const tags: Uint8Array[] = [w.fileAttributes(false)];
for (const [k, color] of colors.entries()) {
  tags.push(
    w.shape({
      id: k + 1,
      bounds: [-1400, 1400, -1400, 1400],
      fills: [color],
      paths: [{ fill1: 1, commands: ring(1000, 120) }],
    }),
  );
}

const dot = colors.length + 1;
tags.push(
  w.shape({
    id: dot,
    bounds: [0, 200, 0, 200],
    fills: [0x000000],
    paths: [
      {
        fill1: 1,
        commands: [{ move: [0, 0] }, { line: [200, 0] }, { line: [100, 200] }, { line: [0, 0] }],
      },
    ],
  }),
);

// Runs of 30, 5, 3 and 24 Graphics, a blurred dot after each: a multi-draw
// with its rows in uniforms, two runs drawn a call a draw, and another multi-draw.
let depth = 1;
let placed = 0;
for (const run of [30, 5, 3, 24]) {
  for (let i = 0; i < run; i++, placed++) {
    tags.push(
      w.place({
        depth: depth++,
        character: (placed % colors.length) + 1,
        matrix: {
          a: 0.12 + (placed % 3) * 0.02,
          d: 0.12,
          tx: 300 + (placed % 12) * 640,
          ty: 300 + Math.floor(placed / 12) * 1000,
        },
      }),
    );
  }

  tags.push(
    w.place({
      depth: depth++,
      character: dot,
      matrix: { tx: 200 + depth * 90, ty: 5600 },
      blurs: [4],
    }),
  );
}

tags.push(w.showFrame(), w.end());
const swf = w.swf({ width: 400, height: 300, frameCount: 1, tags });

for (const gpu of [false, true]) {
  const job = { swf, frames: 1, capture: [1] };
  const [table, pixi] = await runPlayer([job, { ...job, table: false }], { gpu });
  assert.equal(table.error, null);
  assert.equal(pixi.error, null);
  // Without the extension, as some software GL has it, the table draws nothing: the frames must
  // still match, but that is all the run shows.
  const where = `${gpu ? "GPU" : "software GL"} (${table.gl})`;
  console.log(`table-runs: ${where}, ${table.tableDraws} draws in multi-draws`);
  if (table.multiDraw) {
    assert.ok(table.tableDraws > 0, `${where}: the long runs were no multi-draws`);
  } else {
    console.log(`table-runs: ${where} has no WEBGL_multi_draw; the table drew nothing`);
  }

  const a = decodePng(table.images.get(1) as Uint8Array);
  const b = decodePng(pixi.images.get(1) as Uint8Array);
  let differ = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) {
      differ++;
    }
  }

  assert.equal(differ, 0, `${where}: ${differ} bytes differ`);
}

console.log("table-runs: ok");
