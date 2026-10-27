// libtess2's, for wasm32-freestanding, which has no libc headers.
typedef int jmp_buf[1];
#define setjmp(x) 0
__attribute__((noreturn)) void longjmp(int*,int);
