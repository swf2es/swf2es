// jxrlib's, for wasm32-freestanding, which has no libc headers.
#define tolower(c) ((c) >= 'A' && (c) <= 'Z' ? (c) + 32 : (c))
