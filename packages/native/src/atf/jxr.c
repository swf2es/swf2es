// Decodes one JPEG XR image, an ATF block, through jxrlib's glue, in the
// pixel format the block must have: a block of another format, or one
// jxrlib refuses, is an error, never a conversion. Encodes one, from
// BitmapData.encode, through jxrlib's encoder (below).
#include <stddef.h>
#include <stdint.h>

#include "JXRGlue.h"
#include "strcodec.h"

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

// Encoding, as Flash Player's BitmapData.encode writes JPEG XR (each choice
// measured under adl): jxrlib's encoder, which writes Flash's codestream
// bit for bit, set as Flash sets it (spatial order, one tile, hard tile
// boundaries, no overlap filter, interleaved alpha, one quantizer for every
// band and channel), and then what Flash writes otherwise: its headers'
// quantizers and sizes, its padding, and a container of its own.
// The container's 90 bytes, before the codestream: a TIFF-like header, an
// IFD of five entries and the pixel format's GUID.
#define CONTAINER 90
// jxrlib's colour plane header, 13 bytes for three channels of 8 bits:
// colour format and bands, 8 bits of chroma settings, then DC, LP and HP
// quantizers, each with independent indices for Y, U and V.
#define JXRLIB_PLANE 13

static struct {
  CTXSTRCODEC codec;
  struct WMPStream stream;
  // The file so far: the container's room, then the codestream.
  uint8_t *bytes;
  size_t size;
  size_t capacity;
  size_t position;
  unsigned width;
  unsigned height;
  unsigned qp;
  int alpha;
  int failed;
} encoder;

static ERR encoder_write(struct WMPStream *stream, const void *data, size_t n) {
  size_t end = encoder.position + n;
  (void)stream;
  if (end < n) {
    encoder.failed = 1;
    return WMP_errOutOfMemory;
  }

  if (end > encoder.capacity) {
    size_t capacity = encoder.capacity * 2 > end ? encoder.capacity * 2 : end;
    uint8_t *grown = realloc(encoder.bytes, capacity);
    if (grown == NULL) {
      encoder.failed = 1;
      return WMP_errOutOfMemory;
    }

    encoder.bytes = grown;
    encoder.capacity = capacity;
  }

  memcpy(encoder.bytes + encoder.position, data, n);
  encoder.position = end;
  if (end > encoder.size) {
    encoder.size = end;
  }

  return WMP_errSuccess;
}

static ERR encoder_set_position(struct WMPStream *stream, size_t at) {
  (void)stream;
  encoder.position = at;
  return WMP_errSuccess;
}

static ERR encoder_position(struct WMPStream *stream, size_t *at) {
  (void)stream;
  *at = encoder.position;
  return WMP_errSuccess;
}

static Bool encoder_end(struct WMPStream *stream) {
  (void)stream;
  return FALSE;
}

static ERR encoder_read(struct WMPStream *stream, void *data, size_t n) {
  (void)stream;
  (void)data;
  (void)n;
  return WMP_errFail;
}

static ERR encoder_close(struct WMPStream **stream) {
  (void)stream;
  return WMP_errSuccess;
}

// Flash's quantization, 0 to 100, as the codestream's quantizer index:
// 0 is lossless, and the steps are Flash's, as measured.
static unsigned quantizer_index(unsigned quantization) {
  if (quantization <= 15) {
    return quantization * 2;
  }

  return quantization <= 48 ? quantization + 18 : quantization + 20;
}

