// The platform services used by Tamarin's PCRE, built here without the VM.
#pragma once
#include <limits.h>
#include <stdint.h>
#include <string.h>

#define AvmAssert(x) ((void)0)
#define VMPI_memcmp __builtin_memcmp
#define VMPI_memcpy __builtin_memcpy
#define VMPI_memmove __builtin_memmove
#define VMPI_memset __builtin_memset
#define VMPI_strcmp __builtin_strcmp
#define VMPI_strncmp __builtin_strncmp
#define VMPI_strlen __builtin_strlen
#define VMPI_abort() __builtin_trap()
#define VMPI_isprint(c) ((unsigned)(c) - 32 < 95)

extern "C" unsigned char __stack_low;
namespace avmplus {
struct AvmCore {
    static void checkPCREStackOverflow() {
        unsigned char frame;
        if ((uintptr_t)&frame < (uintptr_t)&__stack_low + 16384)
            __builtin_trap();
    }
};
}
