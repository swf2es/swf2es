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

What limits a busy frame now is the commands it sends, not the CPU work
that makes them: about 12,700 GL calls a frame in a crowded room, whose
cost in Chrome's GPU process is about 0.6 µs each. Fewer commands means
knowing the whole frame in one place, which Pixi's structure spreads over
its systems, pipes and render groups.

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
and leaves the list alone. A structural change writes its subtree's span
again, and the list is rebuilt by copying the spans that did not change
(`TypedArray.set` on the ranges) around it. A subtree off the list keeps
its span for as long as its nodes are kept (`render/spares.ts`), so it can
come back without being walked.

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

- **Runs.** Consecutive draws that one program can draw with the same
  state become one draw: atlas geometry through the rows (the table's
  pulled draws), bitmaps and glyphs by their textures. A span that stood
  unchanged for a while may be drawn from a baked copy of its vertices
  instead, as a settled group's Graphics are batched today; the planner
  decides by the span's age and size, the measured rule the table uses now.
- **Layers.** Which filter and blend layers to draw, at what size,
  resolution, padding and samples (the rules now in `render/filters.ts`
  and `render/compositing.ts`: `blurShrink`, dense samples, kept areas);
  which kept outputs to reuse while their objects stand still; and where a
  blend needs a copy of the backdrop or the GPU's blending matches Flash.
- **Masks and clips.** Stencil push, mask drawing and pop; a scroll
  rectangle that is an axis-aligned rectangle on screen as a scissor.
- **Render targets.** When each layer's target is taken and given back,
  so the pool holds no more than the deepest nesting needs.

The command buffer is an `Int32Array` of operations (bind target, clear,
draw run, set blend, stencil step, filter pass, composite) with a
`Float32Array` of their parameters. Planning a frame allocates nothing.

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

It is built on context3d's WebGL 2 pieces (`state`, `programs`,
`buffers`, `limits`): what they lack is added there, not written twice,
and Stage3D's surfaces and the display list share one context, so
compositing them needs no copy.

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

Each step keeps the Flash references of `tests/player`, the draw counts,
which may only go down, and the filter, context-loss, resize and leak
checks passing, and is measured on the busy room replay before it
merges.

1. **The scene list.** Sync writes the list and the row table alongside
   Pixi's containers, and the transform table plans its runs from the list
   in place of the batcher's upload hook. Pixi still draws.
2. **The planner.** It plans runs, layers and filter reuse from the list,
   and the view and the fork's pipes follow its plan. Planner unit tests
   start here.
3. **The backend for runs.** The row program draws the planner's runs of
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
