// zlib, and the LZMA SDK's encoder, for wasm32-freestanding; lzma.zig
// decodes LZMA. Each call works in a bump arena that the host resets
// first; outputs grow in place at the arena's top, so a buffer of unknown
// size is never copied as it grows.
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "LzmaEnc.h"
#include "zlib.h"

#define PAGE 65536u

extern unsigned char __heap_base;

static uintptr_t top;
static uintptr_t last;

static uint8_t *result;
static size_t resultLength;
static size_t consumed;
static const char *message;

static int reserve(uint64_t end) {
  uint64_t have = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
  if (end <= have) {
    return 1;
  }

  if (end > 0xffff0000u) {
    return 0;
  }

  return __builtin_wasm_memory_grow(0, (size_t)((end - have + PAGE - 1) / PAGE)) != (size_t)-1;
}

void reset(void) {
  top = (uintptr_t)&__heap_base;
  last = 0;
  result = 0;
  resultLength = 0;
  consumed = 0;
  message = 0;
}

void *alloc(size_t n) {
  if (top == 0) {
    reset();
  }

  uint64_t start = ((uint64_t)top + 15) & ~(uint64_t)15;
  if (!reserve(start + n)) {
    return 0;
  }

  last = (uintptr_t)start;
  top = (uintptr_t)(start + n);
  return (void *)last;
}

// The arena's top allocation, made `n` bytes long where it is.
int extend(void *p, size_t n) {
  if ((uintptr_t)p != last || !reserve((uint64_t)last + n)) {
    return 0;
  }

  top = last + n;
  return 1;
}

void *memcpy(void *dest, const void *src, size_t n) {
  __builtin_memcpy(dest, src, n);
  return dest;
}

void *memmove(void *dest, const void *src, size_t n) {
  __builtin_memmove(dest, src, n);
  return dest;
}

void *memset(void *dest, int c, size_t n) {
  __builtin_memset(dest, c, n);
  return dest;
}

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a;
  const unsigned char *y = b;
  for (size_t i = 0; i < n; i++) {
    if (x[i] != y[i]) {
      return x[i] - y[i];
    }
  }

  return 0;
}

size_t strlen(const char *s) {
  size_t n = 0;
  while (s[n]) {
    n++;
  }

  return n;
}

uint8_t *resultPointer(void) {
  return result;
}

size_t resultSize(void) {
  return resultLength;
}

size_t inputUsed(void) {
  return consumed;
}

// How lzma.zig, which decodes into the same arena, hands its output over.
void setResult(uint8_t *p, size_t n, size_t used) {
  result = p;
  resultLength = n;
  consumed = used;
}

const char *errorMessage(void) {
  return message;
}

static voidpf zalloc(voidpf opaque, uInt items, uInt size) {
  (void)opaque;
  return alloc((size_t)items * size);
}

static void zfree(voidpf opaque, voidpf p) {
  (void)opaque;
  (void)p;
}

// What zlib allocates once its stream has begun: inflate's window, which it
// asks for only when an output buffer fills. Kept below the output so the
// output stays at the arena's top.
static void *window;
static voidpf windowAlloc(voidpf opaque, uInt items, uInt size) {
  (void)opaque;
  if (window && (size_t)items * size <= 1u << 15) {
    void *p = window;
    window = 0;
    return p;
  }

  return 0;
}

// Statuses; a call returns one, and its output is at resultPointer().
#define DONE 0
#define FULL 1
#define CORRUPT -1
#define TRUNCATED -2
#define NO_MEMORY -3
#define DICTIONARY -4

