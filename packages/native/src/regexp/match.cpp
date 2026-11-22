// The compiled pattern, UTF-8 input and match vector belong to this Wasm instance.
#include "avmplus.h"
#include "pcre.h"

extern "C" void resetHeap();
extern "C" const pcre_callout_t pcre_callout = nullptr;
static pcre *pattern;
static char *text;
static int offsets[99];

extern "C" char *input(int size, int newPattern) {
    if (newPattern) resetHeap();
    else pcre_free(text);
    text = (char *)pcre_malloc((size_t)size + 1);
    text[size] = '\0';
    return text;
}

extern "C" int compilePattern(int flags) {
    const char *error;
    int offset;
    pattern = pcre_compile(text, PCRE_UTF8 | flags, &error, &offset, nullptr);
    if (!pattern) return 0;

    // With default character tables PCRE returns one relocatable block.
    // Keep only that block between calls, so the subject can reuse the source's pages.
    size_t size;
    pcre_fullinfo(pattern, nullptr, PCRE_INFO_SIZE, &size);
    resetHeap();
    pcre *saved = (pcre *)pcre_malloc(size);
    memmove(saved, pattern, size);
    pattern = saved;
    text = nullptr;
    return 1;
}

extern "C" const unsigned char *names(int *count, int *stride) {
    const unsigned char *table = nullptr;
    pcre_fullinfo(pattern, nullptr, PCRE_INFO_NAMECOUNT, count);
    pcre_fullinfo(pattern, nullptr, PCRE_INFO_NAMEENTRYSIZE, stride);
    pcre_fullinfo(pattern, nullptr, PCRE_INFO_NAMETABLE, &table);
    return table;
}

extern "C" int match(int size, int start) {
    // The shell's vector fits 32 captures plus the full match. An unused
    // named capture past the last numbered slot still has an empty value.
    __builtin_memset(offsets, -1, sizeof(offsets));
    return pcre_exec(pattern, nullptr, text, size, start, PCRE_NO_UTF8_CHECK, offsets, 99);
}

extern "C" int *result() { return offsets; }
