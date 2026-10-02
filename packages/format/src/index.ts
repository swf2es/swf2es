/**
 * Parsers for the SWF container, its tags, ABC (DoABC) and AVM1 action records.
 * The compiler and the player both use this package, so it must stay free of
 * DOM and node APIs.
 */

export { type Bitmap, isBitmapTag, readBitmap } from "./bitmap.js";
export {
  CompressedDataError,
  decompressSwf,
  deflateCompress,
  LZMA_HEADER,
  lzmaByteArrayCompress,
  lzmaByteArrayUncompress,
  zlibCompress,
  zlibUncompress,
} from "./compression.js";

export {
  type Place,
  readBinaryData,
  readDoAbc,
  readFrameLabel,
  readPlace,
  readRemove,
  readSprite,
  readSymbolClass,
} from "./display.js";

export {
  type ColorTransform,
  type Fill,
  type Gradient,
  type GradientStop,
  IDENTITY,
  type Line,
  type Matrix,
  readColorTransform,
  readMatrix,
  readShape,
  type Shape,
  type ShapeRecord,
} from "./shape.js";

export {
  backgroundColor,
  isAs3,
  type Rect,
  readSwf,
  readSwfHeader,
  readTags,
  type Swf,
  type SwfCompression,
  type SwfHeader,
  SwfReader,
  type Tag,
} from "./swf.js";

export * as tags from "./tags.js";
