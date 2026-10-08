/**
 * Parsers for the SWF container and its tags: shapes, fonts, text, bitmaps,
 * sounds, buttons and filters, and a DoABC's bytes, which codegen parses.
 * The compiler and the player both use this package, so it must stay free of
 * DOM and node APIs.
 */

export { type Bitmap, isBitmapTag, readBitmap } from "./bitmap.js";
export {
  BUTTON_DOWN,
  BUTTON_HIT_TEST,
  BUTTON_OVER,
  BUTTON_UP,
  type Button,
  type ButtonRecord,
  readButton,
} from "./button.js";
export {
  CompressedDataError,
  decompressSwf,
  decompressSwfPrefix,
  deflateCompress,
  LZMA_HEADER,
  lzmaByteArrayCompress,
  lzmaByteArrayUncompress,
  type ZlibLevel,
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
  readScalingGrid,
  readSceneData,
  readSprite,
  readString,
  readSymbolClass,
  type SceneData,
} from "./display.js";
export { type FilterColor, readFilters, type SwfFilter } from "./filters.js";
export { type Font, type Font4, type Glyph, glyphOf, readFont, readFont4 } from "./font.js";
export {
  type ColorTransform,
  type Fill,
  type Gradient,
  type GradientStop,
  IDENTITY,
  type Line,
  type Matrix,
  type MorphShape,
  readColorTransform,
  readMatrix,
  readMorphShape,
  readShape,
  type Shape,
  type ShapeRecord,
} from "./shape.js";
export {
  type ButtonSounds,
  readButtonSound,
  readSound,
  readSoundInfo,
  readSoundStreamBlock,
  readSoundStreamHead,
  readStartSound,
  type Sound,
  type SoundEnvelopePoint,
  type SoundInfo,
  type SoundStreamBlock,
  type SoundStreamHead,
  type StartSound,
} from "./sound.js";
export {
  backgroundColor,
  fileAttributes,
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
  usesNetwork,
} from "./swf.js";
export * as tags from "./tags.js";
export {
  type EditText,
  type FontName,
  readEditText,
  readFontName,
  readStaticText,
  type StaticText,
  type TextRecord,
} from "./text.js";
