// The renderer's core (docs/renderer.md): what a frame draws, as typed
// arrays, and the planner that turns it into commands. No GPU, no DOM.
export {
  CLEAR,
  COMPOSITE,
  Commands,
  FILTER,
  HELD,
  HOLD_POP,
  HOLD_PUSH,
  LAYER_POP,
  LAYER_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "./commands.js";
export * as filterShaders from "./filter-shaders.js";
export {
  BEVEL,
  BLEND,
  BLUR,
  blurShrink,
  COLOR_MATRIX,
  CONVOLUTION,
  DISPLACEMENT,
  FILL_SHADER,
  Filters,
  GLOW,
  GRADIENT,
  SHADER,
} from "./filters.js";
export {
  Geometries,
  type GeometryData,
  type GeometryHandle,
  GLYPH_FLOATS,
  IDLE_FRAMES,
} from "./geometry.js";
export { KEEP_IDLE_FRAMES, type KeepHandle, Keeps } from "./keeps.js";
export {
  drawnArea,
  filteredRect,
  type MeasureTarget,
  measureLayers,
  wholeBitmap,
} from "./measure.js";
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
  KEPT,
  KERNEL,
  LAYER,
  LAYER_BEGIN,
  LAYER_END,
  LIGHTEN,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  MESH,
  MIRROR,
  MULTIPLY,
  NO_WHOLE,
  NORMAL,
  OVERLAY,
  PLANE,
  REPEAT,
  SCREEN,
  SceneList,
  SHADED,
  SMOOTH,
  SNAP,
  SUBTRACT,
  WHOLE_ALIASED,
  WHOLE_SMOOTH,
} from "./scene.js";
export { type TextureData, type TextureHandle, Textures } from "./textures.js";
