// Animated curved morphs: shared or unique characters, in step or phased,
// at repeating or fresh ratios. Timings, allocations and retained memory
// are separate measurements; --counts also counts actual native calls.
// node tests/player/morph-bench.ts [--morphs 32] [--edges 32] [--loop 96]
//   [--phases] [--unique] [--solid] [--no-lines] [--frames N] [--gpu]
//   [--allocs] [--counts] [--json] [--checkout DIR] [--morph-module FILE]
//   [--native-binary FILE] [--write-swf FILE]
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as w from "../swf-writer.ts";
import { benchPlayer } from "./chrome.ts";

const args = process.argv.slice(2);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const count = Number(value("morphs") ?? 32);
const edges = Number(value("edges") ?? 32);
const loop = Number(value("loop") ?? 96);
const frames = Number(value("frames") ?? Math.max(384, loop * 4));
const phases = args.includes("--phases");
const unique = args.includes("--unique");
const solid = args.includes("--solid");
const lines = !args.includes("--no-lines");
for (const [name, n, low, high] of [
  ["morphs", count, 1, 512],
  ["edges", edges, 4, 2048],
  ["loop", loop, 0, 4096],
  ["frames", frames, 2, 65535],
] as const) {
  assert.ok(Number.isInteger(n) && n >= low && n <= high, `${name}: integer ${low}..${high}`);
}

const path = (end: boolean): w.PathCommand[] => {
  const point = (angle: number): [number, number] => {
    const radius = end ? 340 + 100 * Math.sin(angle * 7) : 400 + 60 * Math.sin(angle * 5);
    return [
      Math.round(Math.cos(angle + (end ? 0.15 : 0)) * radius),
      Math.round(Math.sin(angle + (end ? 0.15 : 0)) * radius * (end ? 0.8 : 1)),
    ];
  };
  const commands: w.PathCommand[] = [{ move: point(0) }];
  for (let i = 1; i <= edges; i++) {
    const a = (i * Math.PI * 2) / edges;
    const control = point(a - Math.PI / edges);
    const anchor = point(i === edges ? 0 : a);
    commands.push({ curve: [...control, ...anchor] });
  }

  return commands;
};
const tags: Uint8Array[] = [w.backgroundColor(0xeeeeee)];
for (let i = 0; i < (unique ? count : 1); i++) {
  tags.push(
    w.morphShape({
      id: i + 1,
      version: 2,
      startBounds: [-500, 500, -500, 500],
      endBounds: [-500, 500, -500, 500],
      fills: solid
        ? [{ start: 0xffee4422, end: 0xff2288ee }]
        : [
            {
              type: 0x10,
              startMatrix: { a: 0.04, d: 0.04 },
              endMatrix: { a: 0.02, b: 0.03, c: -0.03, d: 0.02 },
              stops: [
                [0, 0xffee4422, 0, 0xff2288ee],
                [255, 0xffddcc22, 255, 0xff22cc88],
              ],
            },
          ],
      lines: lines
        ? [{ startWidth: 10, endWidth: 30, startColor: 0xff222222, endColor: 0xff772277 }]
        : [],
      start: [{ fill0: 1, line: lines ? 1 : 0, commands: path(false) }],
      end: [path(true)],
    }),
  );
}
const columns = Math.ceil(Math.sqrt((count * 800) / 600));
const rows = Math.ceil(count / columns);
const scale = Math.min((800 / columns - 4) / 50, (600 / rows - 4) / 50);
for (let frame = 0; frame < frames; frame++) {
  for (let i = 0; i < count; i++) {
    const offset = phases ? Math.floor((i * (loop || 65536)) / count) : 0;
    const step = loop ? (frame + offset) % loop : (frame + offset) % 65536;
    const ratio = loop > 1 ? Math.round((step * 65535) / (loop - 1)) : step;
    tags.push(
      w.place({
        depth: i + 1,
        ...(frame === 0
          ? {
              character: unique ? i + 1 : 1,
              matrix: {
                a: scale,
                d: scale,
                tx: Math.round(((i % columns) + 0.5) * (800 / columns) * 20),
                ty: Math.round((Math.floor(i / columns) + 0.5) * (600 / rows) * 20),
              },
            }
          : { move: true }),
        ratio,
      }),
    );
  }
  tags.push(w.showFrame());
}
tags.push(w.end());
const swf = w.swf({ width: 800, height: 600, frameRate: 60, frameCount: frames, tags });
const write = value("write-swf");
if (write) {
  writeFileSync(write, swf);
  process.exit(0);
}

const mounts: [string, string][] = [];
const module = value("morph-module");
if (module) {
  mounts.push(["/player/display/morph.js", resolve(module)]);
}
const binary = value("native-binary");
if (binary) {
  mounts.push(["/native/render/binary.js", resolve(binary)]);
}
const checkout = value("checkout");
if (checkout) {
  for (const [prefix, pkg] of [
    ["player", "player"],
    ["native", "native"],
    ["format", "format"],
    ["render", "render"],
    ["codegen", "codegen"],
    ["context3d-backend", "context3d"],
    ["runtime", "runtime"],
  ]) {
    mounts.push([`/${prefix}/`, `${resolve(checkout)}/packages/${pkg}/dist/`]);
  }
}
const result = await benchPlayer(swf, frames, {
  gpu: args.includes("--gpu"),
  allocs: args.includes("--allocs"),
  metered: args.includes("--counts"),
  morphMetrics: true,
  mounts,
});
assert.equal(result.error, null);
assert.ok(result.morphs);
const warmup = Math.min(frames - 2, Math.max(32, loop * 3 || 64));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const samples = result.draw
  .slice(warmup)
  .map((draw, i) => draw + result.tick[warmup + i] + result.gl[warmup + i]);
const requests = result.morphs.requests.slice(warmup);
const misses = result.morphs.misses.slice(warmup);
const meters = result.meters.slice(warmup);
const summary = {
  count,
  edges,
  loop,
  frames,
  phases,
  unique,
  solid,
  lines,
  checkout,
  module,
  warmup,
  renderer: result.renderer,
  frameMs: median(samples),
  drawMs: median(result.draw.slice(warmup)),
  tickMs: median(result.tick.slice(warmup)),
  glMs: median(result.gl.slice(warmup)),
  requestsPerFrame: mean(requests),
  missesPerFrame: mean(misses),
  cached: result.morphs.cached,
  pathNumbers: result.morphs.pathNumbers,
  retained: result.retained,
  ...(args.includes("--allocs") ? { allocatedBytesPerFrame: result.allocated / (frames - 1) } : {}),
  ...(args.includes("--counts")
    ? {
        fillCallsPerFrame: mean(meters.map((m) => m.fillCalls)),
        lineCallsPerFrame: mean(meters.map((m) => m.lineCalls)),
      }
    : {}),
};
console.log(args.includes("--json") ? JSON.stringify(summary) : summary);
