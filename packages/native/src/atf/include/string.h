// What jxrlib needs beyond include/string.h, for wasm32-freestanding.
#ifndef SWF2ES_ATF_STRING_H
#define SWF2ES_ATF_STRING_H

#include_next <string.h>

// Only the glue's file names and XMP metadata, and the encoder's temporary
// files, use these, which the module never reads nor writes.
#define strchr(s, c) ((char *)0)
#define strcpy(d, s) (d)
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
