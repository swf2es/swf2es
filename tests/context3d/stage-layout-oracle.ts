// AIR's live Stage settings, their synchronous events and Stage3D placement.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodePng } from "../player/image.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/stage-layout-oracle/`;
mkdirSync(out, { recursive: true });
const layouts = [
  ["showAll", ""],
  ["noScale", ""],
  ["noScale", "TL"],
  ["noScale", "BR"],
  ["noScale", "TBLR"],
  ["exactFit", "TL"],
  ["noBorder", ""],
  ["showAll", "TL"],
  ["noScale", "TL"],
];
const points = [
  [4, 4],
  [10, 10],
  [14, 14],
  [20, 14],
  [34, 34],
  [50, 50],
  [60, 20],
  [70, 70],
  [80, 36],
  [100, 60],
  [130, 40],
  [180, 130],
  [58, 14],
  [64, 20],
  [82, 20],
  [84, 20],
  [108, 40],
  [110, 40],
  [124, 104],
  [0, 0],
  [48, 24],
  [34, 10],
];
// Trace live setters separately: Wine can keep a previous Stage3D window's
// pixels after a layout change. Fresh windows give independent pixel references.
async function reference(name: string, driver: string, capture: boolean) {
  const directory = `${out}${name}/`;
  const title = `swf2es-stage-layout-${process.pid}-${name}`;
  mkdirSync(directory, { recursive: true });
  rmSync(`${directory}close.txt`, { force: true });
  writeFileSync(
    `${directory}Reference.as`,
    `package {
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.utils.setInterval;
  import flash.utils.setTimeout;
  public class Reference extends StageLayout {
    public function Reference() {
      super();
      stage.nativeWindow.activate();
      ${driver}
    }
  }
}`,
  );
  const compiled = spawnSync(
    process.env.AMXMLC ?? "amxmlc",
    [
      "-compiler.float=false",
      "-omit-trace-statements=false",
      "-default-size=96,96",
      `-source-path=${directory},${here}`,
      "-output",
      `${directory}Reference.swf`,
      `${directory}Reference.as`,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  writeFileSync(
    `${directory}app.xml`,
    `<application xmlns="http://ns.adobe.com/air/application/51.3">
<id>swf2es.stage.layout.reference</id><versionNumber>1.0.0</versionNumber><filename>Reference</filename>
<initialWindow><content>Reference.swf</content><visible>true</visible><title>${title}</title><systemChrome>none</systemChrome><resizable>false</resizable><width>192</width><height>144</height><renderMode>direct</renderMode><depthAndStencil>false</depthAndStencil></initialWindow>
<supportedProfiles>extendedDesktop</supportedProfiles><diagnostics><traceToConsole>true</traceToConsole></diagnostics>
</application>`,
  );
  const run = spawn(process.env.ADL ?? "adl", ["app.xml", "."], { cwd: directory });
  let log = "";
  let stopped = false;
  let status: number | null = null;
  run.stdout.on("data", (data) => {
    log += data;
  });
  run.stderr.on("data", (data) => {
    log += data;
  });
  run.on("error", (error) => {
    log += error;
    stopped = true;
  });
  run.on("exit", (code) => {
    status = code;
    stopped = true;
  });
  let samples: string[] = [];
  try {
    const deadline = Date.now() + 30000;
    while (!log.includes("stagelayout capture")) {
      assert.ok(!stopped && Date.now() < deadline, log);
      await setTimeout(50);
    }
    if (capture) {
      const path = `${directory}frame.png`;
      const captured = spawnSync("import", ["-window", title, "-depth", "8", `PNG32:${path}`], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(captured.status, 0, captured.stderr);
      const image = decodePng(readFileSync(path));
      assert.equal(image.width, 192);
      assert.equal(image.height, 144);
      samples = points.map(([x, y]) =>
        Buffer.from(
          image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
        ).toString("hex"),
      );
    }
    writeFileSync(`${directory}close.txt`, "");
    const exitDeadline = Date.now() + 5000;
    while (!stopped && Date.now() < exitDeadline) {
      await setTimeout(50);
    }
    assert.ok(stopped, log);
    assert.equal(status, 0, log);
    return { samples, log };
  } finally {
    writeFileSync(`${directory}trace.log`, log);
    if (!stopped) {
      writeFileSync(`${directory}close.txt`, "");
      await setTimeout(250);
      if (!stopped) {
        run.kill();
      }
    }
  }
}

const live = await reference(
  "live",
  `var started:Boolean = false;
      setInterval(function():void {
        if (File.applicationDirectory.resolvePath("close.txt").exists) {
          NativeApplication.nativeApplication.exit(0);
          return;
        }
        if (!ready || started) { return; }
        started = true;
        trace("stagelayout validation", validateSettings());
        var layouts:Array = ${JSON.stringify(layouts)};
        for (var i:int = 0; i < layouts.length; i++) {
          trace("stagelayout state", i, configureLayout(layouts[i][0], layouts[i][1]));
        }
        trace("stagelayout capture");
      }, 100);`,
  false,
);
const validation = live.log.match(/stagelayout validation ([^\r\n]+)/)?.[1];
assert.ok(validation, live.log);
const states: { mode: string; align: string; state: string; samples: string[] }[] = [];
for (let i = 0; i < layouts.length; i++) {
  const [mode, align] = layouts[i];
  const state = live.log.match(new RegExp(`stagelayout state ${i} ([^\\r\\n]+)`))?.[1];
  assert.ok(state, live.log);
  const pixels = await reference(
    `pixels-${i}`,
    `stage.scaleMode = ${JSON.stringify(mode)};
      stage.align = ${JSON.stringify(align)};
      var captured:Boolean = false;
      setInterval(function():void {
        if (File.applicationDirectory.resolvePath("close.txt").exists) {
          NativeApplication.nativeApplication.exit(0);
          return;
        }
        if (!ready || captured) { return; }
        captured = true;
        setTimeout(function():void { trace("stagelayout capture"); }, 1000);
      }, 100);`,
    true,
  );
  states.push({ mode, align, state, samples: pixels.samples });
}
const result = { width: 192, height: 144, points, validation, states };
const path = `${here}stage-layout-reference.json`;
if (process.argv.includes("--update")) {
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
} else {
  assert.deepEqual(result, JSON.parse(readFileSync(path, "utf8")));
}
console.log(
  "context3d: AIR live Stage events and fresh-window pixels verified (9 layouts, 22 points each)",
);
