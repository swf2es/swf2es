// The test page: plays a SWF in the player, frame by frame, and gives back
// the frames asked for as PNG data URLs. chrome.ts calls window.runSwf.
//
// Flash anti-aliases by supersampling on a grid, none at low quality, 2×2
// at medium and 4×4 at high and best, so the page draws at that many times
// the resolution, without multisampling, and averages each block of
// samples into a pixel.
import { PixiView, Player } from "@swf2es/player";
import { autoDetectRenderer } from "pixi.js";

interface Run {
  images: Record<number, string>;
  error: string | null;
}

const GRID = [1, 2, 4, 4];

/** Average each n×n block of `from`'s pixels into one of `to`'s. */
function downsample(from: HTMLCanvasElement, to: HTMLCanvasElement, n: number): void {
  const source = from.getContext("2d")?.getImageData(0, 0, from.width, from.height).data;
  const target = to.getContext("2d");
  if (!source || !target) {
    throw new Error("no 2D context");
  }

  const image = target.createImageData(to.width, to.height);
  const samples = n * n;
  for (let y = 0; y < to.height; y++) {
    for (let x = 0; x < to.width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let sy = 0; sy < n; sy++) {
          for (let sx = 0; sx < n; sx++) {
            sum += source[((y * n + sy) * from.width + x * n + sx) * 4 + c];
          }
        }

        image.data[(y * to.width + x) * 4 + c] = Math.round(sum / samples);
      }
    }
  }

  target.putImageData(image, 0, 0);
}

async function runSwf(
  base64: string,
  frames: number,
  capture: number[],
  quality: number,
): Promise<Run> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const images: Record<number, string> = {};
  try {
    const player = new Player(bytes);
    const n = GRID[quality] ?? 4;
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      background: player.background,
      antialias: false,
      preserveDrawingBuffer: true,
      resolution: n,
    });
    const samples = document.createElement("canvas");
    samples.width = renderer.canvas.width;
    samples.height = renderer.canvas.height;
    const output = document.createElement("canvas");
    output.width = player.width;
    output.height = player.height;
    document.body.replaceChildren(output);
    const view = new PixiView(renderer);
    for (let frame = 1; frame <= frames; frame++) {
      if (frame > 1) {
        player.tick();
      }

      if (capture.includes(frame)) {
        view.render(player.root);
        samples.getContext("2d")?.drawImage(renderer.canvas, 0, 0);
        downsample(samples, output, n);
        images[frame] = output.toDataURL("image/png");
      }
    }

    renderer.destroy();
    return { images, error: null };
  } catch (e) {
    return { images, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

(globalThis as unknown as { runSwf: typeof runSwf }).runSwf = runSwf;
