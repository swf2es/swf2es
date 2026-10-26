# @swf2es/native

Optional CPU kernels built with the repository's pinned Zig. The first entry,
`@swf2es/native/bitmap`, implements BitmapData convolution. This package depends
on no other package and uses no DOM or node APIs. Compression, MP3 and fill
tessellation keep their existing modules and ownership.

The web host opts in with `configure({ nativeBitmaps: true })`. The default
does not load this package. Each playback owns its convolution scratch and
releases it at teardown. AS3 and AVM1 BitmapData.applyFilter use the same hook;
GPU filters and other CPU filters are unchanged. Worker instances without a
hook keep using JS.

Direct hosts can create a `Convolver` and assign its `convolve` method to a
Scripting or Avm1 `bitmapConvolver`, then clear the hook and call `dispose()`
when that owner retires. The operation returns owned premultiplied ARGB
`Uint32Array` pixels or `null` for JS fallback. No source pixels are changed.
Results survive later calls, memory growth, rejection and disposal.

The wrapper copies the required input rectangle plus halo, including
coefficients, and copies the output before scratch is reused. Existing player
code handles clipping, destination writing and notifications. Strict double
arithmetic and Flash's fixed-point 3×3 quirks match the existing JS path.
Explicit f64x2 SIMD is preferred; compilation refusal falls back to scalar.
Both binaries import nothing. Missing Wasm/CSP refusal is tried once per
owner, traps discard the instance, and normal rejection can reuse its arena.

Wasm memory has a 128 MiB maximum. Instances above 8 MiB are dropped after a
call; `new Convolver({ retainMemory: bytes })` adjusts that threshold, and
`{ simd: false }` selects scalar. Arena reset reuses capacity; only dropping
the instance permits its memory to be collected.

Build with `pnpm --filter @swf2es/native build:wasm`, which first runs the
kernel's Zig tests on the host (`zig build test` in this folder): exact
pixels for small cases, and every allocation failing in turn. The kernel is
`src/convolve.zig`, taking any `std.mem.Allocator`; `src/bitmap.zig` wraps it
in the Wasm module's bump arena. The base64 binaries are committed; normal builds check the input digest, and CI rebuilds them with
the pinned compiler. No external dependency is needed.

`node --test tests/unit/native-bitmap.test.ts` checks exact pixels, ownership,
rejection and trap fallback. `node tests/web/run.ts` checks both VMs, default
opt-out, missing modules, blocked compilation, traps, CSP and teardown.

After `pnpm build`, run `node tests/player/bitmap-bench.ts [processes, 2]`
under the machine lock for synthetic full applyFilter timings in Chrome.
It includes input/output copying, destination writes and oversized-instance
recreation. The benchmark compares JS, scalar and SIMD with exact output
checks and nine balanced rounds per fresh browser process. It measures CPU
filter calls; whole-game performance depends on their share of the workload.
