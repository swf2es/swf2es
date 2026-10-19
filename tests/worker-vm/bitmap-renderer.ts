import { autoDetectRenderer } from "pixi.js";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { BitmapObject, Container } from "../../packages/player/dist/display/display.js";
import type { Drawer } from "../../packages/player/dist/hosts.js";
import { PixiView } from "../../packages/player/dist/render/view.js";

export async function bitmapRenderer() {
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: 40,
    height: 32,
    resolution: 1,
    backgroundAlpha: 0,
    antialias: false,
    preserveDrawingBuffer: true,
    useBackBuffer: true,
  });
  const view = new PixiView(renderer);
  view.quality = "HIGH";
  const stats = { snapshots: 0, gpuDraws: 0, readbacks: 0 };
  const extract = renderer.extract.pixels.bind(renderer.extract);
  renderer.extract.pixels = (...args: Parameters<typeof extract>) => {
    stats.readbacks++;
    return extract(...args);
  };
  const drawer: Drawer = {
    snapshot(...args) {
      stats.snapshots++;
      return view.snapshot(...args);
    },
    drawInto(...args) {
      const drawn = view.drawInto(...args);
      if (drawn) {
        stats.gpuDraws++;
      }

      return drawn;
    },
  };

  return {
    renderer,
    drawer,
    stats,
    picture(pixels: number[]): string {
      const store = new BitmapStore(40, 32, true, 0);
      for (let i = 0; i < pixels.length; i++) {
        store.setPixel32(i % 40, Math.floor(i / 40), pixels[i]);
      }

      const root = new Container();
      root.placeAtDepth(new BitmapObject(store), 1);
      view.render(root);
      const canvas = renderer.canvas as unknown as { toDataURL(type: string): string };
      return canvas.toDataURL("image/png");
    },
    destroy: () => renderer.destroy(),
  };
}
