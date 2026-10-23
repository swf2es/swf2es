// The libc functions zlib and the LZMA SDK call, for wasm32-freestanding,
// which has no libc headers. Zig compiles C there with -ffreestanding, which
// leaves a plain memcpy a call to compiler-rt's loop; as clang's builtins,
// memcpy, memmove and memset become bulk memory's memory.copy and
// memory.fill. memcmp and strlen have no instruction and stay compiler-rt's.
#ifndef SWF2ES_STRING_H
#define SWF2ES_STRING_H

#include <stddef.h>

void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *dest, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);

#define memcpy __builtin_memcpy
#define memmove __builtin_memmove
#define memset __builtin_memset

#endif
