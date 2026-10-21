// A fixed workspace: a frame's encoded bytes and PCM never grow wasm memory.
#define MINIMP3_IMPLEMENTATION
#define MINIMP3_ONLY_MP3
#define MINIMP3_NO_SIMD
#define MINIMP3_FLOAT_OUTPUT
#include "minimp3.h"

static mp3dec_t decoder;
static mp3dec_frame_info_t info;
static unsigned char encoded[4096];
static float pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];

unsigned char *input(void) {
  return encoded;
}

float *output(void) {
  return pcm;
}

int decode(int length) {
  if (length < 0 || length > sizeof(encoded)) {
    return 0;
  }

  return mp3dec_decode_frame(&decoder, encoded, length, pcm, &info);
}

int channels(void) {
  return info.channels;
}

int rate(void) {
  return info.hz;
}
