// Optional AIR reference, separate from the CPU display-list oracle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureSource } from "./fixtures.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture =
  [
    "FrameValidation",
    "FrameValidationFlat",
    "Reconfigure",
    "Comparisons",
    "RenderTargets",
    "CubeTargets",
    "CubeTextures",
    "TemporaryMatrices",
    "Multisampling",
    "Mipmaps",
    "Scissor",
    "ShaderMath",
    "ScalarMath",
    "Blending",
    "ColorMask",
    "Stencil",
    "BufferBytes",
    "TextureBytes",
    "VertexFormats",
    "Depth",
    "Texturing",
    "Arithmetic",
    "Lifecycle",
  ].find((name) =>
    process.argv.includes(`--${name === "ShaderMath" ? "shader-math" : name.toLowerCase()}`),
  ) ?? "Triangle";
const triangle = fixture === "Triangle";
const prefix = fixture === "Lifecycle" ? "life" : fixture.toLowerCase();
const out = `${here}out/oracle-${fixture}/`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}${fixture}.as`, fixtureSource(fixture));
writeFileSync(
  `${out}Reference.as`,
  `package {
  import flash.desktop.NativeApplication;
  import flash.utils.setTimeout;
  public class Reference extends ${fixture} {
    public function Reference() {
      super();
      stage.nativeWindow.activate();
      setTimeout(function():void {
        try {
          ${!triangle ? 'if (!complete) { throw new Error("Fixture did not complete"); }' : "closeContext();"}
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
    <width>96</width><height>96</height><renderMode>direct</renderMode><depthAndStencil>${fixture === "Stencil" || fixture === "ColorMask" || fixture === "Depth" || fixture === "Multisampling" || fixture === "RenderTargets" || fixture === "CubeTargets" || fixture === "Reconfigure" || fixture === "FrameValidation"}</depthAndStencil>
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
    triangle
      ? /^(request|request-returned|created|clear|triangle|outside|upper-left|lower-left|presented|next-clear|complete|disposed|context-error|reference-error)( |$)/.test(
          line,
        )
      : line.startsWith(`${prefix} `),
  );
if (triangle) {
  assert.equal(lines.length, 12, JSON.stringify(lines));
  assert.equal(lines.at(-1), "disposed");
} else {
  assert.equal(
    lines.at(-1),
    fixture === "Lifecycle" ? "life complete 3" : `${prefix} complete`,
    JSON.stringify(lines),
  );
}
const path = `${here}${triangle ? "" : `${fixture.toLowerCase()}-`}reference.json`;
if (fixture === "Comparisons") {
  // Self-checking: do not bless a driver's incorrect shader results as a reference.
  assert.deepEqual(lines, ["comparisons checks 368", "comparisons complete"]);
} else if (process.argv.includes("--update")) {
  writeFileSync(path, `${JSON.stringify(lines, null, 2)}\n`);
} else {
  assert.deepEqual(lines, JSON.parse(readFileSync(path, "utf8")));
}
console.log("context3d: AIR direct-mode reference verified");
