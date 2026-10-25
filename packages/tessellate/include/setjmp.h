typedef int jmp_buf[1];
#define setjmp(x) 0
__attribute__((noreturn)) void longjmp(int*,int);
