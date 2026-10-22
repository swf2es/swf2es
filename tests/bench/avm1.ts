// AVM1 startup, scene entry and warmed script/timeline work in fresh node
// processes. Compare built checkouts in alternating order; no rendering.
//
//   node tests/bench/avm1.ts [--compare CHECKOUT] [--runs 5] [--frames 600]
//   node tests/bench/avm1.ts --swf FILE --replay STEPS.json [--json RESULTS.json]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Container, DisplayObject } from "../../packages/player/dist/display/display.js";
import type { Player } from "../../packages/player/dist/player.js";
import { flashAssembler, script } from "../avm1-script.ts";
import * as w from "../swf-writer.ts";

interface Step {
  label: string;
  ticks: number;
  /** Stage coordinates or a path of named children, whose origin is clicked. */
  click?: [number, number] | string[];
  text?: string;
  next?: boolean;
  repeat?: number;
  expectFrame?: number;
}

interface Sample {
  label: string;
  maxMs: number;
  medianMs: number;
  p95Ms: number;
  compileMs: number;
  compiled: number;
  heapMiB: number;
  wasmMiB: number;
  frame: number;
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    compare: { type: "string" },
    runs: { type: "string", default: "5" },
    frames: { type: "string", default: "600" },
    swf: { type: "string" },
    replay: { type: "string" },
    json: { type: "string" },
    child: { type: "string" },
    fixture: { type: "boolean" },
  },
});
const count = (text: string) => {
  const n = Number(text);
  assert.ok(Number.isSafeInteger(n) && n > 0, `expected a positive integer, got ${text}`);
  return n;
};
const frames = count(values.frames);
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2;
};

/** A stopped scene's enterFrame uses names, arrays, properties and a function call. */
function synthetic(): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(false)];
  for (let phase = 1; phase <= 3; phase++) {
    const unused = Array.from(
      { length: 64 },
      (_, i) => `function unused${i}(x) { return x + ${phase + i}; }`,
    ).join("\n");
    const source = `${phase === 1 ? "var benchTicks = 0;" : ""}
      var benchPhase = ${phase};
      ${unused}
      function hot(n) {
        var o = {value: ${phase}};
        var a = [1, 2, 3, 4];
        var sum = 0;
        for (var i = 0; i < n; i++) { sum += o.value + i + a[i % 4]; }
        return sum;
      }
      onEnterFrame = function() { benchValue = hot(100); benchTicks++; };
      stop();`;
    tags.push(w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]), w.showFrame());
  }

  return w.swf({ version: 8, width: 20, height: 20, frameCount: 3, tags: [...tags, w.end()] });
}

