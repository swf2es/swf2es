# Standalone native tessellation experiment

This is an experimental harness, outside the player and normal build. It uses
libtess2 at `8dbd6483e920311a58c9af10a10beb278efebc36` through the repository's
pinned Zig compiler. It introduces no package dependency, vendored source,
checked-in binary, renderer hook or worker protocol.

Build into a dedicated directory outside the checkout:

```sh
node tools/native-tessellation/build.ts /path/to/artifacts
node tools/native-tessellation/check.ts /path/to/artifacts
flock ~/.cache/swf2es/machine.lock node --expose-gc tools/native-tessellation/probe.ts /path/to/artifacts
```

The builder fetches the pinned upstream sources, keeps their notices, and writes
float and double Wasm variants, SHA-256 hashes, raw/gzip sizes and
`LICENSE.libtess2.txt`. Distribute that SGI Free Software License B notice with
any binary. The C API is compiled directly with Zig's C compiler; there are no
Zig-to-C bindings that would need `addTranslateC`.

`check.ts` tests both winding rules against independent ray crossings on 2,000
random contour sets per variant, validates output indices and coordinates,
rejects malformed input, checks output ownership across arena resets, and forces
an allocation failure followed by a successful request. A precision regression
asserts that a thin fill at a large origin survives in double and collapses in
float. Float is a comparison variant; reducing production precision remains undecided.

`probe.ts` accepts an optional JSON array of `{ contours: number[][], nonzero:
boolean }`, with contours already flattened by the existing JS curve code. It
compares only fills for which the optimized JS crossing kernel returns bands.
JS bands are fan-triangulated into owned Float64 positions and Uint32 indices;
libtess2 returns owned indexed triangles. Containment/earcut costs are excluded.
The default input is synthetic. Keep private input and reports outside git.

Each request passes an entire fill, copies its input into Wasm, tessellates it,
and copies finished positions and indices into JS-owned typed arrays. Keep a
result per paint in original fill order; indices are local to that result.
Nothing cached points into Wasm scratch. Reported times separate packing
(including validation/instantiation), native work and ownership copies.
Flattening, paint/UV generation, renderer packing/upload and frame execution are
outside this standalone comparison.

## Precision and lifetime policy

The double variant explicitly changes `TESSreal` from `float` to `double` and
changes its normalization square root accordingly. Both variants retain
upstream's inclusive coordinate limit of ±2²³. There is no normalization or
silent coordinate clamping. The wrapper rejects nonfinite coordinates, odd or
short contours, more than one million input vertices, and more than 100,000
contours. The arena has a 128 MiB address limit; instances above 8 MiB capacity
are discarded after ownership copies. Resetting an arena does not shrink it.
Allocator byte counts exclude alignment/header overhead; arena high water and
Wasm capacity are reported separately. Capacity already included in a browser's
backing-storage sample must not be counted again.

libtess2's allocation failures can call `longjmp`. This prototype substitutes a
host exception for that path and **discards the instance**, retaining only the
compiled module. It does not implement Wasm setjmp or resume an unwound C stack.
Bad JS input is rejected before entering Wasm; a native failure gets a fresh
instance on the next request. This is a prototype failure boundary, not a
production-ready no-import native library. The exported C entrypoints assume
pointers allocated by this wrapper and are not an untrusted raw-pointer API.

## Initial findings

Baseline: `8165a957ee6fb843d587123fda69b239d09af230`, containing the optimized
JS sorting in #566. Matched browser runs used the same 54 anonymous dense
crossing fills, identical flattened double input, owned output retained for
caching, software WebGL, and the machine lock. Times below are unprofiled;
allocation/GC profiling was a separate run.

| Alternating pair | JS construction | Double construction | JS sampled peak | Double sampled peak |
| --- | ---: | ---: | ---: | ---: |
| 0 | 1614 ms | 605 ms | 119.3 MiB | 39.7 MiB |
| 1 | 1596 ms | 595 ms | 115.6 MiB | 40.1 MiB |
| 2 | 1596 ms | 512 ms | 113.8 MiB | 40.1 MiB |

Peak samples sum CDP JS heap and backing storage between fills; they are lower
bounds, not continuous in-fill maxima. Native capacity is already included.
Finished geometry occupies 54.1 MiB for JS bands versus 18.0 MiB for double
triangles. Maximum native scratch is 16.5 MiB, with 16.8 MiB Wasm capacity. The
ownership copy takes 7.8–8.7 ms in total; packing takes 16.8–18.4 ms. Separate
profiling estimates 269.7 → 35.8 MB cumulative sampled JS allocation and
22.0 → 11.1 ms GC time. Native internal arena allocation is a separate metric.

The refreshed full controlled scene takes 1371–1391 ms on the JS baseline;
its next cached draw takes 0.5–0.9 ms. This is not a replay of a gameplay entry
window, nor a measurement of steady-state script execution. A profiled scene
attributes about 950 ms inclusively to the crossing kernel, with profiling
adding overhead. These numbers do not establish the whole-game entry target.

