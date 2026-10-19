import {
  externalInterfaceHost,
  fromXml,
  invocation,
  type PageValue,
} from "../../packages/web/dist/external.js";
import { bitmapRenderer } from "./bitmap-renderer.ts";
import { type DrawRequest, dimensions, EDGE, restore } from "./bitmap-scene.ts";
import { boot, type Kind } from "./boot.ts";
import { Bridge, channel } from "./bridge.ts";

export type BitmapMode = "direct" | "main-renderer" | "worker-renderer";

export async function runBitmapVm(kind: Kind, mode: BitmapMode, seed = 0, repeats = 1) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 32) {
    throw new RangeError("choose 1 to 32 repetitions");
  }

  const main = await bitmapRenderer();
  const callbacks = new Map<string, (...args: PageValue[]) => PageValue>();
  const errors: string[] = [];
  const page = globalThis as unknown as Record<string, unknown>;
  let startup: string | undefined;
  page.bitmapReport = (value: string) => {
    startup = value;
  };
  const host = externalInterfaceHost(
    {
      objectID: "bitmap-experiment",
      alive: () => true,
      callback(name, value) {
        if (value) {
          callbacks.set(name, value);
        } else {
          callbacks.delete(name);
        }
      },
    },
    (error) => errors.push(String(error)),
  );
  let worker: Worker | undefined;
  let bridge: Bridge | undefined;
  let player: Awaited<ReturnType<typeof boot>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serial = 0;
  let mainDrawMs = 0;
  let fail: (error: Error) => void = () => {};
  let result: (message: { xml: string; elapsed: number; stats: Record<string, number> }) => void =
    () => {};
  try {
    if (mode === "direct") {
      player = await boot(kind, host, (line) => errors.push(line), {
        drawer: main.drawer,
        source: `${kind}-bitmap`,
      });
    } else {
      worker = new Worker("/experiment/bitmap-thread.js", { type: "module" });
      const target = worker;
      const shared = channel();
      const buffer = new SharedArrayBuffer(EDGE * EDGE * 4);
      const pixels = new Uint32Array(buffer);
      bridge = new Bridge(
        shared,
        "reject",
        () => {},
        (method, body) => {
          switch (method) {
            case "snapshot": {
              const request = JSON.parse(body) as DrawRequest;
              const count = dimensions(request.width, request.height);
              if (request.serial !== serial + 1 || ![1, 2, 4, 8].includes(request.samples)) {
                throw new Error("invalid snapshot order or sampling");
              }

              const begun = performance.now();
              const drawn = main.drawer.snapshot(
                restore(request.node),
                request.matrix,
                request.width,
                request.height,
                request.samples,
              );
              if (drawn.length !== count) {
                throw new Error("invalid snapshot size");
              }
              pixels.set(drawn);
              serial = request.serial;
              mainDrawMs += performance.now() - begun;
              return JSON.stringify({ serial, count });
            }
            case "callOut":
              return host.callOut(body) ?? "<null/>";
            case "trace":
              errors.push(body);
              return "";
            default:
              throw new Error(`unexpected bitmap host method: ${method}`);
          }
        },
      );
      await new Promise<void>((resolve, reject) => {
        fail = reject;
        timer = setTimeout(() => reject(new Error("bitmap worker boot timeout")), 30_000);
        target.onerror = (event) => fail(new Error(event.message));
        target.onmessage = (event) => {
          switch (event.data.type) {
            case "pump":
              try {
                bridge?.pump();
              } catch (error) {
                fail(new Error(String(error)));
              }
              break;
            case "ready":
              clearTimeout(timer);
              resolve();
              break;
            case "result":
              result(event.data);
              break;
            case "error":
              fail(new Error(event.data.error));
              break;
          }
        };
        target.postMessage({ type: "init", mode, kind, shared, pixels: buffer });
      });
    }

    if (typeof startup !== "string") {
      throw new Error("constructor draw/report missing");
    }
    let packed: string;
    let elapsed: number;
    let stats: Record<string, number>;
    if (mode === "direct") {
      const callback = callbacks.get("bitmap");
      if (!callback) {
        throw new Error("bitmap callback missing");
      }
      const begun = performance.now();
      const value = callback(seed, repeats);
      if (typeof value !== "string") {
        throw new Error("bitmap callback returned no data");
      }

      packed = value;
      elapsed = performance.now() - begun;
      stats = { ...main.stats, workerRenderers: 0 };
    } else {
      const response = await new Promise<{
        xml: string;
        elapsed: number;
        stats: Record<string, number>;
      }>((resolve, reject) => {
        result = resolve;
        fail = reject;
        timer = setTimeout(() => reject(new Error("bitmap worker run timeout")), 30_000);
        worker?.postMessage({ type: "run", request: invocation("bitmap", [seed, repeats]) });
      });
      clearTimeout(timer);
      packed = String(fromXml(response.xml));
      elapsed = response.elapsed;
      stats = { ...response.stats, mainReadbacks: main.stats.readbacks, mainDrawMs };
    }
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }

    const [readText, pixelText] = packed.split("|");
    const argb = (value: string): number => {
      if (!/^-?[0-9a-f]{1,8}$/.test(value)) {
        throw new Error("invalid bitmap pixel");
      }

      // AVM1's radix formatting is signed; compare the underlying ARGB bits.
      return Number.parseInt(value, 16) >>> 0;
    };
    const reads = readText.split(",").map((value) => argb(value).toString(16));
    const pixels = pixelText?.split(",").map(argb);
    if (
      reads.length !== repeats * 9 ||
      pixels?.length !== 40 * 32 ||
      pixels.some((p) => !Number.isFinite(p))
    ) {
      throw new Error("incomplete bitmap result");
    }

    return {
      kind,
      mode,
      reads,
      pixels,
      startup,
      elapsed,
      stats,
      mainSpins: bridge?.spins ?? 0,
      mainRenderers: 1,
      image: main.picture(pixels),
    };
  } finally {
    clearTimeout(timer);
    bridge?.close();
    worker?.terminate();
    player?.destroy();
    main.destroy();
    delete page.bitmapReport;
  }
}

