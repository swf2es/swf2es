import { Scripting } from "@swf2es/player";
import { configure, type Swf2esPlayerElement } from "../../packages/web/dist/index.js";
import { create } from "./page.ts";

interface Surface {
  slot: number;
  owned: ReturnType<typeof create>;
  destroyed: boolean;
  listeners: number;
}

let element: Swf2esPlayerElement | null = null;
let covering: Swf2esPlayerElement | null = null;
const surfaces: Surface[] = [];
const retired: WeakRef<object>[] = [];
const errors: string[] = [];
let failAttachment = false;
let creations = 0;
const workerThreadsRunning = new Set<Worker>();
const BrowserWorker = globalThis.Worker;
globalThis.Worker = class extends BrowserWorker {
  postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    if (message && typeof message === "object" && "codegen" in message && "init" in message) {
      workerThreadsRunning.add(this);
    }
    if (Array.isArray(options)) {
      super.postMessage(message, options);
    } else {
      super.postMessage(message, options);
    }
  }

  terminate(): void {
    workerThreadsRunning.delete(this);
    super.terminate();
  }
};

export function workerThreads(): number {
  return workerThreadsRunning.size;
}
export async function workersStopped(): Promise<void> {
  await until(() => workerThreadsRunning.size === 0);
}
export function rootProperty(name: string): unknown {
  const { scripting, object } = root();
  return scripting.rt.getProperty(object, scripting.rt.publicName(name));
}

const report = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map(String).join(" "));
  report(...args);
};

function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

