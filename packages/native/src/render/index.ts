// The render module's wrappers, each over an instance of its own: fills
// (Tessellator), a layer's lines (LineBuilder, also a Tessellator's
// `tessellate.lines`) and BitmapData's CPU filters and pixel operations
// (BitmapKernel), BitmapData.draw of a bitmap (DrawKernel), and DXT1/DXT5
// texture encoding (DxtEncoder).
export {
  BitmapKernel,
  type BitmapKernelOptions,
  type BitmapRect,
  type BitmapSource,
  type ConvolutionFilter,
  type CopyOp,
  type LayerFilter,
  type PerlinSetup,
  type PixelRegion,
} from "./bitmap-kernel.js";
export {
  DRAW_OPAQUE,
  DRAW_SKIP_ZERO_ALPHA,
  DRAW_SMOOTH,
  DRAW_TRANSFORM,
  type DrawJob,
  DrawKernel,
  type DrawResult,
} from "./draw-kernel.js";
export { DxtEncoder } from "./dxt-encoder.js";
export { LineBuilder, type LineBuilderOptions, type LineGeometry } from "./lines.js";
export {
  type FillGeometry,
  type FillTessellate,
  PATH_CUBIC,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  Tessellator,
  type TessellatorOptions,
} from "./tessellator.js";
