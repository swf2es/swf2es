// Decodes one JPEG XR image, an ATF block, through jxrlib's glue, in the
// pixel format the block must have: a block of another format, or one
// jxrlib refuses, is an error, never a conversion.
#include <stddef.h>
#include <stdint.h>

#include "JXRGlue.h"

// The formats ATF's blocks hold, as root.zig numbers them.
enum {
  FORMAT_BGR = 0,    // RGB888's images: 24bppBGR, as png2atf writes them, or 24bppRGB
  FORMAT_BGRA = 1,   // RGBA8888's: 32bppBGRA, straight alpha
  FORMAT_RGB565 = 2, // DXT colour endpoints: 16bppRGB565
  FORMAT_GRAY = 3,   // DXT5 alpha endpoints: 8bppGray
};

// Statuses, as root.zig's.
enum { DONE = 0, CORRUPT = -1, NO_MEMORY = -3, FORMAT = -5, SIZE = -6 };

static const PKPixelFormatGUID *expected(int format, unsigned *bytes) {
  switch (format) {
  case FORMAT_BGR:
    *bytes = 3;
    return &GUID_PKPixelFormat24bppBGR;
  case FORMAT_BGRA:
    *bytes = 4;
    return &GUID_PKPixelFormat32bppBGRA;
  case FORMAT_RGB565:
    *bytes = 2;
    return &GUID_PKPixelFormat16bppRGB565;
  case FORMAT_GRAY:
    *bytes = 1;
    return &GUID_PKPixelFormat8bppGray;
  default:
    return NULL;
  }
}

// Decodes `size` bytes at `data`, a JPEG XR file of `format` at most
// `limit` pixels a side, into `*out`, top-down rows of the format's bytes
// with no padding, allocated by malloc. 24-bit pixels come out as BGRA,
// opaque, whichever order of R and B the file names.
int swf2es_jxr_decode(const uint8_t *data, size_t size, int format, unsigned limit,
                      uint8_t **out, unsigned *width, unsigned *height) {
  unsigned bytes = 0;
  const PKPixelFormatGUID *guid = expected(format, &bytes);
  struct WMPStream *stream = NULL;
  PKImageDecode *decoder = NULL;
  I32 w = 0;
  I32 h = 0;
  PKRect rect;
  PKPixelInfo info;
  uint8_t *pixels;
  size_t n;
  int rgb;

  if (guid == NULL) {
    return FORMAT;
  }

  if (CreateWS_Memory(&stream, (void *)data, size) < 0) {
    return NO_MEMORY;
  }

  if (PKImageDecode_Create_WMP(&decoder) < 0) {
    return NO_MEMORY;
  }

  if (decoder->Initialize(decoder, stream) < 0) {
    return CORRUPT;
  }

  // ATF's specification names 24bppRGB, which Adobe's tools write as 24bppBGR.
  rgb = format == FORMAT_BGR && IsEqualGUID(&decoder->guidPixFormat, &GUID_PKPixelFormat24bppRGB);
  if (!rgb && !IsEqualGUID(&decoder->guidPixFormat, guid)) {
    return FORMAT;
  }

  // The output is the container's pixel format, as jxrlib's own decoder
  // sets it: its codestream may name another colour format, depth or
  // alpha, which jxrlib would write by into a buffer sized for this one.
  info.pGUIDPixFmt = &decoder->guidPixFormat;
  if (PixelFormatLookup(&info, LOOKUP_FORWARD) < 0) {
    return FORMAT;
  }

  decoder->WMP.wmiI.cfColorFormat = info.cfColorFormat;
  decoder->WMP.wmiI.bdBitDepth = info.bdBitDepth;
  decoder->WMP.wmiI.cBitsPerUnit = info.cbitUnit;
  decoder->WMP.wmiI.cThumbnailWidth = decoder->WMP.wmiI.cWidth;
  decoder->WMP.wmiI.cThumbnailHeight = decoder->WMP.wmiI.cHeight;
  decoder->WMP.wmiI.bSkipFlexbits = FALSE;
  decoder->WMP.wmiI.cROILeftX = 0;
  decoder->WMP.wmiI.cROITopY = 0;
  decoder->WMP.wmiI.cROIWidth = decoder->WMP.wmiI.cWidth;
  decoder->WMP.wmiI.cROIHeight = decoder->WMP.wmiI.cHeight;
  decoder->WMP.wmiI.oOrientation = O_NONE;
  // RGBA8888's alpha, planar or interleaved, decoded with the image.
  decoder->WMP.wmiSCP.uAlphaMode = (info.grBit & PK_pixfmtHasAlpha) ? 2 : 0;

  decoder->GetSize(decoder, &w, &h);
  if (w <= 0 || h <= 0 || (unsigned)w > limit || (unsigned)h > limit) {
    return SIZE;
  }

  n = (size_t)w * (size_t)h * bytes;
  // Room for a 24-bit image's alpha, which it gains in place.
  pixels = malloc(format == FORMAT_BGR ? n / 3 * 4 : n);
  if (pixels == NULL) {
    return NO_MEMORY;
  }

  rect.X = 0;
  rect.Y = 0;
  rect.Width = w;
  rect.Height = h;
  if (decoder->Copy(decoder, &rect, pixels, (U32)w * bytes) < 0) {
    return CORRUPT;
  }

  // From the last pixel back, so that no pixel is overwritten before it is read.
  for (size_t i = n; format == FORMAT_BGR && i > 0; i -= 3) {
    size_t o = i / 3 * 4;
    uint8_t first = pixels[i - 3];
    uint8_t second = pixels[i - 2];
    uint8_t third = pixels[i - 1];
    pixels[o - 4] = rgb ? third : first;
    pixels[o - 3] = second;
    pixels[o - 2] = rgb ? first : third;
    pixels[o - 1] = 255;
  }

  *out = pixels;
  *width = (unsigned)w;
  *height = (unsigned)h;
  return DONE;
}
