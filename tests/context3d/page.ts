import {
  type Context3DLifecycle,
  SAMPLER_FILTERS,
  SAMPLER_MIPS,
  SAMPLER_WRAPS,
  type SamplerWrap,
  type VertexFormat,
} from "@swf2es/context3d";
import { WebGLContext3D, type WebGLContext3DLimits } from "@swf2es/context3d/webgl";
import { installContext3D as install } from "@swf2es/player/context3d";
import { observeLoss, stage3DCanvasHost } from "@swf2es/player-hosts/stage3d";
import { autoDetectRenderer } from "pixi.js";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import { Player } from "../../packages/player/dist/player.js";
import { PixiView } from "../../packages/player/dist/render/view.js";
import { Scripting } from "../../packages/player/dist/scripting.js";

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

export function create(limits?: Partial<WebGLContext3DLimits>) {
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
  const backend = new WebGLContext3D(gl, limits);
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

export function resourceLimits(): { passed: boolean } {
  const options = {
    maxBuffers: 2,
    maxPrograms: 1,
    maxTextures: 1,
    maxBufferBytes: 12,
    maxTextureBytes: 256,
  };
  const owned = create(options);
  const c = owned.backend;
  try {
    const names = [
      "maxBuffers",
      "maxPrograms",
      "maxTextures",
      "maxBufferBytes",
      "maxTextureBytes",
      "maxTargetDepthBytes",
      "maxTargetColorBytes",
    ] as const;
    const invalid = [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1];
    const handles = owned.created;
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < invalid.length; j++) {
        rejects(() => new WebGLContext3D(owned.gl, { [names[i]]: invalid[j] }));
        check(owned.created === handles, "invalid limits allocated GPU handles");
      }
    }

    const indices = c.createBuffer(4, 0);
    const vertex = c.createBuffer(1, 1);
    const allocated = owned.created;
    options.maxBuffers = 100;
    options.maxBufferBytes = 100;
    rejects(() => c.createBuffer(1, 0));
    check(
      owned.created === allocated,
      "buffer count rejection allocated handles or reread options",
    );
    vertex.dispose();
    const afterDispose = owned.created;
    rejects(() => c.createBuffer(3, 0));
    check(owned.created === afterDispose, "buffer byte rejection allocated GPU handles");
    const replacement = c.createBuffer(2, 0);
    replacement.dispose();
    replacement.dispose();
    indices.dispose();
    c.createBuffer(3, 1).dispose();

    const program = c.createProgram();
    rejects(() => c.createProgram());
    program.dispose();
    c.createProgram().dispose();

    const rectangle = c.createRectangleTexture(8, 8);
    const textureHandles = owned.created;
    rejects(() => c.createRectangleTexture(8, 8));
    check(owned.created === textureHandles, "texture count rejection allocated GPU handles");
    rectangle.dispose();
    rejects(() => c.createTexture(8, 8));
    check(owned.created === textureHandles, "texture mip budget rejection allocated GPU handles");
    c.createRectangleTexture(8, 8).dispose();
    check(owned.gl.getError() === owned.gl.NO_ERROR, "resource quotas changed GL state");
  } finally {
    c.dispose();
    check(owned.live.size === 0, "budget test retained GPU handles");
    owned.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const depth = create({ maxTextures: 2, maxTextureBytes: 512, maxTargetDepthBytes: 256 });
  try {
    const c = depth.backend;
    c.configure(32, 32);
    const first = c.createRectangleTexture(8, 8);
    const second = c.createRectangleTexture(8, 8);
    c.setRenderTarget(first, true);
    c.clear(0, 1, 0, 1);
    const handles = depth.live.size;
    rejects(() => c.setRenderTarget(second, true));
    check(depth.live.size === handles, "target depth quota rejection leaked handles");
    const pixel = new Uint8Array(4);
    depth.gl.readPixels(0, 0, 1, 1, depth.gl.RGBA, depth.gl.UNSIGNED_BYTE, pixel);
    check(color(pixel, 0, 0, 1) === "ff00ff00", "target depth failure lost the old target");
    first.dispose();
    c.setRenderTarget(second, true);
    c.clear(1, 0, 0, 1);
    depth.gl.readPixels(0, 0, 1, 1, depth.gl.RGBA, depth.gl.UNSIGNED_BYTE, pixel);
    check(color(pixel, 0, 0, 1) === "ffff0000", "target depth budget was not released");
    const reused = depth.created;
    c.setRenderTarget(second, false);
    c.setRenderTarget(second, true);
    check(depth.created === reused, "cached depth storage was charged or allocated again");
    check(depth.gl.getError() === depth.gl.NO_ERROR, "target depth quotas changed GL state");
  } finally {
    depth.backend.dispose();
    check(depth.live.size === 0, "target depth budget retained handles");
    depth.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const cube = create({ maxTextureBytes: 6 * 340, maxBuffers: 0, maxPrograms: 0 });
  try {
    const c = cube.backend;
    rejects(() => c.createBuffer(1, 0));
    rejects(() => c.createProgram());
    const texture = c.createTexture(8, 8, true);
    const handles = cube.created;
    rejects(() => c.createTexture(8, 8));
    check(cube.created === handles, "cube mip budget rejection allocated handles");
    texture.dispose();
    c.createTexture(8, 8).dispose();
  } finally {
    cube.backend.dispose();
    check(cube.live.size === 0, "cube budget retained handles");
    cube.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  for (let raised = 0; raised < 2; raised++) {
    const entry = create(raised ? { maxBuffers: 129 } : { maxBuffers: undefined });
    try {
      for (let i = 0; i < 128; i++) {
        entry.backend.createBuffer(1, 0);
      }
      if (raised) {
        entry.backend.createBuffer(1, 0);
      } else {
        rejects(() => entry.backend.createBuffer(1, 0));
      }
      entry.backend.dispose();
      check(entry.live.size === 0, "buffer count budget retained handles");
    } finally {
      entry.backend.dispose();
      entry.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  return { passed: true };
}

export function canvasHost(): { passed: boolean } {
  const parent = document.createElement("div");
  const surfaces: ReturnType<typeof create>[] = [];
  let destroyed = 0;
  const host = stage3DCanvasHost(parent, () => {
    const surface = create();
    surfaces.push(surface);
    return {
      canvas: surface.canvas,
      context: surface.backend,
      destroy: () => {
        check(
          surface.backend.disposed && surface.live.size === 0,
          "surface destroyed before resources",
        );
        destroyed++;
      },
    };
  });
  let lost = 0;
  let restored = 0;
  const lifecycle = {
    lost: () => lost++,
    restored: () => restored++,
  };

  try {
    const context = host.create(2, lifecycle);
    context.configure(64, 64);
    host.place(2, -7, 11, false);
    const surface = surfaces[0];
    const style = surface.canvas.style;
    check(surface.canvas.parentElement === parent, "canvas host did not attach the surface");
    check(
      style.position === "absolute" &&
        style.zIndex === "2" &&
        style.left === "-7px" &&
        style.top === "11px" &&
        style.visibility === "hidden",
      "canvas host lost placement",
    );
    rejects(() => host.create(2, lifecycle));
    check(surfaces.length === 1, "duplicate slot allocated a surface");
    const event = new Event("webglcontextlost", { cancelable: true });
    surface.canvas.dispatchEvent(event);
    surface.canvas.dispatchEvent(new Event("webglcontextrestored"));
    check(event.defaultPrevented && lost === 1 && restored === 1, "loss callbacks were not wired");
    context.dispose();
    host.remove(2);
    host.remove(2);
    check(Number(destroyed) === 1, "surface destroy was repeated or omitted");
    check(!surface.canvas.parentElement && surface.live.size === 0, "surface not released");
    surface.canvas.dispatchEvent(new Event("webglcontextlost"));
    surface.canvas.dispatchEvent(new Event("webglcontextrestored"));
    check(lost === 1 && restored === 1, "removed surface kept its listeners");

    const append = parent.append;
    parent.append = () => {
      throw new Error("injected canvas attachment failure");
    };
    try {
      rejects(() => host.create(1, lifecycle));
    } finally {
      parent.append = append;
    }
    const failed = surfaces[1];
    check(Number(destroyed) === 2, "failed attachment omitted surface destroy");
    check(failed.backend.disposed && failed.live.size === 0, "failed attachment leaked handles");
    failed.canvas.dispatchEvent(new Event("webglcontextlost"));
    check(lost === 1, "failed attachment leaked listeners");
    const retry = host.create(1, lifecycle);
    retry.dispose();
    host.remove(1);
    check(Number(destroyed) === 3, "retry omitted surface destroy");
    check(parent.children.length === 0, "canvas host retained retired surfaces");
  } finally {
    for (let i = 0; i < surfaces.length; i++) {
      surfaces[i].backend.dispose();
      surfaces[i].gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    host.remove(1);
    host.remove(2);
  }

  return { passed: true };
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
  const host = stage3DCanvasHost(frame, (slot) => {
    const entry = create();
    owned.set(slot, entry);
    return { canvas: entry.canvas, context: entry.backend };
  });
  const close = install(scripting, {
    create: host.create,
    place: host.place,
    remove: (slot) => {
      const entry = owned.get(slot);
      check(entry, "missing retired layer");
      check(entry.live.size === 0, "retired layer retained GPU handles");
      host.remove(slot);
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

export async function rectangleTextures() {
  const owned = create();
  const other = create();
  const { backend: c, gl, live } = owned;
  const uploads = gl as unknown as { texSubImage2D(...args: unknown[]): void };
  const upload = uploads.texSubImage2D.bind(gl);
  let staging: unknown;
  let uploadCount = 0;
  uploads.texSubImage2D = (...args) => {
    const bytes = args[8];
    check(!staging || staging === bytes, "rectangle upload replaced staging storage");
    staging = bytes;
    uploadCount++;
    upload(...args);
  };
  const mipmap = gl.generateMipmap;
  gl.generateMipmap = () => {
    throw new Error("rectangle target generated mipmaps");
  };
  try {
    c.configure(32, 32);
    const texture = c.createRectangleTexture(17, 9);
    check(texture.rectangle && !texture.cube && texture.levels === 1, "rectangle allocated mips");
    const bitmap = new Uint32Array(17 * 9).fill(0xff00ff00);
    const small = new Uint32Array([0xffff0000]);
    const big = new Uint32Array(20 * 12).fill(0xff0000ff);
    big[8 * 20 + 16] = 0xff00ffff;
    big[11 * 20 + 19] = 0xffffff00;
    const bytes = new Uint8Array(17 * 9 * 4 + 1);
    for (let i = 1; i < bytes.length; i += 4) {
      bytes[i + 1] = 255;
      bytes[i + 3] = 255;
    }
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-1, -1, 0.5, 1, 3, -1, 0.5, 1, -1, 3, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 5, true);
    const program = c.createProgram();
    program.upload(shader(false), fragment);
    c.setProgram(program);
    const readback = c.read();
    const show = (x: number, y: number, expected: string): void => {
      c.setTexture(0, texture);
      c.setConstants("fragment", 0, [x, y, 0, 1], 1);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(c.read() === readback, "rectangle replaced readback storage");
      check(color(readback, 16, 16, 32) === expected, "rectangle contents differ");
    };
    texture.upload(bitmap);
    show(0.5, 0.5, "ff00ff00");
    c.setTexture(0, null);
    c.setRenderTarget(texture, true);
    c.clear(0, 1, 0, 1);
    c.setRenderTarget(null);
    const allocated = owned.created;
    for (let pass = 0; pass < 10; pass++) {
      texture.upload(small, 0, 0, 1, 1);
      show(0, 0, "ffff0000");
      show(1, 1, "0");
      texture.upload(big, 0, 0, 20, 12);
      show(1, 1, "ff00ffff");
      texture.uploadBytes(bytes, 1);
      show(0.5, 0.5, "ff00ff00");
      c.setTexture(0, null);
      c.setRenderTarget(texture, !!(pass & 1));
      c.clear(1, 0, 0, 1);
      c.setRenderTarget(null);
      show(0.5, 0.5, "ffff0000");
      check(owned.created === allocated, "warm rectangle operations allocated GPU handles");
    }
    check(uploadCount === 31, "unexpected rectangle upload count");
    check(staging instanceof Uint8Array && staging.length === 17 * 9 * 4, "oversized staging");
    rejects(() => texture.upload(bitmap, 1));
    rejects(() => texture.upload(bitmap, 0, 1));
    rejects(() => texture.upload(small, 0, 0, NaN, 1));
    rejects(() => texture.upload(small, 0, 0, 2, 1));
    rejects(() => texture.uploadBytes(bytes, 2));
    rejects(() => other.backend.setTexture(0, texture));
    rejects(() => other.backend.setRenderTarget(texture));
    rejects(() => c.setRenderTarget(texture, false, 1));
    show(0.5, 0.5, "ffff0000");
    const fresh = c.createRectangleTexture(19, 11);
    const allocation = gl as unknown as {
      createFramebuffer(): WebGLFramebuffer | null;
      createRenderbuffer(): WebGLRenderbuffer | null;
    };
    const framebuffer = allocation.createFramebuffer;
    const renderbuffer = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["framebuffer", "depth", "incomplete"]) {
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
      check(live.size === before.size, "failed rectangle target leaked handles");
      for (const handle of live) {
        check(before.has(handle), "failed rectangle target replaced handles");
      }
      show(0.5, 0.5, "ffff0000");
    }
    c.setTexture(0, null);
    c.setRenderTarget(texture, true);
    texture.dispose();
    c.clear(0, 1, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "rectangle disposal lost back buffer");
    rejects(() => texture.upload(bitmap));
    rejects(() => c.setRenderTarget(texture));
    check(gl.getError() === gl.NO_ERROR, "rectangle operations polluted GL state");
    other.backend.configure(32, 32);
    const lost = other.backend.createRectangleTexture(17, 9);
    other.backend.setRenderTarget(lost, true);
    other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejects(() => lost.upload(bitmap));
    rejects(() => other.backend.setRenderTarget(lost));
    return { passed: true };
  } finally {
    uploads.texSubImage2D = upload;
    gl.generateMipmap = mipmap;
    c.dispose();
    other.backend.dispose();
    check(live.size === 0 && other.live.size === 0, "rectangle teardown leaked GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function samplerStates(mode: "native" | "clamped" | "missing" = "native") {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    const getExtension = gl.getExtension.bind(gl);
    const getParameter = gl.getParameter.bind(gl);
    const extension = getExtension("EXT_texture_filter_anisotropic");
    const maximum = extension ? getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    const limit = mode === "clamped" ? Math.min(2, maximum) : maximum;
    let extensionQueries = 0;
    let limitQueries = 0;
    gl.getExtension = ((name: string) => {
      if (name === "EXT_texture_filter_anisotropic") {
        extensionQueries++;
        return mode === "missing" ? null : extension;
      }

      return getExtension(name);
    }) as typeof gl.getExtension;
    gl.getParameter = (name: number) => {
      if (extension && name === extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT) {
        limitQueries++;
        return limit;
      }

      return getParameter(name);
    };
    c.configure(32, 32);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0.25, 0.25, 1], 1);
    const texture = c.createTexture(4, 4);
    const cube = c.createTexture(4, 4, true);
    const rectangle = c.createRectangleTexture(4, 4);
    const pixels = new Uint32Array(16).fill(0xffff0000);
    rectangle.upload(pixels);
    for (let level = 0; level < 3; level++) {
      const data = pixels.subarray(0, (4 >> level) ** 2);
      texture.upload(data, level);
      for (let face = 0; face < 6; face++) {
        cube.upload(data, level, face);
      }
    }

    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 0x40005, true);
    code.setUint32(23, 8 << 16, true);
    const flat = c.createProgram();
    flat.upload(shader(false), fragment);
    code.setUint32(27, 0x41005, true);
    code.setUint32(23, 248 << 16, true);
    const spherical = c.createProgram();
    spherical.upload(shader(false), fragment);
    const encoded = [];
    for (let f = 0; f < SAMPLER_FILTERS.length; f++) {
      code.setUint32(27, 5 | (f << 28) | (2 << 24), true);
      const program = c.createProgram();
      program.upload(shader(false), fragment);
      encoded.push(program);
    }
    c.setProgram(flat);
    c.setTexture(0, texture);
    const readback = c.read();
    const make = gl.createSampler.bind(gl);
    gl.createSampler = () => null as unknown as WebGLSampler;
    c.clear(0, 0, 0, 1);
    rejects(() => c.draw(indices, 0, 1));
    gl.createSampler = make;
    const minFilters = [
      gl.NEAREST,
      gl.LINEAR,
      gl.NEAREST_MIPMAP_NEAREST,
      gl.LINEAR_MIPMAP_NEAREST,
      gl.NEAREST_MIPMAP_LINEAR,
      gl.LINEAR_MIPMAP_LINEAR,
    ];
    let allocated = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (let dimension = 0; dimension < 3; dimension++) {
        c.setProgram(dimension === 1 ? spherical : flat);
        c.setTexture(0, dimension === 1 ? cube : dimension === 2 ? rectangle : texture);
        for (let w = 0; w < SAMPLER_WRAPS.length; w++) {
          for (let f = 0; f < SAMPLER_FILTERS.length; f++) {
            for (let m = 0; m < SAMPLER_MIPS.length; m++) {
              c.setSampler(0, SAMPLER_WRAPS[w], SAMPLER_FILTERS[f], SAMPLER_MIPS[m]);
              c.clear(0, 0, 0, 1);
              if ((dimension !== 0 && w !== 0) || (dimension === 2 && m !== 0)) {
                rejects(() => c.draw(indices, 0, 1));
                continue;
              }
              c.draw(indices, 0, 1);
              const sampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler;
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_MIN_FILTER) ===
                  minFilters[m * 2 + Number(f !== 0)],
                "wrong mip/filter combination",
              );
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_MAG_FILTER) ===
                  (f ? gl.LINEAR : gl.NEAREST),
                "wrong magnification filter",
              );
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_WRAP_S) ===
                  (w & 1 ? gl.REPEAT : gl.CLAMP_TO_EDGE),
                "wrong U wrap",
              );
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_WRAP_T) ===
                  (w & 2 ? gl.REPEAT : gl.CLAMP_TO_EDGE),
                "wrong V wrap",
              );
              if (extension) {
                check(
                  gl.getSamplerParameter(sampler, extension.TEXTURE_MAX_ANISOTROPY_EXT) ===
                    (f > 1 && mode !== "missing" ? Math.min(1 << (f - 1), limit) : 1),
                  "wrong anisotropy or retained previous filter",
                );
              }
              check(c.read() === readback, "samplers replaced readback storage");
              check(color(readback, 16, 16, 32) === "ffff0000", "sampler lost texture contents");
              if (pass) {
                check(owned.created === allocated, "warm sampler draw allocated GPU handles");
              }
            }
          }
        }
      }
      c.setTexture(0, texture);
      for (let f = 0; f < encoded.length; f++) {
        c.setProgram(encoded[f]);
        c.clear(0, 0, 0, 1);
        c.draw(indices, 0, 1);
        const sampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler;
        check(
          gl.getSamplerParameter(sampler, gl.TEXTURE_MIN_FILTER) ===
            minFilters[4 + Number(f !== 0)],
          "AGAL sampler did not replace the previous filter",
        );
        if (extension) {
          check(
            gl.getSamplerParameter(sampler, extension.TEXTURE_MAX_ANISOTROPY_EXT) ===
              (f > 1 && mode !== "missing" ? Math.min(1 << (f - 1), limit) : 1),
            "AGAL sampler did not replace anisotropy",
          );
        }
        if (pass) {
          check(owned.created === allocated, "warm AGAL sampler draw allocated GPU handles");
        }
      }
      if (!pass) {
        allocated = owned.created;
      }
    }

    check(extensionQueries === 1, "anisotropy extension was queried more than once");
    check(
      limitQueries === (extension && mode !== "missing" ? 1 : 0),
      "anisotropy limit was queried during warm draws",
    );
    c.setTexture(0, texture);
    c.setSampler(0, "clamp", "linear", "miplinear");
    rejects(() => c.setSampler(0, "bad" as SamplerWrap, "nearest", "mipnone"));
    rejects(() => c.setSampler(-1, "repeat", "nearest", "mipnone"));
    rejects(() => c.setSampler(16, "repeat", "nearest", "mipnone"));
    c.setSampler(15, "repeat", "nearest", "mipnone");
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "invalid sampler state damaged drawing");
    const bad = fragment.slice();
    bad[7] = 0xff;
    rejects(() => spherical.upload(shader(false), bad));
    const conflicting = new Uint8Array(55);
    conflicting.set(fragment);
    conflicting.set(fragment.subarray(7), 31);
    conflicting[49] = 8;
    rejects(() => spherical.upload(shader(false), conflicting));
    c.draw(indices, 0, 1);
    check(owned.created === allocated, "invalid sampler program allocated handles");
    c.configure(64, 64);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "resize lost runtime sampler state");
    check(gl.getError() === gl.NO_ERROR, "sampler tests polluted GL state");

    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "samplers retained GPU handles");
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

