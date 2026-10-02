/* LZ4 as C compiled by Crossbridge: its block format, fast and HC, and its
   frame format, over three kinds of data, in domain memory. What it prints
   is the same on every run, sizes and checksums; its timings are the lines
   that start with "time: ". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <AS3/AS3.h>

#include "lz4.h"
#include "lz4frame.h"
#include "lz4hc.h"
#include "xxhash.h"

#define SIZE (2 * 1024 * 1024)
#define ITERATIONS 50

static int now(void)
{
    int t;
    inline_as3("import flash.utils.getTimer; %0 = getTimer();" : "=r"(t));
    return t;
}

/* 0: prose, 1: noise, 2: sparse records. */
static void fill(char *data, int kind)
{
    static const char prose[] = "the quick brown fox jumps over the lazy dog 0123456789 ";
    unsigned seed = 0x12345678;
    int i;

    for (i = 0; i < SIZE; i++) {
        if (kind == 0) {
            data[i] = prose[i % (sizeof(prose) - 1)];
        } else if (kind == 1) {
            seed = seed * 1664525u + 1013904223u;
            data[i] = (char)(seed >> 24);
        } else if (i % 16 == 0) {
            seed = seed * 1664525u + 1013904223u;
            memset(data + i, 0, 16);
            data[i] = (char)(seed >> 28);
            data[i + 12] = (char)(seed >> 30);
        }
    }
}

static void run(const char *name, int kind)
{
    int bound = LZ4_compressBound(SIZE);
    char *data = malloc(SIZE);
    char *packed = malloc(bound);
    char *restored = malloc(SIZE);
    size_t frameBound = LZ4F_compressFrameBound(SIZE, NULL);
    char *frame = malloc(frameBound);
    int packedSize = 0, restoredSize = 0, hcSize, n, start;
    size_t frameSize;

    fill(data, kind);

    start = now();
    for (n = 0; n < ITERATIONS; n++) {
        packedSize = LZ4_compress_default(data, packed, SIZE, bound);
    }
    printf("time: %s compress: %d ms\n", name, now() - start);

    start = now();
    for (n = 0; n < ITERATIONS; n++) {
        restoredSize = LZ4_decompress_safe(packed, restored, packedSize, SIZE);
    }
    printf("time: %s decompress: %d ms\n", name, now() - start);

    printf("%s: %d bytes, xxh32 %08x\n", name, SIZE, XXH32(data, SIZE, 0));
    printf("  lz4 %d bytes, xxh32 %08x\n", packedSize, XXH32(packed, packedSize, 0));
    printf("  restored %d bytes, %s\n", restoredSize,
           restoredSize == SIZE && memcmp(data, restored, SIZE) == 0 ? "same" : "DIFFERENT");

    start = now();
    hcSize = LZ4_compress_HC(data, packed, SIZE, bound, 9);
    printf("time: %s compress hc: %d ms\n", name, now() - start);
    restoredSize = LZ4_decompress_safe(packed, restored, hcSize, SIZE);
    printf("  hc %d bytes, xxh32 %08x, %s\n", hcSize, XXH32(packed, hcSize, 0),
           restoredSize == SIZE && memcmp(data, restored, SIZE) == 0 ? "same" : "DIFFERENT");

    frameSize = LZ4F_compressFrame(frame, frameBound, data, SIZE, NULL);
    printf("  frame %d bytes, xxh32 %08x\n", (int)frameSize, XXH32(frame, frameSize, 0));

    free(frame);
    free(restored);
    free(packed);
    free(data);
}

int main(void)
{
    run("prose", 0);
    run("noise", 1);
    run("records", 2);
    return 0;
}
