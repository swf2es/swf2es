import { installContext3D as install } from "@swf2es/player/context3d";
import { stage3DCanvasHost } from "@swf2es/player-hosts/stage3d";
import { type Codegen, createCodegen } from "../../packages/codegen/dist/index.js";
import { Player } from "../../packages/player/dist/player.js";
import { Scripting } from "../../packages/player/dist/scripting.js";
import { create } from "./page.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

interface Surface {
  owned: ReturnType<typeof create>;
}

let data: { codegen: Codegen; libraries: Uint8Array[]; swf: Uint8Array } | null = null;
const retired: { kind: string; reference: WeakRef<object> }[] = [];
let loads = 0;
let collectedObjects = 0;
let made = 0;
let removed = 0;
let checks = 0;
let listeners = 0;
let handlesCreated = 0;
let handlesDeleted = 0;

export async function begin(): Promise<void> {
  const wasm = await WebAssembly.compile(
    await (await fetch("/codegen/codegen.wasm")).arrayBuffer(),
  );
  const libraries = await Promise.all(
    ["builtin", "playerglobal-swf2es"].map(
      async (name) => new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
    ),
  );
  data = {
    codegen: await createCodegen(wasm),
    libraries,
    swf: new Uint8Array(await (await fetch("/context3d/Stress.swf")).arrayBuffer()),
  };
}

function watch(kind: string, object: object): void {
  retired.push({ kind, reference: new WeakRef(object) });
}

function trackListeners(canvas: HTMLCanvasElement): void {
  const callbacks = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const methods = canvas as unknown as {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void;
  };
  const add = methods.addEventListener.bind(canvas);
  const remove = methods.removeEventListener.bind(canvas);
  methods.addEventListener = (type, listener, options) => {
    if (type === "webglcontextlost" || type === "webglcontextrestored") {
      let set = callbacks.get(type);
      if (!set) {
        set = new Set();
        callbacks.set(type, set);
      }
      if (!set.has(listener)) {
        set.add(listener);
        listeners++;
      }
    }
    add(type, listener, options);
  };
  methods.removeEventListener = (type, listener, options) => {
    if (callbacks.get(type)?.delete(listener)) {
      listeners--;
    }
    remove(type, listener, options);
  };
}

async function event(canvas: HTMLCanvasElement, name: string, action: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      canvas.removeEventListener(name, done);
      resolve();
    };
    const timer = setTimeout(() => {
      canvas.removeEventListener(name, done);
      reject(new Error(`stress timed out waiting for ${name}`));
    }, 5000);
    canvas.addEventListener(name, done, { once: true });
    action();
  });
}

export async function load(): Promise<void> {
  check(data, "stress is not initialized");
  const { codegen, libraries, swf } = data;
  const errors: string[] = [];
  const scripting = new Scripting(codegen, {
    audio: null,
    print: () => {},
    onUncaught: (error) => errors.push(scripting.rt.toString(error)),
  });
  const active = new Map<number, Surface>();
  const host = stage3DCanvasHost(document.body, (slot) => {
    check(slot < 2 && !active.has(slot), "stress created a duplicate surface");
    const owned = create();
    trackListeners(owned.canvas);
    active.set(slot, { owned });
    made++;
    watch("backend", owned.backend);
    watch("canvas", owned.canvas);
    return { canvas: owned.canvas, context: owned.backend };
  });
  watch("canvas host", host);
  const close = install(scripting, {
    create: host.create,
    place: (slot, x, y, visible) => {
      check(
        active.has(slot) && x === slot * 13 && y === slot * 7 && visible,
        "stress lost Stage3D placement",
      );
      host.place(slot, x, y, visible);
    },
    remove: (slot) => {
      const surface = active.get(slot);
      check(surface, "stress removed a surface twice");
      check(surface.owned.live.size === 0, "stress retained GPU handles after disposal");
      handlesCreated += surface.owned.created;
      handlesDeleted += surface.owned.created - surface.owned.live.size;
      host.remove(slot);
      surface.owned.gl.getExtension("WEBGL_lose_context")?.loseContext();
      active.delete(slot);
      removed++;
    },
  });
  const player = new Player(swf, scripting);
  watch("player", player);
  watch("scripting", scripting);
  try {
    await scripting.loadLibraries(libraries);
    await player.start();
    await scripting.settled();
    const root = player.root.object;
    check(root, "stress root missing");
    watch("AS root", root);
    const get = (name: string) => scripting.rt.getProperty(root, scripting.rt.publicName(name));
    const call = (name: string, ...args: number[]): void => {
      scripting.rt.call(get(name), root, ...args);
      check(errors.length === 0, errors.join("\n"));
    };
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        await scripting.settled();
        player.tick();
      }
    };
    const ready = async (): Promise<void> => {
      await drain();
      check(get("ready") === 2 && active.size === 2, "stress contexts failed to become ready");
    };
    await ready();
    for (let i = 0; i < 4; i++) {
      call("churn", i);
      for (const surface of active.values()) {
        const { backend, gl, live } = surface.owned;
        const handles = live.size;
        const make = gl.createTexture;
        gl.createTexture = () => null as unknown as WebGLTexture;
        let failed = false;
        try {
          backend.configure(512, 256, true);
        } catch {
          failed = true;
        } finally {
          gl.createTexture = make;
        }
        check(failed && live.size === handles, "stress failed resize leaked handles");
        check(gl.getError() === gl.NO_ERROR, "stress corrupted GL state");
      }
    }
    if (loads % 8 === 0) {
      const surface = active.get(0);
      check(surface, "stress surface missing before loss");
      const extension = surface.owned.gl.getExtension("WEBGL_lose_context");
      check(extension, "stress context-loss extension missing");
      await event(surface.owned.canvas, "webglcontextlost", () => extension.loseContext());
      check(
        surface.owned.backend.disposed && surface.owned.live.size === 0,
        "stress loss retained resources",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await event(surface.owned.canvas, "webglcontextrestored", () => extension.restoreContext());
      await ready();
      call("churn", 4);
    } else {
      call("recreate");
      await ready();
      call("churn", 4);
    }
    const retained = get("retained") as { $a: object[] };
    for (let i = 0; i < retained.$a.length; i++) {
      watch("AS resource", retained.$a[i]);
    }
    checks += Number(get("checks"));
    if (loads % 3 === 0) {
      call("recreate");
      close();
      const before = made;
      await drain();
      check(made === before, "stress resurrected queued context creation");
    }
    loads++;
  } finally {
    close();
    player.destroy();
    scripting.destroy();
    check(active.size === 0 && listeners === 0, "stress teardown retained surfaces/listeners");
    check(
      made === removed && handlesCreated === handlesDeleted,
      "stress teardown retained GPU resources",
    );
  }
  // Let loss events and load callbacks leave the stack before the runner collects.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function collected() {
  const alive: Record<string, number> = {};
  let kept = 0;
  for (let i = 0; i < retired.length; i++) {
    const entry = retired[i];
    if (entry.reference.deref()) {
      alive[entry.kind] = (alive[entry.kind] ?? 0) + 1;
      retired[kept++] = entry;
    }
  }
  collectedObjects += retired.length - kept;
  retired.length = kept;

  return {
    loads,
    collectedObjects,
    made,
    removed,
    checks,
    listeners,
    handlesCreated,
    handlesDeleted,
    alive,
    codegen: data?.codegen.usage(),
  };
}
