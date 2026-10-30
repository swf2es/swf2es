// jxrlib's, for wasm32-freestanding, which has no libc headers. root.zig
// defines the allocator over its arena.
#ifndef SWF2ES_ATF_STDLIB_H
#define SWF2ES_ATF_STDLIB_H

#include <stddef.h>

void *malloc(size_t n);
void *calloc(size_t count, size_t n);
void *realloc(void *p, size_t n);
void free(void *p);

#define abs(x) __builtin_abs(x)
#define exit(status) __builtin_trap()

#endif
