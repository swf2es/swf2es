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

### Generated code: as3pb

as3pb's benchmark (100 messages, 300 iterations), compiled by swf2es and
run in node by `tests/programs`, with its output matching avmshell's.
Totals, encode plus decode, in ms, as roadmap step 7 went:

| Change | Through ByteArray | Through domain memory |
|---|---|---|
| First working version (#20) | 1104 | 1412 |
| Typed comparisons and branches | 1018 | 1256 |
| Type references made once per module | 732 | 821 |
| Builtin traits kept, for-in names taken once, ASCII UTF-8 | 593 | 751 |
| Elements read and written by number | 341 | 458 |
| Defining scripts kept, classes matched first | 313 | 414 |
| Structured control flow (#22) | 289 | 410 |
| Runtime hot paths (#23) | 207 | 251 |
| AwayFL JIT, headless, first run | 525 | 689 |
| AwayFL JIT, headless, runs after | 406–462 | 611–654 |
| PepperFlash | 188 | 83 |
| avmshell (the oracle, its JIT in a container) | 107 | 74 |

Each change was found with `node --cpu-prof` on the benchmark. swf2es's
times are medians of 5 runs, each in a node process of its own, so each a
first run; #23's, with AwayFL's, measured on 2026-09-28 on an otherwise
idle machine (swf2es 207–210 and 250–254 ms). AwayFL runs the same
benchmark (as3pb's codecs unchanged since the SWF it plays was built),
its page read from DevTools screenshots after its first run and after 4
more. AMF3 and JSON take about 1120 and 2730 ms; they are the runtime's
own code (amf.ts, json.ts), not generated.

From step 7.4 on, a change is timed against the build before it with
`tests/programs/ab.ts`: both builds run as3pb in turn, interleaved
(A, B, B, A, ...), each run in a process of its own, so that both see the
same load on the machine. Kept are the changes whose gain repeats; a build
against a copy of itself differs by up to 2 or 3%. These were measured
with another process busy on the machine, so they run slower than the
table above; medians of 7 to 9 runs each, in ms:

| Step 7.4 change | ByteArray | Domain memory | Kept |
|---|---|---|---|
| Vector length 0 as a new array, grown by pushing (packed) | −10.3% | −8.9% | yes |
| Class coercions without the builtin switch, traits on the reference | −8.2% | −14.4% | yes |
| Typed Vector elements by kind, not through the hooks | −7.1% | −12.9% | yes |
| ByteArray methods' arguments passed, not a rest array spread | −6.2% | −1.3% | yes |
| Vector push by `arguments`, not a rest array | −1.2% | −2.0% | no |
| Vector grown by pushing, without the new array for 0 (runs one after another, not interleaved) | +2% | +4% | no |
| findDef's global kept on the multiname | −0.6% | +0.9% | no |
| Vector constructed by pushing (packed) | +1.7% | −1.3% | no |
| Domain memory loads and stores inline, not the helpers | −0.9% | −2.3% | no |
| **Step 7.4 against #22** | **325 → 229 (−29.5%)** | **437 → 302 (−30.9%)** | |
| AwayFL, same load, cold / warm | 559 / 409–462 | 709 / 622–701 | |

Step 10, domain memory against PepperFlash's 83 ms, the same way:

| Step 10 change | ByteArray | Domain memory | Kept |
|---|---|---|---|
| Domain memory's length in a field, not DataView's getter, for the range check | 0.0% | −9% | yes |
| A new DataView for domain memory only when its bytes move or resize | −0.5% | −5.4% | yes |
| **Both, against #25** | **0.0%** | **253 → 224 (−11.5%)** | |
| `writeBytes` through a view, not a copy | 0.0% | −1.3% | no |
| `coerceTo` keeping the last subtype it found | −0.5% | +0.9% | no |
| findDef's global kept on the multiname (again, on an idle machine) | +1.0% | +0.9% | no |

What is left is spread over the generated code: the three methods that
take most (the codec's serializeMemory and deserializeMemory, and the
benchmark's loop) each make a static call per field, `Pack.writeVarint(...)`,
as `rt.findDef(M[k]).$slot` and a direct method call; findDef costs 3.7%
itself, but V8 inlines it well enough that keeping its result gains
nothing. More would need the compiler to bind such calls to a class it
knows, with the script's initialization kept exact.

What paid: a runtime helper that many call sites share with many kinds of
values, where the emitter knows the type and can call one made for it
(`coerceTo`, the Vector accessors); arrays kept as V8 wants them, packed
and emptied without a call into its runtime; and no rest arrays on calls
made millions of times. What did not: small helpers V8 already inlines
(domain memory's, `findDef`).

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
