// The libc functions minimp3 calls, for wasm32-freestanding, which has no
// libc headers. Zig compiles C there with -ffreestanding, which leaves a
// plain memcpy a call to compiler-rt's loop; as builtins they become
// bulk memory's memory.copy and memory.fill, as the hosted build had them.
#ifndef SWF2ES_STRING_H
#define SWF2ES_STRING_H

#include <stddef.h>

void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *dest, int c, size_t n);

#define memcpy __builtin_memcpy
#define memmove __builtin_memmove
#define memset __builtin_memset

#endif
