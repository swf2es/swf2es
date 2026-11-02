# Native edge coverage experiment — not for merging

This is an isolated experiment, with no production renderer changes. It tests
whether a bounded Zig kernel can prepare edge coverage for opaque convex outlines,
using the renderer's existing vertex layout. The extra fragment operation applies
coverage after colour transforms and premultiplication. No dependency is added.

The kernel keeps 256 KiB of fixed scratch memory and copies accepted geometry into
owned typed arrays. Concave, translucent, very thin and malformed outlines are
refused. This is not a general stroke builder: joins, holes, interacting paints,
masks and non-uniform transforms need further work.

## Results

Recorded on main `370c4985`, on an RTX 4060 Laptop GPU through ANGLE/Vulkan.
The experiment branch starts at `abf753f7`; its render, native and Context3D
sources are identical to that main baseline. Synthetic input is 640 separate
opaque rectangles at 1600 × 1000 pixels, with no player or VM workload.

Five paired rounds alternate A/B frames after warming both contexts. CPU timing
excludes `gl.finish`; GPU timings use disjoint timer queries. Clock rates varied,
so the recorded paired ratios are more useful than unrelated absolute times.

| Case | Main CPU/frame | Coverage CPU/frame | Result |
| --- | ---: | ---: | --- |
| Cached outlines | ~0.07 ms | ~0.07 ms | No-MSAA coverage reduced GPU time about 26%, only ~0.02 ms here |
| Rotating cached outlines | ~0.07 ms | ~0.07 ms | No-MSAA coverage reduced GPU time about 35%, only ~0.03 ms here |
| Scaling, rebuilding coverage | ~0.055 ms | ~1.46 ms | CPU and allocation regression |

Coverage plus 4× MSAA was roughly tied with main's 8× GPU time. Geometry grows from
45 KiB to 175 KiB for these shapes. The scaling candidate rebuilds those 175 KiB
each frame; main retains its geometry. Sampled JS allocation over setup and 260
frames was 4.53 MB for main versus 127.79 MB for coverage while scaling. These
are allocation totals, including collected objects, not retained or peak memory.

The no-MSAA candidate has lower edge error against independent exact pixel-box
coverage on both shallow and steeper-angle fixtures. AIR high/best references
were also captured; this does not establish pixel equivalence to Flash. Other
Flash quality modes were not tested.

Per-run measurements and quality results are in `results/2026-11-02/`. They cover
the synthetic prototype, not the diagnostic adapter added afterward.

## Run

From a built checkout, using the repository's supported Node version:

```sh
node experiments/native-edge-aa/build.ts
pnpm exec tsc -p experiments/native-edge-aa/tsconfig.json
node --test experiments/native-edge-aa/outline.test.ts
node experiments/native-edge-aa/run.ts validate
node experiments/native-edge-aa/run.ts preview-check
node experiments/native-edge-aa/run.ts paired
node experiments/native-edge-aa/run.ts allocations
node experiments/native-edge-aa/reference.ts
node experiments/native-edge-aa/reference.ts diagonal
node experiments/native-edge-aa/run.ts capture
node experiments/native-edge-aa/run.ts capture diagonal
node experiments/native-edge-aa/quality.ts
node experiments/native-edge-aa/quality.ts diagonal
node experiments/native-edge-aa/report.ts
```

`build.ts` uses the repository's pinned Zig and runs the kernel's tests first.
The Flash reference commands need AIR's `adl` and compiler. Hardware Chrome is
used for captures and timings. Outputs default to the system temporary directory's
`swf2es-native-edge-aa`; set `SWF2ES_EDGE_AA_OUT` to change that location. Generated
Wasm and the browser entry page are ignored. Run GPU work without competing
workloads; the commands do not acquire a machine lock themselves.

## Optional diagnostic adapter

`CoveragePreview` wraps one backend for local integration experiments. Install
`enableCoverage(gl)` before constructing the backend and retain that shader hook
through context restoration. Create the adapter with a dedicated Wasm instance,
then set `enabled`. Set `highlight` to mark treated geometry in magenta.

The adapter accepts only small, single-colour manifold outlines under uniform
transforms, outside masks and layers. It refuses textures, alpha transforms,
non-normal blending and unsupported geometry. Preparation uses a per-frame budget,
and its cache has at most 128 entries. Only one scale variant per source is kept;
a second scale in the same frame falls back. Source updates invalidate the cache.
Disabling releases candidate geometry, restores the original draws and leaves
the normal renderer in use. Destroying the backend releases the adapter too.

The adapter deliberately does **not** change MSAA. Unhandled drawing still needs
the normal AA path. Turning MSAA off in a host may make the rest of the scene
jagged even while eligible outlines look smoother. Shared boundaries, overlapping
objects and real content are not validated by the synthetic benchmark.

## Next experiment

Keep boundary/extrusion data cached and compute its screen-space offset in the
vertex shader. Verify non-uniform scaling, thin paths, corners, overlaps and
colour transforms before proposing integration. The current CPU rebuild path
should not be enabled in the player by default.
