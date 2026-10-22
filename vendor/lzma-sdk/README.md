# LZMA SDK 26.05, the encoder's files

The files under `C/` are the LZMA encoder and the headers it includes, from
the LZMA SDK 26.05 by Igor Pavlov, unchanged. `packages/compress` compiles
them (`LzmaEnc.c`, `LzFind.c`) into its WebAssembly module; nothing else of
the SDK is used, so nothing else is here.

- Release: LZMA SDK 26.05, `lzma2605.7z` as https://www.7-zip.org/sdk.html
  links it (https://github.com/ip7z/7zip/releases/download/26.05/lzma2605.7z),
  SHA-256 `668fda469b7f584f246008cf28359c66ef98d65fafb3b22a52672eebe6970c28`.
- The same files, with LF line endings, are in 7-Zip's repository at tag
  `26.05` (https://github.com/ip7z/7zip/tree/26.05/C). They are kept here
  with LF endings; the archive's have CRLF, and are otherwise the same bytes.

| File | SHA-256 (LF line endings) |
|---|---|
| `C/7zTypes.h` | `a5d03b8cb65cd3a2a56bde46dd68fb356d2ebacd9d70283e7d4d20b4e0a64713` |
| `C/Compiler.h` | `d5e42be77d26beaa8c81d3e62ef99fc5685736cfc079779fdb9154d05fa8bc4a` |
| `C/CpuArch.h` | `259145c6f4b085f44284014574f39f3f562fc78466746bfb388efe06b4dd59b4` |
| `C/LzFind.c` | `f73da68845094a85b006a0d2da80b3ecdec92a1ca0f85df637e565c642e8d5ba` |
| `C/LzFind.h` | `42732b38df9bb18f82866d7deaa8663f6c6f9cb10e2a2cdfa9e6f420c2e2f239` |
| `C/LzHash.h` | `42d146d2130dfe49d0b21d15cc6f0fe9d79ac0ebb629985fe3aedde7b2bee80e` |
| `C/LzmaEnc.c` | `67f23656339b5e19015acac41acbcf36ea7787a8419907dce91c1dd336a2fb0f` |
| `C/LzmaEnc.h` | `c5e78398309363dd181840b7ba0bcb856f66619f755d5e2f5e04f7437186ba5f` |
| `C/Precomp.h` | `c8903f2e36a771a272d8981e1e9ffed5ba16ca3d2f3dca6d1414d2340a6829d0` |

Each file states "Igor Pavlov : Public domain". The SDK's `DOC/lzma-sdk.txt`:

> LZMA SDK is written and placed in the public domain by Igor Pavlov.
>
> Anyone is free to copy, modify, publish, use, compile, sell, or distribute
> the original LZMA SDK code, either in source code form or as a compiled
> binary, for any purpose, commercial or non-commercial, and by any means.

To move to another release, take the same files from its archive, check
that each still says it is in the public domain, convert them to LF, update
the table, and run `pnpm --filter @swf2es/compress build:wasm`.
