// Times a burst of loads in headless Chrome while a timeline plays: a SWF
// whose shapes move every frame, drawn on each animation frame as the
// element draws, asks for K SWFs at once, each with a sizeable ABC of
// its own and into an application domain of its own, as a game's room
// asks for its map and each arriving player's equipment. Prints, for the
// time from the loads asked to the last one's COMPLETE: that latency, the
// page's thread's busy time (Chrome's TaskDuration, from its DevTools),
// its tasks of 50 ms or more, and the longest time between two frames.
//
// Each run plays in a fresh document, with the loads compiled on the
// background compiler's Web Worker (scripting/compiler.ts) and on the
// page's thread in turn, so that the two interleave and share what the
// machine does meanwhile; the medians of each over the runs follow. A
// first run each way warms the browser up, and is not counted.
//
//   node tests/player/load-bench.ts [--runs N] [--loads K] [--methods M] [--bytes] [--gpu]
//
// --loads K SWFs (12), each of 3 classes of M methods (200) of loops,
// arithmetic, strings, arrays and objects: some 60 KB of ABC a SWF at
// 200. --bytes loads them by Loader.loadBytes, their bytes fetched first,
// whose frames wait for them as Flash's do; by Loader.load by default.
// Run under the machine's lock (AGENTS.md).

import * as w from "../swf-writer.ts";
import { withPage } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const runs = option("--runs", 5);
const loads = option("--loads", 12);
const methods = option("--methods", 200);
const mode = args.includes("--bytes") ? "bytes" : "url";
const gpu = args.includes("--gpu");

const main = `package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.external.ExternalInterface;
  import flash.net.URLLoader;
  import flash.net.URLLoaderDataFormat;
  import flash.net.URLRequest;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;

  public class LoadBenchMain extends MovieClip {
    private var _count:int;
    private var _mode:String;
    private var _bytes:Array = [];
    private var _fetched:int;
    private var _done:int;

    public function LoadBenchMain() {
      ExternalInterface.addCallback("go", go);
      var config:URLLoader = new URLLoader();
      config.addEventListener(Event.COMPLETE, function (e:Event):void {
        var parts:Array = String(config.data).split(" ");
        _count = int(parts[0]);
        _mode = parts[1];
        warm();
      });
      config.load(new URLRequest("bench.txt"));
    }

    // A small SWF loaded first, as a game loads its interface before a room.
    private function warm():void {
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function (e:Event):void {
        if (_mode == "bytes") {
          fetchAll();
        } else {
          trace("ready");
        }
      });
      loader.load(new URLRequest("warm.swf"),
        new LoaderContext(false, new ApplicationDomain(ApplicationDomain.currentDomain)));
    }

    private function fetchAll():void {
      for (var i:int = 0; i < _count; i++) {
        fetchOne(i);
      }
    }

    private function fetchOne(i:int):void {
      var bytes:URLLoader = new URLLoader();
      bytes.dataFormat = URLLoaderDataFormat.BINARY;
      bytes.addEventListener(Event.COMPLETE, function (e:Event):void {
        _bytes[i] = bytes.data;
        if (++_fetched == _count) {
          trace("ready");
        }
      });
      bytes.load(new URLRequest("child" + i + ".swf"));
    }

    private function go():void {
      for (var i:int = 0; i < _count; i++) {
        var loader:Loader = new Loader();
        loader.contentLoaderInfo.addEventListener(Event.COMPLETE, loaded);
        var context:LoaderContext =
          new LoaderContext(false, new ApplicationDomain(ApplicationDomain.currentDomain));
        if (_mode == "bytes") {
          loader.loadBytes(_bytes[i], context);
        } else {
          loader.load(new URLRequest("child" + i + ".swf"), context);
        }

        loader.x = 20 * i;
        addChild(loader);
      }
    }

    private function loaded(e:Event):void {
      if (++_done == _count) {
        trace("done");
      }
    }
  }
}`;

/** A loaded SWF's code: its document class and two more, each of `methods` methods. */
function child(k: number): string {
  const body = (name: string, base: string, first: string) => {
    const lines = [first];
    for (let m = 0; m < methods; m++) {
      lines.push(`    public function m${m}(a:int, b:Number, s:String):Number {
      var t:Number = ${m};
      for (var j:int = 0; j < a; j++) {
        t += Math.sqrt(j * b) + s.length * ${(m % 7) + 1};
        if (t > ${1000 + m}) {
          t = t % ${(m % 5) + 2};
        }
      }
      var list:Array = [a, b, s, "${name}${m}"];
      var o:Object = {x: a, y: b, z: list.length};
      return t + list.length + o.x * o.y - s.indexOf("${k}");
    }`);
    }

    return `  import flash.display.Sprite;
  public class ${name} extends ${base} {
${lines.join("\n")}
  }`;
  };
  return [
    `package {\n${body(`Child${k}`, "Sprite", `    public function Child${k}() {}`)}\n}`,
    `package bench${k} {\n${body("Part", "Sprite", "")}\n}`,
    `package bench${k} {\n${body("Other", "Object", "")}\n}`,
  ].join("\n");
}

