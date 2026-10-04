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
| Ruffle 0.6.0 (web, headless Chrome), first run | 1118 | 1389 |
| Ruffle 0.6.0, runs after | 1165–1355 | 1438–1530 |
| swf2es with domain memory in place (#80), ab.ts medians | 193 | 194 |
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

Ruffle, measured on 2026-10-02, plays that SWF the same way, its 0.6.0
web build served beside it and read from screenshots: after its first
run and after 4 more, about 6 and 7.5 times swf2es's totals. Its AVM2
interprets the bytecode; swf2es's figures are node's, as above, since
the player's getTimer follows its frame clock and cannot time within a
frame.

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

### Step 13: unrolled loops

Each candidate was measured on its own path, then on as3pb with
`tests/programs/ab.ts`. as3pb, over 11 interleaved pairs, is unchanged
by all three (ByteArray 194 → 195 ms, domain memory 201 → 201): it
writes short strings and no AMF Vectors.

| Change | Measured on | Before | After | Kept |
|---|---|---|---|---|
| `utf8()` ASCII detection and copy, 4 or 8 characters at a time | ns per character, strings of 6 to 2000 | 4.2–16.4 | 3.8–16.2 (within noise, 8 slower on short strings) | no |
| `utf8()` through `TextEncoder` from 96 characters (the crossover is about 90) | ns per character, 96 / 512 / 2000 characters | 7.4 / 5.0 / 4.2 | 4.5 / 1.2 / 0.8 | yes |
| The emitter's `Output.text()`, 4 characters per step | compiling the builtins and as3pb, median of 9, 5 interleaved pairs | 122.4 ms | 121.0 ms (−1.1%, lower in 10 of 10 runs) | yes |
| AMF numeric Vectors, their bytes reserved at once | 60 × `writeObject` of a 100,000-element `Vector.<Number>` and `Vector.<int>` | 47 ms | 15 ms (avmshell: 115) | yes |

`TextEncoder` writes a lone surrogate as U+FFFD, as the loop does. There
avmshell's `writeUTFBytes` loses characters instead: a lone high
surrogate takes the one after it, and one at the end disappears. swf2es
keeps valid UTF-8.

### Step 14: JSON through the host's own

as3pb's JSON lines (100 messages of 750 bytes, 300 rounds), then a nested
document of 2000 items (277 KB of text, 20 rounds), in ms:

| | as3pb stringify | as3pb parse | nested stringify | nested parse |
|---|---|---|---|---|
| avmshell | 2240 | 386 | 400 | 104 |
| swf2es before | 2279 | 434 | 363 | 99 |
| Numbers in the host's digits, not avmplus' (its D2A, with big numbers, was half the time) | 1080 | | | |
| toJSON found through a cached binding and the dynamic properties, elements and own properties read directly | 670 | | | |
| Strings quoted by the host's `JSON.stringify` | 650 | | | |
| A tree of the host's values, written by its `JSON.stringify` | 522 | | 96 | |
| Parsed by the host's `JSON.parse`, then made AS3's in place | | 300 | | 56 |

Output reads back as the same keys and values, not the same text (key
order, escapes and digits differ). avmplus' probe for an AS3 toJSON
never finds a script's, so swf2es looks only for a public one. The text
the host rejects, such as `01`, goes to the old parser. Conversion
recurses to a depth of 500, then uses a stack of its own, as avmplus
reads 100,000-deep text.

### Step 15: AMF3 decoding

as3pb's AMF3 deserialize line (`readObject` of 100 typed messages, 300
rounds), medians of interleaved runs (`AB_PATHS` in `tests/programs/ab.ts`),
in ms. avmshell: 317.

| Change | AMF3 decode | JSON decode | Kept |
|---|---|---|---|
| Before (dev) | 821 | 300 | |
| Vector classes kept once made, in `vectorClass` and in `Vector.<T>`'s apply, and builtin classes by name; a Vector's elements through its own setter | 565 | | yes |
| Strings and ByteArray contents read from views of the input, not copies | 497 | | yes |
| A table of each class's variables, set straight to their slots | ~497 (−2%) | | no |
| ASCII read at once from 16 bytes | 497 | 266 (−11%) | yes |
| A short ASCII string a character at a time | 486 (−2.6%) | | yes |
| After review: a numeric Vector's elements at once into its storage, when all are there | 473 (−2.5%) | | yes |
| After review: uint29 through a local cursor when four bytes are there | 478 (+0.2%) | | no |
| After review: a short ASCII string straight from the input, no view | 461 (−3.2%) | | yes |
| **Against dev** | **457 (−43.5%)** | **266 (−10.4%)** | |

