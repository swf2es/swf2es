// Optional AIR reference, separate from the CPU display-list oracle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/oracle/`;
mkdirSync(out, { recursive: true });
writeFileSync(
  `${out}Reference.as`,
  `package {
  import flash.desktop.NativeApplication;
  import flash.utils.setTimeout;
  public class Reference extends Triangle {
    public function Reference() {
      super();
      setTimeout(function():void {
        try {
          closeContext();
          NativeApplication.nativeApplication.exit(0);
        } catch (error:Error) {
          trace("reference-error", error);
          NativeApplication.nativeApplication.exit(1);
        }
      }, 2000);
    }
  }
}`,
);
const compiled = spawnSync(
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
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
writeFileSync(
  `${out}app.xml`,
  `<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>swf2es.context3d.reference</id><versionNumber>1.0.0</versionNumber><filename>Reference</filename>
  <initialWindow><content>Reference.swf</content><visible>true</visible>
    <width>96</width><height>96</height><renderMode>direct</renderMode><depthAndStencil>false</depthAndStencil>
  </initialWindow>
  <supportedProfiles>extendedDesktop</supportedProfiles>
  <diagnostics><traceToConsole>true</traceToConsole></diagnostics>
</application>`,
);
const run = spawnSync(process.env.ADL ?? "adl", ["app.xml", "."], {
  cwd: out,
  encoding: "utf8",
  timeout: 30_000,
});
writeFileSync(`${out}trace.log`, run.stdout + run.stderr);
assert.equal(run.status, 0, run.stdout + run.stderr);
const lines = (run.stdout + run.stderr)
  .replaceAll("\r", "")
  .split("\n")
  .filter((line) =>
    /^(request|request-returned|created|clear|triangle|outside|upper-left|lower-left|presented|next-clear|complete|disposed|context-error|reference-error)( |$)/.test(
      line,
    ),
  );
assert.equal(lines.length, 12, JSON.stringify(lines));
assert.equal(lines.at(-1), "disposed");
const path = `${here}reference.json`;
if (process.argv.includes("--update")) {
  writeFileSync(path, `${JSON.stringify(lines, null, 2)}\n`);
} else {
  assert.deepEqual(lines, JSON.parse(readFileSync(path, "utf8")));
}
console.log("context3d: AIR direct-mode reference verified");