/** A root of `frames` frames whose 120 shapes move every frame, with LoadBenchMain as its class. */
function mainSwf(abc: Uint8Array): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  tags.push(
    w.shape({
      id: 1,
      bounds: [-200, 200, -200, 200],
      fills: [0xff3366cc],
      lines: [{ width: 40, color: 0xff202020 }],
      paths: [
        {
          fill1: 1,
          line: 1,
          commands: [
            { move: [-200, -200] },
            { curve: [0, -400, 200, -200] },
            { line: [200, 200] },
            { line: [-200, 200] },
            { line: [-200, -200] },
          ],
        },
      ],
    }),
  );
  tags.push(w.doAbc(abc, "LoadBenchMain"), w.symbolClass([[0, "LoadBenchMain"]]));
  const count = 120;
  const frames = 48;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < count; i++) {
      const angle = ((i * 37 + f * 7.5) * Math.PI) / 180;
      tags.push(
        w.place({
          depth: i + 1,
          character: f === 0 ? 1 : undefined,
          move: f > 0,
          matrix: {
            a: Math.cos(angle),
            b: Math.sin(angle),
            c: -Math.sin(angle),
            d: Math.cos(angle),
            tx: 400 + ((i * 397) % 10_000),
            ty: 400 + ((i * 211 + f * 40) % 7000),
          },
        }),
      );
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 550, height: 400, frameRate: 30, frameCount: frames, tags });
}

/** A loaded SWF: its one frame, with its code. */
function childSwf(abc: Uint8Array, k: number): Uint8Array {
  return w.swf({
    width: 100,
    height: 100,
    frameRate: 30,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.doAbc(abc, `Child${k}`),
      w.symbolClass([[0, `Child${k}`]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

libraryAbcs();
const sources = [
  { name: "LoadBenchMain", source: main },
  {
    name: "LoadBenchWarm",
    source: `package {
  import flash.display.Sprite;
  public class LoadBenchWarm extends Sprite {
    public function LoadBenchWarm() { trace("warm"); }
  }
}`,
  },
  ...Array.from({ length: loads }, (_, k) => ({
    name: `LoadBenchChild${k}_${methods}`,
    source: child(k),
  })),
];
const abcs = compileScripts(sources);
const mainBytes = mainSwf(abcs.get("LoadBenchMain") as Uint8Array);
const warmBytes = w.swf({
  width: 10,
  height: 10,
  frameRate: 30,
  frameCount: 1,
  tags: [
    w.fileAttributes(true),
    w.doAbc(abcs.get("LoadBenchWarm") as Uint8Array, "LoadBenchWarm"),
    w.symbolClass([[0, "LoadBenchWarm"]]),
    w.showFrame(),
    w.end(),
  ],
});
const children = Array.from({ length: loads }, (_, k) =>
  childSwf(abcs.get(`LoadBenchChild${k}_${methods}`) as Uint8Array, k),
);
let abcBytes = 0;
for (let k = 0; k < loads; k++) {
  abcBytes += abcs.get(`LoadBenchChild${k}_${methods}`)?.length ?? 0;
}

console.log(
  `load-bench: ${loads} SWFs of ${(abcBytes / loads / 1024).toFixed(0)} KB of ABC each, by ${mode === "bytes" ? "loadBytes" : "load"}, ${runs} runs each way`,
);

interface Measured {
  latency: number;
  /** The page's thread's busy time, and of it what was outside the frames' ticks and draws. */
  busy: number;
  outside: number;
  frameWork: number;
  frames: number;
  longTasks: number;
  longTaskTime: number;
  longest: number;
  worstGap: number;
}

/** A run's measures, or their medians, in a line. */
function describe(get: (key: keyof Measured) => number): string {
  const ms = (key: keyof Measured) => `${get(key).toFixed(0)} ms`;
  return (
    `latency ${ms("latency")}, busy ${ms("busy")} (${ms("outside")} outside ${get("frames").toFixed(0)} frames), ` +
    `${get("longTasks").toFixed(0)} long tasks (${ms("longTaskTime")}, longest ${ms("longest")}), worst frame gap ${ms("worstGap")}`
  );
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const results: Record<"worker" | "page", Measured[]> = { worker: [], page: [] };
await withPage(
  "loadBenchSetup",
  async (evaluate, send, fresh) => {
    await send("Performance.enable");
    const metrics = async () => {
      const { metrics } = await send<{ metrics: { name: string; value: number }[] }>(
        "Performance.getMetrics",
      );
      const named = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
      return named("TaskDuration") * 1000;
    };
    const childText = JSON.stringify(children.map(base64));
    for (let run = -1; run < runs; run++) {
      // Which goes first alternates, so that neither always meets a cold machine.
      const order: ("worker" | "page")[] = run % 2 ? ["page", "worker"] : ["worker", "page"];
      for (const way of order) {
        await fresh();
        const setup = await evaluate(
          `loadBenchSetup(${JSON.stringify(base64(mainBytes))}, ${childText}, ${JSON.stringify(base64(warmBytes))}, "${mode}", ${way === "worker"})`,
        );
        if (setup.exception) {
          throw new Error(setup.exception);
        }

        const before = await metrics();
        const { value, exception } = await evaluate<Measured & { error: string | null }>(
          "loadBenchGo()",
        );
        const after = await metrics();
        await evaluate("loadBenchStop()");
        if (exception || !value || value.error) {
          throw new Error(exception ?? value?.error ?? "no answer");
        }

        const busy = after - before;
        const measured = { ...value, busy, outside: busy - value.frameWork };
        if (run >= 0) {
          results[way].push(measured);
        }

        console.log(
          `  ${way.padEnd(6)} ${describe((key) => measured[key])}${run < 0 ? " (warm-up)" : ""}`,
        );
      }
    }
  },
  gpu,
);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
for (const way of ["worker", "page"] as const) {
  console.log(`${way} (medians): ${describe((key) => median(results[way].map((r) => r[key])))}`);
}
