# Renderer performance plan

A plan for the next performance work on the renderer
([renderer.md](renderer.md)): `@swf2es/render`'s WebGL 2 backend and the
view that drives it, `packages/player/src/scene`. Nothing here is built.
Each item gives its design, what it risks against Flash, how it is
measured, its pull requests and its tests. The items are numbered in the
order they were asked for; [the ranking](#ranking) orders them by what
they should gain for their work, and says where that is a guess.

Two rules hold throughout, from [renderer.md](renderer.md#measuring):
a change gets a bench mode of its own in the repository first, then a
check on real content, and is kept only for a gain that repeats; and what
is drawn is held to Flash's frames (`node tests/player/run.ts`), with
`tests/player/draw-counts.ts`'s counts only going down.

## Where the time goes

What is known, and how old it is:

- **Commands, not fill, bound a crowded room.** Under Pixi it took about
  12,700 GL calls a frame; the renderer of our own took some 5,950 a
  render on the same replay (2026-11-06, by hand, after #744), with
  Chrome's GPU process still at about 9 ms a render. What was left was
  less the calls than the passes they break: about 298 framebuffer
  binds, 67 blits and 65 clears a render, from blend layers' backdrop
  copies (about 34), multisampled resolves (about 29) and filter passes.
  #776 then took the copies to 20.5, the binds to 255 and the blits to
  53. Nothing has been measured on the replay since.
- **Chrome pays for each sub-draw of a multi-draw.** A run of 256 fills in
  one `multiDrawElementsWEBGL` is one call in the page and 256 draws in
  the GPU process. Only a real merge counts, which is why
  `webgl/batches.ts` copies stable runs into one indexed draw. Taking
  cheap state changes away alone (redundant uniforms, #609's binds) gave
  nothing measurable, twice.
- **The GPU's own time** was mostly multisampled fill and blend layers
  drawn again each frame, measured saturated. With `denseSamples` (#604,
  #756) an integrated GPU at a device pixel ratio of 1.45 was a third
  idle on the busy replay; at a ratio of 1 it still takes 8 samples at
  high quality.
- **The page's main thread** spent 15 to 18% of its busy time in the
  scene walk on that replay, and 12% in the player's own walks. Planning
  and submitting were about 3%.

Measured for this plan, on dev's renderer at fdbdd117 (the same sources
as 95b08afe's), SwiftShader, 60 frames, `bench.ts --counts`:

| scene | calls | sub-draws | program switches | framebuffer binds | uniform calls |
|---|---|---|---|---|---|
| `--town 100` | 770 | 3,528 | 257 | 9 | 2,173 |
| `--vectors 2000` | 32 | 32 | 0 | 0 | 2 |
| `--blends 100` | 101 | 101 | 2 | 144 | 602 |

And `draw-counts.json` holds the site's crowd at 3 calls of 3 sub-draws
(576 of each without `WEBGL_multi_draw`), `blend-bitmaps` at 24 calls
and 45 framebuffer binds, and `bounce` at 50 calls and 24 binds.

Three things follow, which the ranking leans on:

1. `--vectors 2000` draws 8,000 fills in 32 real draws already: stable
   small geometry is merged. What instancing can add is what merging
   leaves out.
2. `--town 100` makes 770 calls for 3,528 sub-draws, under five a call,
   and switches program 257 times with almost no framebuffer bind: its
   runs are cut short by something drawn between them with another
   program, which fits its filtered outputs (a glowing weapon a
   character, and more) composited one at a time, two switches each.
   Runs that short never reach the 32 fills merging asks for
   (`MERGED_LEAST_MULTI`), so every one of its sub-draws is a draw in
   the GPU process.
3. `--blends 100` binds a framebuffer 144 times for 100 blends that are
   one fill each: the backdrop copies, not the layers.

None of the three is timed on a GPU here. The first step of every item
below is the measurement that would confirm or drop it.

## 1. Instanced drawing of repeated shapes

### What is there

A shape layer's fills are one geometry, shared by every instance
(`scene/parts.ts`, `partsOf`), copied once into the atlas
(`webgl/atlas.ts`). A draw is an index range of the atlas and a row
(`rows.ts`: transform and colour transform, four texels of a float
texture). `webgl/draws.ts` draws consecutive fills as a run in one of
three ways:

- one `multiDrawElementsWEBGL`, each sub-draw reading its packed row
  (row, texture slot, snap bit) from an integer texture by `gl_DrawID`
  (`uRunTable`, `uRunBase`);
- one indexed draw of the run copied into the merged stream
  (`webgl/batches.ts`), for runs of at least 32 geometries of at most 256
  vertices and 1,024 indices, unchanged since the frame before, each
  vertex carrying where its draw's packed row is in an integer texture;
- a call a fill, its row a uniform, where neither applies.

So per-draw data already comes from textures and from a vertex
attribute. No shader indexes a uniform array by anything but a constant,
and none may: a table indexed by `gl_DrawID` hung Intel's GPUs.

### The design

An instanced draw is `drawElementsInstanced` of one atlas range, which
WebGL 2 has without an extension: instance k reads its packed row from
the run table at `uRunBase + gl_InstanceID`, by `texelFetch`, as a
sub-draw reads its own at `uRunBase + gl_DrawID` today. The table, its
upload before the frame's first draw (`Draws.prepare`) and the row
texture are unchanged. No per-instance vertex buffer is needed, and so
no attribute divisor or base instance, which WebGL 2 lacks without
`WEBGL_draw_instanced_base_vertex_base_instance`. Where
`WEBGL_multi_draw` is, a run of several instanced groups is one
`multiDrawElementsInstancedWEBGL`: the table entry at
`uRunBase + gl_DrawID` is then where the group's instances start, a
second fetch.

**Grouping without reordering.** Painter's order stays as the scene
list has it. The planner's runs already end at every blend mode, mask
push and pop, layer, kept output, mesh, shader fill and glyph run
(`plan.ts`, `emit`; `Draws.gatherRun`), so grouping inside a run crosses
none of them. Within a run:

- *Adjacent repeats* (slice 1): consecutive draws of one geometry, the
  same texture slot and snap bit, are one group. Exact by construction:
  the instances draw in their order, as the sub-draws did.
- *Commuting repeats* (slice 2, only if slice 1's census asks): a draw
  may join an earlier group of its geometry if its box on the target
  meets the box of no draw between them. Draws whose boxes do not meet
  touch no common sample, multisampled or not, so their order cannot
  show. The boxes are the geometries' (`geometry.ts`, `boxes`) placed by
  their rows, as `measure.ts` places them for layers. This is pure, in
  the planner, and tested as data: this list, these groups. A bounded
  window (say 64 draws back) keeps it linear.

A crowd of one character is the case that decides between the two. Its
members draw head, body, arm, then the next member's head: no two
adjacent draws share a geometry, and members that overlap on the stage,
as a crowd's do, commute with few. The census below says how many.

**Sharpness.** Instances are the same triangles through the same vertex
shader, rasterized into the same multisampled target: nothing is cached
as pixels. Lines are the limit: a line's geometry is kept by layer and
stretch (`scene/lines.ts`), so instances share it only where they are
stretched alike, which the view already arranges (`settledStretch`).

**With merging and the atlas.** The atlas is untouched: an instanced
draw names the same index range. Against the merged stream the rule is
by cost: the stream holds a copy of the geometry for each draw, 24 bytes
a vertex, where an instanced group holds one row index an instance. A
group of at least four instances whose geometry is too large to merge,
or changed this frame, is instanced; a run of small stable geometries
with few repeats stays merged. Where both apply, measure: the merged
draw is one draw whatever its mix, an instanced run one draw a geometry.

**The fallback.** `drawElementsInstanced` is core, so there is none to
write for the single-group case; without `WEBGL_multi_draw` (Firefox) a
run of groups is a call a group, each told its `uRunBase`. The call a
fill path stays for a frame whose run table does not fit.

**Expected savings.** From the code and the bench scenes: none in calls
where a run is already one multi-draw or one merged draw (the crowd's
3, `--vectors`' 32). The gain is in sub-draws the GPU process executes,
and only for repeats merging leaves: geometries over 256 vertices,
geometry made this frame, runs under 32, and every repeat in Firefox,
where the crowd is 576 calls. `--town` gains nothing: each character has
parts of its own. So the estimate for existing scenes is small, and for
real content unknown.

### Risks to fidelity

Low for adjacent repeats. For commuting repeats, a box that is too
small: a line's width under `SNAP`, or a hairline widened to a screen
pixel, must be inside its geometry's box as placed. The mesh, glyph and
shader-fill programs are left out of grouping.

### Measured by

- First, a census in `bench.ts --counts` and `draw-counts.ts`: sub-draws
  by path (merged, multi-draw, single), and of those not merged, how
  many repeat the draw before them and how many repeat a draw within 64
  that they commute with. Run on `--town`, `--vectors`, the crowd and
  the busy replay. **Stop here if repeats are under a tenth of the
  sub-draws the GPU process executes.**
- A bench mode `--instances N [--parts K] [--large]`: N placements of one
  character of K parts, `--large` giving each part more than 256
  vertices, half of them overlapping.
- A win: GPU-process time a render down by more than run-to-run noise
  (about 1 ms on the replay) on an Intel GPU, and `subDraws` down.

### Pull requests

1. The census, with no change in drawing.
2. Adjacent repeats as instanced draws; `draw-counts.json` updated down.
3. Commuting repeats in the planner, behind slice 2's numbers.

### Tests

`shared-colors` and the crowd demo's frames against Flash;
`tests/player/multi-draw.ts` extended to compare instanced runs with a
call a fill, pixel for pixel, with and without `WEBGL_multi_draw`; unit
tests of the grouping as data in `tests/unit/render`; a new
`draw-counts` case of repeated large parts. Several minutes of the new
bench mode on an Intel GPU before merging, as for any shader change.

## 2. Cached outputs as instanced quads

### What is there

A filtered object's output is kept while nothing it ran on changed but
its place (`scene/filter-layers.ts`, `keptOutput`; `keeps.ts`). Each
kept output is a texture of its own in the target pool
(`TargetPool.keep`, sizes rounded to 16 or 128), and is drawn again by
`Compositor.compositeLayer`: the composite program used, the vertex
array unbound, six uniforms, a scissor, six vertices. A filtered layer
not kept is held (`plan.ts`, `findHolds`): drawn ahead of the stage on
shared pages (`shelves.ts`, `webgl/holds.ts`), and composited the same
way, one at a time. Each composite ends the fill run before it and
starts another after.

`cacheAsBitmap` alone keeps nothing today: `cached()`
(`display/shapeobject.ts`) only decides alpha masks and stale shapes. A
blend layer is not kept either (item 3).

### The design

**A normal composite is a textured fill.** `fillFragment` already
samples one of eight textures by a slot in the draw's packed row and
applies the row's colour transform to the straight colour, a clear texel
staying clear, which is what `LAYER_COLOR` does for a composite. So a
kept or held output in `normal` or `layer` mode becomes an ordinary draw
of the run it stands in: one shared unit quad from the atlas, a row
whose matrix places it and whose colour is the layer's row, and the
output's texture in a slot. The run is not broken, nothing is bound or
told, and the quad merges or multi-draws with the fills around it. The
"instancing" is the run's own: quads are draws like any other, by
`gl_DrawID`, the merged stream, or item 1's instances.

`add` and `screen` outputs, which GL's blending computes, make runs of
their own under that blend, consecutive ones together. Modes that read
what is below stay with the compositor.

**Placement, to the texel.** The composite places a layer by whole
target pixels with a scissor and reads it with `texelFetch`. The quad
must cover exactly those pixels, or a multisampled edge would take a
fraction of a row. Its row is in stage units, and scaling back by
`uView` in 32-bit floats may land a hair off a pixel's edge. So the
packed row takes a bit beside `SNAP_BIT`, `WHOLE_BIT`, under which the
vertex shader rounds the position to whole target pixels. The texture
is sampled through the nearest sampler; a quad on whole pixels then
reads each texel at its centre. On the canvas, whose rows run up,
`uView` flips the quad as it flips fills, where the composite has
`uFlip`.

**The atlas.** Sharing a run needs shared textures: a run has eight
slots (`FILL_TEXTURES`). Held outputs are on pages already, so slice 2
needs no new allocator. Kept outputs then move onto pages that outlive
the frame, extending what is there rather than adding a third atlas:

- pages are layers from `TargetPool`, single-sampled RGBA8, 2,048 a
  side (16 MiB), counted in its working set;
- a page is shelves (`shelves.ts`' rule) of heights in steps of 16, as
  `layerSide` rounds small layers; a shelf's free stretches are kept
  sorted and merged by `webgl/free-ranges.ts`, as the geometry atlas'
  holes are;
- an output is placed when its chain's last pass has run, by one blit
  into its rectangle (later: the last pass drawing there itself, as held
  layers' passes do);
- an output of more than a quarter of a page a side keeps a texture of
  its own, and still joins a run through a slot.

**Eviction** is `Keeps`': an output undrawn for its idle frames is
removed (`keeps.add(0)` lets go at the end of the first frame it is not
drawn), and its rectangle goes back to its shelf. A page with nothing
live goes back to the pool. No compaction at first; if pages stay under
a quarter used for 240 frames, as the merged stream watches
(`SHRINK_FRAMES`), their outputs are blitted onto fewer.

**Invalidation** does not change: `keptOutput` decides, by the object's
and its descendants' flags, its linear transform, its filters, its
slice, the scale and quality (`keptGeneration`), and whether its
rectangle only moved. A changed output takes a new rectangle if its
size changed and overwrites its own if not.

**Colour and alpha.** A filtered object's colour transform is applied
to the pixels its filters made, by its layer's row. The quad's row
carries that colour with the placement, so a recoloured output is drawn
in the new colour with no filter run, as today.

**Memory at high density.** An output's texels grow with the square of
the canvas's pixels to a stage pixel. The pages take a budget of their
own inside the pool's (64 MiB to start, as content pages aim for), and
the quarter-page cut-off sends large outputs to textures of their own,
which the pool trims as it does today. Past the budget an output is
filtered and drawn without being kept, as one that changes every frame
is.

**Context loss.** The pages and their allocator belong to the backend
and are made again empty with the context, as `FillBatches` forgets its
segments. `Keeps.lost()` already has every owner add its output again,
and a frame given up on (`WebGLBackend.resume`) draws its outputs
again. A rectangle is found by its keep's id and generation, so a stale
handle names nothing.

**cacheAsBitmap.** Keeping an unfiltered `cacheAsBitmap` object is the
same machinery with an empty chain, but it is a change in what is drawn,
not only in how: Flash's bitmap is of whole pixels and moves by whole
pixels. It is the last slice and waits for adl cases of its own; until
then such objects stay vectors.

### Risks to fidelity

- An output a texel off, or an edge row at part coverage: `WHOLE_BIT`
  and the nearest sampler are there for it, and the cases below catch
  it.
- A neighbour's texels read at an output's edge: none with nearest
  sampling on whole pixels; a kept output is never drawn scaled or
  between pixels (it moves "to the whole texel").
- The eight slots: a run of outputs on nine textures splits, which
  draws the same.
- 3D objects' planes read their kept output by the mesh program
  (`drawMesh`, `PLANE`) and keep textures of their own.

### Measured by

- First: a census of what ends runs, in `--counts`: by composite, held
  composite, mask, blend change, texture slots, another program, and
  the run's length. It confirms or drops the reading of `--town` above.
- Bench: `--town N` as it is (held outputs), and a mode `--kept N`: N
  still filtered objects among moving shapes, a third recoloured each
  frame. `render-bench.ts`'s cached-filter scene for A/B.
- Real content: the busy replay, GPU-process time a render and frame
  p50 and p90, and its memory.
- A win: on `--town 100`, program switches from 257 to under 20 and
  sub-draws executed (after merging) down by half; on the replay,
  GPU-process time down by more than 1 ms a render. If the counts fall
  and the time does not, as with #609, stop after slice 2.

### Pull requests

1. The run census.
2. `WHOLE_BIT`, and held and kept outputs in `normal` and `layer` drawn
   as quads in their runs from the textures they have.
3. `add` and `screen` outputs as runs of quads.
4. Kept outputs on persistent pages, with the budget and the loss path.
5. The last filter pass drawing into the page; compaction if measured.
6. `cacheAsBitmap` kept, after its adl cases.

### Tests

Against Flash: `filtered-colors`, `blend-filtered-alpha`,
`filter-retween`, `wide-filters`, `zoomed-filters`, `blend-kept`,
`blend-kept-antialias`, `alpha-masks`. `filter-coverage.ts` and
`packed-filters.ts` at the sizes that cross a page. `context-loss.ts`
with outputs on pages, lost mid-frame and during a restore.
`resize.ts`. Unit tests of the shelf allocator's holes as data.
`draw-counts`: `bounce` and `blend-mask` down, and a new case of kept
outputs among fills. `leak.ts` for the pages' budget.

## 3. Keeping unchanged blend layers

### What is there

An object with a blend mode is a layer: drawn into multisampled buffers
of its own, resolved, and composited (`LAYER_PUSH` to `LAYER_POP` in
`WebGLBackend.run`). Three shortcuts exist: a layer of one flat fill is
drawn straight onto what is below (`blendDirect`, #744); `add`,
`screen`, and `multiply` over an opaque stage use GL's blending with no
copy (#776); the rest copy what is below their rectangle
(`Compositor.copyBelow`) and replace it. Only filtered layers are kept.

### The design

Keep the layer's **content**, not its blend. The content is what the
object draws, before it meets what is below; it is valid exactly as a
filter's output is, and `keptOutput`'s rule serves unchanged with an
empty chain: the object and its descendants clean but for a move, the
same linear transform, scale, quality and slice, and a rectangle that
only moved by whole texels. A layer that changes two frames running is
not kept (`changing`), as now.

The composite still runs every frame, against the frame's own backdrop.
So nothing beneath a kept layer can invalidate it, for any mode: `add`
and `overlay` alike read this frame's pixels when they are composited.
What a kept layer saves is its own drawing: the buffers taken and
cleared, its draws, and the resolve.

Keeping the **blended result** as well would save the backdrop copy and
the composite, and would need the invalidation the question names:
valid only while nothing drawn earlier in the target changed under its
rectangle. The stage is drawn whole each frame, and nothing records
what changed where, so this waits for item 5's dirty tracking; inside a
kept parent it comes free, as the parent's own keep covers its
children. It is not planned here.

For the backdrop copies themselves, which `--blends 100` shows are the
cost for single fills (144 binds for 100 blends), one smaller step:
one copy for consecutive blends whose rectangles do not meet, as the
copy made for the first is still what is below the second. (`lighten`
and `darken` by GL's `MAX` and `MIN` were ruled out in #776: they hold
only for an opaque object, which an antialiased edge is not.)

Kept content in `normal`, `layer`, `add` or `screen` is drawn as item
2's quads.

### Risks to fidelity

- A kept layer moved is placed to the whole texel, where a layer drawn
  anew is rasterized where it lies: `blend-subpixel` and `blend-drift`
  hold a blend that glides, which must then not be kept, or be kept only
  when it moved by whole texels (the rule filters use).
- A blend with children in an explicit `layer` colours its combined
  pixels: the colour stays in the composite's row, not in the kept
  content, so a fade does not invalidate it (`blend-layer-fade`).
- A mask from outside a kept layer clips its composite, not its
  content, as for filters.

### Measured by

- Bench: `--blends N` as it is for the copies; a mode
  `--blend-groups N [--still]`: N sprites of a dozen shapes each in
  overlay, multiply, add and screen over moving ground, the sprites
  still or gliding.
- GPU time saturated, in clock cycles a render, on an integrated GPU:
  this item is fill, which the frame time hides at a scene's own rate.
- A win: saturated GPU cycles down a tenth on the busy replay, or
  framebuffer binds a render down by a third with frame p50 no worse.

### Pull requests

1. `--blend-groups`, and a count of blend layers by what a keep would
   save (draws inside, area).
2. Blend layers' content kept by `keptOutput`'s rule.
3. Shared backdrop copies for blends that do not meet.

### Tests

`blend-kept` and `blend-kept-antialias` already hold a blend still,
moved, recoloured, with a child moving and over a changing ground;
`blend-modes`, `blend-formulas`, `blend-drift`, `blend-subpixel`,
`blend-edges`, `blend-nested`, `blend-outside-mask`,
`blend-layer-colors`. `draw-counts`: `blend-mask` and `blend-bitmaps`
down in `bindFramebuffer`.

## 4. Samples by device pixel ratio on desktop

### What is there

`stageSamples` (`packages/web/src/playback.ts`) takes 4 samples at
medium, 8 at high and 16 at best; fewer on a large canvas
(`fittingSamples`, 256 MiB); and fewer for each canvas pixel where the
screen is finer than CSS pixels (`denseSamples`, #604), by the lesser of
the canvas's pixels a stage pixel and the device pixel ratio, since a
stage only zoomed on a coarse screen showed its steps at 4 (#756).
Layers take the stage's count (`TargetPool.beginFrame`). Flash
supersamples on a grid, 2×2 at medium and 4×4 at high and best: 16
samples, but 4 levels along an axis-aligned edge.

### The reasoning, extended

`denseSamples` asks for as many samples a stage pixel as the quality
takes at a ratio of 1, never under 4 a canvas pixel. So:

| ratio | high, a canvas pixel | a stage pixel |
|---|---|---|
| 1 | 8 | 8 |
| 1.25 | 8 | 12.5 |
| 1.5 | 4 | 9 |
| 2 | 4 | 16 |

Three steps, each to be measured before it is taken:

- **Ratios between 1 and 1.5,** the common Windows scalings: 8 is taken
  where 4 would give 6.25 a stage pixel at 1.25. Whether that reads as
  rough is #756's question again; the rule would be 4 from the ratio at
  which adl's edges and ours differ no more than they do at 1.5 today.
- **Layers below the stage.** A filter layer whose output does not show
  the object's own edge (a blur of two pixels or more, a knocked-out
  glow, a shadow with `hideObject`) is blurred after it is resolved, and
  can take 4 samples, or none for a wide blur, whatever the stage takes.
  A layer that shows the object keeps the stage's count, or its edges
  differ from its neighbours' (`filter-coverage.ts`).
- **Best at a ratio of 1** keeps 16: it is what Flash's best asks, and a
  small canvas affords it.

The constraint is Flash at each quality. Low stays aliased. Medium is
Flash's 2×2 and already 4. High and best are where samples are spent,
and where an integrated GPU pays in memory bandwidth.

### Risks to fidelity

Shallow edges step in quarters instead of eighths; #604 measured up to
122 levels on single pixels along them at ratios of 2 and 3, a mean of
0.06 to 0.1. At 1.25 a canvas pixel is larger on the retina than at 2,
so the same difference shows more.

### Measured by

- The GPU saturated, in cycles a render, at 4, 8 and 16 samples and
  ratios of 1, 1.25, 1.5 and 2, on an integrated GPU, with
  `bench.ts --town --gpu` and `render-bench.ts --targets`. On the busy
  replay at 1.45, 8 against 4 left the frame's work the same and raised
  the GPU's clock from 315 to 374 MHz (#756): the GPU was not the
  limit there, so this item pays only where it is.
- A mode `--ratio R` for `bench.ts`, setting the page's device pixel
  ratio, which the samples follow.
- A win: saturated GPU cycles down a fifth at the ratio changed, with
  the edge difference from adl no worse than today's at 1.5.

### Pull requests

1. `--ratio`, and a table of saturated GPU time by samples and ratio in
   `docs/benchmarks.md`.
2. Fewer samples for layers that show no edge of their object.
3. The threshold ratio moved, only if 1's table and the edge
   comparison both allow it.

### Tests

`stage-quality-*` against Flash at each quality; unit tests of
`stageSamples` over ratios; `filter-coverage.ts` with a layer and the
stage at different counts; `blend-antialias` and `blend-kept-antialias`.

## 5. A retained scene walk

### What is there

`RenderView.render` resets the scene list, the rows and the filters and
walks the whole display list (`walk`, `scene/view.ts`). Three things are
already skipped: a frame where nothing changed draws nothing
(`unchanged`); a hidden subtree with nothing dirty is passed over
(`scene/hidden.ts`, #735); and a kept output's content is walked hidden.
Every object carries `dirty` (`TRANSFORM`, `CHILDREN`, `CONTENT`) and
`descendantsDirty`, set up to the root by `invalidate`
(`display/displayobject.ts`) and cleared by the walk.

### The design

Keep each subtree's **span** of the scene list from the frame before,
and write again only what changed. In three steps, each useful alone:

1. **Rows only.** A frame in which no object has more than `TRANSFORM`
   dirty, no morph took a new ratio and no line's stretch changed keeps
   its scene list as it is: the walk visits only dirty objects and
   their subtrees, and writes their rows where they were. Rows are
   concatenated from the stage, so a moved container rewrites its
   subtree's rows; a clean subtree under a clean path is not visited.
   Layers are measured again (`measureLayers`) and the frame planned
   again, which costs little; kept outputs and filter plans are asked
   as now.
2. **Spans.** A container remembers where its subtree's entries began
   and ended, and how many rows, layers and masks they took. A clean
   subtree's span is copied forward, its indices offset; a dirty one is
   walked. The list stays in painter's order and typed arrays; the
   planner sees no difference.
3. **Plans.** Only if planning shows in a profile after 2: the commands
   of an unchanged span reused.

What a span depends on beyond its objects' flags decides whether this
is sound, and is the work:

- the ancestors' transform (line stretch, `settledStretch`, hairline
  width, 9-slice, `facing` for culled triangles) and colour;
- the view's scale, quality and screen scale (`keptGeneration`);
- geometry handles that expire when undrawn (`parts.ts`,
  `IDLE_FRAMES`), which a copied span must still mark as used;
- morph ratios, taken as a shape is drawn;
- text, whose device textures follow the scale;
- masks, whose own subtrees are walked where they are used, and alpha
  masks, drawn inside what they mask;
- `BitmapData.draw`'s passes, which walk a subtree from another root
  and must neither read nor clear the stage's spans (`PassState`).

A span that depends on something not tracked is not kept: correctness
first, then coverage raised by what the profile shows is common.

### Risks to fidelity

The walk clears flags and takes morphs' ratios, which bounds and hit
tests follow (`morph-shapes`): a subtree not visited must have nothing
of the kind pending, which is what `descendantsDirty` already promises
for hidden subtrees. A stale span draws a stale frame, which no pixel
test catches unless it changes that thing: hence the checked mode
below.

### Measured by

- First: on the busy replay, how many objects a frame are visited
  against how many have any flag set, and how many frames are rows
  only. If most of the tree is dirty most frames, stop.
- Bench: `render-bench.ts`'s visible, moving and hidden scenes report the
  walk apart already; add one where a tenth of the branches move. A
  mode `--still-crowd N` for `bench.ts`: a large still scene with a few
  clips playing.
- A win: the walk's time down by half on a scene a tenth dirty, and the
  replay's main-thread time a frame down by a tenth; no scene slower.

### Pull requests

1. The dirty census, and a checked mode: an option of the view, which
   `pnpm test:checked` turns on, under which it walks in full as well
   and compares the scene list and rows entry for entry.
2. Rows-only frames.
3. Spans for containers with no mask, layer or text inside.
4. Spans across layers, masks and text, one kind a pull request.

### Tests

Every player case and the corpus under the checked mode, which is the
test; `redraw.ts`, `resize.ts`, `context-loss.ts` (a loss drops every
span), `leak.ts` (spans must not hold geometry past its idle frames);
unit tests of span offsets as data.

## 6. A render worker with OffscreenCanvas, later

### What would move

The backend and the planner have no need of the page: they take typed
arrays (the scene list, rows, filters, commands) and a WebGL 2 context,
which an `OffscreenCanvas` transferred from the element gives a worker.
The walk cannot move alone: it reads the display list, which lives with
the player and AS3. So there are two shapes:

- **The backend alone in a worker.** The page walks, then posts the
  scene list, rows and filters, with the geometries and textures added
  that frame, as transferred buffers. The worker plans and draws. What
  moves off the page's thread is planning, submission and the GL calls'
  own cost there: a few percent of a busy frame.
- **The player in a worker,** renderer and all, the page keeping input,
  text entry, audio and the DOM. This moves everything, and is a
  different project: it is how Flash Workers already run a player
  ([workers.md](workers.md)), without a stage.

### What stands in the way

- **Synchronous results.** `BitmapData.draw` draws on the GPU and a
  later `getPixel` reads it back at once (`bitmap/draw.ts`,
  `WebGLBackend.snapshot`, `readTexture`). A page cannot wait on a
  worker; with the backend alone in a worker, BitmapData needs a
  context of its own on the page, and its textures cannot be shared
  with the stage's. This alone may rule the first shape out.
- **The DOM the view uses:** device text rasterized on a 2D canvas
  (`scene/text.ts`, possible on an `OffscreenCanvas` with the fonts
  loaded in the worker), video frames (`scene/videos.ts`,
  `VideoFrame`s transferred), the pointer and the context menu
  (`scene/pointer.ts`, `context-menu.ts`, which stay on the page).
- **Presentation.** A worker's frames reach the screen when it commits
  them; resizing the canvas from the page must reach the worker before
  the frame it applies to, or a frame stretches (`resize.ts`).
- **Context loss** is told to the worker; the restore path, which makes
  everything again from what the player keeps, then crosses threads.
- **Stage3D** shares the device layer and is to share the stage's
  context.
- **Browsers:** WebGL 2 on an `OffscreenCanvas` in a worker is in
  current Chrome, Firefox and Safari; `WEBGL_multi_draw` and timing
  there need checking.

### Measured by

Before any design: on the busy replay, the page's main-thread time by
part (walk, plan, submit, GL calls), so that the first shape's ceiling
is a number. A prototype would post a recorded frame's lists to a
worker and time the copies. A win is the page's long frames (p99)
falling, not its median.

### Pull requests

None planned. A design document of its own once items 2 and 5 have
changed what a frame costs on the page, and the ceiling is measured.

## Ranking

By expected gain for the work, with what it rests on:

1. **Cached outputs as quads (item 2), slices 1 and 2.** The one item
   with a measured mechanism in a bench scene: `--town`'s runs are cut
   to under five fills, which keeps merging from applying to 3,500
   sub-draws. Slice 2 reuses the fill program, the slots and the held
   pages; the atlas (slice 4) follows only if textures run out of
   slots. *Thin:* that the composites are what cuts the runs is read
   from counts, not traced; and fewer switches alone gave nothing
   before. The run census settles the first, a GPU A/B the second.
2. **Keeping blend layers' content (item 3).** Small, as it is
   `keptOutput` with an empty chain and its cases exist; it removes
   multisampled fill, resolves and framebuffer binds, which the last
   profile named as the GPU process's cost. *Thin:* how many of a
   room's hundred blend layers hold more than one flat fill, which
   `blendDirect` already draws without a layer. Count them first.
3. **A retained walk, rows-only first (item 5).** The largest known
   share of the page's thread that is the renderer's, 15 to 18% of busy
   time, and the only item that lowers it. More work and more risk than
   1 and 2, bounded by the checked mode. *Thin:* how dirty a busy
   frame's tree is; the census says whether rows-only frames exist in
   real content.
4. **Samples by ratio (item 4).** A day's work for the policy, but it
   pays only where the GPU is the limit, which the busy replay at 1.45
   was not; layers that show no edge are the safer half. *Thin:* no
   saturated measurement at a ratio of 1 since `denseSamples`.
5. **Instancing (item 1).** Asked for first, ranked fifth: stable small
   repeats are merged into real draws already, the crowd is three
   calls, and a crowd in painter's order has few adjacent repeats. It
   may still pay for large shared parts and in Firefox. *Thin:*
   everything but the calls; the census is a day and decides it. If
   repeats turn out common in real content it moves to second.
6. **A render worker (item 6).** The most work, synchronous
   `BitmapData` results in the way, and a ceiling of a few percent
   unless the player moves too.

### Measure first

One pull request before any of the above adds to `bench.ts --counts`
and `draw-counts.ts`, with no change in drawing:

- sub-draws by path, and repeats among those not merged (item 1);
- what ended each run, and run lengths (item 2);
- blend layers by draws inside and area, and backdrop copies (item 3);
- objects visited and objects dirty a frame, and rows-only frames
  (item 5).

Then one run of each on `--town`, `--vectors`, `--blends`, the crowd
and the busy replay on an Intel GPU, and saturated GPU time at 4, 8 and
16 samples at a ratio of 1 (item 4). The ranking above is redone from
that table, and this document updated with it.

## Open questions

- Is GPU-process time on the busy replay still about 9 ms a render,
  and is it draws executed or passes broken? The last profile is from
  2026-11-06, before #776 and two weeks of other changes.
- Do fewer, longer runs lower GPU-process time once merging applies to
  them, where fewer state changes alone did not?
- At which ratio between 1 and 1.5 do 4 samples a canvas pixel stop
  showing against adl?
- Should `cacheAsBitmap` alone keep a bitmap, as Flash does, with its
  whole-pixel moves, or stay vectors, which are sharper under a zoom?
- Does the render worker mean the backend alone, or the player?