export async function idle(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function until(ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 10000;
  while (!ready()) {
    check(performance.now() < deadline, `host did not settle: ${errors}`);
    await idle();
  }

  await idle();
}

function root() {
  const player = element?.player;
  check(player?.scripting, "no scripted player");

  return { player, scripting: player.scripting, object: player.root.object };
}

function ready(): boolean {
  const { scripting, object } = root();
  return !!scripting.rt.getProperty(object, scripting.rt.publicName("ready"));
}

function factory(slot: number) {
  creations++;
  const surface: Surface = { slot, owned: create(), destroyed: false, listeners: 0 };
  surfaces.push(surface);
  const { canvas, backend, gl, live } = surface.owned;
  const callbacks = new Set<EventListenerOrEventListenerObject>();
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
    if (
      (type === "webglcontextlost" || type === "webglcontextrestored") &&
      !callbacks.has(listener)
    ) {
      callbacks.add(listener);
      surface.listeners++;
    }

    add(type, listener, options);
  };
  methods.removeEventListener = (type, listener, options) => {
    if (callbacks.delete(listener)) {
      surface.listeners--;
    }

    remove(type, listener, options);
  };
  if (failAttachment) {
    failAttachment = false;
    const parent = element?.shadowRoot?.querySelector<HTMLDivElement>(".box > div");
    check(parent, "no layer for attachment failure");
    const append = parent.append;
    parent.append = () => {
      parent.append = append;
      throw new Error("injected Stage3D attachment failure");
    };
  }

  return {
    canvas,
    context: backend,
    destroy: () => {
      check(!surface.destroyed, "surface destroy repeated");
      check(backend.disposed && live.size === 0, "surface destroyed before resources");
      check(surface.listeners === 0 && !canvas.isConnected, "surface destroyed before detach");
      surface.destroyed = true;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

export async function open(enabled = true, settle = true, fixture = "Composition"): Promise<void> {
  check(!element, "previous element not removed");
  errors.length = 0;
  configure({
    libraries: {
      builtin: "/libraries/builtin.abc",
      playerglobal: "/libraries/playerglobal-swf2es.abc",
    },
    stage3D: enabled ? factory : null,
  });
  element = document.createElement("swf2es-player") as Swf2esPlayerElement;
  element.style.cssText = "position:fixed;left:0;top:0;width:96px;height:96px";
  element.setAttribute("scale", "noScale");
  element.setAttribute("salign", "TL");
  element.addEventListener("error", (event) =>
    errors.push(String((event as unknown as CustomEvent).detail.error)),
  );
  document.body.append(element);
  await element.load(`/context3d/${fixture}.swf`);
  if (settle) {
    if (enabled) {
      await until(() => ready() || errors.length !== 0);
    } else {
      await idle();
      await idle();
    }
  }
}

export async function advance(step: number): Promise<void> {
  const { scripting, object } = root();
  scripting.rt.callValue(
    scripting.rt.getProperty(object, scripting.rt.publicName("advance")),
    object,
    [step],
    null,
  );
  await idle();
}

export async function layout(
  scale: string,
  salign: string,
  width = 192,
  height = 144,
): Promise<void> {
  check(element, "no player element");
  element.setAttribute("scale", scale);
  element.setAttribute("salign", salign);
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  // The AIR viewport reference changes the Stage properties after startup.
  const { scripting, player } = root();
  scripting.rt.setProperty(player.stage.object, scripting.rt.publicName("scaleMode"), scale);
  scripting.rt.setProperty(player.stage.object, scripting.rt.publicName("align"), salign);
  await idle();
}

export function scriptLayout(mode: string, align: string): string {
  const { scripting, object } = root();
  return String(
    scripting.rt.callValue(
      scripting.rt.getProperty(object, scripting.rt.publicName("configureLayout")),
      object,
      [mode, align],
      null,
    ),
  );
}

export function scriptState(validate = false): string {
  const { scripting, object } = root();
  return String(
    scripting.rt.callValue(
      scripting.rt.getProperty(
        object,
        scripting.rt.publicName(validate ? "validateSettings" : "layoutState"),
      ),
      object,
      [],
      null,
    ),
  );
}

export function resizeToShowAll(): void {
  const { scripting, object } = root();
  scripting.rt.setProperty(object, scripting.rt.publicName("resizeToShowAll"), true);
}

export function pointerState(): string {
  const { scripting, object } = root();
  return String(scripting.rt.getProperty(object, scripting.rt.publicName("pointerState")));
}

export async function resize(width: number, height: number): Promise<void> {
  check(element, "no player element");
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  await idle();
}

export async function overlap(show: boolean): Promise<void> {
  if (show) {
    configure({ stage3D: null });
    covering = document.createElement("swf2es-player") as Swf2esPlayerElement;
    covering.style.cssText = "position:fixed;left:0;top:0;width:96px;height:96px";
    covering.setAttribute("bgcolor", "#778899");
    document.body.append(covering);
    await covering.load("/context3d/Composition.swf");
  } else {
    check(covering, "no covering player");
    if (covering.player) {
      retired.push(new WeakRef(covering.player));
      if (covering.player.scripting) {
        retired.push(new WeakRef(covering.player.scripting));
      }
    }
    retired.push(new WeakRef(covering));
    covering.destroy();
    covering.remove();
    covering = null;
    configure({ stage3D: factory });
  }
  await idle();
}

export async function reload(): Promise<void> {
  check(element, "no player element");
  const before = surfaces.length;
  const { player, scripting } = root();
  retired.push(new WeakRef(player), new WeakRef(scripting));
  await element.load("/context3d/Composition.swf");
  for (let i = 0; i < before; i++) {
    check(
      surfaces[i].destroyed && surfaces[i].owned.live.size === 0,
      "reload retained old surface",
    );
  }
  await until(ready);
}

export async function recover(): Promise<void> {
  const before = surfaces.find((surface) => surface.slot === 0 && !surface.destroyed);
  check(before, "no surface to lose");
  const extension = before.owned.gl.getExtension("WEBGL_lose_context");
  check(extension, "no context loss extension");
  extension.loseContext();
  await until(() => before.owned.backend.disposed);
  check(
    !before.destroyed && before.owned.canvas.isConnected && before.listeners === 2,
    "lost canvas removed before restoration",
  );
  extension.restoreContext();
  await until(
    () =>
      before.destroyed &&
      surfaces.some(
        (surface) => surface.slot === 0 && !surface.destroyed && surface.owned.canvas.width === 48,
      ),
  );
}

export function status() {
  return {
    ready: element?.player ? ready() : false,
    errors,
    canvases: element?.shadowRoot?.querySelectorAll("canvas").length ?? 0,
    overlayWidth:
      element?.shadowRoot?.querySelector<HTMLCanvasElement>(".box > canvas")?.width ?? 0,
    surfaces: surfaces.map((surface) => ({
      slot: surface.slot,
      destroyed: surface.destroyed,
      handles: surface.owned.live.size,
      listeners: surface.listeners,
      width: surface.owned.canvas.width,
      height: surface.owned.canvas.height,
      x: surface.owned.canvas.getBoundingClientRect().x,
      y: surface.owned.canvas.getBoundingClientRect().y,
    })),
  };
}

export async function close(remove = false): Promise<void> {
  check(element, "no player element");
  const player = element.player;
  if (player) {
    retired.push(new WeakRef(player));
    if (player.scripting) {
      retired.push(new WeakRef(player.scripting));
    }
  }
  retired.push(new WeakRef(element));
  if (remove) {
    element.remove();
    await idle();
  } else {
    element.destroy();
    check(element.shadowRoot?.querySelectorAll("canvas").length === 0, "destroy retained a canvas");
    element.remove();
  }
  for (let i = 0; i < surfaces.length; i++) {
    const surface = surfaces[i];
    check(
      surface.destroyed && surface.owned.live.size === 0 && surface.listeners === 0,
      "host retained GPU handles or listeners",
    );
    retired.push(new WeakRef(surface.owned.backend), new WeakRef(surface.owned.canvas));
  }
  surfaces.length = 0;
  element = null;
  await idle();
}

export async function queued(): Promise<void> {
  await open();
  const { scripting } = root();
  const rt = scripting.rt;
  const slots = rt.getProperty(scripting.stage?.object, rt.publicName("stage3Ds")) as {
    $a: object[];
  };
  const slot = slots.$a[0];
  const context = rt.getProperty(slot, rt.publicName("context3D"));
  rt.callValue(rt.getProperty(context, rt.publicName("dispose")), context, [false], null);
  rt.callValue(rt.getProperty(slot, rt.publicName("requestContext3D")), slot, [], null);
  const before = creations;
  await close();
  check(creations === before, "destroy created a late surface");
}

export async function cancelled(): Promise<void> {
  const original = Scripting.prototype.loadLibraries;
  let entered!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  Scripting.prototype.loadLibraries = async function (...args) {
    retired.push(new WeakRef(this));
    entered();
    await held;
    if (!this.destroyed) {
      await original.apply(this, args);
    }
  };
  const loading = open(true, false).then(
    () => false,
    () => true,
  );
  try {
    await reached;
    check(element?.shadowRoot?.querySelector(".box > div"), "no startup layer");
    await close();
    resume();
    check(await loading, "cancelled startup resolved");
    check(surfaces.length === 0, "cancelled startup created a late surface");
  } finally {
    resume();
    Scripting.prototype.loadLibraries = original;
  }
}

export async function failed(): Promise<void> {
  failAttachment = true;
  await open();
  check(
    errors.some((error) => error.includes("injected Stage3D attachment failure")),
    `missing failure: ${errors}`,
  );
  check(surfaces.length === 1 && surfaces[0].destroyed, "failed attachment retained surface");
  await close();
}

export function collected(): boolean {
  return retired.every((ref) => !ref.deref());
}
