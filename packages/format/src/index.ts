/**
 * Parsers for the SWF container and its tags: shapes, fonts, text, bitmaps,
 * sounds, buttons and filters, a DoABC's bytes, which codegen parses, and
 * the AVM1 action blocks, which it compiles.
 * The compiler and the player both use this package, so it must stay free of
 * DOM and node APIs.
 */

export {
  type ActionBlock,
  type ActionList,
  type ActionOwner,
  ButtonCondition,
  ClipEvent,
  readActions,
} from "./actions.js";
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
  CompressedDataTooLargeError,
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
  readExports,
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
export {
  type Font,
  type Font4,
  type FontInfo,
  type Glyph,
  glyphOf,
  readFont,
  readFont4,
  readFontAlignZones,
  readFontInfo,
} from "./font.js";
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
} from "./swf.js";
export * as tags from "./tags.js";
export {
  type CsmTextSettings,
  type EditText,
  type FontName,
  readCsmTextSettings,
  readEditText,
  readFontName,
  readStaticText,
  type StaticText,
  type TextRecord,
} from "./text.js";
