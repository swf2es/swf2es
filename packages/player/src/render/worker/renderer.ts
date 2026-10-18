import { type Adapter, autoDetectRenderer, DOMAdapter, EventSystem, extensions } from "pixi.js";

/** Experimental stage renderer; input and synchronous BitmapData drawing stay on the main thread. */
export async function workerRenderer(
  canvas: OffscreenCanvas,
  width: number,
  height: number,
  adapter: Adapter,
) {
  if (typeof document !== "undefined" || typeof globalThis.postMessage !== "function") {
    throw new Error("workerRenderer must run in a dedicated worker");
  }

  DOMAdapter.set(adapter);
  // The browser bundle registers events, which need a DOM even with an OffscreenCanvas.
  extensions.remove(EventSystem);

  return autoDetectRenderer({
    canvas,
    width,
    height,
    preference: ["webgl"],
    background: 0xffffff,
    antialias: false,
    preserveDrawingBuffer: true,
    useBackBuffer: true,
  });
}