function click(player: Player, target: NonNullable<Step["click"]>): void {
  assert.ok(target.length > 0, "a click needs coordinates or a child path");
  let x: number;
  let y: number;
  if (typeof target[0] === "number") {
    assert.ok(target.length === 2 && target.every(Number.isFinite), "invalid click coordinates");
    [x, y] = target as [number, number];
  } else {
    let object: DisplayObject = player.root;
    for (const name of target as string[]) {
      assert.ok("children" in object, `no children in ${target.join("/")}`);
      const child = (object as Container).children.find((c) => c?.name === name);
      assert.ok(child, `no child ${name} in ${target.join("/")}`);
      object = child;
    }

    x = 0;
    y = 0;
    for (let objectAt: DisplayObject | null = object; objectAt; objectAt = objectAt.parent) {
      const m = objectAt.matrix;
      [x, y] = [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
    }
  }

  player.pointer?.handle("move", { x, y });
  player.pointer?.handle("down", { x, y });
  player.pointer?.handle("up", { x, y });
}

if (values.child) {
  assert.ok(values.swf && values.replay);
  const built = (path: string) =>
    pathToFileURL(join(values.child as string, "packages", path)).href;
  const { createCodegen } = (await import(
    built("codegen/dist/index.js")
  )) as typeof import("../../packages/codegen/dist/index.js");
  const { Avm1 } = (await import(
    built("player/dist/avm1/avm1.js")
  )) as typeof import("../../packages/player/dist/avm1/avm1.js");
  const { Player } = (await import(
    built("player/dist/player.js")
  )) as typeof import("../../packages/player/dist/player.js");
  const codegen = await createCodegen(
    await WebAssembly.compile(
      readFileSync(join(values.child, "packages/codegen/dist/codegen.wasm")),
    ),
  );
  let seed = 12345;
  Math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let compileMs = 0;
  let compiled = 0;
  const each = codegen.compileActionBlocks.bind(codegen);
  codegen.compileActionBlocks = (...args) => {
    const begin = performance.now();
    const result = each(...args);
    compileMs += performance.now() - begin;
    compiled += result.size;
    return result;
  };
  // Units, where control leaves a block's own bytes, compile as they first run too.
  if ("compileActionUnit" in codegen) {
    const unit = codegen.compileActionUnit.bind(codegen);
    codegen.compileActionUnit = (...args) => {
      const begin = performance.now();
      const result = unit(...args);
      compileMs += performance.now() - begin;
      return result;
    };
  }
  const module = codegen.compileActionsModule.bind(codegen);
  codegen.compileActionsModule = (...args) => {
    const begin = performance.now();
    const result = module(...args);
    compileMs += performance.now() - begin;
    compiled += args[1].blocks.length;
    return result;
  };
  const errors: string[] = [];
  const avm1 = new Avm1(codegen, {
    print() {},
    onUncaught: (error) => errors.push(String(error)),
    realTime: null,
    audio: null,
  });
  const player = new Player(new Uint8Array(readFileSync(values.swf)), null, avm1);
  const samples: Sample[] = [];
  const sample = async (
    label: string,
    body: (work: (fn: () => void) => void) => Promise<number | undefined> | number | undefined,
  ) => {
    const times: number[] = [];
    const before = { compileMs, compiled };
    const elapsed = await body((fn) => {
      const begin = performance.now();
      fn();
      times.push(performance.now() - begin);
    });
    if (elapsed !== undefined) {
      times.push(elapsed);
    }
    assert.deepEqual(errors, [], label);
    global.gc?.();
    times.sort((a, b) => a - b);
    samples.push({
      label,
      maxMs: times.at(-1) ?? 0,
      medianMs: times.length ? median(times) : 0,
      p95Ms: times[Math.floor((times.length - 1) * 0.95)] ?? 0,
      compileMs: compileMs - before.compileMs,
      compiled: compiled - before.compiled,
      heapMiB: process.memoryUsage().heapUsed / 1048576,
      wasmMiB: codegen.usage().memory / 1048576,
      frame: player.root.currentFrame,
    });
  };
  await sample("start", async () => {
    const begin = performance.now();
    await player.start();
    return performance.now() - begin;
  });
  const steps = JSON.parse(readFileSync(values.replay, "utf8")) as Step[];
  assert.ok(Array.isArray(steps));
  for (const step of steps) {
    assert.ok(
      typeof step.label === "string" && Number.isSafeInteger(step.ticks) && step.ticks >= 0,
    );
    await sample(step.label, (work) => {
      for (let i = 0; i < count(String(step.repeat ?? 1)); i++) {
        if (step.click) {
          work(() => click(player, step.click as NonNullable<Step["click"]>));
        }
        if (step.text) {
          work(() => {
            for (const c of step.text as string) {
              const key = { keyCode: c.toUpperCase().charCodeAt(0), charCode: c.charCodeAt(0) };
              player.keyboard?.handle("down", key);
              player.keyboard?.handle("up", key);
            }
          });
        }
        if (step.next) {
          player.root.playing = true;
        }
        for (let frame = 0; frame < step.ticks; frame++) {
          work(() => player.tick());
        }
      }
      if (step.expectFrame !== undefined) {
        assert.equal(player.root.currentFrame, step.expectFrame, step.label);
      }
    });
    if (values.fixture && step.label.startsWith("warm")) {
      assert.equal(samples.at(-1)?.compiled, 0, `${step.label} compiled during warmed execution`);
    }
  }
  if (values.fixture) {
    assert.equal(avm1.faceOf(player.root)?.props.get("benchValue")?.value, 5500);
  }
  player.destroy();
  console.log(JSON.stringify(samples));
} else {
  const temporary = mkdtempSync(join(tmpdir(), "swf2es-avm1-bench-"));
  try {
    const swf = values.swf ? resolve(values.swf) : join(temporary, "synthetic.swf");
    const replay = values.replay ? resolve(values.replay) : join(temporary, "steps.json");
    if (!values.swf) {
      writeFileSync(swf, synthetic());
    }
    if (!values.replay) {
      const steps: Step[] = values.swf
        ? [{ label: "play", ticks: frames }]
        : [
            { label: "warm1", ticks: frames, expectFrame: 1 },
            { label: "scene2", next: true, ticks: 1, expectFrame: 2 },
            { label: "warm2", ticks: frames, expectFrame: 2 },
            { label: "scene3", next: true, ticks: 1, expectFrame: 3 },
            { label: "warm3", ticks: frames, expectFrame: 3 },
          ];
      writeFileSync(replay, JSON.stringify(steps));
    }
    const builds = values.compare
      ? [
          ["A", resolve(values.compare)],
          ["B", root],
        ]
      : [["now", root]];
    const all: { build: string; run: number; samples: Sample[] }[] = [];
    for (let run = 0; run < count(values.runs); run++) {
      for (const [name, dir] of run % 2 ? [...builds].reverse() : builds) {
        const out = execFileSync(
          process.execPath,
          [
            "--expose-gc",
            fileURLToPath(import.meta.url),
            "--child",
            dir,
            "--swf",
            swf,
            "--replay",
            replay,
            ...(!values.swf ? ["--fixture"] : []),
          ],
          { encoding: "utf8" },
        );
        all.push({ build: name, run, samples: JSON.parse(out) });
      }
    }
    console.log("AVM1 in node: milliseconds of script/timeline work; rendering is excluded.");
    for (const [name, dir] of builds) {
      console.log(`${name}: ${dir}`);
      const runs = all.filter((r) => r.build === name);
      for (let i = 0; i < runs[0].samples.length; i++) {
        const rows = runs.map((r) => r.samples[i]);
        const field = (k: keyof Sample) => median(rows.map((s) => Number(s[k]))).toFixed(3);
        console.log(
          `${rows[0].label.padEnd(12)} median ${field("medianMs")}  p95 ${field("p95Ms")}  max ${field("maxMs")}  compile ${field("compileMs")}  blocks ${field("compiled")}  heap ${field("heapMiB")} MiB  wasm ${field("wasmMiB")} MiB`,
        );
      }
    }
    if (values.json) {
      writeFileSync(values.json, `${JSON.stringify(all, null, 2)}\n`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
