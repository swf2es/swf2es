import { mkdirSync, writeFileSync } from "node:fs";
import { runFlash } from "../../oracle/flash.ts";
import * as w from "../../tests/swf-writer.ts";
import { out } from "./paths.ts";
import { fixture } from "./shapes.ts";

mkdirSync(out, { recursive: true });
const tags = [w.backgroundColor(0xffffff)];
const diagonal = process.argv[2] === "diagonal";
const prefix = diagonal ? "diagonal-" : "";
const shapes = fixture(diagonal);
for (let i = 0; i < shapes.length; i++) {
  const points = shapes[i].map((v) => Math.round(v * 20));
  const commands: w.PathCommand[] = [{ move: [points[0], points[1]] }];
  for (let k = 2; k < points.length; k += 2) {
    commands.push({ line: [points[k], points[k + 1]] });
  }
  commands.push({ line: [points[0], points[1]] });
  tags.push(
    w.shape({
      id: i + 1,
      bounds: [0, 10240, 0, 6400],
      fills: [0],
      paths: [{ fill1: 1, commands }],
    }),
  );
  tags.push(w.place({ depth: i + 1, character: i + 1 }));
}
tags.push(w.showFrame(), w.end());
const swf = w.swf({ width: 512, height: 320, frameCount: 1, tags });
writeFileSync(`${out}${prefix}fixture.swf`, swf);
writeFileSync(`${out}${prefix}fixture.json`, JSON.stringify(shapes));
const results = await runFlash(
  ["high", "best"].map((quality) => ({ swf, quality, frames: 1, capture: [1] })),
);
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const image = r.images.get(1);
  if (r.incomplete || r.errors.length || !image) {
    throw new Error(JSON.stringify(r));
  }
  writeFileSync(`${out}${prefix}flash-${i === 0 ? "high" : "best"}.png`, image);
  console.log({ quality: i === 0 ? "high" : "best", errors: r.errors, trace: r.output });
}
