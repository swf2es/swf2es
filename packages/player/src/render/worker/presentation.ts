// Presentation settings travel with the snapshot, so taking the newest slot
// cannot pair it with an older resize or quality control message.
import { ValuesReader, ValuesWriter } from "./values.js";

export const PRESENTATION_BYTES = 88;
const QUALITIES = ["LOW", "MEDIUM", "HIGH", "BEST"];
export interface RenderState {
  width: number;
  height: number;
  resolution: number;
  background: number;
  quality: string;
  antialias: boolean;
  samples: number;
  layerSamples: number;
}

export function writePresentation(bytes: Uint8Array, state: RenderState, libraries = 0): void {
  const w = new ValuesWriter(new Float64Array(bytes.buffer, bytes.byteOffset, 11), 0);
  w.number(2);
  w.number(performance.now());
  w.number(state.width);
  w.number(state.height);
  w.number(state.resolution);
  w.number(state.background);
  w.number(QUALITIES.indexOf(state.quality));
  w.number(Number(state.antialias));
  w.number(state.samples);
  w.number(state.layerSamples);
  w.number(libraries);
}

export function readPresentation(bytes: Uint8Array): {
  state: RenderState;
  published: number;
  libraries: number;
} {
  if (bytes.byteLength < PRESENTATION_BYTES) {
    throw new Error("truncated worker presentation");
  }

  const r = new ValuesReader(new Float64Array(bytes.buffer, bytes.byteOffset, 11), 0);
  if (r.number() !== 2) {
    throw new Error("invalid worker presentation version");
  }

  const published = r.number();
  const width = r.integer(1, 16384);
  const height = r.integer(1, 16384);
  const resolution = r.number();
  const background = r.integer(0, 0xffffff);
  const quality = QUALITIES[r.integer(0, QUALITIES.length - 1)];
  const antialias = r.boolean();
  const samples = r.integer(1, 16);
  const layerSamples = r.integer(1, 16);
  const libraries = r.integer(0, 512);
  if (!Number.isFinite(published) || !(resolution > 0 && resolution <= 8)) {
    throw new Error("invalid worker presentation dimensions");
  }

  return {
    state: { width, height, resolution, background, quality, antialias, samples, layerSamples },
    published,
    libraries,
  };
}
