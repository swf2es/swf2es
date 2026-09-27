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

Step 10's follow-up asked why V8 does not inline more of the codec. With
the generated functions named after their methods (`function
$as3pb_proto__Pack_writeVarint32(...)`, kept, as stacks and profiles read
better), V8's `--trace-turbo-inlining` shows the codec's small methods
refused for their bytecode size (`kExceedsBytecodeLimit`), and
`--trace-deopt` no deoptimizations in its loops worth the name:

| Step 10 follow-up | ByteArray | Domain memory | Kept |
|---|---|---|---|
| Two registers swapped through a temporary, not `[a, b] = [b, a]` (an array and the iterator protocol) | +1.6% | −9.5% | yes |
| **Against #27** | **+0.5%** | **224 → 199 (−11.2%)** | |
| A null check once per register until it is written | +1.6% | +1.0% | no |

Raising V8's inlining limits (`--max-inlined-bytecode-size=2000
--max-inlined-bytecode-size-cumulative=4000`, a flag, not a change)
improves this workload by about 7%. That measures those settings on the
code as it is, not a bound: smaller code could also save work, compiling
and registers, and other limits on inlining remain. Against the swap, as
medians of 7 interleaved pairs each (`AB_NODE_ARGS` in `tests/programs/ab.ts`):

| | ByteArray | Domain memory |
|---|---|---|
| Swap by destructuring, V8's limits | 193 | 222 |
| Swap through a temporary, V8's limits | 194 | 199 |
| Swap by destructuring, limits raised | 181 | 213 |
| Swap through a temporary, limits raised | 182 | 185 |

Both gains persist when combined: the swap is worth as much with the
limits raised (−13%), and raising the limits still helps after it. The null checks' dedup
gained nothing measurable, which does not show that V8 removes every one.

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

## Comparison

Measured on 2026-09-28: Intel Core i9-13900H (x86-64), AlmaLinux 10.2,
Linux 6.12.0-211.56.1.el10_2.x86_64, Node v24.13.1, rustc 1.92.0
(ded5c06cf, Red Hat 1.92.0-2.el10_2.alma.1), Cargo 1.92.0.
This is a laptop measurement with ordinary background activity, no CPU affinity
or frequency lock, and another agent working in a separate checkout. Treat
small differences as noise, not a ranking of entire players.

Implementations:

- **swf2es:** `dev` at `da17175`, plus the test-only `benchCompare` entry point;
  AssemblyScript 0.28.20, release `-O3`, incremental GC, assertions enabled.
- **AwayFL:** local `avm2/dist` from the checkout at
  `ce9630d8b7c4f6022da33e37a1a5b1a33aad459b` (package 0.2.239), bundled
  without changing its parser or analyzer. Installed peers: swf-loader
  0.4.135, core 0.9.61, graphics 0.5.101, scene 0.13.324, stage 0.11.172.
  Build tools came from the existing player installation: Rollup 2.80.0,
  node-resolve 11.2.1, commonjs 18.1.0. No pnpm dependency was added.
- **Ruffle:** the published [`swf` 0.3.0 crate](https://docs.rs/swf/0.3.0/swf/),
  pinned with Cargo.lock, default features disabled, compiled with
  `cargo build --release`. This measures the crate's ABC/op reader, not
  Ruffle's complete VM verifier or runtime.

Each tool reads the same input bytes, including all constant-pool and ABC tables,
traits, exceptions, and body headers. Parse + decode creates a fresh ABC and
decodes every body each round. All instruction operands are read; Ruffle retains
a `Vec<Op>` until each body is complete and passes it through `black_box`.
AwayFL calls its actual `analyze(methodInfo)`; touching `body.code` alone would
only read a raw byte view and would not decode instructions.

The timing rule matches `bench.ts`: three warm-up rounds, one calibration round,
then the median of five samples, with `max(1, round(40 / calibration_ms))` ABCs
per sample. One untimed parse and decode also checks counts before warm-up.
Each tool/input runs in a fresh process, sequentially, with a single benchmark
thread; Node/V8 can still use runtime helper threads. Input I/O, module loading,
Wasm compilation, and process startup are outside timings. GC/deallocation during
timed work is included; no forced GC is used. Raw samples, rounds, input SHA-256s,
and artifact hashes are in
[`comparison-results.json`](../tests/bench/comparison-results.json).

**Read these caveats alongside every table:** swf2es checks avmplus verification
rules and decodes only reachable instructions. It retains strings and code as
input offsets, uses packed instruction arrays, and reuses decoder scratch across
bodies. Its JS-to-Wasm input transfer and padded input copy happen once per
sample batch, amortized over that batch's rounds. AwayFL constructs JS strings,
namespaces and trait objects, retains global namespace interning across warm-up
and samples, and performs stack/scope propagation, branch linking and catch-block
analysis in addition to decoding. `OPTIMISE_ON_IR=false` prevents instruction
fusion so counts remain comparable; other settings retain their shipped defaults.
Ruffle copies strings into byte vectors and copies body code, then linearly reads
all instructions without running the VM verifier. These are different amounts of
work and different output representations.

**Units:** parse and parse + decode are ms per ABC; MB/s uses decimal MB
(1,000,000 bytes), unlike the older `pnpm bench` display, which uses MiB.
The final column is an **estimated incremental decode cost**:
`(median(parse + decode) - median(parse)) * 1e6 / decoded_instruction_count`.
It is a difference of independent medians, not a directly timed decode-only run;
allocation, GC and measurement noise also affect it. The existing `pnpm bench`
parses only once per decode batch, so its decode column is not the total column
below.

### `abcdump.abc`

33,121 bytes; 100 methods in all three.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 6,489 | 0.078 | 423.6 | 0.316 | 36.7 |
| AwayFL | 6,489 | 0.241 | 137.6 | 1.644 | 216.2 |
| Ruffle | 6,489 | 0.062 | 536.6 | 0.172 | 17.0 |

### `as3/Vector/initializerLargeVector.abc`

3,962,592 bytes; 58 methods in all three.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 1,002,071 | 0.734 | 5401.0 | 35.446 | 34.6 |
| AwayFL | 1,002,088 | 0.601 | 6596.8 | 216.325 | 215.3 |
| Ruffle | 1,002,088 | 0.449 | 8832.0 | 14.664 | 14.2 |

AwayFL and Ruffle include 17 instructions skipped as unreachable by swf2es.

### `spidermonkey/js1_5/Regress/regress-280769.abc`

40,846 bytes; 58 methods in all three.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 2,144 | 0.033 | 1228.4 | 0.099 | 30.8 |
| AwayFL | 2,161 | 0.057 | 721.3 | 0.364 | 142.0 |
| Ruffle | 2,161 | 0.020 | 2083.8 | 0.054 | 15.8 |

AwayFL and Ruffle include 17 instructions skipped as unreachable by swf2es.
This regression ABC is mostly string data; its small instruction count makes
parse throughput a poor proxy for decoder throughput.

### `spidermonkey/js1_5/Regress/regress-274888.abc`

73,484 bytes; 58 methods in all three.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 2,127 | 0.031 | 2338.0 | 0.097 | 30.7 |
| AwayFL | 2,144 | 0.060 | 1229.4 | 0.352 | 136.3 |
| Ruffle | 2,144 | 0.019 | 3926.2 | 0.052 | 15.6 |

AwayFL and Ruffle include 17 instructions skipped as unreachable by swf2es.
This regression ABC is mostly string data; its small instruction count makes
parse throughput a poor proxy for decoder throughput.

### `spidermonkey/js1_5/Regress/regress-311629.abc`

127,807 bytes; 58 methods in all three.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 2,096 | 0.031 | 4068.0 | 0.093 | 29.5 |
| AwayFL | 2,113 | 0.061 | 2085.8 | 0.344 | 134.0 |
| Ruffle | 2,113 | 0.019 | 6686.2 | 0.054 | 16.5 |

AwayFL and Ruffle include 17 instructions skipped as unreachable by swf2es.
This regression ABC is mostly string data; its small instruction count makes
parse throughput a poor proxy for decoder throughput.

### `ecma3/Statements/eregress_74474_002.abc`

97,665 bytes; 59 methods in all three.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 38,113 | 0.033 | 2971.0 | 1.344 | 34.4 |
| AwayFL | 38,130 | 0.052 | 1861.6 | 382.599 | 10032.7 |
| Ruffle | 38,130 | 0.019 | 5260.1 | 0.518 | 13.1 |

AwayFL and Ruffle include 17 instructions skipped as unreachable by swf2es.

AwayFL's 382.6 ms here includes its branch/stack/scope analysis passes. This
outlier must not be interpreted as the cost of reading opcode operands alone.

### Reproduce

Run from the repository root. Rust is optional and is not invoked by any pnpm
step. If Cargo is unavailable, stop rather than installing a toolchain.
The AwayFL checkout needs its existing `dist/` output; the second argument points
to a local installation containing its peers and Rollup plugins. The bundler
writes only ignored `tests/bench/out/awayfl.js`; no third-party code is committed.
Node aliases `self` and `window` to its global object for AwayJS feature detection
and explicitly calls `initlazy()` before any measurements. It does not initialize
a player or DOM. `AWAYFL_BUNDLE` can override the bundle path.

```sh
pnpm build
node tests/bench/awayfl-build.ts /path/to/awayfl/avm2 /path/to/awayfl/awayfl-player/node_modules
cargo build --release --locked -j 4 --manifest-path tests/bench/ruffle/Cargo.toml
SWF2ES_ORACLE_JOBS=4 pnpm --workspace-concurrency=1 test
SWF2ES_ORACLE_JOBS=4 pnpm tamarin as3/Vector/initializerLargeVector spidermonkey/js1_5/Regress/regress-280769 spidermonkey/js1_5/Regress/regress-274888 spidermonkey/js1_5/Regress/regress-311629 ecma3/Statements/eregress_74474_002
node tests/bench/compare.ts \
  tests/conformance/out/abcdump.abc \
  tests/tamarin/out/as3/Vector/initializerLargeVector.abc \
  tests/tamarin/out/spidermonkey/js1_5/Regress/regress-280769.abc \
  tests/tamarin/out/spidermonkey/js1_5/Regress/regress-274888.abc \
  tests/tamarin/out/spidermonkey/js1_5/Regress/regress-311629.abc \
  tests/tamarin/out/ecma3/Statements/eregress_74474_002.abc > tests/bench/out/comparison.json
```

The measurements above used existing cached Tamarin ABCs, with the code-heavy
`eregress_74474_002` measured in a subsequent invocation of the same harness.
The harness rejects parser/decoder errors, differing method counts, differing
AwayFL/Ruffle instruction counts, or swf2es counts larger than the linear readers.
It retains the reachable-versus-linear count difference instead of hiding it.