What is left is mostly constructing the objects read (38%), about two
thirds of it as3pb's own constructors, which avmshell runs too.

### Step 12: typed verification

`pnpm bench` now times typed verification too: every body the ABC's
scripts can run, in a domain after builtin and shell_toplevel, as the
compiler verifies, with `getBinding`'s memo cleared each round. In ms, then
ns per instruction verified:

| Change | abcdump | as3pb | initializerLargeVector |
|---|---|---|---|
| Before | 2.38 (367) | 19.7 (204) | 135.8 (135) |
| A binding's probe compares the slot's hash before its key | 2.13 | 18.9 | 135.2 |
| The domain's hash tables at most half full, not three quarters | 2.12 | 16.1 | 135.5 |
| `mergeEntry` in two ranges, skipping a value whose type and flags stay | 2.10 | 15.5 | 135.6 |
| `getBinding`'s answers kept, by type, ABC and multiname | 1.39 | 14.9 | 136.3 |
| A handler edge skipped when its locals are as at its last merge | 1.42 (219) | 13.3 (138) | 135.4 (135) |
| A table of each traits' names, before each namespace's probe | no gain once the memo was in | | |

Compiling builtin, shell_toplevel and as3pb to modules: 121.9 to 110.9 ms
(−9%), in 5 interleaved pairs.

What is left is the verifier's second pass, which walks every block again
to emit its IR: 34% of as3pb's verification and 52% of
initializerLargeVector's, a body of a million instructions with no handlers.
In a worklist that reaches a fixed point, each block's last visit follows
the last change to its entry state, so the IR could be kept from that visit
instead, once whatever only the second pass does is done in the first.

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

- **swf2es:** `dev` at `d5ffa36`, plus the test-only `benchCompare` entry point;
  Structural verification is included; domain linking and typed verification are not.
  AssemblyScript 0.28.20, release `-O3`, incremental GC, assertions enabled.
- **AwayFL:** local `avm2/dist` from the checkout at
  `ce9630d8b7c4f6022da33e37a1a5b1a33aad459b` (package 0.2.239), bundled
  without changing its parser or analyzer. Installed peers: swf-loader
  0.4.135, core 0.9.61, graphics 0.5.101, scene 0.13.324, stage 0.11.172.
  Build tools came from the existing player installation: Rollup 2.80.0,
  node-resolve 11.2.1, commonjs 18.1.0. No pnpm dependency was added.
