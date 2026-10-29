# The renderer (planned)

The player draws with PixiJS, a fork of it in `vendor/pixijs`. Pixi is a
general engine: a scene graph of its own, render groups, instruction sets
rebuilt as the graph changes, pipes and systems behind an extension
registry, and renderers for WebGL, WebGPU and the 2D canvas. swf2es uses a
small part of it, and mirrors Flash's display list into Pixi's graph
(`render/view.ts`) to use even that. Much of `render/` is now spent
steering Pixi through hooks in the fork (`render/hooks.ts`): the transform
table draws runs of Graphics through a pipe of its own and plans its rows
from an upload hook (`render/table.ts`), groups settle and unsettle
around Pixi's rebuilds (`render/settle.ts`), and filters keep their areas
and outputs through the fork's filter pipe.

A crowded room's frame costs in two places. Its commands, about 12,700
GL calls a frame, are executed on the main thread of Chrome's GPU
process, which spends some 17 ms a frame on them. Its fill, some
20 ms of GPU time on an Intel Iris Xe, is mostly multisampling and blend
layers drawn again every frame. Sending fewer commands needs the whole
frame known in one place; drawing fewer pixels needs the layers planned
from it. Pixi spreads that knowledge over its systems, pipes and render
groups.

Fewer commands is a means, not the goal. Pulled draws took that scene from
12,700 GL calls to 11,273 ([architecture.md](architecture.md#rendering)).
Chrome's GPU process went from 17.3 to 16.5 ms a frame, the GPU's own
time did not move, and the page spent 0.5 ms more planning. Each step
here is judged by frame time:

- median and p95 frame time;
- planning and submission time on the page;
- the GPU process's time and the GPU's own time;
- upload bytes and memory.

These are measured on the busy room replay, a mostly static scene with
small edits, and a filter-heavy scene, on a GPU and on software GL.

GPU time is measured with the GPU saturated, frames drawn as fast as it
goes, in clock cycles a render: an integrated GPU lowers its clock when
it has less to do, so at a scene's own frame rate its timer hides most
changes. Measured so, the busy room's GPU time is mostly fill: 8×
multisampling of the back buffer, and blend layers drawn again every
frame. Fewer commands save the GPU process's time, not the GPU's; both
are reported.

The replay is the acceptance test, but it takes minutes and a private
recording. For each pull request, a synthetic scene in
`tests/player/bench.ts`, perhaps grown from `--town`, is built to the
busy room's measured mix and checked once against the replay's counts:

- about 4,650 Graphics a frame, most of them still;
- bitmap and gradient fills;
- 240 filters, most with kept outputs;
- 100 blend layers;
- a few masks.

It measures a change in seconds.

Command and draw counts are supporting evidence. `draw-counts.ts` keeps
them from creeping up unnoticed, but a step that raises them and is
measurably faster updates the baseline on purpose.

This document plans a renderer of swf2es' own, which only draws what Flash
draws: TypeScript for the GPU calls, data-oriented, in typed arrays,
with WebAssembly for the kernels that pay for it. Crossing from wasm to
WebGL costs a call per command, so the commands stay in JavaScript. It
is built beside Pixi, behind a switch, and replaces it once it draws
everything Pixi draws and measures better (see [Steps](#steps)).

## Layers

```
display list (player)        display objects, timeline, AS3
   │  sync
   ▼
scene list                   the frame's drawing, in order, in typed arrays
   │  plan
   ▼
command buffer   ◄──────     resources: geometry atlas, textures, render
   │  execute                targets, glyphs, budgets, context loss
   ▼
backend                      WebGL 2 on context3d's pieces; WebGPU later
```

Each layer can be tested alone. Only the backend calls the GPU.

### The scene list

The view's sync walks the display list, as it does now, but writes a flat
list in drawing order in place of updating Pixi containers. It is a
structure of typed arrays, an entry a drawable or a boundary:

- **Draw:** what is drawn (a range of the geometry atlas, a texture, a
  glyph run, a video frame, a 3D object's plane), its row, its blend mode,
  and flags (smoothing, pixel snapping, hairline strokes). Textured fills
  are atlas geometry too: in the busy room, bitmap and gradient fills
  are as common as bitmaps.
- **Rows:** a row is an object's concatenated transform and colour
  transform, the table's row today (five texels: the linear part, the
  translation, the tint, the colour transform's multipliers and offsets).
  Rows live in a table of their own, indexed by the list.
- **Boundaries:** push and pop of a filter layer, a blend layer, a mask
  (its drawing between push and use), a scroll rectangle's clip, and
  `cacheAsBitmap`. Each push names its object's filter or blend records and
  its bounds.

Each node keeps the span of the list its subtree wrote. A frame where only
transforms or colours changed, an animation's usual frame, writes rows
and leaves the list alone; the rows it wrote go up in coalesced ranges,
not one by one.

Some changes of a transform do invalidate entries, as they redraw today
(`render/view.ts`):

- a scale-nine object, whose slices depend on its scale;
- device text, whose texture's resolution follows its scale on screen;
- a stroke, whose lines are shared only by instances under the same
  transform (`render/strokes.ts`).

Each entry kind states what invalidates it: its geometry, its textures,
its clip, its filter inputs.

A structural change writes its subtree's span again. Rebuilding the list
by copying the unchanged spans around it (`TypedArray.set` on the
ranges) costs time in proportion to the whole scene, so it is measured
before it is relied on. Stable chunks, linked in order, are the
alternative if it is not cheap enough.

A subtree off the list keeps its span for as long as its nodes are kept
(`render/spares.ts`), so it can come back without being walked.

This replaces Pixi's render groups and instruction sets: the group
heuristics in [architecture.md](architecture.md#rendering) (64 art objects
a group, settling, parking and eviction) exist only because a Pixi group
rebuilds whole.

### The planner

The planner turns the scene list into a command buffer. It is pure:
no GPU, no DOM, no clock. What depends on time, such as how long a span
has stood unchanged, comes in as a frame count. Given a scene list and the
resources' state, it always plans the same commands, which makes it unit
tested as data: this list, these commands. The draw-count check
(`tests/player/draw-counts.ts`) becomes a planner test, alongside the
browser case it is now.

It decides:

- **Runs, and how each is drawn.** Consecutive draws that one program
  can draw with the same state become one run. Its strategy is a choice
  the planner makes per run:
  - pulled draws from the expanded atlas;
  - a multi-draw of the atlas's index ranges;
  - plain indexed draws from the atlas, a call a draw with its buffers
    bound once for the run, which beat a multi-draw on short runs;
  - a baked copy of the vertices, for a span that stood unchanged, as a
    settled group's Graphics are batched today.

  The choice depends on the backend's capabilities and on measured rules
  the planner is given. Each wins somewhere: pulled draws more than
  doubled SwiftShader's GL time on one workload, and small coloured
  Graphics drawn by the table cost a GPU more than the CPU saved. Runs of
  a few draws that change every frame want a lighter program than the
  textured pulled one, such as untextured pulled draws or plain indexed
  draws. In step 0 such a scene took 16.1 ms a frame with the textured
  program, against 13.0 ms with today's table.
- **Texture batching.** Fills, bitmaps, gradients and glyphs share
  texture units in a run as far as Flash's drawing order allows. Which
  textures a run binds, and where it must break, is part of the plan.
- **Layers.** Which filter and blend layers to draw, at what size,
  resolution, padding and samples (the rules now in `render/filters.ts`
  and `render/compositing.ts`: `blurShrink`, dense samples, kept areas);
  which kept outputs to reuse while their objects stand still; and where a
  blend needs a copy of the backdrop or the GPU's blending matches Flash.
  A layer's size is what its draws cover, their geometries' boxes placed
  by their rows and cut by the masks among them (`measure.ts`), not the
  bounds Flash reports: those differ wherever drawing does (scroll
  offsets, non-scaling strokes, 3D), and a layer cut to them clips.
- **Masks and clips.** Stencil push, mask drawing and pop; a scroll
  rectangle that is an axis-aligned rectangle on screen as a scissor.
- **Passes and targets.** A layer is a small graph of passes, each with
  explicit inputs and outputs, sample counts and resolves. One layer can
  hold several targets at once: its source, a filter's intermediates, the
  original image a glow or bevel combines with, and the backdrop a blend
  reads (`render/filters.ts`). A temporary target is given back after its
  last use in the frame. A retained one, such as a kept filter output or
  `cacheAsBitmap`, belongs to its object until the object changes or the
  budget reclaims it. The pool is sized by those lifetimes, not by
  nesting depth.
- **Reuse.** A span whose entries and inputs did not change keeps its
  plan from the last frame; only what changed is planned again. A plan
  is kept only once its span has stood unchanged for a frame: keeping
  the plans of spans that change every frame cost more than planning
  them afresh. Its rows and chunks live on the GPU alone, not mirrored
  on the CPU. A plan also depends on more than its entries: the atlas
  ranges and textures it names, which can move or be evicted, and the
  clip and target it inherits from its enclosing spans. Resources carry generations, and a
  plan is reused only if those generations and the inherited state
  are the ones it was made with.

The command buffer is an `Int32Array` of operations (bind target, clear,
draw run, set blend, stencil step, filter pass, composite) with a
`Float32Array` of their parameters. Because passes are explicit, a WebGPU
backend can map the buffer onto render passes, rather than translating
GL calls. Planning a frame allocates nothing.

### Resources

Everything on the GPU, owned in one place:

- **The geometry atlas:** fills and lines as native tessellation writes
  them, placed by `Ranges` and grown in place (`render/table.ts` today),
  with the expanded atlas for pulled draws. Textured fills' coordinates
  do not widen every index's record: step 0's two texels an index
  halved what the atlas held. They live in a texture of their own, or
  vertices are fetched by index rather than expanded per index. An
  atlas that outgrows its largest texture, as a long session's contexts
  and the holes they leave can make it, starts again with only what is
  live, rather than failing.
- **Textures:** bitmaps (`render/bitmaps.ts`), device text, video frames,
  gradients.
- **Render targets:** pooled by size and samples, for layers, cached
  filter outputs and `BitmapData.draw`.
- **Glyphs:** Saffron's outline data (`render/saffron.ts`).

Each kind has a budget; what goes over is reclaimed oldest first, never
while a planned frame uses it. After a lost context everything is made
again from what the player keeps, as it is for Stage3D (context3d's
budgets and reclaiming do the same for its resources).

### The backend

The backend executes a command buffer, and is the only code that calls
WebGL. It is small by design:

- **Programs:** the row program (fills, bitmaps and colour transforms,
  pulled), drawTriangles' meshes (textured in perspective, their bitmap
  read as adl reads it), the filter passes, the blend formulas, the 3D
  plane. A closed set, compiled once a context.
- **Runs:** consecutive fills are one multi-draw of the atlas's index
  ranges (`WEBGL_multi_draw`) for as long as their textures fit the fill
  program's eight units, each draw reading its row, its texture's unit and
  whether it snaps by `gl_DrawID` from a uniform array; without the
  extension, a call a draw.
- **Held layers:** a filtered layer of draws, masks and held layers
  alone, not kept, is drawn before the stage with every other such of its
  level (the planner's `HOLD_PUSH`), after the levels it holds, whose
  outputs its content composites: their content side by side on pages,
  then their filters' passes in waves, the k-th of every chain at once,
  planned ahead as data (`filter-plan.ts`), each wave's targets on pages of
  their own. A pass reads a target within its rectangle as a texture of
  its own size. On a busy scene's 300 glows, some in others, a frame's
  framebuffer binds went from 1,300 to 9, and its GPU time from about
  13 ms to 4.
- **A state cache,** so no bind, blend or stencil state is set twice.
- **Uploads** of rows and run chunks once a frame, as the table does.

**Anti-aliasing** is the GPU's multisampling, as the Pixi view's is
(architecture.md, "Stage quality"): the host sets the samples by the
stage's quality, and the stage is drawn into multisampled buffers the
canvas's size, resolved into a texture and then onto the canvas, as a
resolve must keep its format and an opaque canvas has no alpha. Without
multisampling, a frame in which an erase or alpha blend clears the stage
itself, as adl clears it, is drawn into a layer the canvas's size and
copied onto the canvas, so that the blends after it read that alpha. A blend
or filter layer draws into multisampled buffers of its own, resolved into
its texture before a filter or its composite reads it, its rectangle
alone or, filtered, all of it. A blend's backdrop is copied to where it
lies, as a blit out of a multisampled target must keep its rectangle.
Filter passes draw single-sampled, and BitmapData's draws supersample, as
Flash's do.

It reuses context3d's low-level WebGL 2 mechanisms (state tables,
program linking, buffers, limits), extracted where needed so that both
can use them. Context3D's own draw path stays Stage3D's: it validates and
rebinds as Stage3D requires, which a 2D draw must not pay for.

Those mechanisms grow into a device layer in context3d (a sub-path of
it), which both the renderer and the Context3D API draw through: the
context and its state cache, resources, budgets and context loss, and
later the WebGPU device. The two APIs on top stay apart. Context3D
validates what a SWF sends and fails as Flash does; the renderer trusts
its own plans. The device layer becomes a package of its own only if it
outgrows context3d.

**One context, one owner of its state.** The backend and Stage3D share
a context, and each could change GL state behind the other's cache. A
stale cache draws wrong, and resetting everything at each handoff spends
the commands saved: in step 0, resetting Pixi's state after each run
cost 1.3 ms a frame, more than the prototype saved. So the context's
state has a single cache from the first draw, which Stage3D's surfaces
use too, and they compose with the display list in one context without
copies. With the switch on, Pixi does not draw at all, so it never
shares the context with the backend.

A WebGPU backend later implements the same interface: the command buffer
maps onto a render pass, and a span that stands still onto a render
bundle. An experimental backend, such as Vello's, could implement it too.

## Alongside

- **Filters and blend modes** become the passes the planner emits: blur,
  glow, shadow, bevel, gradient glow and bevel, colour matrix, convolution
  and displacement map, as they are drawn now to match adl. The filters'
  shaders and `blurShrink` moved unchanged to `filter-shaders.ts` and
  `filters.ts`, where the Pixi view reads them too; the player works out
  each filter's values, padding and insets (`scene/filters.ts`), and a
  filtered layer is measured as Pixi's filter system measured it. The
  blend formulas moved from `render/blend.ts` to the composite program.
- **Text** stays laid out by the player. The renderer sees glyph runs:
  Saffron's quads, or a device text texture.
- **`BitmapData.draw`** plans a scene list into a render target with the
  same planner and backend, so it draws as the stage does.
- **Hit testing and bounds** are the player's own maths, never the
  renderer's.
- **WebAssembly kernels** (`@swf2es/native`) stay where they measure
  well: tessellation and flattening, bitmap filters and colour transforms
  on the CPU. Packing rows and planning may move there later, if profiles
  show them hot; the GPU calls do not.

## Package

The renderer becomes `@swf2es/render`, which depends on `context3d` alone
and knows nothing about AS3, timelines or display objects, as codegen
knows nothing about the runtime. The player depends on it and feeds it
scene lists. Like context3d, its core (scene list, planner, command
buffer) loads no DOM types, and its WebGL backend is a sub-path
(`@swf2es/render/webgl`). The table in `tests/unit/boundaries.test.ts`
and [architecture.md](architecture.md#packages) change with the package.

## Steps

Step 0, a throwaway prototype (#616), drew Pixi's Graphics and sprites in
runs of its own between Pixi's other instructions. On the busy room it
took Chrome's GPU process from 4.8 to 4.0 ms a render on a discrete GPU,
the GPU's cycles down 8.5%, draws from 1,414 to 1,020 and buffer uploads
from 784 to 51 KB; on a mostly still scene with small edits, frames from
4.1 to 1.0 ms. It lost where every short run changed every frame. Most of
its work and all of its bugs were in interleaving with Pixi: runs bounded
by Pixi's render groups, change signals borrowed from Pixi, a colour
transform Pixi never hears of. Taking object kinds from Pixi a step at a
time would build that interleaving and then take it apart. So the
renderer is built beside Pixi instead:

1. **A renderer behind a switch,** on `dev`, off by default. With the
   switch on it owns the whole frame and the GL context: its own sync
   from the display list, writing the scene list and rows from the
   player's change signals (transforms and colours write rows, structure
   writes spans), the planner, resources and backend. Pixi stays the
   default, and takes only fixes the player meets, not upstream's
   releases.
2. **Grown to completeness,** in pull requests each small enough to
   review, in about this order:
   - shapes, bitmaps and text;
   - masks and scroll clips;
   - blend modes;
   - filters;
   - `BitmapData.draw`;
   - 3D planes;
   - context loss.

   The player's Flash references, the corpus and the draw counts run
   with the switch on as well as off. What passes with it on is how
   complete it is, and a reference that passed may not fail again.
3. **The default flipped** once every reference passes with the switch
   on and it measures better on the three scenes, on an integrated GPU
   and a discrete one, and no worse under software GL, which CI draws
   with and a player without a usable GPU falls back to: there the
   planner chooses strategies that suit it, as pulled draws did not.
4. **Pixi removed:** its containers, render groups, settling, pools,
   spare batchers and the fork.
5. **WebGPU,** behind the same command buffer.

Until the default flips, each pull request is judged by what it adds to
the switch's completeness and by its measurements, not by improving the
default renderer.
