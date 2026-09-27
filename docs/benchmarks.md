# Benchmarks

## Inputs

- **as3pb** ([33TU/as3pb](https://github.com/33TU/as3pb), MIT): a protobuf
  runtime for AS3. Its benchmark (`runtime/test/bench/Main.as`, built by the
  `build-runtime-bench` target of its `justfile`) encodes and decodes
  messages through `ByteArray` and domain memory, so its bytecode covers bit
  operations, `lookupswitch`, `int`/`uint` coercions and the `li*`/`si*`
  opcodes: many of the less common instructions, in hot loops.

  Build it with **`-compiler.float=false`** (`AS3_FLOAT=false`). Without it,
  the AIR SDK compiler may emit ABC 47.16 float instructions, which Flash
  Player never shipped and swf2es treats as illegal.

  The benchmark reports through a `TextField`, so for avmshell it needs a
  shell entry point that only calls `trace()` (milestone 1).
- **abcdump.abc**: avmplus' `utils/abcdump.as`, compiled by the oracle into
  `tests/conformance/out/` on every conformance run. It is MPL-2.0 derived,
  so it is regenerated rather than committed.

## Results

Node 24, x86-64, warm, averaged over 100 to 200 rounds. Numbers are for
comparing changes on one machine, not across machines.

**as3pb benchmark ABC** (96,280 bytes; built with AIR SDK 51.3.1, compiler
3.2.3.0; ABC 46.16; 310 method bodies, 43,829 reachable instructions, 2
unreachable bytes):

| Step | Time per ABC | Throughput |
|---|---|---|
| Parse all tables (`readAbc`) | 0.127 ms | 724 MB/s |
| Parse, then decode every body (`decodeBody`) | 6.94 ms | 13 MB/s |

Decoding costs about 160 ns per instruction, mostly allocation: a new
decoder with code-sized scratch arrays per body, growing output arrays,
and a final copy into offset order. See [roadmap.md](roadmap.md).
