# A CPU rasterizer for display objects

Status: draft, design only, for review. Read against `dev` at c97e4296
(the merge of #1012). Where this says "inferred", the code was not read
to confirm it.

## Why

`BitmapData.draw` of a display object goes through the host's renderer
(`packages/player/src/bitmap/draw.ts`, `drawObject`), which in the browser
is WebGL. `RenderView.drawInto` leaves the result in the store's texture
(`StoreCopy`, `packages/player/src/scene/paints.ts`), and the first CPU
read pays `BitmapStore.readable` → `WebGLBackend.readTexture`'s synchronous
`gl.readPixels` (`packages/render/src/webgl/backend.ts`, about line 652).

A SWF measured on 2026-11-15 draws a character into a new 546×693
bitmap every frame, scans it and reads it. With #1012, a frame costs
about 4.3 ms on an RTX 4060 and about 45 ms under SwiftShader, nearly
all of it the readback: SwiftShader rasterizing the draw. Turning off
vsync and the frame-rate limit changed nothing. Servers that run SWFs
like it under Xvfb have no GPU.

In node there is no renderer at all: AS3's `draw` throws "BitmapData#draw
of a display object without a renderer"
(`playerglobal/flash/display/BitmapData.ts:172`), and AVM1's draws nothing
(`avm1/globals/BitmapData.ts:351`).

## 1. Goal and non-goals

Goal: a `Drawer` that draws display objects into BitmapData on the CPU,
in wasm SIMD.

- To the pixel with the GPU path where that path matches Flash, and
  within the same tolerance where the GPU path is within one of Flash.
- Always in node and Deno. In the browser and the desktop, where there is
  no WebGL 2, or where the GPU's result would only be read back.

First: solid fills and lines, per-vertex colour, colour transforms, the
normal blend, and the 1, 2 and 4 sample grids. Then gradients and bitmap
fills, then masks and scroll rectangles, then blend layers and filters.

Later: advanced text's glyph program, `drawTriangles` meshes, and the CPU
backend drawing whole stage frames in node.

Never, or only when asked for:

- 3D planes (`PLANE`), Stage3D and video.
- Pixel Bender fills, filters and blends (`SHADED`, `KERNEL`): the CPU
  interpreter in `bitmap/pixel-bender.ts` could run them, slowly.
- Device text in node, which has no canvas to rasterize it
  (`scene/text-items.ts`, `scene/device-glyphs.ts`): counted as
  unsupported.

## 2. Where it plugs in

**A backend, not a new walk.** `RenderView` (`packages/player/src/scene/view.ts`)
walks the display list into a `SceneList`, `Rows`, `Geometries` and
`Textures`, measures, plans into `Commands` and calls one backend method;
`drawAlone` already splits "walk and plan" from "draw with n samples".
Masks, scroll rectangles, nine-slice, strokes, the hairline width,
`cacheAsBitmap` and filters are all decided in the walk or the planner. A
backend that executes the same 11 opcodes (`packages/render/src/commands.ts`:
CLEAR, RUN, STENCIL_PUSH/POP, LAYER_PUSH/POP, FILTER, COMPOSITE,
HOLD_PUSH/POP, HELD) gets all of that for nothing. A rasterizer starting
from shape records would have to do the walk, curve flattening, stroking
and nine-slice again, and parity would suffer.

Changes:

1. A `Backend` interface in `packages/render/src/backend.ts` for what
   `RenderView` calls of it (about 15 places): `execute`, `snapshot`,
   `drawIntoTexture`, `readTexture`, `fillTexture`, `copyTexture`,
   `uploadOutlines`, `drawPlane`, `restore`, `destroy`, `samples`, a texture
   limit and a lost flag.
2. Making the canvas and the WebGL context moves out of the `RenderView`
   constructor into a factory; a view made with a `CpuBackend` has no
   canvas.
3. `CpuBackend` in `packages/render/src/cpu/`, published as
   `@swf2es/render/cpu`. It loads no DOM types, as the core does, executes
   `Commands`, and takes its raster kernels through a structural interface,
   so `render` still depends on `context3d` alone
   (`tests/unit/boundaries.test.ts`).
4. The kernels in `@swf2es/native/render`: a new `raster.zig` (triangle
   spans, sampling, compositing) and a `raster.ts` wrapper beside
   `bitmap-kernel.ts`, in an instance of the module of its own, as every
   user of the module has.
5. `@swf2es/player` exports `cpuDrawer()`. A node or Deno embedder sets
   `scripting.drawer` and `player.avm1.drawer` to it, as
   `packages/web/src/playback.ts:81` does with the WebGL view.

**The Drawer's methods on the CPU.** `snapshot` returns premultiplied ARGB
directly, with no RGBA swap. `drawInto` copies the destination block into
wasm, draws over it and copies it back, as draw.zig does, writing the
store through its usual write path so that `version` and the solid-colour
state stay right (inferred). In node nothing is ever newer on a GPU.

**When the browser or desktop uses it.** Without WebGL 2, always. With
it, per draw, after the walk and plan and before `draw(n)`: the scene list
then shows the features the draw uses, and a draw needing one the CPU
backend lacks goes to the GPU. The choice is by the drawn `DisplayObject`
(a WeakMap), with a drawer-wide prior for objects not seen before:

- **R (read back):** `StoreCopy.read` pulls back a texture a GPU `drawInto`
  wrote, before the store was drawn again or shown. `BitmapStore.drawnOnGpu`
  records the source key so that `read` can report it.
- **U (upload):** `Paints.storeTexture` uploads a store whose newest version
  came from a CPU draw, with no CPU read between.
- GPU to CPU after 2 R in a row for the key. A key not seen before starts
  on the CPU when at least 12 of the drawer's last 16 GPU draws were read
  back: the measured SWF draws into a new store every frame, so a rule by
  store would never fire.
- CPU to GPU after 8 U in a row, or when a draw's cost (area × samples²)
  is over a budget, or when it uses an unsupported feature. The uneven
  thresholds are the hysteresis.
- A draw into a store newer on the GPU stays on the GPU unless its key is
  already in CPU mode.

**Coherence.** A CPU draw writes the store's CPU pixels and bumps
`version`; the texture is uploaded again when next shown, which is
asynchronous and far cheaper than `readPixels`. A GPU draw goes through
`drawnOnGpu` and `StoreCopy` as now. A CPU draw whose scene samples a store
newer on the GPU pays one readback through `readable`, which the heuristic
counts as an R. One gap: `Textures` lets a texture's bytes go once the GPU
has them (`packages/render/src/textures.ts`), so a CPU backend sharing the
registry may find no pixels. Proposal: `Paints` can make a texture's pixels
again from their source (a store's `readable`, a gradient's ramp or
`radialPixels`, a text's raster), which context-loss recovery needs in
effect anyway; the CPU backend keeps its own copies by id, generation and
version.

## 3. The rasterizer

**Input: the renderer's geometries.** Each `GeometryData`
(`packages/render/src/geometry.ts`) holds positions in stage pixels through
the draw's row, each vertex's straight RGBA colour, and optional texels and
indices. Gradients are textures already: a 256-colour ramp, or a radial
gradient computed over its region (`paints.ts`, `gradientTexture`). A bitmap
fill is texels and a sampler (`SMOOTH`, `CLAMP`/`REPEAT`/`MIRROR`). Lines
come from `strokes.zig` with Flash's widths, caps, joins, scale modes and
one-pixel hairline floor; a translucent line comes as a non-zero outline,
so nothing overlaps. Analytic area coverage would be wrong here: Flash and
the GPU path both count samples.

**Coverage.** Samples at (i + 0.5)/n of a pixel, n = 1, 2 or 4 for LOW,
MEDIUM and HIGH/BEST: draw.zig's offsets and the GPU's n-times target.
Vertices transformed in f32 as `fillVertex` does, `SNAP` rounding to quarter
pixels ties-to-even, positions snapped to 1/256 of a sample. Integer edge
functions with a top-left rule decide each sample exactly, so triangles
that share an edge cover each sample once: no seams, no double coverage.
GPUs snap to 8 sub-pixel bits (inferred): SwiftShader likely matches
exactly, other GPUs may differ by an edge sample. The resolve is
`drawSampled`'s: halved twice, each 2×2 average rounded to 8 bits, not one
division by 16 (see question 1).

**Bands.** The command buffer runs one band of pixel rows at a time: 4·h
sample rows, at most about 256 KiB of samples, so clearing, filling,
stencilling and resolving stay in cache. Triangles are binned into the
bands their y-range touches once per draw, in draw order. The resolve
writes the band's pixels straight into the output block. `arena.zig`'s
128 MiB ceiling rules out a whole 16-sample buffer for a large bitmap
anyway.

**Shading,** after `fillFragment`. A triangle with three equal colours and
no texture is a constant span, transformed and premultiplied once (f32,
clamped, `round(c·255)`). Otherwise colour and texel are interpolated along
the span. Textures read nearest or bilinear with 8-bit fractional weights
as GPUs filter (inferred), under clamp, repeat or mirror.

**Compositing.** Premultiplied source-over, `s + d·(255−sa)/255`, rounded as
GL's blend unit rounds (inferred; it may vary by GPU). Bitmap stores use
Flash's floored `over`, as `compositeOver` and draw.zig do.

**Masks and scroll rectangles.** A stencil byte per sample in the band,
counted as the GL backend counts `masks.depth`. A scroll rectangle is a
mask of the unit quad (`scene/masks.ts`).

**Layers.** LAYER_PUSH/POP composite in the blend mode with the formulas of
`compositeFragment` and `BLEND_FRONT` in `programs.ts`, and `ALPHA_MASK`.

**Filters.** A filtered layer is drawn whole into its rectangle ahead of
the bands, as held layers are drawn ahead of the stage, and its chain runs
through the existing kernels: `blur.zig` for blur, glow, shadow and bevel,
`convolve.zig`, `pixels.zig` for the colour matrix, and the displacement
map in JS. Those are adl's applyFilter arithmetic, not the GPU's
`FilterPlan` passes (question 2). The layer is then sampled as a texture by
the band pass. In a draw filters run at n units a pixel (`filterUnits`), so
a filtered draw costs n² more. Kept outputs never occur in a draw
(`!this.drawRoot`), so the CPU needs none of the GPU's.

**Text.** Advanced text: a CPU port of `glyphsFragment`, coverage by the
distance to the glyph's segments, per sample. Device text in the browser is
a texture already; in node it is not drawn.

## 4. Performance

- One draw is one wasm call. In slice 1 the geometries are copied in for
  each draw; later the instance keeps geometries by id and generation, and
  textures by version, beside the per-call arena: an atlas on the CPU.
- Kernels written for 4-lane SIMD: constant spans as 128-bit stores of four
  pixels, source-over four pixels at a time, a resolve reading 4×4 samples
  into one pixel.
- Later: a "uniform pixel" flag per band pixel, so a pixel whose samples
  are all equal (interiors, empty space) costs one write, not 16.
- No threads: SharedArrayBuffer needs cross-origin isolation, and node needs
  none for a first version.
- Estimate for the measured case (not measured): about 6M samples at 4×4 at
  most, as the draw covers only the object's bounds. Dense bands in cache:
  3 to 8 ms; with uniform pixels, 1 to 3 ms; against 45 ms under
  SwiftShader. The scan and read after the draw stay as they are.
- Measured by `tests/player/bench.ts --readback N` under SwiftShader and
  with `--gpu`, a new `--drawer cpu|gpu|auto` to force the drawer, and a
  node mode of the same SWF with `cpuDrawer()`, timing the draw alone;
  recorded in docs/benchmarks.md.

## 5. Correctness

1. **Kernel tests:** Zig tests in `raster.zig` (run by
   `pnpm --filter @swf2es/native build:wasm`) and
   `tests/unit/render/cpu-*.test.ts`: the top-left rule, sample positions,
   quarter-pixel snapping, the halving's rounding, the colour transform's
   clamp, source-over and each blend formula.
2. **Both drawers on the same cases:** a test-page flag `?drawer=cpu` plays
   the `tests/player` cases with the CPU drawer in Chrome, and a checking
   drawer runs both on every draw and compares the pixels by
   `tests/player/image.ts`'s rule. Starting tolerances: 0 on SwiftShader for
   solid fills, at most 1 per channel at edges, 2 for bilinear texels, and
   "within 2" for blends, as compositing.md already allows.
   `tests/bench/bitmap-draws.ts` is the pattern: random draws, every pixel
   compared.
3. **Flash's references:** many draw cases check pixels by trace
   (`draw-objects`, `draw-bitmaps`, the filters' `*-draw` cases), so they
   can run in node with `cpuDrawer()`. A later slice draws stage frames
   through `CpuBackend.execute` into a buffer, so the PNG references under
   `tests/player/references` can be compared in node too.
4. **Fuzzing:** a new `tests/fuzz/raster.ts` after `tests/fuzz/tessellate.ts`:
   random triangles, slivers, shared edges, huge and non-finite positions,
   against an independent point-in-triangle reference in TypeScript. Each
   sample is covered by exactly one of any triangles that tile a region;
   malformed params are refused and never trap.
5. **Checked build:** under `SWF2ES_CHECKED`, every draw the browser's
   choice sends to the CPU is drawn on the GPU as well, and a difference
   past the tolerance throws, as the player's other shortcuts are proved
   (docs/architecture/testing.md), with mutation checks: an R event dropped
   on purpose must fail a test.

## 6. Phasing (rough, one engineer)

0. **Backend interface** (3 to 5 days): `Backend` extracted, a canvas-less
   `RenderView`, no change in behaviour; `draw-counts.ts` and the player
   cases stay as they are.
1. **Node drawer, solid** (2 to 3 weeks): `CpuBackend` with RUN and CLEAR,
   per-vertex colour, rows' colour transforms, the normal blend, `SNAP`, the
   1, 2 and 4 grids, the halving, `snapshot` and `drawInto`, and
   `cpuDrawer()`. Node stops throwing and solid art draws; the trace cases
   run in node.
2. **Paint** (1 to 2 weeks): textures in the instance, nearest and bilinear,
   clamp, repeat and mirror: linear and radial gradients (focal, spread and
   linearRGB come in the texture) and bitmap fills, smoothing included.
3. **Clips** (1 week): stencil masks and scroll rectangles; nine-slice comes
   from the walk and needs only tests.
4. **Layers and filters** (3 to 4 weeks): blend layers and their formulas,
   `ALPHA_MASK`, filtered layers through the native kernels, HOLD and HELD,
   then advanced text's glyphs.
5. **The browser's choice, and speed** (2 weeks): the R/U heuristic, the
   `Paints` pixel source, the checked comparison, `bench.ts --drawer`, the
   persistent geometry and texture cache, uniform pixels.
6. **Optional:** stage frames in node (`execute` into a buffer) for server
   thumbnails and Chrome-free player tests; meshes (`MESH`) in perspective.

## 7. Risks and open questions

1. **Parity target.** The GPU averages 4×4 samples in two rounded halvings,
   draw.zig's Flash rule scales by coverage/16 once; they differ by about 1
   at edges. Match the GPU first (one oracle, simpler differential tests)
   and change both paths together when a reference says so, or match Flash?
2. **Filters.** adl's applyFilter kernels (probably closer to Flash, already
   written) or `filter-plan.ts`'s passes, `blurShrink` included (parity with
   the GPU, more work)?
3. **Package boundary.** A new `@swf2es/render/cpu` that takes the kernels by
   interface, or let `render` depend on `native`, which changes the
   boundaries table and docs/architecture/overview.md?
4. **Textures shared in one view.** The `Paints` pixel source, or separate
   registries (and a second set of tessellations) for the CPU backend?
5. **Device text in node.** Not drawn, or a host hook for glyph rasters? No
   new dependency without asking.
6. **Memory.** A filtered draw's layers at n² size and the 128 MiB ceiling:
   past a budget, halve n as `drawAlone` does for the texture limit, or
   refuse?
7. **GPU rounding.** Blend and filtering precision vary by GPU, so
   tolerances set on SwiftShader may not hold on every GPU; CI has only
   SwiftShader.
8. **Main thread.** A large CPU draw blocks as long as `readPixels` would,
   but now even without a read; the heuristic's size budget is the guard.
   What should it be?
9. **Heuristic thresholds** (2, 12 of 16, 8) are guesses until
   `bench.ts --drawer auto` and real SWFs show their effect.
