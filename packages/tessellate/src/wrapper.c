#include <stdint.h>
#include <stddef.h>
#include "tesselator.h"

extern unsigned char __heap_base;
__attribute__((import_module("env"), import_name("failure"), noreturn))
void failure(int);

static uint32_t base, top, spent, limit = 128 * 1024 * 1024;
static TESStesselator *tess;

void reset(void) {
  if (!base) {
    base = ((uintptr_t)&__heap_base + 15) & ~15;
  }

  top = base;
  spent = 0;
  tess = 0;
}

void setLimit(uint32_t n) { limit = n; }

void *alloc(uint32_t n) {
  uint64_t start = ((uint64_t)top + 15) & ~15ULL;
  uint64_t end = start + 16 + n;
  if (end > limit) {
    return 0;
  }

  uint64_t have = __builtin_wasm_memory_size(0) * 65536ULL;
  if (end > have &&
      __builtin_wasm_memory_grow(0, (end - have + 65535) / 65536) == (size_t)-1) {
    return 0;
  }

  // The header lets the allocator callback implement realloc without libc.
  *(uint32_t *)(uintptr_t)start = n;
  top = end;
  spent += n;
  return (void *)(uintptr_t)(start + 16);
}

void *malloc(size_t n) { return alloc(n); }
void free(void *p) { (void)p; }
void *realloc(void *p, size_t n) {
  void *q = alloc(n);
  if (q && p) {
    uint32_t old = *(uint32_t *)((char *)p - 16);
    __builtin_memcpy(q, p, old < n ? old : n);
  }

  return q;
}

static void *get(void *user, unsigned int n) {
  (void)user;
  return alloc(n);
}

static void *grow(void *user, void *p, unsigned int n) {
  (void)user;
  return realloc(p, n);
}

static void drop(void *user, void *p) {
  (void)user;
  (void)p;
}

// The host catches this exception and discards the instance. It must never
// resume an arena whose C stack was unwound without real setjmp support.
void longjmp(int *env, int code) {
  (void)env;
  failure(code);
}

uint32_t highWater(void) { return top - base; }
uint32_t allocated(void) { return spent; }

int run(TESSreal *coords, uint32_t count, uint32_t *ends, uint32_t contours,
        int nonzero) {
  uint32_t at = 0;
  if (contours > 100000 || count > 1000000 || nonzero < 0 || nonzero > 1) {
    return -2;
  }

  for (uint32_t i = 0; i < count * 2; i++) {
    if (!__builtin_isfinite(coords[i]) || coords[i] < TESS_MIN_VALID_INPUT_VALUE ||
        coords[i] > TESS_MAX_VALID_INPUT_VALUE) {
      return -2;
    }
  }

  for (uint32_t i = 0; i < contours; i++) {
    if (ends[i] < at || ends[i] > count || ends[i] - at < 3) {
      return -2;
    }

    at = ends[i];
  }

  if (at != count) {
    return -2;
  }

  TESSalloc allocator = {0};
  allocator.memalloc = get;
  allocator.memrealloc = grow;
  allocator.memfree = drop;
  allocator.extraVertices = count / 4 + 16;
  tess = tessNewTess(&allocator);
  if (!tess) {
    return -1;
  }

  at = 0;
  for (uint32_t i = 0; i < contours; i++) {
    tessAddContour(tess, 2, coords + at * 2, sizeof(TESSreal) * 2, ends[i] - at);
    at = ends[i];
  }

  const TESSreal normal[3] = {0, 0, 1};
  return tessTesselate(tess, nonzero ? TESS_WINDING_NONZERO : TESS_WINDING_ODD,
                      TESS_POLYGONS, 3, 2, normal) ? 0 : -1;
}

uintptr_t vertices(void) { return (uintptr_t)tessGetVertices(tess); }
uintptr_t indices(void) { return (uintptr_t)tessGetElements(tess); }
uint32_t vertexCount(void) { return tessGetVertexCount(tess); }
uint32_t triangleCount(void) { return tessGetElementCount(tess); }
