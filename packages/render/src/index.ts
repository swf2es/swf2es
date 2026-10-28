// The renderer's core (docs/renderer.md): what a frame draws, as typed
// arrays, and the planner that turns it into commands. No GPU, no DOM.
export { CLEAR, Commands, RUN } from "./commands.js";
export {
  Geometries,
  type GeometryData,
  type GeometryHandle,
  IDLE_FRAMES,
} from "./geometry.js";
export { plan } from "./plan.js";
export { type ColorRow, ROW_FLOATS, ROWS_A_LINE, Rows } from "./rows.js";
export { CLAMP, MIRROR, NORMAL, REPEAT, SceneList, SMOOTH } from "./scene.js";
export { type TextureData, type TextureHandle, Textures } from "./textures.js";
