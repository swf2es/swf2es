import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedResolves } from "../../../packages/player/dist/pixi-resolve.js";

function scene() {
  const calls: unknown[][] = [];
  const target = (name: string, msaa = true) => ({
    name,
    colorTexture: {},
    colorAttachments: [{}],
    gpu: { msaa, framebuffer: name, resolveTargetFramebuffer: `${name}-resolved` },
  });
  const stage = target("stage");
  const intermediate = target("filter");
  let duringCopy: (() => void) | null = null;
  const adaptor = {
    bindFramebuffer(framebuffer: unknown) {
      calls.push(["bind", framebuffer]);
    },
    finishRenderPass(into?: typeof stage) {
      calls.push(["full", into?.name]);
    },
    copyToTexture(
      source: typeof stage,
      destination: object,
      origin: { x: number; y: number },
      size: { width: number; height: number },
      to: { x: number; y: number },
    ) {
      duringCopy?.();
      this.finishRenderPass(source);
      calls.push(["copy", origin, size, to]);
      return destination;
    },
  };
  const filter = {
    _setupFilterTextures(run: () => void) {
      run();
    },
    _setupBindGroupsAndRender(run: () => void) {
      run();
    },
  };
  const renderer = {
    filter,
    renderTarget: { adaptor, getGpuRenderTarget: (into: typeof stage) => into.gpu },
    backBuffer: { _backBufferTexture: { source: stage.colorTexture } },
    gl: {
      READ_FRAMEBUFFER: 1,
      COLOR_BUFFER_BIT: 2,
      NEAREST: 3,
      bindFramebuffer(...args: unknown[]) {
        calls.push(["glBind", ...args]);
      },
      blitFramebuffer(...args: unknown[]) {
        calls.push(["blit", ...args]);
      },
    },
  };
  const install = () =>
    boundedResolves(renderer as unknown as Parameters<typeof boundedResolves>[0]);
  const copy = (source = stage) =>
    adaptor.copyToTexture(source, {}, { x: 17, y: 29 }, { width: 31, height: 43 }, { x: 2, y: 3 });

  return {
    calls,
    stage,
    intermediate,
    adaptor,
    filter,
    install,
    copy,
    duringCopy(run: () => void) {
      duringCopy = run;
    },
  };
}

test("blend setup resolves only the copied source rectangle and preserves copy offsets", () => {
  const s = scene();
  s.install();
  s.filter._setupFilterTextures(() => {
    s.adaptor.finishRenderPass(s.stage);
    s.copy();
  });
  assert.deepEqual(s.calls, [
    ["bind", "stage-resolved"],
    ["glBind", 1, "stage"],
    ["blit", 17, 29, 48, 72, 17, 29, 48, 72, 2, 3],
    ["bind", "stage"],
    ["copy", { x: 17, y: 29 }, { width: 31, height: 43 }, { x: 2, y: 3 }],
  ]);
});

test("filter outputs resolve for sampling, but the stage waits until presentation", () => {
  const s = scene();
  s.install();
  s.filter._setupBindGroupsAndRender(() => {
    s.adaptor.finishRenderPass(s.intermediate);
    s.adaptor.finishRenderPass(s.stage);
  });
  s.adaptor.finishRenderPass(s.stage);
  assert.deepEqual(s.calls, [
    ["full", "filter"],
    ["full", "stage"],
  ]);

  s.calls.length = 0;
  s.stage.gpu.msaa = false;
  s.filter._setupFilterTextures(() => s.adaptor.finishRenderPass(s.stage));
  s.stage.gpu.msaa = true;
  s.stage.colorAttachments = [];
  s.filter._setupBindGroupsAndRender(() => s.adaptor.finishRenderPass(s.stage));
  assert.deepEqual(s.calls, [
    ["full", "stage"],
    ["full", "stage"],
  ]);
});

test("resolve scopes unwind after errors and remain local to their renderer and source", () => {
  const s = scene();
  s.install();
  const finish = s.adaptor.finishRenderPass;
  s.install();
  assert.equal(s.adaptor.finishRenderPass, finish);
  const other = scene();
  other.filter._setupBindGroupsAndRender(() => other.adaptor.finishRenderPass(other.stage));
  assert.deepEqual(other.calls, [["full", "stage"]]);

  for (const enter of [s.filter._setupFilterTextures, s.filter._setupBindGroupsAndRender]) {
    assert.throws(
      () =>
        enter(() => {
          throw new Error("render failed");
        }),
      /render failed/,
    );
    s.adaptor.finishRenderPass(s.stage);
  }
  assert.deepEqual(s.calls, [
    ["full", "stage"],
    ["full", "stage"],
  ]);

  s.calls.length = 0;
  s.duringCopy(() => {
    s.adaptor.finishRenderPass(s.intermediate);
    throw new Error("copy failed");
  });
  assert.throws(() => s.copy(), /copy failed/);
  s.adaptor.finishRenderPass(s.stage);
  assert.deepEqual(s.calls, [
    ["full", "filter"],
    ["full", "stage"],
  ]);
});
