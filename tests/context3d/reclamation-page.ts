import { Player, Scripting } from "@swf2es/player";
import { installContext3D } from "@swf2es/player/context3d";
import { stage3DCanvasHost } from "@swf2es/player-hosts/stage3d";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import { create } from "./page.ts";

type Owned = ReturnType<typeof create>;
interface Run {
  player: Player;
  scripting: Scripting;
  close: () => void;
  owned: Owned[];
  active: Map<number, Owned>;
  errors: string[];
  loss: WEBGL_lose_context | null;
}
let run: Run | null = null;
const watched: WeakRef<object>[] = [];
const retired: WeakRef<object>[] = [];
const pending: (() => void)[] = [];

function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function get(name: string) {
  check(run, "reclamation not initialized");
  return run.scripting.rt.getProperty(run.player.root.object, run.scripting.rt.publicName(name));
}

function call(name: string, ...args: number[]): void {
  check(run, "reclamation not initialized");
  run.scripting.rt.call(get(name), run.player.root.object, ...args);
  check(run.errors.length === 0, run.errors.join("\n"));
}

function watch(): void {
  const resources = get("resources") as { $a: object[] };
  for (let i = 0; i < resources.$a.length; i++) {
    watched.push(new WeakRef(resources.$a[i]));
  }
}

function storage(owned: Owned) {
  const c = owned.backend as unknown as {
    buffers: { size: number };
    programs: { size: number };
    textures: { size: number };
    bufferBytes: number;
    textureBytes: number;
    targetDepthBytes: number;
  };
  return {
    buffers: c.buffers.size,
    programs: c.programs.size,
    textures: c.textures.size,
    bufferBytes: c.bufferBytes,
    textureBytes: c.textureBytes,
    targetDepthBytes: c.targetDepthBytes,
    handles: owned.live.size,
    created: owned.created,
  };
}

export async function begin(delayed = false, bytes = false): Promise<void> {
  watched.length = 0;
  retired.length = 0;
  check(pending.length === 0, "undelivered finalizers from previous test");
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const errors: string[] = [];
  const scripting = new Scripting(codegen, {
    audio: null,
    realTime: null,
    onUncaught: (error) => errors.push(String(error)),
  });
  const owned: Owned[] = [];
  const active = new Map<number, Owned>();
  const host = stage3DCanvasHost(document.body, (slot) => {
    const entry = create({
      maxBuffers: delayed && !bytes ? 2 : 8,
      maxPrograms: delayed ? 2 : 4,
      maxTextures: delayed && !bytes ? 2 : 8,
      maxBufferBytes: 128 * 1024,
      maxTextureBytes: bytes ? 21844 : 64 * 1024,
      maxTargetDepthBytes: 16 * 1024,
    });
    owned.push(entry);
    active.set(slot, entry);
    return { canvas: entry.canvas, context: entry.backend };
  });
  const original = globalThis.FinalizationRegistry;
  // Hold actual collection notifications so allocation pressure and teardown
  // must handle callbacks that have not yet reached the adapter.
  class Delayed<T> extends original<T> {
    constructor(callback: (value: T) => void) {
      super((value) => pending.push(() => callback(value)));
    }
  }
  if (delayed) {
    globalThis.FinalizationRegistry = Delayed;
  }
  let close: () => void;
  try {
    close = installContext3D(scripting, {
      create: host.create,
      place: host.place,
      remove: (slot) => {
        const entry = active.get(slot);
        check(entry?.live.size === 0, "retired context still owns GPU handles");
        host.remove(slot);
        active.delete(slot);
      },
    });
  } finally {
    globalThis.FinalizationRegistry = original;
  }
  await scripting.loadLibraries(
    await Promise.all(
      ["builtin", "playerglobal-swf2es"].map(
        async (name) => new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
      ),
    ),
  );
  const player = new Player(
    new Uint8Array(await (await fetch("/context3d/Reclamation.swf")).arrayBuffer()),
    scripting,
  );
  run = { player, scripting, close, owned, active, errors, loss: null };
  await player.start();
  await ready(1);
}

async function ready(count: number): Promise<void> {
  check(run, "reclamation not initialized");
  for (let i = 0; i < 5; i++) {
    await run.scripting.settled();
    run.player.tick();
  }
  check(get("ready") === count, "context did not become ready");
  check(run.errors.length === 0, run.errors.join("\n"));
  watch();
}

export function bound(): void {
  check(run, "reclamation not initialized");
  for (let i = 0; i < 4; i++) {
    let failed = false;
    try {
      call("invalidBinding", i);
    } catch {
      failed = true;
    }
    check(failed, "invalid binding was accepted");
  }
  call("drop");
}

export function presentBack(): void {
  call("presentBack");
}

export function disposeBound(): void {
  call("disposeBound");
}

