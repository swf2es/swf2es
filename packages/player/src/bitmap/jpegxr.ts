// BitmapData.encode's JPEG XR, as Flash writes one (every choice measured
// under adl; see jxr.c in @swf2es/native, which encodes it with jxrlib's
// encoder): a container of five tags and a codestream in spatial order,
// one tile, no overlap filter, one quantizer for every band and channel.
// An opaque bitmap is 24bppBGR; a transparent one 32bppPBGRA, its
// premultiplied pixels as the store keeps them, with alpha interleaved,
// and its flexbits never trimmed, as Flash's. "auto" is 4:4:4. The bytes
// are Flash's.
import { JXR_420, JXR_422, JXR_444, jxrEncode } from "@swf2es/native/atf";
import type { BitmapStore, PixelRect } from "./bitmap.js";
import { areaPixels } from "./jpeg.js";

/** JPEGXREncoderOptions' colorSpace as the encoder's subsampling; undefined for none of them. */
export const JPEG_XR_COLOR_SPACES: Readonly<Record<string, number>> = {
  auto: JXR_444,
  "4:4:4": JXR_444,
  "4:2:2": JXR_422,
  "4:2:0": JXR_420,
};

/**
 * `rect` of the store, clipped to it and not empty, as a JPEG XR file at
 * `quantization` (0, lossless, to 100), with a colour space of
 * JPEG_XR_COLOR_SPACES and `trimFlexBits` 0 to 15.
 */
export function encodeJpegXr(
  store: BitmapStore,
  rect: PixelRect,
  quantization: number,
  colorSpace: string,
  trimFlexBits: number,
): Uint8Array {
  return jxrEncode(areaPixels(store, rect), rect.width, rect.height, {
    alpha: store.transparent,
    quantization,
    subsampling: JPEG_XR_COLOR_SPACES[colorSpace],
    trimFlexBits,
  });
}
