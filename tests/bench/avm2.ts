// AVM2 eager/lazy startup, first-use and warmed script work in fresh processes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import { Player } from "../../packages/player/dist/player.js";
import { Scripting } from "../../packages/player/dist/scripting.js";
import { bare } from "../player/cases.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compiler } from "../player/scripts.ts";

interface Sample {
  label: string;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  compileMs: number;
  methods: number;
  sourceBytes: number;
  heapMiB: number;
  wasmMiB: number;
}
interface Run {
  lazy: boolean;
  samples: Sample[];
}
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    frames: { type: "string", default: "600" },
    swf: { type: "string" },
    json: { type: "string" },
    child: { type: "string" },
    lazy: { type: "boolean" },
    fixture: { type: "boolean" },
  },
});
const count = (s: string) => {
  const n = Number(s);
  assert.ok(Number.isSafeInteger(n) && n > 0);
  return n;
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2;
};
const frames = count(values.frames);
const root = fileURLToPath(new URL("../../", import.meta.url));
if (values.child) {
  const codegen = await createCodegen(
    await WebAssembly.compile(readFileSync(join(root, "packages/codegen/dist/codegen.wasm"))),
  );
  let compileMs = 0;
  let methods = 0;
  let sourceBytes = 0;
  for (const key of ["compileModule", "compileLazyModule"] as const) {
    const original = codegen[key].bind(codegen);
    codegen[key] = (...args) => {
      const begin = performance.now();
      const source = original(...args);
      compileMs += performance.now() - begin;
      sourceBytes += Buffer.byteLength(source);
      return source;
    };
  }
  const each = codegen.compileMethods.bind(codegen);
  codegen.compileMethods = (...args) => {
    const begin = performance.now();
    const result = each(...args);
    compileMs += performance.now() - begin;
    methods += result.size;
    for (const source of result.values()) {
      sourceBytes += Buffer.byteLength(source);
    }
    return result;
  };
  const errors: string[] = [];
  const scripting = new Scripting(codegen, {
    lazyCompilation: values.lazy,
    print() {},
    realTime: null,
    onUncaught: (error) => errors.push(scripting.rt.toString(error as never)),
  });
  const samples: Sample[] = [];
  const sample = async (label: string, work: () => void | Promise<void>, iterations = 1) => {
    const before = { compileMs, methods, sourceBytes };
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const begin = performance.now();
      const result = work();
      if (result instanceof Promise) {
        await result;
      }
      times.push(performance.now() - begin);
    }
    assert.deepEqual(errors, [], label);
    global.gc?.();
    times.sort((a, b) => a - b);
    samples.push({
      label,
      medianMs: median(times),
      p95Ms: times[Math.floor((times.length - 1) * 0.95)],
      maxMs: times.at(-1) ?? 0,
      compileMs: compileMs - before.compileMs,
      methods: methods - before.methods,
      sourceBytes: sourceBytes - before.sourceBytes,
      heapMiB: process.memoryUsage().heapUsed / 1048576,
      wasmMiB: codegen.usage().memory / 1048576,
    });
  };
  await sample("libraries", () => scripting.loadLibraries(libraryAbcs()));
  let player!: Player;
  await sample("start", async () => {
    player = new Player(new Uint8Array(readFileSync(values.child as string)), scripting);
    await player.start();
  });
  for (let phase = 1; phase <= 3; phase++) {
    if (values.fixture && phase > 1) {
      await sample(`scene ${phase}`, () => {
        scripting.rt.callProperty(player.root.object, scripting.rt.publicName(`scene${phase}`));
      });
    }
    if (!values.fixture && phase > 1) {
      break;
    }
    await sample(values.fixture ? `warm ${phase}` : "ticks", () => player.tick(), frames);
    if (values.fixture) {
      assert.equal(samples.at(-1)?.methods, 0, "warmed ticks must compile no further methods");
      assert.equal(samples.at(-1)?.compileMs, 0, "warmed ticks must compile no further modules");
      assert.equal(
        scripting.rt.getProperty(player.root.object, scripting.rt.publicName("value")),
        5200 + phase * 100,
      );
    }
  }
  scripting.destroy();
  console.log(JSON.stringify({ lazy: !!values.lazy, samples }));
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "swf2es-avm2-bench-"));
try {
  let swf = values.swf;
  if (!swf) {
    const unused = Array.from(
      { length: 256 },
      (_, i) =>
        `function cold${i}(n:int):int { var s:int=${i}; for(var j:int=0;j<n;j++) s+=j; return s; }`,
    ).join("\n");
    const action = (phase: number) => `action = function():void {
      var a:Array=[1,2,3,4]; var o:Object={value:${phase}}; var sum:int=0;
      for(var i:int=0;i<100;i++) sum+=o.value+i+a[i%4]; value=sum;
    };`;
    const abc = compiler(join(root, "tests/bench/out/avm2"))(
      "Avm2Bench",
      `package {
      import flash.display.Sprite; import flash.events.Event;
      public class Avm2Bench extends Sprite {
        public var value:int; private var action:Function;
        public function Avm2Bench() { ${action(1)} addEventListener(Event.ENTER_FRAME,tick); }
        private function tick(e:Event):void { action(); }
        public function scene2():void { ${action(2)} }
        public function scene3():void { ${action(3)} }
        private function neverCalled():void { ${unused} }
      }
    }`,
    );
    swf = join(scratch, "fixture.swf");
    writeFileSync(swf, bare(abc, 1, "Avm2Bench"));
  }
  const runs: Run[] = [];
  for (let i = 0; i < count(values.runs); i++) {
    for (const lazy of i % 2 ? [true, false] : [false, true]) {
      const args = [
        "--expose-gc",
        import.meta.filename,
        "--child",
        swf,
        "--frames",
        String(frames),
      ];
      if (lazy) {
        args.push("--lazy");
      }
      if (!values.swf) {
        args.push("--fixture");
      }
      runs.push(
        JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1048576 })),
      );
    }
  }
  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify(runs, null, 2)}\n`);
  }
  console.log(
    "mode  phase       median ms    p95 ms    max ms  compile ms  entries  source KiB  heap MiB  Wasm MiB",
  );
  for (const lazy of [false, true]) {
    for (const label of runs[0].samples.map((s) => s.label)) {
      const samples = runs
        .filter((r) => r.lazy === lazy)
        .flatMap((r) => r.samples.filter((s) => s.label === label));
      const fields = [
        "medianMs",
        "p95Ms",
        "maxMs",
        "compileMs",
        "methods",
        "sourceBytes",
        "heapMiB",
        "wasmMiB",
      ] as const;
      const results = fields.map(
        (k) => median(samples.map((s) => s[k])) / (k === "sourceBytes" ? 1024 : 1),
      );
      console.log(
        `${lazy ? "lazy " : "eager"} ${label.padEnd(11)} ${results.map((n) => n.toFixed(3).padStart(9)).join(" ")}`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