export function drawBound(): void {
  check(run, "reclamation not initialized");
  call("draw");
  const entry = run.active.get(0);
  check(entry, "no active context");
  const pixel = new Uint8Array(4);
  entry.gl.readPixels(16, 16, 1, 1, entry.gl.RGBA, entry.gl.UNSIGNED_BYTE, pixel);
  check(pixel.join(",") === "255,0,0,255", `lost a bound resource: ${pixel}`);
  check(entry.gl.getError() === entry.gl.NO_ERROR, "drawing bound resources failed");
}

export function unbind(): void {
  call("unbind");
}

export function churn(dispose: boolean): void {
  call("churn");
  watch();
  if (dispose) {
    call("disposeAll");
    call("disposeAll");
  } else {
    call("drop");
  }
}

export function drop(): void {
  call("drop");
}

export function pressure(kind: number): void {
  call("pressure", kind);
  watch();
}

export function deliver(): void {
  for (let i = 0; i < pending.length; i++) {
    pending[i]();
  }
  pending.length = 0;
}

export function constructionFailure(): void {
  check(run, "reclamation not initialized");
  const rt = run.scripting.rt;
  for (const [kind, name] of [
    [0, "flash.display3D::VertexBuffer3D"],
    [1, "flash.display3D::Program3D"],
    [2, "flash.display3D.textures::Texture"],
    [3, "flash.display3D.textures::RectangleTexture"],
    [4, "flash.display3D::IndexBuffer3D"],
    [7, "flash.display3D.textures::CubeTexture"],
  ] as const) {
    const owner = run.active.get(0);
    check(owner, "no active context");
    const before = storage(owner);
    const type = rt.classNamed(name);
    const instance = type.$it.instance;
    let injected = false;
    type.$it.instance = () => {
      injected = true;
      throw new Error("injected wrapper construction failure");
    };
    let failed = false;
    try {
      call("pressure", kind);
    } catch {
      failed = true;
    } finally {
      type.$it.instance = instance;
    }
    check(failed && injected, "wrapper construction should fail");
    const after = storage(owner);
    check(
      after.handles === before.handles &&
        after.buffers === before.buffers &&
        after.programs === before.programs &&
        after.textures === before.textures &&
        after.bufferBytes === before.bufferBytes &&
        after.textureBytes === before.textureBytes,
      "failed wrapper construction leaked storage",
    );
  }
}

export async function recreate(churn = true): Promise<void> {
  const count = Number(get("ready"));
  if (churn) {
    call("churn");
    watch();
    call("drop");
  }
  call("recreate");
  await ready(count + 1);
}

async function event(canvas: HTMLCanvasElement, name: string, action: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      canvas.removeEventListener(name, done);
      reject(new Error(name));
    }, 5000);
    canvas.addEventListener(name, done, { once: true });
    action();
  });
}

export async function lose(churn = true): Promise<void> {
  check(run, "reclamation not initialized");
  const entry = run.active.get(0);
  check(entry, "no active context");
  const extension = entry.gl.getExtension("WEBGL_lose_context");
  check(extension, "no context loss extension");
  run.loss = extension;
  if (churn) {
    call("churn");
    watch();
    call("drop");
  }
  await event(entry.canvas, "webglcontextlost", () => extension.loseContext());
  check(entry.live.size === 0, "context loss retained handles");
}

export async function restore(): Promise<void> {
  check(run, "reclamation not initialized");
  const count = Number(get("ready"));
  const entry = run.active.get(0);
  check(entry, "no lost surface");
  const extension = run.loss;
  check(extension, "no context loss extension");
  await event(entry.canvas, "webglcontextrestored", () => extension.restoreContext());
  run.loss = null;
  await ready(count + 1);
}

export function status() {
  check(run, "reclamation not initialized");
  let alive = 0;
  for (let i = 0; i < watched.length; i++) {
    if (watched[i].deref()) {
      alive++;
    }
  }
  return {
    alive,
    watched: watched.length,
    pending: pending.length,
    surfaces: run.owned.map(storage),
    errors: run.errors,
  };
}

export function close(): void {
  check(run, "reclamation not initialized");
  run.close();
  run.player.destroy();
  run.scripting.destroy();
  retired.push(new WeakRef(run.player), new WeakRef(run.scripting));
  for (let i = 0; i < run.owned.length; i++) {
    const entry = run.owned[i];
    check(entry.live.size === 0, "teardown retained handles");
    const counts = storage(entry);
    check(
      counts.bufferBytes + counts.textureBytes + counts.targetDepthBytes === 0,
      "teardown retained budget",
    );
    retired.push(new WeakRef(entry.backend), new WeakRef(entry.canvas));
    entry.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  run = null;
}

export function collected(): boolean {
  return watched.every((ref) => !ref.deref()) && retired.every((ref) => !ref.deref());
}
