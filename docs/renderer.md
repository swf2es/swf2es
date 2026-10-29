# The renderer

The player draws with a renderer of swf2es's own, which only draws what
Flash draws: TypeScript for the GPU calls, data-oriented, in typed
arrays, with WebAssembly for the kernels that pay for it. Crossing from
wasm to WebGL costs a call per command, so the commands stay in
JavaScript. It is `@swf2es/render` (`packages/render`) and the view
that drives it, `RenderView` (`packages/player/src/scene/view.ts` and
the modules beside it).

## Layers

```
display list (player)        display objects, timeline, AS3
   │  walk (RenderView)
   ▼
scene list                   the frame's drawing, in order, in typed arrays
   │  plan
   ▼
command buffer   ◄──────     resources: geometry atlas, textures, render
   │  execute                targets, kept outputs, glyphs, context loss
   ▼
backend                      WebGL 2 on context3d's device layer
```

Each layer can be tested alone. Only the backend calls the GPU.

### The view

`RenderView` walks the display list each frame and writes the scene
list. The walk is in `view.ts`, the per-object hot path; what it asks
of each kind of object is in modules of its own under
`packages/player/src/scene/`:

- `parts.ts`: a shape layer's fills and lines as the renderer's
  geometries, shared by every instance that draws the layer, and let go
  of once undrawn (`partsOf`, `dropUndrawn`);
- `fills.ts` and `strokes.ts`: fills tessellated, and lines built, by
  `@swf2es/native/render`, a layer in one call; `lines.ts` keeps a
  layer's lines by the stretch they were built for;
- `shapes.ts`: a shape layer's fills and meshes as geometries, its
  bitmap fills merged where they sample alike;
- `stale-shapes.ts`: a Shape's stale bitmap cache, which Flash shows for
  a Shape given another of the same bounds while cached;
- `paints.ts`: bitmap and gradient textures (`storeTexture`,
  `gradientTexture`);
- `text.ts`, `text-items.ts`, `advanced.ts`: device text's textures,
  and advanced text's glyph quads;
- `masks.ts`: masks and scroll rectangles;
- `filters.ts`, `filter-layers.ts`: each filter's values, padding and
  insets, and kept outputs;
- `planes.ts`: 3D objects' passes and quads;
- `pointer.ts`, `context-menu.ts`: the canvas's input.

