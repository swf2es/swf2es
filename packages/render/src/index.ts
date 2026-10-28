// The renderer's core (docs/renderer.md): what a frame draws, as typed
// arrays, and the planner that turns it into commands. No GPU, no DOM.
export {
  CLEAR,
  Commands,
  LAYER_POP,
  LAYER_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "./commands.js";
export {
  Geometries,
  type GeometryData,
  type GeometryHandle,
  IDLE_FRAMES,
} from "./geometry.js";
export { type MeasureTarget, measureLayers } from "./measure.js";
export { plan } from "./plan.js";
export { type ColorRow, ROW_FLOATS, ROWS_A_LINE, Rows } from "./rows.js";
export {
  ADD,
  ALPHA,
  BLEND_NAMES,
  CLAMP,
  DARKEN,
  DIFFERENCE,
  DRAW,
  ERASE,
  HARDLIGHT,
  INVERT,
  LAYER,
  LAYER_BEGIN,
  LAYER_END,
  LIGHTEN,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  MIRROR,
  MULTIPLY,
  NORMAL,
  OVERLAY,
  REPEAT,
  SCREEN,
  SceneList,
  SMOOTH,
  SUBTRACT,
} from "./scene.js";
export { type TextureData, type TextureHandle, Textures } from "./textures.js";