export async function targetMultisampling() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(64, 64);
    const vertices = c.createBuffer(4, 6);
    vertices.upload(
      [-1, -1, 0.5, 1, 0, 1, 1, -1, 0.5, 1, 1, 1, -1, 1, 0.5, 1, 0, 0, 1, 1, 0.5, 1, 1, 0],
      0,
      4,
    );
    const triangle = c.createBuffer(3, 4);
    triangle.upload([-0.8, -0.8, 0.5, 1, 0.8, -0.8, 0.5, 1, 0, 0.8, 0.5, 1], 0, 3);
    const indices = c.createBuffer(6, 0);
    indices.upload([0, 1, 2, 2, 1, 3], 0, 6);
    const solid = c.createProgram();
    solid.upload(shader(false), shader(true));
    const vertex = new Uint8Array(55);
    vertex.set(shader(false));
    const v = new DataView(vertex.buffer);
    v.setUint32(35, 0x040f0000, true);
    v.setUint32(39, 0xe4000001, true);
    const fragment = shader(true);
    const f = new DataView(fragment.buffer);
    f.setUint32(7, 0x28, true);
    f.setUint32(19, 4, true);
    f.setUint32(27, 5, true);
    const sampled = c.createProgram();
    sampled.upload(vertex, fragment);
    const texture = c.createTexture(64, 64);
    const rectangle = c.createRectangleTexture(64, 48);
    const draw = () => {
      c.setVertex(0, triangle, 0, "float4");
      c.setVertex(1, null, 0, "float2");
      c.setProgram(solid);
      c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
      c.draw(indices, 0, 1);
    };
    const show = (target: typeof texture) => {
      c.setRenderTarget(null);
      c.setScissor(null);
      c.setDepth(false, "always");
      c.clear(0, 0, 0, 1);
      c.setVertex(0, vertices, 0, "float4");
      c.setVertex(1, vertices, 4, "float2");
      c.setProgram(sampled);
      c.setTexture(0, target);
      c.draw(indices, 0, 2);
      c.setTexture(0, null);
      return c.read();
    };
    const partial = (pixels: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 0 && pixels[i] < 255) {
          count++;
        }
      }
      return count;
    };
    c.setDepth(false, "always");
    c.setRenderTarget(texture);
    c.clear(0, 0, 1, 1);
    draw();
    check(partial(show(texture)) === 0, "single-sample texture has partial coverage");
    c.setRenderTarget(texture, true, 0, 4);
    c.clear(0, 0, 1, 1);
    draw();
    check(partial(show(texture)) > 0, "multisample texture lost antialiased edges");
    c.setRenderTarget(rectangle, false, 0, 4);
    c.clear(0, 0, 1, 1);
    draw();
    check(partial(show(rectangle)) > 0, "multisample rectangle lost antialiased edges");

    const handles = owned.created;
    for (let i = 0; i < 16; i++) {
      c.setRenderTarget(texture, i % 2 === 0, 0, 4);
      c.setRenderTarget(texture, i % 2 === 0, 0, 4);
      c.clear(0, 0, 1, 1);
      draw();
      c.setScissor(30, 30, 4, 4);
      const pixels = show(texture);
      check(color(pixels, 32, 32, 64) === "ffff0000", "warm target lost color");
      check(partial(pixels) > 0, "scissor clipped the multisample resolve");
      check(owned.created === handles, "warm multisample targets allocated GPU handles");
    }

    const blit = gl.blitFramebuffer;
    let resolves = 0;
    gl.blitFramebuffer = (...args) => {
      resolves++;
      blit.apply(gl, args);
    };
    try {
      c.setRenderTarget(texture, true, 0, 4);
      c.clear(0, 1, 0, 1);
      c.setRenderTarget(null);
      check(resolves === 1, "color changes did not resolve once");
      c.setRenderTarget(texture, true, 0, 4);
      c.clear(0, 0, 0, 1, 1, 6);
      c.setRenderTarget(null);
      check(resolves === 1, "depth-only clear repeated the color resolve");
    } finally {
      gl.blitFramebuffer = blit;
    }

    c.setRenderTarget(texture, true, 0, 4);
    c.clear(0, 1, 0, 1);
    const before = live.size;
    const fresh = c.createTexture(32, 32);
    const baseline = live.size;
    const allocation = gl as unknown as {
      createRenderbuffer(): WebGLRenderbuffer | null;
      createTexture(): WebGLTexture | null;
    };
    const allocate = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["color", "depth", "single", "multi"] as const) {
      let allocations = 0;
      let checks = 0;
      allocation.createRenderbuffer = () =>
        ++allocations === (failure === "color" ? 1 : failure === "depth" ? 2 : 0)
          ? null
          : allocate.call(gl);
      gl.checkFramebufferStatus = (target) =>
        ++checks === (failure === "single" ? 1 : failure === "multi" ? 2 : 0)
          ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT
          : status.call(gl, target);
      try {
        rejects(() => c.setRenderTarget(fresh, true, 0, 4));
      } finally {
        allocation.createRenderbuffer = allocate;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === baseline, "failed multisample target leaked handles");
      check(color(show(texture), 32, 32, 64) === "ff00ff00", "failed target lost old color");
      c.setRenderTarget(texture, true, 0, 4);
    }
    c.setRenderTarget(fresh, false, 0, 4);
    c.clear(0, 1, 0, 1);
    const warm = live.size;
    for (const fail of ["allocation", "framebuffer"]) {
      allocation.createRenderbuffer = () => (fail === "allocation" ? null : allocate.call(gl));
      gl.checkFramebufferStatus = (target) =>
        fail === "framebuffer" ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : status.call(gl, target);
      try {
        rejects(() => c.setRenderTarget(fresh, true, 0, 4));
      } finally {
        allocation.createRenderbuffer = allocate;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === warm, "failed cached target upgrade leaked handles");
      draw();
      check(color(show(fresh), 32, 32, 64) === "ffff0000", "cached target rollback broke drawing");
      check(gl.getError() === gl.NO_ERROR, "cached target rollback polluted GL state");
      c.setRenderTarget(fresh, false, 0, 4);
    }
    c.setRenderTarget(null);
    fresh.dispose();
    check(live.size === before, "failed target retained resources after disposal");

    const cube = c.createTexture(16, 16, true);
    for (let face = 0; face < 6; face++) {
      for (let level = 0; level < cube.levels; level++) {
        const size = 16 >> level;
        const pixels = new Uint32Array(size * size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            pixels[y * size + x] =
              (0xff000000 |
                (((face + 1) * 24) << 16) |
                (x < size / 2 ? 0x2000 : 0x8000) |
                (y < size / 2 ? 0x40 : 0xc0)) >>>
              0;
          }
        }
        cube.upload(pixels, level, face);
      }
    }
    const cubeFragment = shader(true);
    new DataView(cubeFragment.buffer).setUint32(7, 0x28, true);
    new DataView(cubeFragment.buffer).setUint32(27, 0x1005, true);
    const cubeProgram = c.createProgram();
    cubeProgram.upload(shader(false), cubeFragment);
    const directions = [
      [1, -0.5, -0.5, 1],
      [-1, -0.5, 0.5, 1],
      [0.5, 1, 0.5, 1],
      [0.5, -1, -0.5, 1],
      [0.5, -0.5, 1, 1],
      [-0.5, -0.5, -1, 1],
    ];
    c.setRenderTarget(null);
    c.clear(0, 0, 0, 1);
    c.setVertex(0, triangle, 0, "float4");
    c.setVertex(1, null, 0, "float2");
    c.setProgram(cubeProgram);
    c.setConstants("fragment", 0, directions[0], 1);
    c.setTexture(0, cube);
    c.draw(indices, 0, 1);
    const cubeBaseline = color(c.read(), 32, 32, 64);
    check(cubeBaseline === "ff1880c0", `cube source baseline: ${cubeBaseline}`);
    c.setTexture(0, null);
    for (let face = 0; face < 6; face++) {
      c.setRenderTarget(cube, false, face, 4);
      c.setScissor(0, 0, 8, 8);
      draw();
      c.setRenderTarget(null);
      c.setScissor(null);
      c.clear(0, 0, 0, 1);
      c.setProgram(cubeProgram);
      c.setConstants("fragment", 0, directions[face], 1);
      c.setTexture(0, cube);
      c.draw(indices, 0, 1);
      const expected = ((0xff000000 | (((face + 1) * 24) << 16) | 0x80c0) >>> 0).toString(16);
      const actual = color(c.read(), 32, 32, 64);
      check(
        actual === expected,
        `cube multisample seed lost face ${face}: ${actual} != ${expected}`,
      );
      c.setTexture(0, null);
    }
    const unbound = c.createTexture(16, 16, true);
    const originalTexture = allocation.createTexture;
    const count = live.size;
    allocation.createTexture = () => null;
    try {
      rejects(() => c.setRenderTarget(unbound, false, 0, 4));
    } finally {
      allocation.createTexture = originalTexture;
    }
    check(live.size === count, "failed cube resolve allocation leaked handles");
    check(gl.getError() === gl.NO_ERROR, "failed cube resolve polluted GL state");
    unbound.dispose();

    const warmed = owned.created;
    for (let i = 0; i < 12; i++) {
      c.setRenderTarget(cube, false, i % 6, 4);
      c.clear(0, 1, 0, 1);
      c.setRenderTarget(null);
      check(owned.created === warmed, "cube face switching allocated GPU handles");
    }
    c.configure(32, 32, true, 4);
    c.setRenderTarget(texture, true, 0, 4);
    c.clear(0, 0, 1, 1);
    c.setRenderTarget(null);
    c.read();
    check(gl.getError() === gl.NO_ERROR, "multisample targets polluted GL state");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejects(() => c.setRenderTarget(texture, true, 0, 4));
  } finally {
    c.dispose();
    check(live.size === 0, "multisample target teardown retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const bytes = 32 * 32 * 4 * 4;
  for (const budget of ["color", "cube", "depth", "fallback"] as const) {
    const owned = create({
      maxTargetColorBytes:
        budget === "cube" ? bytes + 32 * 32 * 4 : budget === "color" ? bytes : bytes * 2,
      maxTargetDepthBytes: bytes,
    });
    const { backend: c, gl } = owned;
    try {
      c.configure(32, 32);
      if (budget === "fallback") {
        gl.getInternalformatParameter = () => new Int32Array();
      }
      const first = c.createTexture(32, 32, budget === "cube");
      const second = c.createTexture(32, 32, budget === "cube");
      c.setRenderTarget(first, true, 0, 4);
      const count = owned.live.size;
      if (budget === "color" || budget === "cube") {
        rejects(() => c.setRenderTarget(second, false, 0, 4));
        check(owned.live.size === count, "color budget failure leaked handles");
      } else if (budget === "depth") {
        c.setRenderTarget(second, false, 0, 4);
        const count = owned.live.size;
        rejects(() => c.setRenderTarget(second, true, 0, 4));
        check(owned.live.size === count, "depth budget failure leaked handles");
      } else {
        check(gl.getParameter(gl.SAMPLES) === 0, "unsupported MSAA did not fall back");
      }
      c.setRenderTarget(null);
      first.dispose();
      c.setRenderTarget(second, true, 0, 4);
      c.setRenderTarget(null);
      second.dispose();
      check(gl.getError() === gl.NO_ERROR, "multisample target quotas polluted GL state");
    } finally {
      c.dispose();
      check(owned.live.size === 0, "multisample target budgets retained GPU handles");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  return { passed: true };
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