// Inflate `length` bytes at `input`, zlib's (`windowBits` 15) or raw (-15),
// into at most `limit` bytes: DONE at the stream's end, FULL if the limit
// came first.
int inflateData(const uint8_t *input, size_t length, int windowBits, size_t limit) {
  z_stream s = {0};
  s.zalloc = zalloc;
  s.zfree = zfree;
  if (inflateInit2(&s, windowBits) != Z_OK) {
    return NO_MEMORY;
  }

  window = alloc(1u << 15);
  s.zalloc = windowAlloc;
  size_t capacity = length < limit / 4 ? length * 4 : limit;
  if (capacity < 65536) {
    capacity = limit < 65536 ? limit : 65536;
  }

  uint8_t *out = alloc(capacity);
  if (!window || !out) {
    return NO_MEMORY;
  }

  s.next_in = (Bytef *)input;
  s.avail_in = (uInt)length;
  s.next_out = out;
  s.avail_out = (uInt)capacity;
  int status;
  for (;;) {
    int z = inflate(&s, Z_NO_FLUSH);
    size_t written = (size_t)(s.next_out - out);
    if (z == Z_STREAM_END) {
      status = DONE;
      break;
    }

    if (z == Z_NEED_DICT) {
      status = DICTIONARY;
      break;
    }

    if (z == Z_DATA_ERROR) {
      message = s.msg;
      status = CORRUPT;
      break;
    }

    if (z == Z_MEM_ERROR) {
      status = NO_MEMORY;
      break;
    }

    if (s.avail_out != 0) {
      // Every byte read, and the stream not ended.
      status = TRUNCATED;
      break;
    }

    if (written == limit) {
      status = FULL;
      break;
    }

    size_t grown = capacity > limit / 2 ? limit : capacity * 2;
    if (!extend(out, grown)) {
      status = NO_MEMORY;
      break;
    }

    s.next_out = out + written;
    s.avail_out = (uInt)(grown - written);
    capacity = grown;
  }

  result = out;
  resultLength = (size_t)(s.next_out - out);
  consumed = (size_t)(s.next_in - input);
  return status;
}

// Deflate `length` bytes at `input` at `level`, as a zlib stream
// (`windowBits` 15) or a raw one (-15).
int deflateData(const uint8_t *input, size_t length, int level, int windowBits) {
  z_stream s = {0};
  s.zalloc = zalloc;
  s.zfree = zfree;
  if (deflateInit2(&s, level, Z_DEFLATED, windowBits, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
    return NO_MEMORY;
  }

  size_t bound = deflateBound(&s, (uLong)length);
  uint8_t *out = alloc(bound);
  if (!out) {
    return NO_MEMORY;
  }

  s.next_in = (Bytef *)input;
  s.avail_in = (uInt)length;
  s.next_out = out;
  s.avail_out = (uInt)bound;
  if (deflate(&s, Z_FINISH) != Z_STREAM_END) {
    return NO_MEMORY;
  }

  result = out;
  resultLength = (size_t)(s.next_out - out);
  return DONE;
}

static void *szAlloc(ISzAllocPtr p, size_t size) {
  (void)p;
  return alloc(size);
}

static void szFree(ISzAllocPtr p, void *address) {
  (void)p;
  (void)address;
}

static const ISzAlloc arena = {szAlloc, szFree};

// `length` bytes at `input` as ByteArray's LZMA, as avmplus' ByteArray writes
// it: 5 property bytes, the length in 8 bytes, and the stream, encoded at
// level 9 with a 1 MB dictionary, or one no larger than the input needs.
int lzmaEncode(const uint8_t *input, size_t length) {
  CLzmaEncProps props;
  LzmaEncProps_Init(&props);
  props.level = 9;
  props.dictSize = 1u << 20;
  // A smaller input, a smaller dictionary: the match finder's tables, some
  // 12 times the dictionary, are allocated and cleared for every call.
  props.reduceSize = length;
  props.numThreads = 1;
  // Never more than the input and a little: what does not compress is stored as literals.
  size_t bound = length + length / 3 + 256;
  uint8_t *out = alloc(LZMA_PROPS_SIZE + 8 + bound);
  if (!out) {
    return NO_MEMORY;
  }

  SizeT propsSize = LZMA_PROPS_SIZE;
  SizeT written = bound;
  SRes r = LzmaEncode(out + LZMA_PROPS_SIZE + 8, &written, input, length, &props, out, &propsSize,
                      0, 0, &arena, &arena);
  if (r != SZ_OK) {
    return NO_MEMORY;
  }

  uint64_t n = length;
  for (int i = 0; i < 8; i++) {
    out[LZMA_PROPS_SIZE + i] = (uint8_t)(n >> (8 * i));
  }

  result = out;
  resultLength = LZMA_PROPS_SIZE + 8 + written;
  return DONE;
}