// Begins a `width` by `height` image, pixels with `alpha` or without, at
// Flash's `quantization` (0 to 100), its chroma `subsampling` (YUV_444,
// YUV_422 or YUV_420) and `trim` flexbits (0 to 15, which Flash drops when
// there is alpha). Rows follow, 16 at a time, through swf2es_jxr_encode_rows.
int swf2es_jxr_encode_begin(unsigned width, unsigned height, int alpha, unsigned quantization,
                            int subsampling, unsigned trim) {
  CWMImageInfo info;
  CWMIStrCodecParam params;

  if (width == 0 || height == 0 || width > 65536 || height > 65536 || quantization > 100 ||
      trim > 15 || (subsampling != YUV_444 && subsampling != YUV_422 && subsampling != YUV_420)) {
    return CORRUPT;
  }

  memset(&encoder, 0, sizeof(encoder));
  encoder.width = width;
  encoder.height = height;
  encoder.alpha = alpha;
  encoder.qp = quantizer_index(quantization);
  encoder.stream.Write = encoder_write;
  encoder.stream.SetPos = encoder_set_position;
  encoder.stream.GetPos = encoder_position;
  encoder.stream.EOS = encoder_end;
  encoder.stream.Read = encoder_read;
  encoder.stream.Close = encoder_close;
  encoder.position = CONTAINER;
  encoder.size = CONTAINER;

  memset(&info, 0, sizeof(info));
  info.cWidth = width;
  info.cHeight = height;
  info.cfColorFormat = CF_RGB;
  info.bdBitDepth = BD_8;
  // The store's pixels, BGRA in memory, whether or not their alpha is kept.
  info.cBitsPerUnit = 32;
  info.bRGB = FALSE;

  memset(&params, 0, sizeof(params));
  params.uiDefaultQPIndex = (U8)encoder.qp;
  params.uiDefaultQPIndexAlpha = (U8)encoder.qp;
  params.cfColorFormat = (COLORFORMAT)subsampling;
  params.bdBitDepth = BD_LONG;
  params.olOverlap = OL_NONE;
  params.bfBitstreamFormat = SPATIAL;
  params.cChannel = 3;
  // 3: alpha interleaved in the one codestream, as a plane of its own.
  params.uAlphaMode = alpha ? 3 : 0;
  params.sbSubband = SB_ALL;
  params.uiTrimFlexBits = alpha ? 0 : (U8)trim;
  params.bUseHardTileBoundaries = TRUE;
  params.pWStream = &encoder.stream;

  if (ImageStrEncInit(&info, &params, &encoder.codec) != ICERR_OK || encoder.failed) {
    return NO_MEMORY;
  }

  return DONE;
}

// The next `lines` rows (16, or what is left at the bottom) at `pixels`,
// unpadded rows of BGRA.
int swf2es_jxr_encode_rows(const uint8_t *pixels, unsigned lines) {
  CWMImageBufferInfo buffer;

  memset(&buffer, 0, sizeof(buffer));
  buffer.pv = (void *)pixels;
  buffer.cLine = lines;
  buffer.cbStride = (size_t)encoder.width * 4;
  if (ImageStrEncEncode(encoder.codec, &buffer) != ICERR_OK || encoder.failed) {
    return NO_MEMORY;
  }

  return DONE;
}

// Bits written into `bytes` from the most significant.
typedef struct {
  uint8_t *bytes;
  size_t bit;
} Bits;

static void put_bits(Bits *b, unsigned value, unsigned n) {
  while (n-- > 0) {
    uint8_t *byte = &b->bytes[b->bit >> 3];
    unsigned mask = 0x80u >> (b->bit & 7);
    *byte = (value >> n) & 1 ? (uint8_t)(*byte | mask) : (uint8_t)(*byte & ~mask);
    b->bit++;
  }
}

// One band's quantizer as Flash writes it: uniform across the channels,
// one index; lossless, "mixed", one for Y and one for U and V.
static void put_quantizer(Bits *b, unsigned qp) {
  if (qp == 0) {
    put_bits(b, 1, 2);
    put_bits(b, 0, 8);
    put_bits(b, 0, 8);
  } else {
    put_bits(b, 0, 2);
    put_bits(b, qp, 8);
  }
}

static void put_le(uint8_t *at, uint32_t value, unsigned n) {
  for (unsigned i = 0; i < n; i++) {
    at[i] = (uint8_t)(value >> (8 * i));
  }
}

