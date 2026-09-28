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

Node 24, x86-64, after a warm-up, the median of 5 samples of about 40 ms
each. Numbers are for comparing changes on one machine, not across machines.

`pnpm bench [file.abc...]` measures these; without files it uses abcdump.abc.

Decoding includes the structural verifier's checks, without types.

| ABC | Size | Instructions | Parse | Decode every body | Per instruction |
|---|---|---|---|---|---|
| abcdump.abc | 32 KB | 6,489 | 0.056 ms | 0.240 ms | 37 ns |
| as3pb, avmshell build (`tests/programs`) | 209 KB | 96,575 | 0.128 ms | 2.90 ms | 30 ns |
| Tamarin `as3/Vector/initializerLargeVector` | 3.8 MB | 1,002,071 | 1.33 ms | 68.2 ms | 68 ns |

### The AssemblyScript runtime

codegen.wasm uses AssemblyScript's `minimal` runtime: the TLSF allocator
and a collector that runs only when the host calls `__collect()`, which
the wrapper does between calls once memory has grown by 64 MB. The
`incremental` runtime collects during calls, and pays for it with a write
barrier on every store of an object reference. Switching made the same
builds, with the same output:

| ABC | Parse, incremental | minimal | Decode per instruction, incremental | minimal |
|---|---|---|---|---|
| abcdump.abc | 0.075 ms | 0.056 ms | 67.5 ns | 37.0 ns |
| as3pb (avmshell build) | 0.185 ms | 0.128 ms | 61.6 ns | 30.0 ns |
| initializerLargeVector | 1.41 ms | 1.33 ms | 63.8 ns | 68.0 ns |

The one huge body of initializerLargeVector spends its time in per-body
scratch, not in managed stores. Loading, linking, resolving and verifying
with types every Tamarin ABC, each in a new domain after builtin and
shell_toplevel, went from 9.8 to 5.5 s. The `stub` runtime, which never
frees, was no faster. The optimizer's `converge` and `noAssert` made no
measurable difference at `optimizeLevel` 3. Neither did `uncheckedBehavior: "always"`,
as the hot loops were already unchecked; releases use it anyway, so the
code needs no `unchecked()`, and `pnpm test:checked` runs the tests with
every access checked instead (see AGENTS.md).

Before the BodyDecoder rewrite (a new decoder with code-sized scratch per
body, growing output arrays and a final copy into offset order), decoding
cost 181, 152 and 123 ns per instruction for the same three files. Reusing
one decoder's buffers across bodies, writing instructions into offset slots
and packing them in one pass made it 3.4 to 5.2 times faster, with output
identical for all 2,579 compiled Tamarin ABCs.
