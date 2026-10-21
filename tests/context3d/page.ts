import { autoDetectRenderer } from "pixi.js";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import { Player } from "../../packages/player/dist/player.js";
import { PixiView } from "../../packages/player/dist/render/view.js";
import { Scripting } from "../../packages/player/dist/scripting.js";
import type { Context3DLifecycle, VertexFormat } from "./backend.ts";
import { install } from "./natives.ts";
import { observeLoss, WebGLContext3D } from "./webgl.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function rejects(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(threw, "operation should have been rejected");
}

function create() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  });
  check(gl, "WebGL2 unavailable");
  const live = new Set<object>();
  let created = 0;
  // Count actual GPU handles, including shaders and resources a failed
  // upload allocates; empty JS ownership maps alone do not prove deletion.
  for (const kind of [
    "Buffer",
    "Program",
    "Shader",
    "Texture",
    "Framebuffer",
    "Renderbuffer",
    "VertexArray",
    "Sampler",
  ] as const) {
    const object = gl as unknown as Record<string, (...args: never[]) => object | null>;
    const createName = `create${kind}`;
    const deleteName = `delete${kind}`;
    const make = object[createName].bind(gl);
    const drop = object[deleteName].bind(gl);
    object[createName] = (...args) => {
      const value = make(...args);
      if (value) {
        live.add(value);
        created++;
      }
      return value;
    };
    object[deleteName] = (...args) => {
      live.delete(args[0]);
      return drop(...args);
    };
  }
  const backend = new WebGLContext3D(gl);
  return {
    canvas,
    gl,
    live,
    backend,
    get created() {
      return created;
    },
  };
}

function color(bytes: Uint8Array, x: number, y: number, width: number): string {
  const i = (y * width + x) * 4;
  return (
    ((bytes[i + 3] << 24) | (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]) >>>
    0
  ).toString(16);
}

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