- **Ruffle:** the published [`swf` 0.3.0 crate](https://docs.rs/swf/0.3.0/swf/),
  pinned with Cargo.lock, default features disabled, compiled with
  `cargo build --release` for both native and `wasm32-unknown-unknown`.
  The Wasm reader runs in the same Node/V8 as swf2es; both Rust builds share
  the same reader function. See the Wasm build details below. This measures the crate's ABC/op reader, not
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
[`comparison-wasm-results.json`](../tests/bench/comparison-wasm-results.json).
The older pre-verifier samples remain in `comparison-results.json` for reference.

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

33,121 bytes; 100 methods in all four.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 6,489 | 0.079 | 421.3 | 0.502 | 65.2 |
| AwayFL | 6,489 | 0.228 | 145.1 | 2.070 | 283.8 |
| Ruffle native | 6,489 | 0.069 | 479.5 | 0.172 | 15.9 |
| Ruffle Wasm | 6,489 | 0.076 | 436.2 | 0.186 | 17.0 |

### `as3/Vector/initializerLargeVector.abc`

3,962,592 bytes; 58 methods in all four.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 1,002,071 | 0.764 | 5188.2 | 61.806 | 60.9 |
| AwayFL | 1,002,088 | 0.724 | 5473.8 | 257.292 | 256.0 |
| Ruffle native | 1,002,088 | 0.478 | 8297.2 | 14.961 | 14.5 |
| Ruffle Wasm | 1,002,088 | 0.632 | 6266.0 | 13.473 | 12.8 |

AwayFL and both Ruffle builds include 17 instructions skipped as unreachable by swf2es.

### `spidermonkey/js1_5/Regress/regress-280769.abc`

40,846 bytes; 58 methods in all four.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 2,144 | 0.034 | 1191.8 | 0.160 | 58.7 |
| AwayFL | 2,161 | 0.056 | 730.0 | 0.423 | 170.1 |
| Ruffle native | 2,161 | 0.019 | 2117.1 | 0.052 | 15.2 |
| Ruffle Wasm | 2,161 | 0.018 | 2331.7 | 0.050 | 14.8 |

AwayFL and both Ruffle builds include 17 instructions skipped as unreachable by swf2es.
This ABC is mostly string data; parse throughput is not a proxy for decoder throughput.

### `spidermonkey/js1_5/Regress/regress-274888.abc`

73,484 bytes; 58 methods in all four.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 2,127 | 0.034 | 2144.8 | 0.166 | 61.9 |
| AwayFL | 2,144 | 0.061 | 1206.9 | 0.413 | 164.3 |
| Ruffle native | 2,144 | 0.027 | 2764.3 | 0.055 | 13.5 |
| Ruffle Wasm | 2,144 | 0.018 | 4049.4 | 0.051 | 15.3 |

AwayFL and both Ruffle builds include 17 instructions skipped as unreachable by swf2es.
This ABC is mostly string data; parse throughput is not a proxy for decoder throughput.

### `spidermonkey/js1_5/Regress/regress-311629.abc`

127,807 bytes; 58 methods in all four.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 2,096 | 0.038 | 3339.7 | 0.157 | 56.6 |
| AwayFL | 2,113 | 0.067 | 1918.5 | 0.402 | 158.9 |
| Ruffle native | 2,113 | 0.020 | 6272.9 | 0.055 | 16.4 |
| Ruffle Wasm | 2,113 | 0.020 | 6449.5 | 0.051 | 14.8 |

AwayFL and both Ruffle builds include 17 instructions skipped as unreachable by swf2es.
This ABC is mostly string data; parse throughput is not a proxy for decoder throughput.

### `ecma3/Statements/eregress_74474_002.abc`

97,665 bytes; 59 methods in all four.

| Tool | Instructions | Parse ms | Parse MB/s | Parse + decode ms | Estimated decode ns/instr |
|---|---:|---:|---:|---:|---:|
| swf2es | 38,113 | 0.032 | 3058.4 | 2.638 | 68.4 |
| AwayFL | 38,130 | 0.080 | 1217.6 | 386.519 | 10134.8 |
| Ruffle native | 38,130 | 0.019 | 5257.5 | 0.524 | 13.3 |
| Ruffle Wasm | 38,130 | 0.018 | 5440.1 | 0.492 | 12.4 |

AwayFL and both Ruffle builds include 17 instructions skipped as unreachable by swf2es.

AwayFL's 386.5 ms code-heavy result includes its analysis passes and must not
be interpreted as isolated opcode-reading cost.

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
cargo build --release --locked --lib --target wasm32-unknown-unknown -j 4 --manifest-path tests/bench/ruffle/Cargo.toml
SWF2ES_ORACLE_JOBS=4 pnpm --workspace-concurrency=1 test
SWF2ES_ORACLE_JOBS=4 pnpm tamarin as3/Vector/initializerLargeVector spidermonkey/js1_5/Regress/regress-280769 spidermonkey/js1_5/Regress/regress-274888 spidermonkey/js1_5/Regress/regress-311629 ecma3/Statements/eregress_74474_002
node tests/bench/compare.ts --ruffle-wasm \
  tests/conformance/out/abcdump.abc \
  tests/tamarin/out/as3/Vector/initializerLargeVector.abc \
  tests/tamarin/out/spidermonkey/js1_5/Regress/regress-280769.abc \
  tests/tamarin/out/spidermonkey/js1_5/Regress/regress-274888.abc \
  tests/tamarin/out/spidermonkey/js1_5/Regress/regress-311629.abc \
  tests/tamarin/out/ecma3/Statements/eregress_74474_002.abc > tests/bench/out/comparison.json
```

The measurements above used existing cached Tamarin ABCs, all measured in one
sequential invocation of the four-implementation harness.
The harness rejects parser/decoder errors, differing method counts, differing
AwayFL/Ruffle instruction counts, or swf2es counts larger than the linear readers.
It retains the reachable-versus-linear count difference instead of hiding it.

## Ruffle Wasm follow-up

On the same machine and tool versions, the optional `--ruffle-wasm` comparison
runs Ruffle's **same `swf` 0.3.0 reader function** as both native Rust and
`wasm32-unknown-unknown` in Node v24.13.1. Both builds use Cargo's default release
profile and the same lockfile. The Wasm build has no host imports; Node handles
file I/O and timing. Its input is allocated, copied and freed once per sample
batch, with that work included in timing. Native input is already resident.
Module compilation/instantiation is excluded, just as for swf2es.
No wasm-opt, LTO overrides, SIMD flags or browser-player code are involved.

swf2es is now rebased onto `dev` at `d5ffa36`: decoding includes structural
verification, but this harness does not invoke domain linking or typed
verification. This is more work than Ruffle's standalone opcode reader performs.
The main comparison tables above use this updated run.

Median **parse + decode ms** from the six-input follow-up:

| ABC | swf2es Wasm | AwayFL | Ruffle native | Ruffle Wasm |
|---|---:|---:|---:|---:|
| abcdump.abc | 0.502 | 2.070 | 0.172 | 0.186 |
| initializerLargeVector.abc | 61.806 | 257.292 | 14.961 | 13.473 |
| regress-280769.abc | 0.160 | 0.423 | 0.052 | 0.050 |
| regress-274888.abc | 0.166 | 0.413 | 0.055 | 0.051 |
| regress-311629.abc | 0.157 | 0.402 | 0.055 | 0.051 |
| eregress_74474_002.abc | 2.638 | 386.519 | 0.524 | 0.492 |

All native/Wasm Ruffle method and instruction counts match. The existing
reachable-versus-linear differences remain. Raw parse timings, throughput,
estimated incremental decode costs, samples and artifact hashes are preserved
in [comparison-wasm-results.json](../tests/bench/comparison-wasm-results.json).
This measures the reader crate in Node, not the full Ruffle web player. It does
not support applying a fixed Wasm slowdown multiplier to the native results.

A second invocation repeated the three main inputs. Large-vector Ruffle Wasm
was 13.501 ms versus 15.881 ms native (first run: 13.473 / 14.961 ms).
For abcdump, Wasm was 0.166 ms versus 0.180 ms native; for the code-heavy
regression it was 0.639 ms versus 0.554 ms. These small-input timings vary;
the large vector does not show the previously hypothesized ~25 ms Wasm cost.
[Repeat samples](../tests/bench/comparison-wasm-repeat.json) are preserved too.

With a matching Rust Wasm standard library and linker already available:

```sh
cargo build --release --locked -j 4 --manifest-path tests/bench/ruffle/Cargo.toml
cargo build --release --locked --lib --target wasm32-unknown-unknown -j 4 --manifest-path tests/bench/ruffle/Cargo.toml
node tests/bench/compare.ts --ruffle-wasm tests/conformance/out/abcdump.abc tests/tamarin/out/as3/Vector/initializerLargeVector.abc
```

For this run, the system Rust 1.92.0 compiler was retained. Its matching AlmaLinux
`rust-std-static-wasm32-unknown-unknown` 1.92.0-2.el10_2.alma.1 and LLVM linker
packages (`lld` / `lld-libs` 21.1.8-1.el10.alma.1) were signature-checked and
unpacked under `/tmp/swf2es-rust-wasm`, without installing system packages.
The Wasm build used these environment overrides:

```sh
LD_LIBRARY_PATH=/tmp/swf2es-rust-wasm/usr/lib64
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--sysroot=/tmp/swf2es-rust-wasm/usr -C linker=/tmp/swf2es-rust-wasm/usr/bin/wasm-ld'
```

Pass those variables to Cargo (or export them) when using the temporary sysroot.
They are unnecessary with a normally installed matching target and linker.
