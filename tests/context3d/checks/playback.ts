import type { Context3DLifecycle } from "@swf2es/context3d";
import { installContext3D as install } from "@swf2es/player/context3d";
import { observeLoss } from "@swf2es/player-hosts/stage3d";
import { createCodegen } from "../../../packages/codegen/dist/index.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";

import { check, color, create, rejects } from "./context.ts";

export async function triangle(mode: "enabled" | "fallback" | "cancel") {
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const trace: string[] = [];
  let close = () => {};
  const scripting = new Scripting(codegen, {
    print: (line) => {
      trace.push(line);
      if (mode === "cancel" && line === "request-returned null") {
        close();
      }
    },
    audio: null,
  });
  const owned: ReturnType<typeof create>[] = [];
  close =
    mode === "fallback"
      ? () => {}
      : install(scripting, {
          create: () => {
            const entry = create();
            owned.push(entry);
            return entry.backend;
          },
          place: () => {},
          remove: () => {},
        });
  let player: Player | null = null;
  try {
    await scripting.loadLibraries(
      await Promise.all(
        ["builtin", "playerglobal-swf2es"].map(
          async (name) =>
            new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
        ),
      ),
    );
    player = new Player(
      new Uint8Array(await (await fetch("/context3d/Triangle.swf")).arrayBuffer()),
      scripting,
    );
    await player.start();
    check(trace[1] === "request-returned null", "request created a context synchronously");
    for (let i = 0; i < 3; i++) {
      await scripting.settled();
      player.tick();
    }
    let presented: string[] = [];
    if (mode === "enabled") {
      check(owned.length === 1, "expected one context");
      const { gl, backend } = owned[0];
      check(gl.getError() === gl.NO_ERROR, "WebGL error after AS3 triangle");
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const bytes = new Uint8Array(64 * 64 * 4);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      presented = [color(bytes, 32, 32, 64), color(bytes, 0, 0, 64)];
      const root = scripting.root?.object;
      check(root, "missing document instance");
      scripting.rt.callValue(
        scripting.rt.getProperty(root, scripting.rt.publicName("closeContext")),
        root,
        [],
        null,
      );
      check(backend.disposed, "AS3 dispose did not dispose the backend");
      check(owned[0].live.size === 0, "AS3 dispose retained GPU handles");
      rejects(() => backend.clear(0, 0, 0, 1));
      rejects(() => backend.setBlend("one", "zero"));
    }
    return { trace, presented, contexts: owned.length };
  } finally {
    close();
    player?.destroy();
    scripting.destroy();
    for (const entry of owned) {
      check(entry.live.size === 0, "host teardown retained GPU handles");
      entry.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}

export async function lifecycle(cancel: boolean) {
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const trace: string[] = [];
  let close = () => {};
  const scripting = new Scripting(codegen, {
    print: (line) => {
      trace.push(line);
      if (cancel && line === "life dispose-returned 1") {
        close();
      }
    },
    audio: null,
  });
  const active = new Map<number, ReturnType<typeof create>>();
  const presented: string[] = [];
  let created = 0;
  let placed = 0;
  close = install(scripting, {
    create: (slot) => {
      check(slot === 0 && active.size === 0, "recreation retained the old surface");
      const entry = create();
      active.set(slot, entry);
      created++;
      return entry.backend;
    },
    place: (slot, x, y, visible) => {
      check(slot === 0 && x === 7 && y === 11 && !visible, "slot state lost during recreation");
      placed++;
    },
    remove: (slot) => {
      const entry = active.get(slot);
      check(entry, "removed the same surface twice");
      check(entry.live.size === 0, "retired context still owns GPU resources");
      const { gl } = entry;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const pixel = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      presented.push(color(pixel, 0, 0, 1));
      check(gl.getError() === gl.NO_ERROR, "GL error during recreation");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      active.delete(slot);
    },
  });
  let player: Player | null = null;
  try {
    await scripting.loadLibraries(
      await Promise.all(
        ["builtin", "playerglobal-swf2es"].map(
          async (name) =>
            new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
        ),
      ),
    );
    player = new Player(
      new Uint8Array(await (await fetch("/context3d/Lifecycle.swf")).arrayBuffer()),
      scripting,
    );
    await player.start();
    for (let i = 0; i < 6; i++) {
      await scripting.settled();
      player.tick();
    }

    check(active.size === 0, "completed lifecycle retained a surface");
    check(placed === created, "recreated context was not placed");
    return { trace, created, presented };
  } finally {
    close();
    player?.destroy();
    scripting.destroy();
  }
}

export async function shaderFixture(
  fixture:
    | "Arithmetic"
    | "Texturing"
    | "Depth"
    | "Blending"
    | "ColorMask"
    | "Stencil"
    | "BufferBytes"
    | "TextureBytes"
    | "VertexFormats"
    | "ShaderMath"
    | "ScalarMath"
    | "Comparisons"
    | "FrameValidation"
    | "FrameValidationFlat"
    | "Reconfigure"
    | "Scissor"
    | "Mipmaps"
    | "SamplerStates"
    | "LodBias"
    | "RectangleTextures"
    | "Multisampling"
    | "TargetMultisampling"
    | "TemporaryMatrices"
    | "IndirectConstants"
    | "CubeTargets"
    | "CubeTextures"
    | "RenderTargets",
) {
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const trace: string[] = [];
  const scripting = new Scripting(codegen, { print: (line) => trace.push(line), audio: null });
  const owned: ReturnType<typeof create>[] = [];
  let targetSamples = 0;
  const close = install(scripting, {
    create: () => {
      const entry = create();
      if (fixture === "TargetMultisampling") {
        const select = entry.backend.setRenderTarget.bind(entry.backend);
        entry.backend.setRenderTarget = (texture, depth, face, antiAlias) => {
          select(texture, depth, face, antiAlias);
          if (texture) {
            targetSamples = Math.max(targetSamples, entry.gl.getParameter(entry.gl.SAMPLES));
          }
        };
      }
      owned.push(entry);
      return entry.backend;
    },
    place: () => {},
    remove: () => {},
  });
  let player: Player | null = null;
  try {
    await scripting.loadLibraries(
      await Promise.all(
        ["builtin", "playerglobal-swf2es"].map(
          async (name) =>
            new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
        ),
      ),
    );
    player = new Player(
      new Uint8Array(await (await fetch(`/context3d/${fixture}.swf`)).arrayBuffer()),
      scripting,
    );
    await player.start();
    for (let i = 0; i < 3; i++) {
      await scripting.settled();
      player.tick();
    }
    check(
      trace.at(-1) === `${fixture.toLowerCase()} complete`,
      `incomplete shader trace: ${trace}`,
    );
    check(owned.length === 1, "unexpected shader context count");
    check(owned[0].gl.getError() === owned[0].gl.NO_ERROR, "GL error after shader fixture");
    if (fixture === "TargetMultisampling") {
      check(targetSamples > 0, "AS antialiasing requests did not reach texture targets");
    }
    return { trace };
  } finally {
    close();
    player?.destroy();
    scripting.destroy();
    for (const entry of owned) {
      check(entry.live.size === 0, "shader fixture retained GPU handles");
      entry.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}

/** Forced browser loss is separate from the AIR explicit-disposal oracle. */

export async function recovery(cancel: "none" | "lost" | "queued") {
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const trace: string[] = [];
  const scripting = new Scripting(codegen, { print: (line) => trace.push(line), audio: null });
  type Surface = ReturnType<typeof create> & { detach: () => void; events: Context3DLifecycle };
  const surfaces: Surface[] = [];
  let active: Surface | null = null;
  let placed = 0;
  const close = install(scripting, {
    create: (slot, events) => {
      check(slot === 0 && active === null, "recovery retained the old surface");
      const entry = create();
      active = { ...entry, events, detach: observeLoss(entry.canvas, events) };
      surfaces.push(active);
      return entry.backend;
    },
    place: (slot, x, y, visible) => {
      check(slot === 0 && x === 7 && y === 11 && !visible, "recovery lost slot properties");
      placed++;
    },
    remove: () => {
      check(active, "recovery removed the surface twice");
      active.detach();
      check(active.live.size === 0, "recovery retained GPU handles");
      active.gl.getExtension("WEBGL_lose_context")?.loseContext();
      active = null;
    },
  });
  const waitEvent = (canvas: HTMLCanvasElement, name: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        canvas.removeEventListener(name, done);
        reject(new Error(`Timed out waiting for ${name}`));
      }, 5000);
      canvas.addEventListener(name, done, { once: true });
    });
  const expected: string[] = [];
  const errors = [
    "recovery context Error 3694",
    "recovery buffer Error 3694",
    "recovery indices Error 3694",
    "recovery buffer-bytes Error 3694",
    "recovery index-bytes Error 3694",
    "recovery program Error 3694",
    "recovery texture-bytes Error 3694",
    "recovery texture Error 3694",
    "recovery cube-target Error 3694",
  ];
  let player: Player | null = null;
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await scripting.settled();
      player?.tick();
    }
  };
  const verify = (generation: number): void => {
    expected.push(`recovery created ${generation} true`, "recovery initial 0 0 false");
    if (generation > 1) {
      expected.push(...errors, "recovery survived true");
    }
    check(
      JSON.stringify(trace) === JSON.stringify(expected),
      `unexpected recovery trace: ${trace}`,
    );
    check(active && placed === generation, "recovery did not place the new context");
    const { gl } = active;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const pixel = new Uint8Array(4);
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    check(
      color(pixel, 0, 0, 1) === ["ffff0000", "ff00ff00", "ff0000ff"][generation - 1],
      "recreated AS3 context did not present new pixels",
    );
    check(gl.getError() === gl.NO_ERROR, "GL error after recovery");
  };
  try {
    await scripting.loadLibraries(
      await Promise.all(
        ["builtin", "playerglobal-swf2es"].map(
          async (name) =>
            new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
        ),
      ),
    );
    player = new Player(
      new Uint8Array(await (await fetch("/context3d/Recovery.swf")).arrayBuffer()),
      scripting,
    );
    await player.start();
    await drain();
    verify(1);
    surfaces[0].events.restored();
    await drain();
    check(surfaces.length === 1, "restoration without loss recreated a context");
    for (let cycle = 0; cycle < (cancel === "none" ? 2 : 1); cycle++) {
      const retired = surfaces[cycle];
      const extension = retired.gl.getExtension("WEBGL_lose_context");
      check(extension, "loss extension unavailable");
      retired.backend.setScissor(0, 0, 1, 1);
      const lost = waitEvent(retired.canvas, "webglcontextlost");
      extension.loseContext();
      await lost;
      retired.events.lost();
      check(retired.backend.disposed && retired.live.size === 0, "loss retained old resources");
      const root = scripting.root?.object;
      check(root, "missing recovery document");
      scripting.rt.callValue(
        scripting.rt.getProperty(root, scripting.rt.publicName("inspectLost")),
        root,
        [],
        null,
      );
      expected.push("recovery empty true", "recovery disposed Disposed 0 null", ...errors);
      check(JSON.stringify(trace) === JSON.stringify(expected), `unexpected lost trace: ${trace}`);
      await drain();
      check(surfaces.length === cycle + 1, "created a context before browser restoration");
      if (cancel === "lost") {
        close();
      }
      const restored = waitEvent(retired.canvas, "webglcontextrestored");
      // Let the loss event finish before asking the extension to restore.
      await new Promise((resolve) => setTimeout(resolve, 20));
      extension.restoreContext();
      await restored;
      check(surfaces.length === cycle + 1, "restoration dispatched AS3 synchronously");
      if (cancel === "queued") {
        close();
      }
      await drain();
      if (cancel === "none") {
        verify(cycle + 2);
      }
      // Even an already queued callback from a retired host must be harmless.
      retired.events.lost();
      retired.events.restored();
      retired.events.restored();
      await drain();
      check(
        surfaces.length === (cancel === "none" ? cycle + 2 : 1),
        "stale callback recreated a context",
      );
      check(JSON.stringify(trace) === JSON.stringify(expected), "stale callback changed AS3 state");
      check(
        cancel === "none" ? active !== null : active === null,
        "stale callback changed the current surface",
      );
    }
    return { passed: true };
  } finally {
    close();
    player?.destroy();
    scripting.destroy();
    for (const surface of surfaces) {
      check(surface.live.size === 0, "recovery teardown retained GPU resources");
      const event = new Event("webglcontextlost", { cancelable: true });
      surface.canvas.dispatchEvent(event);
      check(!event.defaultPrevented, "teardown retained a loss listener");
      surface.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}
