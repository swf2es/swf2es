// jxrlib's, for wasm32-freestanding, which has no libc headers.
#define sqrt(x) __builtin_sqrt(x)
#define fabs(x) __builtin_fabs(x)