function shader(fragment: boolean): Uint8Array {
  const bytes = new Uint8Array(31);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xa0;
  view.setUint32(1, 1, true);
  bytes[5] = 0xa1;
  bytes[6] = fragment ? 1 : 0;
  view.setUint32(11, 0x030f0000, true);
  view.setUint32(15, 0xe4000000, true);
  view.setUint32(19, fragment ? 1 : 0, true);
  return bytes;
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
    | "Multisampling"
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
  const close = install(scripting, {
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

let compositionRun: { step: (step: number) => void; close: () => void } | null = null;

/** Browser layers are a composition probe, not the production presentation path. */
export async function composition(): Promise<void> {
  check(!compositionRun, "composition already running");
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: 96,
    height: 96,
    resolution: 1,
    antialias: false,
    backgroundAlpha: 0,
  });
  const view = new PixiView(renderer);
  const frame = document.createElement("div");
  frame.style.cssText =
    "position:fixed;left:0;top:0;width:96px;height:96px;overflow:hidden;background:black";
  const overlay = renderer.canvas as HTMLCanvasElement;
  overlay.style.cssText = "position:absolute;left:0;top:0;z-index:5";
  frame.append(overlay);
  document.body.append(frame);
  const scripting = new Scripting(codegen, { audio: null });
  const owned = new Map<number, ReturnType<typeof create>>();
  const close = install(scripting, {
    create: (slot) => {
      const entry = create();
      entry.canvas.style.cssText = `position:absolute;z-index:${slot + 1}`;
      owned.set(slot, entry);
      frame.append(entry.canvas);
      return entry.backend;
    },
    place: (slot, x, y, visible) => {
      const entry = owned.get(slot);
      check(entry, "missing layer");
      entry.canvas.style.left = `${x}px`;
      entry.canvas.style.top = `${y}px`;
      entry.canvas.style.visibility = visible ? "visible" : "hidden";
    },
    remove: (slot) => {
      const entry = owned.get(slot);
      check(entry, "missing retired layer");
      check(entry.live.size === 0, "retired layer retained GPU handles");
      entry.canvas.remove();
      entry.gl.getExtension("WEBGL_lose_context")?.loseContext();
      owned.delete(slot);
    },
  });
  let player: Player | null = null;
  const cleanup = () => {
    close();
    player?.destroy();
    scripting.destroy();
    view.dispose(view.stage);
    renderer.destroy();
    frame.remove();
    compositionRun = null;
    check(owned.size === 0, "host retained layers");
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
      new Uint8Array(await (await fetch("/context3d/Composition.swf")).arrayBuffer()),
      scripting,
    );
    await player.start();
    for (let i = 0; i < 4; i++) {
      await scripting.settled();
      player.tick();
    }

    const root = scripting.root?.object;
    check(root && scripting.rt.getProperty(root, scripting.rt.publicName("ready")), "not ready");
    check(owned.size === 2, "expected two Stage3D slots");
    const current = player;
    compositionRun = {
      step: (step) => {
        scripting.rt.callValue(
          scripting.rt.getProperty(root, scripting.rt.publicName("advance")),
          root,
          [step],
          null,
        );
        frame.style.backgroundColor = `#${(scripting.stageColor ?? 0xffffff).toString(16).padStart(6, "0")}`;
        view.render(current.stage);
      },
      close: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function compositionStep(step: number): Promise<void> {
  check(compositionRun, "composition not running");
  compositionRun.step(step);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

export function closeComposition(): void {
  compositionRun?.close();
}

export async function renderTargets() {
  const owned = create();
  const other = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(64, 64, true, 4);
    c.clear(0, 0, 1, 1);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const solid = c.createProgram();
    solid.upload(shader(false), shader(true));
    const sampled = c.createProgram();
    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 5, true);
    sampled.upload(shader(false), fragment);
    const texture = c.createTexture(32, 16);
    const fresh = c.createTexture(16, 32);
    const tiny = c.createTexture(1, 1);
    const cube = c.createTexture(8, 8, true);
    rejects(() => c.setRenderTarget(tiny));
    rejects(() => c.setRenderTarget(cube, false, 6));
    rejects(() => other.backend.setRenderTarget(texture));
    tiny.dispose();
    cube.dispose();
    const show = () => {
      c.setRenderTarget(null);
      c.setTexture(0, texture);
      c.setProgram(sampled);
      c.setDepth(false, "always");
      c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
      c.draw(indices, 0, 1);
      check(color(c.read(), 32, 32, 64) === "ffff0000", "rendered texture was not sampled");
      c.setTexture(0, null);
    };
    c.setRenderTarget(texture, true);
    c.clear(1, 0, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff0000ff", "target read changed the MSAA back buffer");
    show();
    const warmed = new Set(live);
    for (let i = 0; i < 24; i++) {
      c.setRenderTarget(texture, i % 2 === 0);
      c.setRenderTarget(texture, i % 2 === 0);
      c.clear(0, 1, 0, 1);
      c.setProgram(solid);
      c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
      c.draw(indices, 0, 1);
      show();
      check(live.size === warmed.size, "warm render target pass allocated GPU resources");
      for (const handle of live) {
        check(warmed.has(handle), "warm render target pass replaced GPU resources");
      }
    }

    c.setRenderTarget(texture, true);
    c.setTexture(0, texture);
    c.setProgram(sampled);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, null);
    const allocation = gl as unknown as {
      createFramebuffer(): WebGLFramebuffer | null;
      createRenderbuffer(): WebGLRenderbuffer | null;
    };
    const framebuffer = allocation.createFramebuffer;
    const renderbuffer = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["framebuffer", "depth", "incomplete"] as const) {
      const before = new Set(live);
      try {
        if (failure === "framebuffer") {
          allocation.createFramebuffer = () => null;
        }
        if (failure === "depth") {
          allocation.createRenderbuffer = () => null;
        }
        if (failure === "incomplete") {
          gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        rejects(() => c.setRenderTarget(fresh, true));
      } finally {
        allocation.createFramebuffer = framebuffer;
        allocation.createRenderbuffer = renderbuffer;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === before.size, "failed render target leaked GPU resources");
      for (const handle of live) {
        check(before.has(handle), "failed target replaced a resource");
      }
      c.clear(1, 0, 0, 1);
      show();
      c.setRenderTarget(texture, true);
    }
    c.setRenderTarget(fresh, false);
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    try {
      rejects(() => c.setRenderTarget(fresh, true));
    } finally {
      gl.checkFramebufferStatus = status;
    }
    c.setDepth(true, "never");
    c.setProgram(solid);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    c.setRenderTarget(null);
    c.setTexture(0, fresh);
    c.setProgram(sampled);
    c.setDepth(false, "always");
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "failed target attached depth state");
    c.setTexture(0, null);
    c.setRenderTarget(texture, true);
    texture.dispose();
    rejects(() => c.setRenderTarget(texture));
    c.clear(0, 1, 0, 1);
    check(
      color(c.read(), 32, 32, 64) === "ff00ff00",
      "disposing active target left invalid framebuffer",
    );
    c.setRenderTarget(fresh, true);
    c.clear(1, 0, 0, 1);
    c.present();
    c.clear(0, 0, 1, 1);
    check(color(c.read(), 32, 32, 64) === "ff0000ff", "present did not restore back buffer");
    check(gl.getError() === gl.NO_ERROR, "render targets polluted GL state");

    other.backend.configure(32, 32);
    const lost = other.backend.createTexture(16, 16);
    other.backend.setRenderTarget(lost, true);
    other.backend.clear(1, 0, 0, 1);
    other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejects(() => other.backend.setRenderTarget(lost));
    return { passed: true };
  } finally {
    c.dispose();
    other.backend.dispose();
    check(live.size === 0 && other.live.size === 0, "render target teardown leaked GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function cubeTargets() {
  const owned = create();
  const other = create();
  const { backend: c, gl, live } = owned;
  let inspect: WebGLFramebuffer | null = null;
  try {
    c.configure(32, 32, true, 4);
    c.clear(0, 0, 0, 1);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-1, -1, 0.5, 1, 1, -1, 0.5, 1, 0, 1, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const sampled = c.createProgram();
    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 0x1005, true);
    sampled.upload(shader(false), fragment);
    const cube = c.createTexture(32, 32, true);
    const directions = [
      [1, 0, 0, 1],
      [-1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, -1, 0, 1],
      [0, 0, 1, 1],
      [0, 0, -1, 1],
    ];
    const colors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
      [1, 0, 1],
    ];
    const expected = ["ffff0000", "ff00ff00", "ff0000ff", "ffffff00", "ff00ffff", "ffff00ff"];
    const show = (face: number) => {
      c.setRenderTarget(null);
      c.setDepth(false, "always");
      c.setProgram(sampled);
      c.setTexture(0, cube);
      c.setConstants("fragment", 0, directions[face], 1);
      c.draw(indices, 0, 1);
      const pixels = c.read();
      check(color(pixels, 16, 16, 32) === expected[face], `cube face ${face} changed`);
      c.setTexture(0, null);
      return pixels;
    };
    for (let face = 0; face < 6; face++) {
      c.setRenderTarget(cube, true, face);
      c.clear(colors[face][0], colors[face][1], colors[face][2], 1);
    }
    const readback = show(0);
    inspect = gl.createFramebuffer();
    check(inspect, "cannot create inspection framebuffer");
    // Inspect every mip, including the levels that are not visible at screen resolution.
    const pixel = new Uint8Array(4);
    gl.activeTexture(gl.TEXTURE0);
    // Bind through a draw to inspect the actual GPU handle.
    c.setTexture(0, cube);
    c.draw(indices, 0, 1);
    const handle = gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP) as WebGLTexture;
    check(handle, "cube was not bound");
    c.setTexture(0, null);
    for (let face = 0; face < 6; face++) {
      for (let level = 0; level < cube.levels; level++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, inspect);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          handle,
          level,
        );
        check(
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
          "cube mip incomplete",
        );
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        check(color(pixel, 0, 0, 1) === expected[face], `cube face ${face} mip ${level} differs`);
      }
    }
    const created = owned.created;
    for (let i = 0; i < 48; i++) {
      const face = i % 6;
      c.setRenderTarget(cube, i % 2 === 0, face);
      c.setRenderTarget(cube, i % 2 === 0, face);
      c.setScissor(0, 0, 4, 4);
      c.clear(colors[face][0], colors[face][1], colors[face][2], 1);
      c.setScissor(null);
      check(show(face) === readback, "cube target allocated readback storage");
      check(owned.created === created, "warm cube pass allocated GPU handles");
    }
    c.setRenderTarget(cube, true, 4);
    c.setProgram(sampled);
    c.setTexture(0, cube);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, null);
    for (const face of [-1, 6, 1.5, NaN]) {
      rejects(() => c.setRenderTarget(cube, false, face));
    }
    rejects(() => other.backend.setRenderTarget(cube, true, 2));
    const fresh = c.createTexture(16, 16, true);
    const allocation = gl as unknown as {
      createFramebuffer(): WebGLFramebuffer | null;
      createRenderbuffer(): WebGLRenderbuffer | null;
    };
    const framebuffer = allocation.createFramebuffer;
    const renderbuffer = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["framebuffer", "mip-framebuffer", "depth", "incomplete"]) {
      const before = new Set(live);
      let calls = 0;
      try {
        if (failure === "framebuffer" || failure === "mip-framebuffer") {
          allocation.createFramebuffer = () =>
            ++calls === (failure === "framebuffer" ? 1 : 2) ? null : framebuffer.call(gl);
        }
        if (failure === "depth") {
          allocation.createRenderbuffer = () => null;
        }
        if (failure === "incomplete") {
          gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        rejects(() => c.setRenderTarget(fresh, true, 5));
      } finally {
        allocation.createFramebuffer = framebuffer;
        allocation.createRenderbuffer = renderbuffer;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === before.size, "failed cube target leaked handles");
      for (const handle of live) {
        check(before.has(handle), "failed cube target replaced handles");
      }
      c.clear(0, 1, 1, 1);
      show(4);
      c.setRenderTarget(cube, true, 4);
    }
    // Roll back a face switch that fails while adding depth to an existing framebuffer.
    c.setRenderTarget(fresh, false, 2);
    c.clear(1, 0, 0, 1);
    const freshHandle = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
    ) as WebGLTexture;
    allocation.createRenderbuffer = () => null;
    try {
      rejects(() => c.setRenderTarget(fresh, true, 3));
    } finally {
      allocation.createRenderbuffer = renderbuffer;
    }
    c.clear(0, 1, 0, 1);
    c.setRenderTarget(null);
    // Sampling would require all six faces; inspect the two affected faces directly.
    gl.bindFramebuffer(gl.FRAMEBUFFER, inspect);
    for (let face = 2; face <= 3; face++) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        freshHandle,
        0,
      );
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      check(
        color(pixel, 0, 0, 1) === (face === 2 ? "ff00ff00" : "0"),
        "failed switch changed the active face",
      );
    }
    check(gl.getError() === gl.NO_ERROR, "cube operations polluted GL state");
    c.setRenderTarget(cube, true, 5);
    cube.dispose();
    rejects(() => c.setRenderTarget(cube, true, 0));
    c.clear(0, 1, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "disposed cube did not restore back buffer");
    fresh.dispose();
    c.configure(64, 32);
    c.clear(1, 0, 0, 1);
    check(color(c.read(), 32, 16, 64) === "ffff0000", "cube target broke resize");
    other.backend.configure(32, 32);
    const lost = other.backend.createTexture(16, 16, true);
    other.backend.setRenderTarget(lost, true, 3);
    other.backend.clear(1, 0, 0, 1);
    other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejects(() => other.backend.setRenderTarget(lost, true, 4));
    return { passed: true };
  } finally {
    gl.deleteFramebuffer(inspect);
    c.dispose();
    other.backend.dispose();
    check(live.size === 0 && other.live.size === 0, "cube target teardown leaked GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function indirectConstants() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32);
    const vertices = c.createBuffer(3, 5);
    vertices.upload([-0.75, -0.75, 0.5, 1, 5, 0.75, -0.75, 0.5, 1, 5, 0, 0.75, 0.5, 1, 5], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "float1");
    const vertex = new Uint8Array(55);
    vertex.set(shader(false));
    vertex.set(vertex.subarray(7, 31), 31);
    const code = new DataView(vertex.buffer);
    code.setUint32(35, 0x040f0000, true);
    code.setUint32(39, 0xe4000001, true);
    code.setUint32(43, 0x80000001, true);
    const fragment = shader(true);
    new DataView(fragment.buffer).setUint32(19, 4, true);
    const program = c.createProgram();
    program.upload(vertex, fragment);
    c.setProgram(program);
    const value = new Float32Array([0, 1, 0, 1]);
    const readback = c.read();
    const allocated = owned.created;
    const uniform = gl.uniform4fv.bind(gl);
    const location = gl.getUniformLocation.bind(gl);
    let queries = 0;
    let calls = 0;
    let bank: Float32Array | null = null;
    let bankMode = true;
    gl.getUniformLocation = (program, name) => {
      queries++;
      return location(program, name);
    };
    gl.uniform4fv = (location, data, offset, length) => {
      calls++;
      check(data instanceof Float32Array, "constant upload is not typed storage");
      check(data.length === 512, "constant upload allocated a temporary slice");
      check(!bank || data === bank, "draw replaced constant storage");
      bank = data;
      if (bankMode) {
        check(offset === undefined && length === undefined, "indexed draw did not upload one bank");
      } else {
        check(offset === 20 && length === 4, "direct-only draw stopped uploading sparse constants");
      }
      uniform(location, data, offset, length);
    };

    for (let iteration = 0; iteration < 32; iteration++) {
      value[1] = iteration & 1;
      value[2] = 1 - value[1];
      c.setConstants("vertex", 5, value, 1);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(c.read() === readback, "indexed draw replaced readback storage");
      check(
        color(readback, 16, 16, 32) === (value[1] ? "ff00ff00" : "ff0000ff"),
        "stale indexed constant",
      );
      check(calls === iteration + 1, "indexed draw made redundant uniform uploads");
      check(
        queries === 0 && owned.created === allocated,
        "indexed draw queried or allocated GPU state",
      );
    }

    const badFragment = fragment.slice();
    badFragment[7] = 0xff;
    rejects(() => program.upload(vertex, badFragment));
    check(queries === 0 && owned.created === allocated, "invalid shader allocated GPU state");
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "failed upload replaced indexed program");
    const direct = vertex.slice();
    const directCode = new DataView(direct.buffer);
    directCode.setUint32(39, 0xe4000005, true);
    directCode.setUint32(43, 1, true);
    program.upload(direct, fragment);
    bankMode = false;
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "direct replacement lost constants");
    program.upload(vertex, fragment);
    bankMode = true;
    c.configure(64, 64);
    value[0] = 1;
    value[1] = 0;
    c.setConstants("vertex", 5, value, 1);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(
      color(c.read(), 32, 32, 64) === "ffff0000",
      "indexed replacement or resize lost constants",
    );
    // Dead indexed reads can leave only a statically used prefix of the bank.
    const overwritten = new Uint8Array(79);
    overwritten.set(vertex);
    overwritten.set(direct.subarray(31), 55);
    program.upload(overwritten, fragment);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "optimized bank prefix lost constants");
    program.dispose();
    rejects(() => c.draw(indices, 0, 1));
    check(gl.getError() === gl.NO_ERROR, "indexed constants polluted GL state");

    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "indexed constants retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function vertexFormats() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32);
    const vertices = c.createBuffer(3, 5);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const bytes = new Uint8Array(60);
    const view = new DataView(bytes.buffer);
    const xy = [-0.75, -0.75, 0.75, -0.75, 0, 0.75];
    for (let i = 0; i < 3; i++) {
      view.setFloat32(i * 20, xy[i * 2], true);
      view.setFloat32(i * 20 + 4, xy[i * 2 + 1], true);
      view.setFloat32(i * 20 + 8, 0.5, true);
      view.setFloat32(i * 20 + 12, 1, true);
    }
    const vertex = new Uint8Array(55);
    vertex.set(shader(false));
    vertex.set(vertex.subarray(7, 31), 31);
    const code = new DataView(vertex.buffer);
    code.setUint32(35, 0x040f0000, true);
    code.setUint32(39, 0xe4000001, true);
    const fragment = shader(true);
    new DataView(fragment.buffer).setUint32(19, 4, true);
    const program = c.createProgram();
    program.upload(vertex, fragment);
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "bytes4");
    const readback = c.read();
    const allocated = owned.created;
    for (let iteration = 0; iteration < 24; iteration++) {
      for (let i = 0; i < 3; i++) {
        const at = i * 20 + 16;
        bytes[at] = iteration;
        bytes[at + 1] = 255 - iteration;
        bytes[at + 2] = 128 + iteration;
        bytes[at + 3] = 255;
      }
      vertices.uploadBytes(bytes, 0, 0, 3);
      c.setVertex(1, vertices, 3, "float1");
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(color(c.read(), 16, 16, 32) === "ffff0000", "float default components changed");
      c.setVertex(1, vertices, 4, "bytes4");
      c.draw(indices, 0, 1);
      check(c.read() === readback, "vertex formats replaced readback storage");
      const expected =
        (0xff000000 | (iteration << 16) | ((255 - iteration) << 8) | (128 + iteration)) >>> 0;
      check(
        color(readback, 16, 16, 32) === expected.toString(16),
        "packed channels not normalized",
      );
      rejects(() => c.setVertex(1, vertices, 4, "invalid" as VertexFormat));
      c.draw(indices, 0, 1);
      check(
        color(c.read(), 16, 16, 32) === expected.toString(16),
        "invalid format replaced binding",
      );
      for (const offset of [-1, 5, 6]) {
        c.setVertex(1, vertices, offset, "bytes4");
        rejects(() => c.draw(indices, 0, 1));
      }
      c.setVertex(1, vertices, 2, "float4");
      rejects(() => c.draw(indices, 0, 1));
      check(color(c.read(), 16, 16, 32) === expected.toString(16), "invalid offset changed pixels");
      check(owned.created === allocated, "vertex formats allocated GPU handles");
    }
    c.setVertex(1, vertices, 4, "bytes4");
    c.configure(64, 64);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff17e897", "resize lost packed format");
    const other = create();
    try {
      rejects(() => other.backend.setVertex(1, vertices, 4, "bytes4"));
    } finally {
      other.backend.dispose();
      check(other.live.size === 0, "foreign packed-buffer check retained resources");
      other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    vertices.dispose();
    rejects(() => c.draw(indices, 0, 1));
    check(gl.getError() === gl.NO_ERROR, "vertex format validation polluted GL state");
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "packed vertices retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function textureBytes() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  const framebuffer = gl.createFramebuffer();
  check(framebuffer, "byte upload readback framebuffer unavailable");
  const uploads = gl as unknown as { texSubImage2D: (...args: unknown[]) => void };
  const upload = uploads.texSubImage2D;
  try {
    c.configure(32, 32);
    const flat = c.createTexture(8, 4);
    const cube = c.createTexture(4, 4, true);
    const source = new Uint8Array(new ArrayBuffer(144), 5, 131);
    const readback = new Uint8Array(128);
    const bitmap = new Uint32Array(32);
    const staging = new Map<WebGLTexture, unknown>();
    const allocated = owned.created;
    let calls = 0;
    uploads.texSubImage2D = function (...args) {
      const handle = gl.getParameter(
        args[0] === gl.TEXTURE_2D ? gl.TEXTURE_BINDING_2D : gl.TEXTURE_BINDING_CUBE_MAP,
      ) as WebGLTexture;
      if (!staging.has(handle)) {
        staging.set(handle, args[8]);
      }
      check(staging.get(handle) === args[8], "texture bytes replaced staging storage");
      calls++;
      upload.apply(this, args);
    };
    for (let iteration = 0; iteration < 8; iteration++) {
      for (const texture of [flat, cube]) {
        const target = texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
        for (let face = 0; face < (texture.cube ? 6 : 1); face++) {
          for (let level = 0; level < texture.levels; level++) {
            const w = Math.max(1, texture.width >> level);
            const h = Math.max(1, texture.height >> level);
            const seed = iteration + face * 17 + level * 31;
            for (let i = 0; i < w * h; i++) {
              const at = 3 + i * 4;
              source[at] = (i + seed) * 7;
              source[at + 1] = (i + seed) * 5;
              source[at + 2] = (i + seed) * 3;
              source[at + 3] = i + seed;
            }
            texture.uploadBytes(source, 3, level, face);
            source.fill(0);
            const handle = gl.getParameter(
              texture.cube ? gl.TEXTURE_BINDING_CUBE_MAP : gl.TEXTURE_BINDING_2D,
            ) as WebGLTexture;
            const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer;
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              texture.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : target,
              handle,
              level,
            );
            check(
              gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
              "byte upload mip cannot be read",
            );
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, readback);
            gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
            for (let i = 0; i < w * h; i++) {
              check(
                readback[i * 4] === (((i + seed) * 3) & 255) &&
                  readback[i * 4 + 1] === (((i + seed) * 5) & 255) &&
                  readback[i * 4 + 2] === (((i + seed) * 7) & 255) &&
                  readback[i * 4 + 3] === ((i + seed) & 255),
                "byte upload changed channel bits, rows, mip or cube face",
              );
            }
          }
        }
      }
      // Both upload paths must share the same storage, even after smaller mip uploads.
      flat.upload(bitmap);
      check(owned.created === allocated, "texture byte uploads allocated GPU handles");
    }
    check(staging.size === 2 && calls === 184, "missing byte texture uploads");
    for (const texture of [flat, cube]) {
      for (const offset of [-1, 0.5, Number.NaN, Infinity, source.length]) {
        rejects(() => texture.uploadBytes(source, offset));
      }
      for (const level of [-1, 0.5, Number.NaN, texture.levels]) {
        rejects(() => texture.uploadBytes(source, 0, level));
      }
      for (const face of [-1, 0.5, Number.NaN, texture.cube ? 6 : 1]) {
        rejects(() => texture.uploadBytes(source, 0, 0, face));
      }
    }
    rejects(() => flat.uploadBytes(source, 4));
    check(calls === 184, "invalid texture bytes reached the GPU");
    check(gl.getError() === gl.NO_ERROR, "texture bytes polluted GL state");
    flat.dispose();
    rejects(() => flat.uploadBytes(source, 0));
    c.dispose();
    rejects(() => cube.uploadBytes(source, 0));
    return { passed: true };
  } finally {
    uploads.texSubImage2D = upload;
    gl.deleteFramebuffer(framebuffer);
    c.dispose();
    check(live.size === 0, "byte textures retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function bufferBytes() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32);
    const vertices = c.createBuffer(6, 4);
    const indices = c.createBuffer(6, 0);
    // Exercise both a view's byteOffset and an unaligned offset inside that view.
    const vertexSource = new Uint8Array(new ArrayBuffer(64), 5, 51);
    const floats = new DataView(vertexSource.buffer, 8, 48);
    const values = [-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1];
    const indexSource = new Uint8Array(new ArrayBuffer(16), 2, 9);
    const indexValues = new Uint8Array([3, 0, 4, 0, 5, 0]);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);

    // Raw uploads preserve float bit patterns without converting through JS Numbers.
    const raw = c.createBuffer(2, 1);
    const bits = new Uint8Array([0xa5, 0, 0, 0, 128, 1, 0, 192, 127]);
    const stored = new Uint8Array(8);
    raw.uploadBytes(bits, 1, 0, 2);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, stored);
    for (let i = 0; i < stored.length; i++) {
      check(stored[i] === bits[i + 1], "raw vertex upload changed float bits");
    }

    const allocated = owned.created;
    const pixels = c.read();
    const upload = gl.bufferSubData;
    let uploads = 0;
    gl.bufferSubData = (
      target: number,
      offset: number,
      data: AllowSharedBufferSource,
      sourceOffset: number = 0,
      length?: number,
    ) => {
      uploads++;
      check(data === vertexSource || data === indexSource, "byte upload made a new view");
      check(ArrayBuffer.isView(data), "byte upload expected a view");
      upload.call(gl, target, offset, data, sourceOffset, length);
    };
    try {
      for (let iteration = 0; iteration < 24; iteration++) {
        for (let i = 0; i < values.length; i++) {
          floats.setFloat32(i * 4, values[i], true);
        }
        indexSource.set(indexValues, 3);
        vertices.uploadBytes(vertexSource, 3, 3, 3);
        indices.uploadBytes(indexSource, 3, 0, 3);
        const before = uploads;
        vertices.uploadBytes(vertexSource, 0, 6, 0);
        indices.uploadBytes(indexSource, 0, 6, 0);
        check(uploads === before, "empty upload sent data to WebGL");
        rejects(() => vertices.uploadBytes(vertexSource, 4, 3, 3));
        rejects(() => indices.uploadBytes(indexSource, 3, 5, 3));
        check(uploads === before, "invalid upload changed GPU storage");
        vertexSource.fill(0);
        indexSource.fill(255);
        c.clear(0, 0, 1, 1);
        c.draw(indices, 0, 1);
        check(c.read() === pixels, "byte uploads replaced readback storage");
        check(color(pixels, 16, 16, 32) === "ffff0000", "upload retained source bytes");
      }
      check(uploads === 48, "unexpected number of GPU uploads");
      check(owned.created === allocated, "byte uploads allocated GPU handles");
    } finally {
      gl.bufferSubData = upload;
    }

    // Updating byte indices must also update the CPU bounds checks used by draw().
    indexSource.fill(255);
    indices.uploadBytes(indexSource, 3, 0, 3);
    rejects(() => c.draw(indices, 0, 1));
    const fresh = c.createBuffer(3, 0);
    fresh.uploadBytes(indexSource, 0, 0, 0);
    rejects(() => c.draw(fresh, 0, 1));
    const other = create();
    try {
      rejects(() => other.backend.setVertex(0, vertices, 0, "float4"));
    } finally {
      other.backend.dispose();
      check(other.live.size === 0, "foreign byte-buffer check retained resources");
      other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    check(gl.getError() === gl.NO_ERROR, "byte uploads polluted GL state");
    vertices.dispose();
    rejects(() => vertices.uploadBytes(vertexSource, 3, 0, 3));
    c.dispose();
    rejects(() => indices.uploadBytes(indexSource, 3, 0, 3));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "byte uploads retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function stencil() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32, true, 4);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.setDepth(false, "always");
    c.setStencilActions("frontAndBack", "equal", "keep", "keep", "keep");
    c.setStencilReference(42, 255, 0);
    const pixels = c.read();
    const allocated = owned.created;
    const func = gl.stencilFuncSeparate;
    const op = gl.stencilOpSeparate;
    const mask = gl.stencilMask;
    const query = gl.getParameter;
    let changes = 0;
    let queries = 0;
    gl.stencilFuncSeparate = (...args) => {
      changes++;
      func.apply(gl, args);
    };
    gl.stencilOpSeparate = (...args) => {
      changes++;
      op.apply(gl, args);
    };
    gl.stencilMask = (...args) => {
      changes++;
      mask.apply(gl, args);
    };
    gl.getParameter = (...args) => {
      queries++;
      return query.apply(gl, args);
    };
    try {
      for (let i = 0; i < 24; i++) {
        c.setStencilActions("frontAndBack", "equal", "keep", "keep", "keep");
        c.setStencilReference(42, 255, 0);
      }
      check(changes === 0, "unchanged stencil setters changed GPU state");
      for (let i = 0; i < 24; i++) {
        c.clear(0, 0, 1, 1, 1, 7, 42);
        c.draw(indices, 0, 1);
        c.setStencilActions("frontAndBack", "never", "keep", "keep", "keep");
        check(c.read() === pixels, "stencil changed readback storage");
        check(color(pixels, 16, 16, 32) === "ffff0000", "stencil clear or resolve failed");
        c.present();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        check(color(pixels, 16, 16, 32) === "ffff0000", "stencil clipped presentation");
        c.setStencilActions("frontAndBack", "equal", "keep", "keep", "keep");
      }
      check(queries === 0, "stencil operations queried GPU state");
      check(owned.created === allocated, "stencil operations allocated GPU handles");
    } finally {
      gl.stencilFuncSeparate = func;
      gl.stencilOpSeparate = op;
      gl.stencilMask = mask;
      gl.getParameter = query;
    }
    // A color-only target bypasses stencil, retaining state when depth returns.
    c.configure(32, 32, false);
    c.setStencilActions("frontAndBack", "never", "keep", "keep", "keep");
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "stencil rejected color-only draws");
    c.configure(32, 32, true);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff000000", "configuration lost stencil state");
    check(gl.getError() === gl.NO_ERROR, "stencil operations polluted GL state");
    c.dispose();
    rejects(() => c.setStencilReference(0, 255, 255));
    rejects(() => c.setStencilActions("none", "always", "keep", "keep", "keep"));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "stencil test retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function colorMasks() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32, true, 4);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 1, 0, 1], 1);
    c.setDepth(false, "always");
    const pixels = c.read();
    const allocated = owned.created;
    const setMask = gl.colorMask;
    const getParameter = gl.getParameter;
    let changes = 0;
    let queries = 0;
    gl.colorMask = (...args) => {
      changes++;
      setMask.apply(gl, args);
    };
    gl.getParameter = (...args) => {
      queries++;
      return getParameter.apply(gl, args);
    };
    try {
      c.setColorMask(true, false, false, false);
      const initial = changes;
      for (let i = 0; i < 32; i++) {
        c.setColorMask(true, false, false, false);
      }
      check(changes === initial, "unchanged color mask repeated a GL state change");
      for (let i = 0; i < 24; i++) {
        c.clear(0, 0, 1, 1);
        c.draw(indices, 0, 1);
        c.setColorMask(false, false, false, false);
        check(c.read() === pixels, "color mask replaced readback storage");
        check(color(pixels, 16, 16, 32) === "ffff00ff", "resolve obeyed draw-time color mask");
        c.present();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        check(color(pixels, 16, 16, 32) === "ffff00ff", "presentation obeyed color mask");
        check(color(pixels, 0, 0, 32) === "ff0000ff", "masked clear lost channels");
        c.setColorMask(true, false, false, false);
      }
      check(queries === 0, "color masks queried GPU state");
      check(owned.created === allocated, "color masks allocated GPU handles");
    } finally {
      gl.colorMask = setMask;
      gl.getParameter = getParameter;
    }
    check(gl.getError() === gl.NO_ERROR, "color masks polluted GL state");
    c.dispose();
    rejects(() => c.setColorMask(true, true, true, true));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "color mask test retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function reconfiguration() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    for (const quality of [0, 4]) {
      for (const depth of [false, true]) {
        c.configure(64, 64, depth, quality);
        c.clear(1, 0, 0, 1);
        const pixels = c.read();
        const warmed = new Set(live);
        const allocated = owned.created;
        const formats = gl.getInternalformatParameter;
        const status = gl.checkFramebufferStatus;
        let queries = 0;
        gl.getInternalformatParameter = (...args) => {
          queries++;
          return formats.apply(gl, args);
        };
        gl.checkFramebufferStatus = (...args) => {
          queries++;
          return status.apply(gl, args);
        };
        try {
          for (let i = 0; i < 24; i++) {
            c.clear(0, 0, 1, 1);
            c.configure(64, 64, depth, quality);
            check(c.read() === pixels, "unchanged configuration replaced readback storage");
            check(color(pixels, 32, 32, 64) === "ff0000ff", "configuration lost pending color");
            c.present();
            c.configure(64, 64, depth, quality);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            check(color(pixels, 32, 32, 64) === "ff0000ff", "configuration cleared presentation");
            check(owned.created === allocated, "unchanged configuration allocated GPU handles");
            check(live.size === warmed.size, "unchanged configuration retired GPU handles");
            for (const handle of live) {
              check(warmed.has(handle), "unchanged configuration replaced GPU handles");
            }
          }
          check(queries === 0, "unchanged configuration queried capabilities or completeness");
        } finally {
          gl.getInternalformatParameter = formats;
          gl.checkFramebufferStatus = status;
        }
        rejects(() => c.configure(64, 64, depth, Number.NaN));
        rejects(() => c.configure(64.5, 64, depth, quality));
        const allocation = gl as unknown as { createTexture(): WebGLTexture | null };
        const allocate = allocation.createTexture;
        allocation.createTexture = () => null;
        try {
          rejects(() => c.configure(32, 32, depth, quality));
        } finally {
          allocation.createTexture = allocate;
        }
        const afterFailure = owned.created;
        c.configure(64, 64, depth, quality);
        check(owned.created === afterFailure, "failed resize invalidated the previous request");
        check(c.read() === pixels, "failed resize replaced readback storage");
        check(color(pixels, 32, 32, 64) === "ff0000ff", "failed resize lost old pixels");
      }
    }
    const texture = c.createTexture(8, 8);
    c.setRenderTarget(texture);
    rejects(() => c.configure(64, 64, true, 4));
    c.setRenderTarget(null);
    check(gl.getError() === gl.NO_ERROR, "reconfiguration polluted GL state");
    c.dispose();
    rejects(() => c.configure(64, 64, true, 4));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "reconfiguration retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function multisampling() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(64, 64);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.setDepth(false, "always");
    const baseline = live.size;
    const partial = (pixels: Uint8Array): number => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 0 && pixels[i] < 255) {
          count++;
        }
      }
      return count;
    };
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(partial(c.read()) === 0, "nonmultisampled triangle has partial coverage");

    for (let i = 0; i < 6; i++) {
      const size = i % 2 === 0 ? 64 : 32;
      const depth = i % 3 !== 0;
      c.configure(size, size, depth, 4);
      check(gl.getParameter(gl.SAMPLES) === 4, "4x sample buffers unavailable in test browser");
      check(live.size === baseline + 2 + Number(depth), "MSAA resize retained GPU handles");
      c.clear(0, 0, 1, 1);
      c.draw(indices, 0, 1);
      check(partial(c.read()) > 0, "multisample readback lost edge coverage");
    }

    c.configure(64, 64, true, 4);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    c.setScissor(30, 30, 4, 4);
    let resolves = 0;
    const blit = gl.blitFramebuffer;
    gl.blitFramebuffer = function (...args) {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) {
        resolves++;
      }
      blit.apply(this, args);
    };
    try {
      const pixels = c.read();
      check(partial(pixels) > 0, "scissor clipped the resolve outside its rectangle");
      check(color(pixels, 0, 0, 64) === "ff0000ff", "resolve lost background");
      c.read();
      c.present();
      check(resolves === 1, "unchanged buffer resolved more than once");
      const presented = new Uint8Array(64 * 64 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, presented);
      check(partial(presented) > 0, "presentation lost antialiased edges");
      check(color(presented, 0, 0, 64) === "ff0000ff", "scissor clipped presentation");
      c.clear(0, 1, 0, 1);
      check(color(c.read(), 0, 0, 64) === "ff00ff00", "scissor clipped multisample clear");
      check(Number(resolves) === 2, "clear did not invalidate the resolve");
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, presented);
      check(color(presented, 0, 0, 64) === "ff0000ff", "clear overwrote presentation");
      c.draw(indices, 0, 1);
      const clipped = c.read();
      check(color(clipped, 32, 32, 64) === "ffff0000", "resolve lost the new draw");
      check(color(clipped, 20, 32, 64) === "ff00ff00", "resolve disabled draw-time scissor");
      check(Number(resolves) === 3, "draw did not invalidate the resolve");
      c.clear(0, 0, 0, 1, 1, 2);
      c.read();
      check(Number(resolves) === 3, "depth-only clear needlessly resolved color");
    } finally {
      gl.blitFramebuffer = blit;
    }

    c.setScissor(null);
    const handles = live.size;
    const allocation = gl as unknown as { createRenderbuffer(): WebGLRenderbuffer | null };
    const allocate = allocation.createRenderbuffer;
    allocation.createRenderbuffer = () => null;
    try {
      rejects(() => c.configure(32, 32, false, 4));
    } finally {
      allocation.createRenderbuffer = allocate;
    }
    check(live.size === handles, "failed MSAA allocation leaked GPU handles");
    const status = gl.checkFramebufferStatus;
    for (let failed = 1; failed <= 2; failed++) {
      let checks = 0;
      gl.checkFramebufferStatus = function (target) {
        return ++checks === failed
          ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT
          : status.call(this, target);
      };
      try {
        rejects(() => c.configure(32, 32, true, 4));
      } finally {
        gl.checkFramebufferStatus = status;
      }
      check(live.size === handles, "incomplete MSAA framebuffer leaked GPU handles");
      check(c.width === 64 && c.height === 64, "failed MSAA resize changed dimensions");
      check(color(c.read(), 32, 32, 64) === "ffff0000", "failed MSAA resize lost old pixels");
    }
    c.configure(64, 64);
    check(live.size === baseline, "disabling MSAA retained its resources");
    c.draw(indices, 0, 1);
    check(partial(c.read()) === 0, "disabling MSAA retained partial coverage");

    const formats = gl.getInternalformatParameter;
    gl.getInternalformatParameter = (_target, format) =>
      format === gl.RGBA8 ? Int32Array.of(4) : Int32Array.of(2);
    try {
      c.configure(32, 32, true, 4);
      check(gl.getParameter(gl.SAMPLES) === 0, "incompatible sample counts were selected");
      check(live.size === baseline + 1, "MSAA fallback allocated unused resources");
    } finally {
      gl.getInternalformatParameter = formats;
    }
    check(gl.getError() === gl.NO_ERROR, "multisampling polluted GL state");
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "multisampling retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function lifetime() {
  const first = create();
  const second = create();
  const c = first.backend;
  try {
    c.configure(64, 64);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const p = c.createProgram();
    p.upload(shader(false), shader(true));
    c.setProgram(p);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, -1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "initial triangle");
    c.setScissor(30, 30, 4, 4);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    c.present();
    first.gl.bindFramebuffer(first.gl.FRAMEBUFFER, null);
    const presented = new Uint8Array(64 * 64 * 4);
    first.gl.readPixels(0, 0, 64, 64, first.gl.RGBA, first.gl.UNSIGNED_BYTE, presented);
    check(color(presented, 0, 0, 64) === "ff0000ff", "scissor clipped presentation");
    check(color(presented, 32, 32, 64) === "ffff0000", "scissor lost the drawn region");
    c.setScissor(null);
    const swizzled = shader(true);
    new DataView(swizzled.buffer).setUint32(15, 0xe1000000, true);
    p.upload(shader(false), swizzled);
    check(first.gl.getParameter(first.gl.CURRENT_PROGRAM) === null, "replaced program still bound");
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff00ff00", "AGAL swizzle did not reach the GPU");
    p.upload(shader(false), shader(true));
    vertices.upload([-0.75, -0.75, -0.5, 1, 0.75, -0.75, -0.5, 1, 0, 0.75, -0.5, 1], 0, 3);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff0000ff", "negative AGAL clip depth was not clipped");
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    rejects(() => second.backend.setProgram(p));
    rejects(() => second.backend.setVertex(0, vertices, 0, "float4"));
    rejects(() => c.draw(vertices, 0, 1));
    rejects(() => indices.upload([0], 3, 1));
    rejects(() => c.setVertex(8, vertices, 0, "float4"));
    rejects(() => c.setConstants("fragment", 28, [1, 0, 0, 1], 1));
    const handles = first.live.size;
    // Valid stages with incompatible varyings fail linking after GPU allocation.
    const varying = shader(true);
    new DataView(varying.buffer).setUint32(19, 4, true);
    rejects(() => p.upload(shader(false), varying));
    check(first.live.size === handles, "failed program upload leaked GPU handles");
    // A failed replacement must leave the previously linked program usable.
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "failed upload replaced a working program");
    check(first.gl.getError() === first.gl.NO_ERROR, "failed upload polluted GL state");
    rejects(() => c.configure(31, 32));
    c.configure(32, 32);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "resize invalidated live resources");
    const colorHandles = first.live.size;
    const allocation = first.gl as unknown as { createRenderbuffer(): WebGLRenderbuffer | null };
    const makeDepth = allocation.createRenderbuffer;
    allocation.createRenderbuffer = () => null;
    try {
      rejects(() => c.configure(64, 64, true));
    } finally {
      allocation.createRenderbuffer = makeDepth;
    }
    check(first.live.size === colorHandles, "failed depth allocation leaked GPU handles");
    const status = first.gl.checkFramebufferStatus;
    first.gl.checkFramebufferStatus = () => first.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    try {
      rejects(() => c.configure(64, 64, true));
    } finally {
      first.gl.checkFramebufferStatus = status;
    }
    check(first.live.size === colorHandles, "incomplete depth target leaked GPU handles");
    check(c.width === 32 && c.height === 32, "failed resize changed back-buffer dimensions");
    check(color(c.read(), 16, 16, 32) === "ffff0000", "failed resize lost the old back buffer");

    c.setDepth(false, "always");
    for (let i = 0; i < 8; i++) {
      const size = i % 2 === 0 ? 64 : 32;
      c.configure(size, size, true);
      c.draw(indices, 0, 1);
      check(color(c.read(), size / 2, size / 2, size) === "ffff0000", "depth resize lost geometry");
      check(first.live.size === colorHandles + 1, "depth resize retained retired handles");
      check(
        !first.gl.getParameter(first.gl.DEPTH_WRITEMASK),
        "resize changed the depth write mask",
      );
    }
    c.setDepth(true, "never");
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff0000ff", "depth test was disabled after resize");
    c.configure(32, 32, false);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "color-only target performed a depth test");
    check(first.live.size === colorHandles, "disabling depth retained its attachment");
    c.setDepth(true, "less");
    check(first.gl.getError() === first.gl.NO_ERROR, "depth resize polluted GL state");

    rejects(() => c.createTexture(0, 2));
    rejects(() => c.createTexture(3, 2));
    rejects(() => c.createTexture(4096, 2));
    const texture = c.createTexture(2, 2);
    rejects(() => second.backend.setTexture(0, texture));
    rejects(() => c.setTexture(8, texture));
    const textured = shader(true);
    const textureCode = new DataView(textured.buffer);
    textureCode.setUint32(7, 0x28, true);
    textureCode.setUint32(27, 5, true);
    p.upload(shader(false), textured);
    c.setConstants("fragment", 0, [0.25, 0.25, 0, 1], 1);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, texture);
    rejects(() => c.draw(indices, 0, 1));
    const pixels = Uint32Array.of(0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff);
    rejects(() => texture.upload(pixels.subarray(1)));
    rejects(() => texture.upload(pixels, 2));
    rejects(() => texture.upload(pixels, -1));
    rejects(() => texture.upload(pixels, 0.5));
    rejects(() => texture.upload(pixels, 1));
    const gl = first.gl as unknown as { texSubImage2D: (...args: unknown[]) => void };
    const upload = gl.texSubImage2D;
    let staging: unknown;
    let uploads = 0;
    gl.texSubImage2D = function (...args) {
      if (uploads === 0) {
        staging = args[8];
      }
      check(staging === args[8], "texture upload replaced its staging buffer");
      uploads++;
      upload.apply(this, args);
    };
    try {
      texture.upload(pixels);
      c.draw(indices, 0, 1);
      const warmed = new Set(first.live);
      for (let i = 0; i < 8; i++) {
        pixels[0] = i % 2 === 0 ? 0xff00ff00 : 0xffff0000;
        texture.upload(pixels);
        c.draw(indices, 0, 1);
        check(color(c.read(), 16, 16, 32) === pixels[0].toString(16), "reupload did not reach GPU");
        check(first.live.size === warmed.size, "warm texture draws allocated GPU handles");
        for (const handle of first.live) {
          check(warmed.has(handle), "warm texture draws replaced a GPU handle");
        }
      }
      textureCode.setUint32(27, 0x12000005, true);
      p.upload(shader(false), textured);
      rejects(() => c.draw(indices, 0, 1));
      const mip = Uint32Array.of(0xff0000ff);
      texture.upload(mip, 1);
      c.draw(indices, 0, 1);
      const mipHandles = new Set(first.live);
      texture.upload(mip, 1);
      c.draw(indices, 0, 1);
      check(first.live.size === mipHandles.size, "mip reupload allocated GPU handles");
      for (const handle of first.live) {
        check(mipHandles.has(handle), "mip reupload replaced a GPU handle");
      }
      check(uploads === 11, "texture upload was skipped");
    } finally {
      gl.texSubImage2D = upload;
    }
    c.configure(64, 64);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "resize lost texture bindings");
    c.setTexture(0, null);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, texture);
    texture.dispose();
    texture.dispose();
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, texture);
    rejects(() => c.draw(indices, 0, 1));
    rejects(() => texture.upload(pixels));
    c.setTexture(0, null);
    rejects(() => c.createTexture(2, 4, true));
    rejects(() => c.createTexture(2048, 2048, true));
    const cube = c.createTexture(2, 2, true);
    rejects(() => second.backend.setTexture(0, cube));
    rejects(() => cube.upload(pixels, 0, -1));
    rejects(() => cube.upload(pixels, 0, 6));
    rejects(() => cube.upload(pixels, 0, 0.5));
    textureCode.setUint32(27, 0x12001005, true);
    p.upload(shader(false), textured);
    c.setTexture(0, cube);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    uploads = 0;
    staging = undefined;
    gl.texSubImage2D = function (...args) {
      if (uploads === 0) {
        staging = args[8];
      }
      check(staging === args[8], "cube faces/mips replaced the shared staging buffer");
      uploads++;
      upload.apply(this, args);
    };
    try {
      const mip = Uint32Array.of(0xffff0000);
      pixels.fill(0xffff0000);
      for (let face = 0; face < 6; face++) {
        cube.upload(pixels, 0, face);
        rejects(() => c.draw(indices, 0, 1));
        cube.upload(mip, 1, face);
      }
      c.draw(indices, 0, 1);
      const handles = new Set(first.live);
      for (let frame = 0; frame < 8; frame++) {
        const argb = frame % 2 ? 0xffff0000 : 0xff00ff00;
        pixels.fill(argb);
        cube.upload(pixels, 0, 0);
        c.clear(0, 0, 0, 1);
        c.draw(indices, 0, 1);
        check(color(c.read(), 32, 32, 64) === argb.toString(16), "cube reupload did not reach GPU");
        check(first.live.size === handles.size, "cube reupload allocated GPU handles");
        for (const handle of first.live) {
          check(handles.has(handle), "cube reupload replaced GPU handles");
        }
      }
      check(uploads === 20, "cube uploads were skipped");
    } finally {
      gl.texSubImage2D = upload;
    }
    c.configure(32, 32);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "resize lost cube binding");
    c.setTexture(0, null);
    check(
      first.gl.getParameter(first.gl.TEXTURE_BINDING_CUBE_MAP) === null,
      "cube was not unbound",
    );
    c.setTexture(0, cube);
    c.draw(indices, 0, 1);
    cube.dispose();
    cube.dispose();
    check(
      first.gl.getParameter(first.gl.TEXTURE_BINDING_CUBE_MAP) === null,
      "disposed cube remains bound",
    );
    rejects(() => cube.upload(pixels));
    c.setTexture(0, cube);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, null);
    check(first.gl.getError() === first.gl.NO_ERROR, "cube lifetime polluted GL state");
    p.upload(shader(false), shader(true));
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    vertices.dispose();
    rejects(() => c.draw(indices, 0, 1));
    rejects(() => vertices.upload([], 0, 0));
    p.dispose();
    check(first.gl.getParameter(first.gl.CURRENT_PROGRAM) === null, "disposed program still bound");
    rejects(() => c.setProgram(p));
    c.dispose();
    c.dispose();
    check(first.live.size === 0, "context disposal leaked resources");
    rejects(() => c.createProgram());
    rejects(() => c.configure(1, 1));
    second.backend.configure(32, 32);
    const lossCube = second.backend.createTexture(2, 2, true);
    lossCube.upload(pixels, 0, 0);
    const loss = second.gl.getExtension("WEBGL_lose_context");
    check(loss, "context loss extension unavailable");
    const lost = new Promise<void>((resolve) =>
      second.canvas.addEventListener("webglcontextlost", () => resolve(), { once: true }),
    );
    loss.loseContext();
    await lost;
    rejects(() => second.backend.clear(1, 0, 0, 1));
    rejects(() => second.backend.configure(32, 32));
    second.backend.dispose();
    check(second.live.size === 0, "lost context retains resource handles");
    rejects(() => lossCube.upload(pixels));
    return { passed: true };
  } finally {
    c.dispose();
    second.backend.dispose();
    first.gl.getExtension("WEBGL_lose_context")?.loseContext();
    second.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
