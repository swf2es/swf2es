// Declared for the LZMA SDK's headers; compress.zig gives every library its
// own allocator, so nothing calls these.
#ifndef SWF2ES_STDLIB_H
#define SWF2ES_STDLIB_H

#include <stddef.h>

void *malloc(size_t n);
void free(void *p);

#endif
