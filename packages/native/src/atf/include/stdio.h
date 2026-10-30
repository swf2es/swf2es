// What jxrlib needs beyond include/stdio.h, for wasm32-freestanding: the
// module decodes from memory alone, so its file streams and diagnostics
// are inert.
#ifndef SWF2ES_ATF_STDIO_H
#define SWF2ES_ATF_STDIO_H

#include_next <stdio.h>
#include <stddef.h>

typedef struct swf2es_file FILE;

#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define EOF (-1)

#define stdout ((FILE *)0)
#define stderr ((FILE *)0)
#define printf(...) 0
#define fprintf(...) 0
#define sprintf(...) 0
#define fflush(f) 0
#define fopen(name, mode) ((FILE *)0)
#define fclose(f) 0
#define fread(p, size, n, f) ((size_t)0)
#define fwrite(p, size, n, f) ((size_t)0)
#define fseek(f, offset, whence) (-1)
#define ftell(f) (-1L)
#define feof(f) 1

#endif