Both variants completed the dense and morph inputs. Independent randomized
coverage checks passed. Canvas2D comparisons on 117 real/morph fills and ten
synthetic fixtures found no fully-covered/fully-empty pixel reversals, but did
find edge alpha differences up to 100/255. A locally rebased precision fixture
also exposes the float loss. Canvas2D is not Flash, and these comparisons do not
establish renderer pixel parity. Resolve edge behavior against AIR before
accepting a renderer change. Different triangle counts/orders are expected.

The standalone time, output size and sampled memory results justify further
work on the double variant. Production adoption remains gated on resolved
Flash pixels, an actual entry-window comparison including all surrounding
costs, failure-path review, and the required renderer/corpus/lifetime checks.
This draft intentionally leaves those integration gates open.

## Other candidates tested

The additional candidates were evaluated outside the checkout, with no new
package dependencies. These results guide the next experiment; their adapters
are not production integrations.

| Candidate | Matched construction time, three runs | Compatibility finding |
| --- | ---: | --- |
| Optimized JS bands + owned triangle fan | 1560–1598 ms | Existing crossing/winding kernel |
| JS bands + earstrip 0.2.0 direct batch, owned triangle list | 1596–1692 ms | Retains the expensive JS crossing pass |
| libtess2 double | 513–530 ms | Explicit full-precision candidate |
| lyon_tessellation 1.0.23 | 620–626 ms | Handles both rules and crossings; f32 geometry |

Earstrip's direct batch operated on the same resolved convex bands as the JS
fan, with coordinates packed once per fill and owned positions/indices copied
out. It did not produce a repeatable time or sampled-memory benefit in this
workload. This does not measure replacing Pixi's earcut alone on an ordinary
polygon workload; it measures the construction path relevant to crossing fills.

[earstrip](https://github.com/GLMap/earstrip), pinned through npm 0.2.0 with its
registry integrity checked, is 68,088 bytes raw / 27,301 gzip in the published
Wasm. Its outer-ring/holes model does not expose the global even-odd/non-zero
choice needed here. In synthetic independent winding tests, equally oriented
nested rings incorrectly cut a hole for non-zero, a twice-wound contour remains
filled for even-odd, and two disjoint outer rings lose an island when passed as
one polygon. Its direct strips API correctly handles the bowtie fixture using
generated vertices, while the input-only triangle convenience API reports an
approximate result with wrong coverage. Preprocessing and checking status would
still be needed. No renderer change or dependency was added for it.

[earcut.zig](https://github.com/tenyoru/earcut.zig), commit
`8d45844c3de8bbd3d8b332a517330459d73d0221`, builds with the pinned Zig and uses
f64 coordinates. Like earcut, it triangulates an already resolved outer ring
and holes; it cannot replace winding/intersection processing by itself. In the
nested-ring fixture it cuts a hole even when the non-zero result is solid.

[Lyon's fill tessellator](https://docs.rs/lyon_tessellation/1.0.23/lyon_tessellation/struct.FillTessellator.html)
is a closer substitute for the full crossing kernel. The standalone Rust 1.92.0
build is 111,480 bytes raw / 44,351 gzip, with no Wasm imports. It passed 2,000
random contour cases and 24,000 independent winding samples. Its input/output
positions are f32, so its smaller output size (12.9 MiB here versus double's
18.0 MiB) is not a precision-equivalent memory comparison. It is a useful
alternative to retain for subsequent correctness work.

An AIR probe of a 0.125-pixel rectangle quantified an additional caveat: Flash
quantizes its local width to 0.1, and the large-origin transformed capture does
not preserve the expected coverage. Thus the large-origin exact-area fixture
is evidence of mathematical precision loss, not proof of a Flash pixel
regression. Neither Canvas nor raw area is an adequate oracle for that case.

A separate literal drop-in comparison on 645,042 already resolved band polygons
measured earcut.js 3.2.4 at 65/81/92 ms and earstrip's convenience call at
78/85/79 ms in three alternating pairs. Neither library's returned per-polygon
array was retained. This isolates triangulation calls, excludes the crossing
pass and renderer construction, and does not show a consistent improvement.
Triangle counts differ slightly, so this is not evidence of pixel parity.

Both double libtess2 and lyon also passed 14,976 independent point-coverage
checks on all 117 real/morph fills, testing both winding rules. These samples
supplement, rather than replace, pixel comparisons. Fresh-process Node tests
put each candidate's Wasm compile plus instantiation below 1 ms in this setup;
that excludes package decoding/glue and does not charge lazily compiled code
until its first execution. Separate-directory builds of both libtess2 variants
produced identical Wasm bytes; stripped raw/gzip sizes are 27,251/10,639 bytes
for float and 27,932/10,757 for double.
