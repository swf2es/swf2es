// What jxrlib needs beyond include/stdlib.h, for wasm32-freestanding.
// root.zig defines the allocator over its arena.
#ifndef SWF2ES_ATF_STDLIB_H
#define SWF2ES_ATF_STDLIB_H

#include_next <stdlib.h>

void *calloc(size_t count, size_t n);

#define abs(x) __builtin_abs(x)
#define exit(status) __builtin_trap()
// The encoder's random quantizers a macroblock, which it draws only from
// several a frame; the module sets one.
#define rand() 0

#endif