Object.assign(globalThis, { runBitmapVm });

const button = document.querySelector<HTMLButtonElement>("#compare");
if (button) {
  const status = document.querySelector("#status") as HTMLElement;
  const cards = document.querySelector("#cards") as HTMLElement;
  const ticks = document.querySelector("#ticks") as HTMLElement;
  let count = 0;
  setInterval(() => {
    ticks.textContent = String(++count);
  }, 100);
  button.addEventListener("click", async () => {
    button.disabled = true;
    cards.replaceChildren();
    try {
      const kind = (document.querySelector("#kind") as HTMLSelectElement).value as Kind;
      const repeats = Number((document.querySelector("#repeats") as HTMLSelectElement).value);
      const seed = Number((document.querySelector("#color") as HTMLSelectElement).value);
      let baseline: Awaited<ReturnType<typeof runBitmapVm>> | undefined;
      const modes: BitmapMode[] = ["direct", "main-renderer", "worker-renderer"];
      const titles = [
        "VM and Pixi on main",
        "VM worker · Pixi on main",
        "VM worker · extra worker renderer",
      ];
      for (let i = 0; i < modes.length; i++) {
        status.textContent = `Running ${titles[i]}…`;
        const value = await runBitmapVm(kind, modes[i], seed, repeats);
        baseline ??= value;
        if (
          JSON.stringify(value.reads) !== JSON.stringify(baseline.reads) ||
          JSON.stringify(value.pixels) !== JSON.stringify(baseline.pixels)
        ) {
          throw new Error(`Pixel comparison failed: ${titles[i]}`);
        }

        const card = document.createElement("article");
        const heading = document.createElement("h2");
        heading.textContent = titles[i];
        const image = document.createElement("img");
        image.src = value.image;
        image.alt = "Bitmap drawn and read immediately by Flash";
        const info = document.createElement("p");
        info.textContent =
          `${value.reads.length} pixel checks passed · ` +
          `${value.elapsed.toFixed(1)} ms callback · ${1 + value.stats.workerRenderers} renderer(s)`;
        card.append(heading, image, info);
        cards.append(card);
      }
      status.textContent = "All three modes match, including immediate reads after every draw.";
    } catch (error) {
      status.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}