static const uint8_t PIXEL_FORMAT[16] = {0x24, 0xc3, 0xdd, 0x6f, 0x03, 0x4e, 0xfe, 0x4b,
                                         0xb1, 0x85, 0x3d, 0x77, 0x76, 0x8d, 0xc9, 0x0c};

// Ends the image: `*out` is the file, `*size` bytes, in the arena.
int swf2es_jxr_encode_end(uint8_t **out, size_t *size) {
  uint8_t *code;
  size_t length;
  size_t sizes;
  size_t old_header;
  size_t new_header;
  uint8_t zero[2] = {0, 0};
  Bits b;

  if (ImageStrEncTerm(encoder.codec) != ICERR_OK || encoder.failed) {
    return NO_MEMORY;
  }

  code = encoder.bytes + CONTAINER;
  length = encoder.size - CONTAINER;
  // jxrlib's image header: the signature, three bytes of flags, the colour
  // format and depth, then the size in 16 bits a side, or 32 past 255
  // macroblocks; the colour plane's header after it.
  sizes = code[10] & 0x80 ? 4 : 8;
  old_header = 12 + sizes + JXRLIB_PLANE;
  if (length < old_header) {
    return CORRUPT;
  }

  // Flash's: always the short size, and one quantizer a band.
  b.bytes = code;
  b.bit = 10 * 8;
  put_bits(&b, code[10] | 0x80, 8);
  b.bit = 12 * 8;
  put_bits(&b, encoder.width - 1, 16);
  put_bits(&b, encoder.height - 1, 16);
  // The plane's colour format, arithmetic and bands, then its chroma settings, none.
  put_bits(&b, code[12 + sizes], 8);
  put_bits(&b, 0, 8);
  // DC's quantizer, then LP's and HP's, each its own, not the band's before.
  put_bits(&b, 1, 1);
  put_quantizer(&b, encoder.qp);
  put_bits(&b, 0, 1);
  put_bits(&b, 1, 1);
  put_quantizer(&b, encoder.qp);
  put_bits(&b, 0, 1);
  put_bits(&b, 1, 1);
  put_quantizer(&b, encoder.qp);
  while (b.bit & 7) {
    put_bits(&b, 0, 1);
  }

  new_header = b.bit >> 3;
  memmove(code + new_header, code + old_header, length - old_header);
  length -= old_header - new_header;
  encoder.position = encoder.size = CONTAINER + length;

  // The codestream padded to an even length, and the file one byte past it, as Flash's.
  if (encoder_write(&encoder.stream, zero, (length & 1) + 1) != WMP_errSuccess) {
    return NO_MEMORY;
  }

  length += length & 1;
  code = encoder.bytes;
  memset(code, 0, CONTAINER);
  // Little-endian, JPEG XR's magic, the IFD at 8.
  code[0] = 'I';
  code[1] = 'I';
  code[2] = 0xbc;
  code[3] = 0x01;
  put_le(code + 4, 8, 4);
  put_le(code + 8, 5, 2);
  // Tag, type (1 byte, 4 long), count and value: the pixel format's GUID at 74,
  // the width, the height, and where the codestream is and how long.
  {
    static const uint16_t tags[5] = {0xbc01, 0xbc80, 0xbc81, 0xbcc0, 0xbcc1};
    uint32_t values[5] = {74, encoder.width, encoder.height, CONTAINER, (uint32_t)length};
    for (unsigned i = 0; i < 5; i++) {
      uint8_t *entry = code + 10 + 12 * i;
      put_le(entry, tags[i], 2);
      put_le(entry + 2, i == 0 ? 1 : 4, 2);
      put_le(entry + 4, i == 0 ? 16 : 1, 4);
      put_le(entry + 8, values[i], 4);
    }
  }

  // No next IFD, then 24bppBGR's GUID, or 32bppPBGRA's: premultiplied, as the store keeps it.
  memcpy(code + 74, PIXEL_FORMAT, 16);
  if (encoder.alpha) {
    code[89] = 0x10;
  }

  *out = encoder.bytes;
  *size = encoder.size;
  return DONE;
}
