// The render module's wrappers, each over an instance of its own: fills
// (Tessellator), a layer's lines (LineBuilder, also a Tessellator's
// `tessellate.lines`) and BitmapData's CPU filters and pixel operations
// (BitmapKernel), and BitmapData.draw of a bitmap (DrawKernel).
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
  type DrawArea,
  DrawKernel,
  type DrawResult,
  type DrawSource,
  type DrawValues,
} from "./draw-kernel.js";
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
