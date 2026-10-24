// Captures AIR's actual Stage3D composition; BitmapData.draw(stage) omits it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodePng } from "../player/image.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/composition-oracle/`;
const title = `swf2es-context3d-${process.pid}`;
const points = [
  [4, 4],
  [12, 12],
  [28, 28],
  [36, 36],
  [52, 36],
  [68, 68],
  [60, 12],
  [80, 12],
];
mkdirSync(out, { recursive: true });
function signal(step: number): void {
  writeFileSync(`${out}step-next.txt`, String(step));
  renameSync(`${out}step-next.txt`, `${out}step.txt`);
}

signal(-1);
writeFileSync(
  `${out}Reference.as`,
  `package {
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileMode;
  import flash.filesystem.FileStream;
  import flash.utils.setInterval;
  import flash.utils.setTimeout;
  public class Reference extends Composition {
    public function Reference() {
      super();
      stage.nativeWindow.activate();
      var previous:int = -1;
      setInterval(function():void {
        if (!ready) {
          return;
        }
        var stream:FileStream = new FileStream();
        stream.open(File.applicationDirectory.resolvePath("step.txt"), FileMode.READ);
        var step:int = int(stream.readUTFBytes(stream.bytesAvailable));
        stream.close();
        if (step == previous) {
          return;
        }
        previous = step;
        if (step == 9) {
          NativeApplication.nativeApplication.exit(0);
          return;
        }
        advance(step);
        setTimeout(function():void { trace("capture", step); }, 300);
      }, 100);
    }
  }
}`,
);
const compile = spawnSync(
  process.env.AMXMLC ?? "amxmlc",
  [
    "-compiler.float=false",
    "-omit-trace-statements=false",
    `-source-path=${out},${here}`,
    "-output",
    `${out}Reference.swf`,
    `${out}Reference.as`,
  ],
  { encoding: "utf8", timeout: 60_000 },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);
writeFileSync(
  `${out}app.xml`,
  `<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>swf2es.context3d.composition</id><versionNumber>1.0.0</versionNumber><filename>Reference</filename>
  <initialWindow><content>Reference.swf</content><visible>true</visible><title>${title}</title>
    <systemChrome>none</systemChrome><resizable>false</resizable>
    <width>96</width><height>96</height><renderMode>direct</renderMode><depthAndStencil>false</depthAndStencil>
  </initialWindow>
  <supportedProfiles>extendedDesktop</supportedProfiles>
  <diagnostics><traceToConsole>true</traceToConsole></diagnostics>
</application>`,
);
const run = spawn(process.env.ADL ?? "adl", ["app.xml", "."], { cwd: out });
let log = "";
run.stdout.on("data", (data) => {
  log += data;
});
run.stderr.on("data", (data) => {
  log += data;
});
let stopped = false;
let status: number | null = null;
let failure = "";
run.on("error", (error) => {
  failure = error.message;
  stopped = true;
});
run.on("exit", (code) => {
  status = code;
  stopped = true;
});
const samples: string[][] = [];
try {
  for (let step = 0; step < 9; step++) {
    signal(step);
    const deadline = Date.now() + 30_000;
    while (!log.includes(`capture ${step}`)) {
      assert.ok(!stopped && Date.now() < deadline, failure || log);
      await setTimeout(50);
    }

    const path = `${out}/step-${step}.png`;
    const capture = spawnSync("import", ["-window", title, "-depth", "8", `PNG32:${path}`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(capture.status, 0, capture.stderr);
    const image = decodePng(readFileSync(path));
    // Some window managers enforce a minimum width even without window chrome.
    // NO_SCALE/TOP_LEFT keeps the sampled stage coordinates unchanged.
    assert.ok(image.width >= 96 && image.height >= 96);
    samples.push(
      points.map(([x, y]) =>
        Buffer.from(
          image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
        ).toString("hex"),
      ),
    );
  }

  signal(9);
  const deadline = Date.now() + 5_000;
  while (!stopped && Date.now() < deadline) {
    await setTimeout(50);
  }

  assert.ok(stopped, "AIR did not exit after capture");
  assert.equal(status, 0, failure || log);
  const result = { points, samples };
  const path = `${here}composition-reference.json`;
  if (process.argv.includes("--update")) {
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  } else {
    assert.deepEqual(result, JSON.parse(readFileSync(path, "utf8")));
  }

  console.log("context3d: AIR composition reference verified (9 states, 8 points each)");
} finally {
  writeFileSync(`${out}trace.log`, log);
  if (!stopped) {
    run.kill();
  }
}
