// Each layout starts in a fresh AIR window: Wine can present a stale frame
// when an existing Stage3D window changes scale mode while it is obscured.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodePng } from "../player/image.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const width = 192;
const height = 144;
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
];
const states: { scale: string; salign: string; samples: string[] }[] = [];

for (const salign of ["TL", ""]) {
  for (const scale of ["noScale", "showAll", "exactFit", "noBorder"]) {
    const out = `${here}out/viewport-oracle/${scale}-${salign || "center"}/`;
    const title = `swf2es-viewport-${process.pid}-${states.length}`;
    mkdirSync(out, { recursive: true });
    rmSync(`${out}close.txt`, { force: true });
    writeFileSync(
      `${out}Reference.as`,
      `package {
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.utils.setInterval;
  import flash.utils.setTimeout;
  public class Reference extends Composition {
    public function Reference() {
      super();
      stage.align = ${JSON.stringify(salign)};
      stage.scaleMode = ${JSON.stringify(scale)};
      stage.nativeWindow.activate();
      var captured:Boolean = false;
      setInterval(function():void {
        if (File.applicationDirectory.resolvePath("close.txt").exists) {
          NativeApplication.nativeApplication.exit(0);
        }
        if (ready && !captured) {
          captured = true;
          setTimeout(function():void { trace("viewport capture"); }, 1000);
        }
      }, 100);
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
        `-source-path=${out},${here}`,
        "-output",
        `${out}Reference.swf`,
        `${out}Reference.as`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    writeFileSync(
      `${out}app.xml`,
      `<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>swf2es.context3d.viewport</id><versionNumber>1.0.0</versionNumber><filename>Reference</filename>
  <initialWindow><content>Reference.swf</content><visible>true</visible><title>${title}</title>
    <systemChrome>none</systemChrome><resizable>false</resizable>
    <width>${width}</width><height>${height}</height><renderMode>direct</renderMode><depthAndStencil>false</depthAndStencil>
  </initialWindow><supportedProfiles>extendedDesktop</supportedProfiles>
  <diagnostics><traceToConsole>true</traceToConsole></diagnostics>
</application>`,
    );
    const run = spawn(process.env.ADL ?? "adl", ["app.xml", "."], { cwd: out });
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
      log += error.message;
      stopped = true;
    });
    run.on("exit", (code) => {
      status = code;
      stopped = true;
    });
    try {
      let deadline = Date.now() + 30000;
      while (!log.includes("viewport capture")) {
        assert.ok(!stopped && Date.now() < deadline, log);
        await setTimeout(50);
      }
      const path = `${out}frame.png`;
      const capture = spawnSync("import", ["-window", title, "-depth", "8", `PNG32:${path}`], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(capture.status, 0, capture.stderr);
      const image = decodePng(readFileSync(path));
      assert.ok(image.width >= width && image.height >= height);
      states.push({
        scale,
        salign,
        samples: points.map(([x, y]) =>
          Buffer.from(
            image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
          ).toString("hex"),
        ),
      });
      writeFileSync(`${out}close.txt`, "close");
      deadline = Date.now() + 5000;
      while (!stopped && Date.now() < deadline) {
        await setTimeout(50);
      }
      assert.ok(stopped, log);
      assert.equal(status, 0, log);
    } finally {
      writeFileSync(`${out}trace.log`, log);
      if (!stopped) {
        run.kill();
      }
    }
  }
}

const result = { width, height, points, states };
const path = `${here}viewport-reference.json`;
if (process.argv.includes("--update")) {
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
} else {
  assert.deepEqual(result, JSON.parse(readFileSync(path, "utf8")));
}
console.log("context3d: AIR viewport reference verified (8 layouts, 18 pixel points each)");
