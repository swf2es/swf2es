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

In a crowded room, the frame is limited by its GPU commands, not by the
CPU work that builds them: about 12,700 GL calls a frame, executed by
Chrome's GPU process, plus some 20 ms of GPU time on an Intel Iris Xe. To
send fewer commands, the whole frame has to be known in one place, and
Pixi spreads that knowledge over its systems, pipes and render groups.

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
Command and draw counts are supporting evidence. `draw-counts.ts` keeps
them from creeping up unnoticed, but a step that raises them and is
measurably faster updates the baseline on purpose.

This document plans a renderer of swf2es' own, which only draws what Flash
draws: TypeScript for the GPU calls, data-oriented, in typed arrays,
with WebAssembly for the kernels that pay for it. Crossing from wasm to
WebGL costs a call per command, so the commands stay in JavaScript. It
is reached a step at a time, each step a pull request that improves
the player on its own, with Pixi doing less after each until it goes.

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
  and flags (smoothing, pixel snapping, hairline strokes).
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
  Graphics drawn by the table cost a GPU more than the CPU saved.
- **Texture batching.** Fills, bitmaps, gradients and glyphs share
  texture units in a run as far as Flash's drawing order allows. Which
  textures a run binds, and where it must break, is part of the plan.
- **Layers.** Which filter and blend layers to draw, at what size,
  resolution, padding and samples (the rules now in `render/filters.ts`
  and `render/compositing.ts`: `blurShrink`, dense samples, kept areas);
  which kept outputs to reuse while their objects stand still; and where a
  blend needs a copy of the backdrop or the GPU's blending matches Flash.
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
  also depends on more than its entries: the atlas ranges and textures
  it names, which can move or be evicted, and the clip and target it
  inherits from its enclosing spans. Resources carry generations, and a
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
  with the expanded atlas for pulled draws.
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
  pulled), the filter passes, the blend formulas, the 3D plane. A closed
  set, compiled once a context.
- **A state cache,** so no bind, blend or stencil state is set twice.
- **Uploads** of rows and run chunks once a frame, as the table does.

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

**One context, one owner of its state.** While Pixi, this backend and
Stage3D share a context, each can change GL state behind the others'
caches. A stale cache draws wrong, and resetting everything at each
handoff spends the commands saved. The context's state therefore has a
single cache, or a handoff protocol that says what each side may assume
and must restore. This comes early, before the backend draws anything.
Once it exists, Stage3D's surfaces and the display list compose in one
context without copies.

A WebGPU backend later implements the same interface: the command buffer
maps onto a render pass, and a span that stands still onto a render
bundle. An experimental backend, such as Vello's, could implement it too.

## Alongside

- **Filters and blend modes** become the passes the planner emits: blur,
  glow, shadow, bevel, gradient glow and bevel, colour matrix, convolution
  and displacement map, as they are drawn now to match adl. Their shaders
  and the rules for exactness move from `render/filters.ts` and
  `render/blend.ts` unchanged.
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

Each step keeps the Flash references of `tests/player` and the filter,
context-loss, resize and leak checks passing, and is measured as above
before it merges.

0. **A prototype.** A throwaway scene list and planner that draw the
   busy room's shape and bitmap runs, measured on the three scenes. It
   shows which commands disappear and whether frame time improves,
   before two representations of the scene are kept in step. It counts
   the whole cost: scene updates, planning, uploads, submission and the
   handoffs between renderers. It is compared with the current renderer
   on identical frames at the same resolution, in repeated alternating
   runs. Its measurements settle what this document leaves open:
   contiguous or chunked lists, batching thresholds, cache policies.
1. **The scene list.** Sync writes the list and the row table alongside
   Pixi's containers, and the transform table plans its runs from the list
   in place of the batcher's upload hook. Pixi still draws.
2. **The planner.** It plans runs, layers and filter reuse from the list,
   and the view and the fork's pipes follow its plan. Planner unit tests
   start here.
3. **The backend for runs.** The shared context's state ownership comes
   first. Then the row program draws the planner's runs of
   fills, bitmaps and glyphs on context3d's pieces; Pixi draws only what
   the planner hands it (filters, masks, blends, 3D planes).
4. **Masks, clips, filters and blends,** one at a time, onto the backend.
   `BitmapData.draw` with them.
5. **Pixi removed:** its containers, groups, pools and fork. Render groups,
   settling and spare batchers go with it.
6. **WebGPU,** behind the same command buffer, when the WebGL backend is
   complete.

Until step 5 the fork stays, but takes only fixes the player meets, not
upstream's releases.
