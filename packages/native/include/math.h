// libtess2's, for wasm32-freestanding, which has no libc headers.
#define sqrtf(x) __builtin_sqrtf(x)
#define sqrt(x) __builtin_sqrt(x)
#define fabs(x) __builtin_fabs(x)
#define isnan(x) __builtin_isnan(x)
