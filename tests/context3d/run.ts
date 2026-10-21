import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { fixtureSource } from "./fixtures.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${here}out/`;
mkdirSync(out, { recursive: true });
libraryAbcs();
const scripts = compileScripts(
  [
    "Triangle",
    "Composition",
    "Lifecycle",
    "Recovery",
    "Arithmetic",
    "Texturing",
    "Depth",
    "Blending",
    "ColorMask",
    "Stencil",
    "BufferBytes",
    "TextureBytes",
    "VertexFormats",
    "ShaderMath",
    "ScalarMath",
    "Comparisons",
    "FrameValidation",
    "FrameValidationFlat",
    "Reconfigure",
    "Scissor",
    "Mipmaps",
    "SamplerStates",
    "LodBias",
    "Multisampling",
    "RenderTargets",
    "CubeTargets",
    "CubeTextures",
    "TemporaryMatrices",
    "IndirectConstants",
  ].map((name) => ({
    name,
    source: fixtureSource(name),
  })),
  out,
);
for (const name of [
  "Triangle",
  "Composition",
  "Lifecycle",
  "Recovery",
  "Arithmetic",
  "Texturing",
  "Depth",
  "Blending",
  "ColorMask",
  "Stencil",
  "BufferBytes",
  "TextureBytes",
  "VertexFormats",
  "ShaderMath",
  "ScalarMath",
  "Comparisons",
  "FrameValidation",
  "FrameValidationFlat",
  "Reconfigure",
  "Scissor",
  "Mipmaps",
  "SamplerStates",
  "LodBias",
  "Multisampling",
  "RenderTargets",
  "CubeTargets",
  "CubeTextures",
  "TemporaryMatrices",
  "IndirectConstants",
]) {
  const abc = scripts.get(name);
  assert.ok(abc);
  const size = name === "Triangle" ? 64 : 96;
  writeFileSync(`${out}${name}.swf`, bare(abc, 1, name, size, size));
}
if (!process.argv.includes("--build-only")) {
  const reference: string[] = JSON.parse(readFileSync(`${here}reference.json`, "utf8"));
  await withPage(
    "runSwf",
    async (evaluate, send) => {
      for (const mode of ["enabled", "fallback", "cancel"]) {
        const result = await evaluate<{ trace: string[]; presented: string[]; contexts: number }>(
          `import("/repo/tests/context3d/page.ts").then(m => m.triangle(${JSON.stringify(mode)}))`,
        );
        assert.equal(result.exception, null, JSON.stringify(result));
        assert.ok(result.value);
        if (mode === "enabled") {
          assert.deepEqual(result.value.trace, reference);
          assert.deepEqual(
            result.value.presented,
            ["ffff0000", "ff336699"],
            "presented buffer changed after clear",
          );
          assert.equal(result.value.contexts, 1);
        } else {
          assert.equal(result.value.contexts, 0);
          assert.deepEqual(result.value.trace, [
            "request",
            "request-returned null",
            ...(mode === "fallback" ? ["context-error 3702"] : []),
          ]);
        }
        console.log(`context3d: ${mode} ok`);
      }
      const result = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.lifetime())',
      );
      assert.equal(result.exception, null, JSON.stringify(result));
      assert.equal(result.value?.passed, true);
      console.log("context3d: ownership, failed uploads, resize, disposal and context loss ok");
      const targets = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.renderTargets())',
      );
      assert.equal(targets.exception, null, JSON.stringify(targets));
      assert.equal(targets.value?.passed, true);
      console.log("context3d: render target reuse, feedback, allocation failures and cleanup ok");
      const cubes = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.cubeTargets())',
      );
      assert.equal(cubes.exception, null, JSON.stringify(cubes));
      assert.equal(cubes.value?.passed, true);
      console.log(
        "context3d: cube target faces, mipmaps, reuse, allocation rollback and cleanup ok",
      );
      const msaa = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.multisampling())',
      );
      assert.equal(msaa.exception, null, JSON.stringify(msaa));
      assert.equal(msaa.value?.passed, true);
      console.log("context3d: multisample edges, resolve reuse, resize and allocation failures ok");
      const reconfiguration = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.reconfiguration())',
      );
      assert.equal(reconfiguration.exception, null, JSON.stringify(reconfiguration));
      assert.equal(reconfiguration.value?.passed, true);
      console.log("context3d: unchanged back buffers reuse resources and preserve pixels");
      const masks = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.colorMasks())',
      );
      assert.equal(masks.exception, null, JSON.stringify(masks));
      assert.equal(masks.value?.passed, true);
      console.log("context3d: color masks preserve resolve/presentation and reuse GPU state");
      const stencil = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.stencil())',
      );
      assert.equal(stencil.exception, null, JSON.stringify(stencil));
      assert.equal(stencil.value?.passed, true);
      console.log(
        "context3d: stencil preserves presentation, reuses GPU state and releases resources",
      );
      const bytes = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.bufferBytes())',
      );
      assert.equal(bytes.exception, null, JSON.stringify(bytes));
      assert.equal(bytes.value?.passed, true);
      console.log("context3d: raw byte uploads preserve bits, reuse storage and validate indices");
      const textureBytes = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.textureBytes())',
      );
      assert.equal(textureBytes.exception, null, JSON.stringify(textureBytes));
      assert.equal(textureBytes.value?.passed, true);
      console.log(
        "context3d: texture byte uploads preserve channels, reuse staging and release resources",
      );
      const samplers = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.samplerStates())',
      );
      assert.equal(samplers.exception, null, JSON.stringify(samplers));
      assert.equal(samplers.value?.passed, true);
      console.log(
        "context3d: runtime samplers share cached handles and preserve resource lifetime",
      );
      const indirect = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.indirectConstants())',
      );
      assert.equal(indirect.exception, null, JSON.stringify(indirect));
      assert.equal(indirect.value?.passed, true);
      console.log("context3d: indexed constants reuse their bank and preserve program lifetime");
      const vertexFormats = await evaluate<{ passed: boolean }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.vertexFormats())',
      );
      assert.equal(vertexFormats.exception, null, JSON.stringify(vertexFormats));
      assert.equal(vertexFormats.value?.passed, true);
      console.log(
        "context3d: packed vertex formats normalize on GPU and preserve resource lifetime",
      );
      const lifecycle: string[] = JSON.parse(
        readFileSync(`${here}lifecycle-reference.json`, "utf8"),
      );
      for (const cancel of [false, true]) {
        const result = await evaluate<{ trace: string[]; created: number; presented: string[] }>(
          `import("/repo/tests/context3d/page.ts").then(m => m.lifecycle(${cancel}))`,
        );
        assert.equal(result.exception, null, JSON.stringify(result));
        assert.ok(result.value);
        assert.deepEqual(
          result.value.trace,
          cancel ? lifecycle.slice(0, lifecycle.indexOf("life dispose-returned 1") + 1) : lifecycle,
        );
        assert.equal(result.value.created, cancel ? 1 : 3);
        assert.deepEqual(
          result.value.presented,
          cancel ? ["ffff0000"] : ["ffff0000", "ff00ff00", "ff0000ff"],
        );
      }

      console.log("context3d: AIR lifecycle, disposed errors and cancellation of recreation ok");
      for (const cancel of ["none", "lost", "queued"]) {
        const result = await evaluate<{ passed: boolean }>(
          `import("/repo/tests/context3d/page.ts").then(m => m.recovery(${JSON.stringify(cancel)}))`,
        );
        assert.equal(result.exception, null, JSON.stringify(result));
        assert.equal(result.value?.passed, true);
        console.log(`context3d: real WebGL loss/restoration (${cancel}) ok`);
      }
      for (const fixture of [
        "Arithmetic",
        "Texturing",
        "Depth",
        "Blending",
        "ColorMask",
        "Stencil",
        "BufferBytes",
        "TextureBytes",
        "VertexFormats",
        "ShaderMath",
        "ScalarMath",
        "FrameValidation",
        "FrameValidationFlat",
        "Reconfigure",
        "Scissor",
        "Mipmaps",
        "SamplerStates",
        "LodBias",
        "Multisampling",
        "RenderTargets",
        "CubeTargets",
        "CubeTextures",
        "TemporaryMatrices",
        "IndirectConstants",
      ]) {
        const result = await evaluate<{ trace: string[] }>(
          `import("/repo/tests/context3d/page.ts").then(m => m.shaderFixture(${JSON.stringify(fixture)}))`,
        );
        assert.equal(result.exception, null, JSON.stringify(result));
        assert.deepEqual(
          result.value?.trace,
          JSON.parse(readFileSync(`${here}${fixture.toLowerCase()}-reference.json`, "utf8")),
        );
        console.log(`context3d: ${fixture} matches AIR`);
      }
      const comparisons = await evaluate<{ trace: string[] }>(
        'import("/repo/tests/context3d/page.ts").then(m => m.shaderFixture("Comparisons"))',
      );
      assert.equal(comparisons.exception, null, JSON.stringify(comparisons));
      assert.deepEqual(comparisons.value?.trace, [
        "comparisons checks 368",
        "comparisons complete",
      ]);
      console.log("context3d: fragment comparisons pass 368 independent pixel checks");
      const composition: { points: number[][]; samples: string[][] } = JSON.parse(
        readFileSync(`${here}composition-reference.json`, "utf8"),
      );
      try {
        const started = await evaluate(
          'import("/repo/tests/context3d/page.ts").then(m => m.composition())',
        );
        assert.equal(started.exception, null, JSON.stringify(started));
        for (let step = 0; step < composition.samples.length; step++) {
          const advanced = await evaluate(
            `import("/repo/tests/context3d/page.ts").then(m => m.compositionStep(${step}))`,
          );
          assert.equal(advanced.exception, null, JSON.stringify(advanced));
          const capture = (await send("Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width: 96, height: 96, scale: 1 },
          })) as { data: string };
          const png = Buffer.from(capture.data, "base64");
          writeFileSync(`${out}composition-${step}.png`, png);
          const image = decodePng(png);
          assert.equal(image.width, 96);
          assert.equal(image.height, 96);
          for (let point = 0; point < composition.points.length; point++) {
            const [x, y] = composition.points[point];
            const expected = Buffer.from(composition.samples[step][point], "hex");
            const actual = image.data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4);
            for (let channel = 0; channel < 4; channel++) {
              assert.ok(
                Math.abs(actual[channel] - expected[channel]) <= 1,
                `composition step ${step}, (${x}, ${y}): ${actual} != ${expected}`,
              );
            }
          }
        }

        console.log("context3d: Stage3D composition matches AIR (9 states, 8 points each)");
      } finally {
        const closed = await evaluate(
          'import("/repo/tests/context3d/page.ts").then(m => m.closeComposition())',
        );
        assert.equal(closed.exception, null, JSON.stringify(closed));
      }
    },
    false,
    {
      mounts: [
        ["/repo/", root],
        ["/context3d/", out],
      ],
    },
  );
}
