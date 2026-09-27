# Benchmarks

## Inputs

- **as3pb** ([33TU/as3pb](https://github.com/33TU/as3pb), MIT): a protobuf
  runtime for AS3. Its benchmark (`runtime/test/bench/Main.as`, built by the
  `build-runtime-bench` target of its `justfile`) encodes and decodes
  messages through `ByteArray` and domain memory, so its bytecode covers bit
  operations, `lookupswitch`, `int`/`uint` coercions and the `li*`/`si*`
  opcodes: many of the less common instructions, in hot loops.

  Build it with **`-compiler.float=false`** (`AS3_FLOAT=false`). Without it,
  the AIR SDK compiler may emit ABC 47.16 float instructions. Only HARMAN's
  AIR runtime supports those (its `airglobal` defines `float`); Flash
  Player and Ruffle do not, and swf2es treats them as illegal for now.

  The benchmark reports through a `TextField`, so for avmshell it needs a
  shell entry point that only calls `trace()` (milestone 1).
- **abcdump.abc**: avmplus' `utils/abcdump.as`, compiled by the oracle into
  `tests/conformance/out/` on every conformance run. It is MPL-2.0 derived,
  so it is regenerated rather than committed.

## Results

Node 24, x86-64, warm, averaged over 100 to 200 rounds. Numbers are for
comparing changes on one machine, not across machines.

`pnpm bench [file.abc...]` measures these; without files it uses abcdump.abc.

| ABC | Size | Instructions | Parse | Decode every body | Per instruction |
|---|---|---|---|---|---|
| abcdump.abc | 32 KB | 6,489 | 0.078 ms | 0.225 ms | 35 ns |
| as3pb benchmark | 94 KB | 43,829 | 0.103 ms | 1.376 ms | 31 ns |
| Tamarin `as3/Vector/initializerLargeVector` | 3.8 MB | 1,002,071 | 1.211 ms | 36.5 ms | 36 ns |

The as3pb ABC was built with AIR SDK 51.3.1 (compiler 3.2.3.0), ABC 46.16,
with 310 method bodies and 2 unreachable bytes.

Before the BodyDecoder rewrite (a new decoder with code-sized scratch per
body, growing output arrays and a final copy into offset order), decoding
cost 181, 152 and 123 ns per instruction for the same three files. Reusing
one decoder's buffers across bodies, writing instructions into offset slots
and packing them in one pass made it 3.4 to 5.2 times faster, with output
identical for all 2,579 compiled Tamarin ABCs.
