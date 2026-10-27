// Declared for the LZMA SDK's headers and libtess2; minimp3 includes it but
// calls nothing. src/compress/root.zig gives every library its own
// allocator, and src/tessellate/root.zig defines these over its arena.
#ifndef SWF2ES_STDLIB_H
#define SWF2ES_STDLIB_H

#include <stddef.h>

void *malloc(size_t n);
void *realloc(void *p, size_t n);
void free(void *p);

#endif
