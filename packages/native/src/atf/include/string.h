// jxrlib's, for wasm32-freestanding, which has no libc headers: as
// include/string.h, clang's builtins become bulk memory instructions;
// memcmp and strlen are Zig's compiler-rt's.
#ifndef SWF2ES_ATF_STRING_H
#define SWF2ES_ATF_STRING_H

#include <stddef.h>

void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *dest, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);

#define memcpy __builtin_memcpy
#define memmove __builtin_memmove
#define memset __builtin_memset
// Only the glue's file names and XMP metadata use these, which the module
// never reads.
#define strchr(s, c) ((char *)0)
#define strrchr(s, c) ((char *)0)
#define strncpy(d, s, n) ((char *)0)
#define wcslen(s) ((size_t)0)

// The decoder checks a container's signature with it.
static inline char *strstr(const char *s, const char *t) {
  for (; *s; s++) {
    const char *a = s;
    const char *b = t;
    while (*b && *a == *b) {
      a++;
      b++;
    }
    if (!*b) {
      return (char *)s;
    }
  }
  return *t ? (char *)0 : (char *)s;
}

#endif
