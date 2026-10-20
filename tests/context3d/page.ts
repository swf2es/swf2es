import { autoDetectRenderer } from "pixi.js";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import { Player } from "../../packages/player/dist/player.js";
import { PixiView } from "../../packages/player/dist/render/view.js";
import { Scripting } from "../../packages/player/dist/scripting.js";
import { install } from "./natives.ts";
import { WebGLContext3D } from "./webgl.ts";

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
  // Count actual GPU handles, including shaders and resources a failed
  // upload allocates; empty JS ownership maps alone do not prove deletion.
  for (const kind of [
    "Buffer",
    "Program",
    "Shader",
    "Texture",
    "Framebuffer",
    "VertexArray",
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
      }
      return value;
    };
    object[deleteName] = (...args) => {
      live.delete(args[0]);
      return drop(...args);
    };
  }
  const backend = new WebGLContext3D(gl);
  return { canvas, gl, live, backend };
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
    c.setVertex(0, vertices, 0, 4);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, -1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "initial triangle");
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
    rejects(() => second.backend.setVertex(0, vertices, 0, 4));
    rejects(() => c.draw(vertices, 0, 1));
    rejects(() => indices.upload([0], 3, 1));
    rejects(() => c.setVertex(8, vertices, 0, 4));
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
    const loss = second.gl.getExtension("WEBGL_lose_context");
    check(loss, "context loss extension unavailable");
    const lost = new Promise<void>((resolve) =>
      second.canvas.addEventListener("webglcontextlost", () => resolve(), { once: true }),
    );
    loss.loseContext();
    await lost;
    rejects(() => second.backend.clear(1, 0, 0, 1));
    second.backend.dispose();
    check(second.live.size === 0, "lost context retains resource handles");
    return { passed: true };
  } finally {
    c.dispose();
    second.backend.dispose();
    first.gl.getExtension("WEBGL_lose_context")?.loseContext();
    second.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