What the view works out from Flash's shapes, lines, bitmaps and text is
in [architecture.md](architecture.md#rendering); this document is about
what happens after.

A drawing redrawn every frame, as a software 3D engine draws its
triangles, is the view's hardest case, and three things keep it cheap.
A drawing's new version releases the parts of the layers its last
version drew and this one no longer does, rather than waiting out their
idle frames: in one such SWF, live geometries went from about 413,000 to
1,430, and its heap after a full collection from 315 MB to 61 MB (#656).
`beginFill` after a layer of fills alone carries on in that layer, up to
256 fills (`display/drawing.ts`, `SHARED_FILLS`), so 1,400 triangles a
frame make one layer, not 1,400, and adjacent fills of the same bitmap,
smoothing and repeat make one geometry. And the native module fills a
single convex contour as a fan, without libtess2's sweep. Together they
took that SWF's frame from 4.9 to about 2.5 ms (#658), and cutting the
garbage its calls make to 1.8 ms (#659).

### The scene list

The scene list (`scene.ts`) is a structure of typed arrays in drawing
order, an entry a drawable or a boundary:

- **Draw:** what is drawn (a geometry, a texture, a glyph run, a 3D
  object's plane), its row, its blend mode, and flags (smoothing, pixel
  snapping, hairline strokes). Textured fills are geometries too, their
  texels in the vertices.
- **Rows:** a row is an object's concatenated transform and colour
  transform (`rows.ts`: the linear part, the translation, the colour
  transform's multipliers and offsets), four texels of a float texture
  uploaded once a frame.
- **Boundaries:** push and pop of a filter layer, a blend layer, a mask
  (its drawing between push and use), a scroll rectangle's clip, and a
  kept layer (`cacheAsBitmap`, or a filter's output kept while its object
  stands still). Each push names its filter records and its bounds.

The view writes the list and its rows anew each frame. Keeping a span of
the list for a subtree that did not change, and writing only rows on a
frame where only transforms or colours changed, is not built; it waits
for a profile that shows the walk worth it.

### The planner

The planner (`plan.ts`) turns the scene list into a command buffer. It
is pure: no GPU, no DOM, no clock. Given a scene list, it always plans
the same commands, which makes it unit tested as data: this list, these
commands (`tests/unit/render`). It decides:

- **Runs.** Consecutive draws under one blend mode are one run, which the
  backend draws as one multi-draw where it can.
- **Layers.** Which filter and blend layers to draw, at what size,
  resolution and padding (`filters.ts`' `blurShrink`, kept outputs), and
  where a blend needs a copy of the backdrop or the GPU's blending
  matches Flash. A layer's size is what its draws cover, their
  geometries' boxes placed by their rows and cut by the masks among them
  (`measure.ts`), not the bounds Flash reports: those differ wherever
  drawing does (scroll offsets, non-scaling strokes, 3D), and a layer
  cut to them clips.
- **Held layers.** A filtered layer of draws, masks and held layers
  alone, not kept, is held (`findHolds`): drawn before the stage with
  every other such of its level (`HOLD_PUSH`), after the levels it holds,
  and composited where it stood (`HELD`). Its filters' passes are
  planned ahead as data (`filter-plan.ts`): each pass's program, the
  slots it reads and draws into, their frames and its uniforms.
- **Masks and clips.** Stencil push, mask drawing and pop.

The command buffer (`commands.ts`) is an `Int32Array` of operations
(clear, run, stencil push and pop, layer push and pop, filter, composite,
hold push and pop, held) with a `Float32Array` of their parameters.
Because passes are explicit, a WebGPU backend could map the buffer onto
render passes, rather than translating GL calls. Planning a frame
allocates nothing.

### Resources

Everything a frame names is held by id in a registry (`registry.ts`),
whose reused ids are new generations an old handle does not name, and
whose entries go once unused for their idle frames:

- **Geometries** (`geometry.ts`): fills and lines as the native module
  writes them, copied once into the atlas's vertex and index buffers
  (`webgl/atlas.ts`), a hole left where one goes and the atlas packed
  again once the holes outweigh what is live. An atlas that outgrows its
  largest buffer starts again with only what is live, rather than
  failing.
- **Textures** (`textures.ts`): bitmaps, device text, gradients, their
  pixels uploaded and then let go of on the CPU
  (`webgl/gpu-textures.ts`).
- **Kept outputs** (`keeps.ts`): the layers kept from one frame to the
  next, as Flash keeps a filtered object's bitmap while nothing in it
  changed.
- **Render targets:** pooled by size and samples within a budget, the
  least lately freed let go of first past it (`webgl/pool.ts`,
  `webgl/targets.ts`), for layers, held layers' pages (`shelves.ts`) and
  `BitmapData.draw`.
- **Glyphs:** advanced text's glyph quads, in an atlas of their own, and
  Saffron's outlines in a texture.

After a lost context everything is made again from what the player
keeps, as it is for Stage3D.

### The backend

The backend (`@swf2es/render/webgl`) executes a command buffer, and is
the only code that calls WebGL. `webgl/backend.ts` runs a frame's
commands through parts of a file each, which it owns and makes again
with the context:

- **Programs** (`programs.ts`): the fill program (fills, bitmaps and
  colour transforms, by row), drawTriangles' meshes (textured in
  perspective, their bitmap read as adl reads it), the glyph program, the
  filter passes, the blend formulas, the 3D plane. A closed set, compiled
  once a context.
- **Runs** (`draws.ts`): consecutive fills are one multi-draw of the
  atlas's index ranges (`WEBGL_multi_draw`, up to 256 draws a call) for
  as long as their textures fit the fill program's eight units, each draw
  reading its row, its texture's unit and whether it snaps by
  `gl_DrawID` from a uniform array; without the extension, a call a draw.
- **Held layers** (`holds.ts`): each level's held layers drawn side by
  side on pages, then their filters' passes in waves, the k-th of every
  chain at once, each wave's targets on pages of their own (`filters.ts`
  runs a pass). A pass reads a target within its rectangle as a texture
  of its own size.
- **Composites** of layers in their blend modes (`composite.ts`), and
  the stage's way onto the canvas (`stage.ts`).
- **One state cache.** The backend sets GL state through context3d's
  device layer (`@swf2es/context3d/device`'s `GlState`), so no bind,
  blend or stencil state is set twice.

**Anti-aliasing** is the GPU's multisampling
([architecture.md](architecture.md#showing-a-player)): the host sets the
samples by the stage's quality, and the stage is drawn into multisampled
buffers the canvas's size, resolved into a texture and then onto the
canvas, as a resolve must keep its format, which the canvas's need not
be: an opaque canvas has no alpha, and SwiftShader refuses a resolve
onto one with it. Without multisampling, a frame in which an erase or
alpha blend clears the stage itself, as adl clears it, is drawn into a
layer the canvas's size and copied onto the canvas, so that the blends
after it read that alpha. A blend or filter layer draws into
multisampled buffers of its own, resolved into its texture before a
filter or its composite reads it, its rectangle alone or, filtered, all
of it. A blend's backdrop is copied to where it lies, as a blit out of a
multisampled target must keep its rectangle. Filter passes draw
single-sampled, and BitmapData's draws supersample, as Flash's do.

**One context, one owner of its state.** The device layer is shared with
Context3D, whose own draw path stays Stage3D's: it validates and rebinds
as Stage3D requires, which a 2D draw must not pay for. Stage3D's
surfaces draw on canvases of their own below the stage's for now; once
they share the stage's context, the single state cache is what lets them
compose with the display list without copies.

## Alongside

- **Filters and blend modes** are the passes the planner emits: blur,
  glow, shadow, bevel, gradient glow and bevel, colour matrix,
  convolution and displacement map, drawn to match adl. Their shaders
  and rules are `filter-shaders.ts` and `filters.ts`. A filtered layer is
  measured as PixiJS's filter system measured it (`measure.ts`), since
  the filters' exactness rules were found against that.
- **Text** stays laid out by the player. The renderer sees glyph runs:
  Saffron's quads, or a device text texture.
- **`BitmapData.draw`** plans a scene list into a render target with the
  same planner and backend, so it draws as the stage does.
- **Hit testing and bounds** are the player's own maths, never the
  renderer's.
- **WebAssembly** (`@swf2es/native/render`, [its
  README](../packages/native/README.md)): one module, in Zig, which each
  user instantiates apart. Its `Tessellator` fills with libtess2 in
  double precision, a layer in one call, a single convex contour as a
  fan, and whatever libtess2 refuses or fails at by bands (`bands.zig`):
  each horizontal band between vertices and crossings filled as disjoint
  trapezoids under its winding rule. Its `LineBuilder` builds a layer's
  lines in one call (`strokes.zig`): triangles along the path for a line
  at whole alpha, an outline filled non-zero for any other. Its
  `BitmapKernel` is BitmapData's convolution, blur family and pixel
  operations on the CPU. The module is required, built with SIMD
  throughout and with no scalar build: there is no JavaScript path for
  fills, lines or those kernels, so an engine without Wasm or SIMD, or a
  page whose policy lacks `'wasm-unsafe-eval'`, plays nothing, and the
  element says why. The GPU calls stay in JavaScript.

## Package

`@swf2es/render` depends on `context3d` alone and knows nothing about
AS3, timelines or display objects, as codegen knows nothing about the
runtime. The player depends on it and feeds it scene lists. Like
context3d, its core (scene list, registries, planner, command buffer)
loads no DOM types, and its WebGL backend is a sub-path
(`@swf2es/render/webgl`); `tests/unit/boundaries.test.ts` and
[architecture.md](architecture.md#packages) hold it to that.

## Measuring

Each change is judged by frame time, not by counts:

- median and p95 frame time;
- the walk, planning and submission time on the page;
- the GPU process's time and the GPU's own time;
- upload bytes and memory.

GPU time is measured with the GPU saturated, frames drawn as fast as it
goes, in clock cycles a render: an integrated GPU lowers its clock when
it has less to do, so at a scene's own frame rate its timer hides most
changes. Fewer commands save the GPU process's time, not the GPU's; both
are reported.

The acceptance test is a replay of a busy room, a mostly static scene
recorded from real content: it takes minutes and a private recording,
so it is run by hand. Its measured mix is about 4,650 Graphics a frame,
most of them still; bitmap and gradient fills; some 240 filters, most
with kept outputs; 100 blend layers; and a few masks.

For each pull request, `tests/player/bench.ts` builds a synthetic scene
and times it; `--town N` draws N hairline-outlined characters and
scenery instead, some of them glowing, which is nearer a room's lines and
filters but has none of its bitmap or gradient fills, blend layers or
masks. A synthetic scene built to the replay's whole mix is still to
come. `--gpu` draws on the GPU rather than software GL. A change is measured
on a GPU and on SwiftShader, which CI draws with and a player without a
usable GPU falls back to. `tests/player/draw-counts.ts` keeps GL calls,
sub-draws, binds and uniform calls a frame from creeping up unnoticed
(`draw-counts.json` may only go down); a change that raises them and is
measurably faster updates it on purpose.

## Why not Pixi

Until #650 and #651 the player drew with PixiJS, through a fork. Pixi is
a general engine: a scene graph of its own, render groups, instruction
sets rebuilt as the graph changes, pipes and systems behind an extension
registry. swf2es used a small part of it, mirrored Flash's display list
into Pixi's graph to use even that, and spent much of its view steering
Pixi through hooks in the fork.

A crowded room cost in two places under Pixi. Its commands, about 12,700
GL calls a frame, were executed on the main thread of Chrome's GPU
process, which spent some 17 ms a frame on them. Its fill, some 20 ms of
GPU time on an Intel Iris Xe, was mostly multisampling and blend layers
drawn again every frame. Sending fewer commands needs the whole frame
known in one place; drawing fewer pixels needs the layers planned from
it. Pixi spread that knowledge over its systems, pipes and render
groups.

A throwaway prototype (#616) drew Pixi's Graphics and sprites in runs of
its own between Pixi's other instructions. On the busy room it took
Chrome's GPU process from 4.8 to 4.0 ms a render on a discrete GPU, the
GPU's cycles down 8.5%, draws from 1,414 to 1,020 and buffer uploads
from 784 to 51 KB; on a mostly still scene with small edits, frames from
4.1 to 1.0 ms. Most of its work and all of its bugs were in interleaving
with Pixi, so the renderer was built beside Pixi instead, behind a
switch, and grown to completeness in small pull requests (#618 to #649),
with the player's Flash references, the corpus and the draw counts run
with the switch on as well as off. It became the default once every
check passed with it (#650), and Pixi was then removed with its fork
(#651).

Measured on the way, against Pixi:

| | Pixi | swf2es's renderer |
|---|---|---|
| 32 animated characters, GPU: draw calls, frame time | 2,839, 34.7 ms | 2,121, 18.4 ms (#643) |
| the same, JavaScript a frame | 14.3 ms | 3.3 ms |
| busy town (`bench.ts --town 200`), SwiftShader | 141 ms | 110 ms (#646) |

Then, the renderer alone, holding filtered layers on the busy town on a
GPU took its framebuffer binds a frame from 1,300 to 255 (#646) and then
9 (#649), and its GL wait from about 13 ms to 5.9 and then 3.9.

## Next

- **WebGPU,** behind the same command buffer: a span that stands still
  onto a render bundle.
- **Spans kept across frames, and plans reused,** only where profiles
  show the walk or the planner hot.
- **Geometry buffers owned by wasm,** so that the module writes the
  atlas's vertices where the backend reads them, only if profiles ask.
- **Known differences from adl,** parked: a filtered object with a mask
  is filtered and then clipped, where adl masks its content before the
  filter; and a filtered layer's edge samples differ from the stage's at
  4 or 8 samples, which `tests/player/filter-coverage.ts` allows a
  quarter of a pixel's coverage for.
