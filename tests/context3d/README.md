# Context3D rendering experiment

An opt-in vertical slice: a real AS3 SWF requests a Context3D, uploads
vertex/index buffers and AGAL, draws an indexed triangle, reads it through
BitmapData, presents, and disposes its resources.

```sh
pnpm build
node --test tests/context3d/agal.test.ts
node tests/context3d/run.ts
```

`reference.json` is the trace from the same AS3 source in AIR, using direct
render mode. To check it with an installed AIR SDK:

```sh
node tests/context3d/oracle.ts
# Deliberately replace it after changing the reference fixture:
node tests/context3d/oracle.ts --update
node tests/context3d/oracle.ts --lifecycle
node tests/context3d/oracle.ts --arithmetic
node tests/context3d/oracle.ts --texturing
node tests/context3d/oracle.ts --depth
node tests/context3d/oracle.ts --blending
node tests/context3d/oracle.ts --colormask
node tests/context3d/oracle.ts --stencil
node tests/context3d/oracle.ts --bufferbytes
node tests/context3d/oracle.ts --texturebytes
node tests/context3d/oracle.ts --vertexformats
node tests/context3d/oracle.ts --shader-math
node tests/context3d/oracle.ts --scissor
node tests/context3d/oracle.ts --mipmaps
node tests/context3d/oracle.ts --multisampling
node tests/context3d/oracle.ts --temporarymatrices
node tests/context3d/oracle.ts --cubetextures
node tests/context3d/oracle.ts --rendertargets
node tests/context3d/oracle.ts --reconfigure
node tests/context3d/oracle.ts --framevalidation
node tests/context3d/oracle.ts --framevalidationflat
# Requires a reference driver that implements pixel-shader predication:
node tests/context3d/oracle.ts --comparisons
```

`AMXMLC` and `ADL` select the SDK commands. The reference runner is separate
from `oracle/flash.ts`: that harness uses CPU display-list capture, which
does not capture Stage3D.

The native adapter exchanges buffers, programs, textures and pixels through
`backend.ts`; it imports no Pixi or WebGL code. The WebGL2 backend owns its
context and resources. Presentation copies the offscreen back buffer to
the canvas, so a subsequent clear does not alter the presented image.
Readback reuses its storage and converts GL's bottom-up rows to top-down
RGBA before the native adapter writes transparent BitmapData. AIR preserves
the render buffer's RGB channels and raises alpha to at least the largest
color channel. Multiplying RGB by alpha again would darken uploaded textures.

Browser checks cover the AIR trace, presentation preservation, unchanged
unavailable-context fallback, cancellation before creation, resource
ownership, shader swizzles and clip depth, failed shader replacement,
resize, disposal and refusal after context loss. They count actual
created/deleted GPU handles.

`BufferBytes.as` compares 334 trace lines (including 117 pixel samples) with AIR
for vertex/index `uploadFromByteArray`: byte offsets 0 through 7, destination
subranges, partial replacements, mixing vector/byte uploads, source mutation,
logical length versus capacity, zero counts and invalid ranges. The bytes are
little-endian regardless of the ByteArray's endian flag; its position, length and
flag remain unchanged. Null sources fail with TypeError 2007 before lifetime
checks. Explicitly disposed buffers ignore non-null uploads, including invalid
ranges and uploads after owner disposal. Other buffers whose owner is disposed
fail with Error 3694; live invalid ranges fail with RangeError 3669.

The backend uploads the existing byte view with WebGL2 source offsets and lengths,
without allocating temporary arrays or views. Index uploads update the existing
CPU index storage for draw validation. Zero counts skip the GL upload: WebGL's
zero source-length argument would otherwise upload the rest of the view.
Browser checks cover raw float-bit preservation, nonzero view offsets, source
independence, unchanged storage/GPU handles, bounds/ownership and cleanup.
Recovery checks reject uploads to lost buffers and upload fresh byte buffers after
restoration.

`TextureBytes.as` checks 396 AIR trace lines, including 212 pixel samples, for
2D/cube `uploadFromByteArray`. Top-down BGRA bytes are copied without multiplying
or dividing by alpha; the ByteArray's endian flag and position do not affect
the upload or change afterward. Tests cover offsets 0–7, transparent and
non-premultiplied values, rectangular mip chains, six cube faces, source mutation,
bitmap/byte replacements, logical-length bounds and render-target initialization.
Only a successful base-level upload initializes the target; failed or smaller-mip
uploads do not. Null data fails first (2007); explicit texture disposal ignores
non-null uploads even after owner disposal. Other retired owners fail with 3694,
then invalid faces (3673), mip levels (3674), and source ranges (3669) are checked
in that order.

The backend swizzles BGRA into the existing RGBA staging array with an indexed
loop. Both upload paths, every mip and every cube face share that storage;
uploads create no temporary arrays or views. Browser checks inspect raw GPU
bytes at each mip/face, including nonzero source-view offsets, assert unchanged
staging/GPU handles, and check invalid uploads, disposal and context recovery.

`VertexFormats.as` compares 681 AIR trace lines, including 1,128 pixel samples,
for `bytes4` and the four float formats. Packed attributes consume one 32-bit
word and expose its four bytes in memory order as unsigned values divided by
255. Checks cover every byte value, alpha and swizzles, separate/interleaved
streams, float defaults, format changes, offset/stride bounds, null buffers,
invalid formats and disposed resources/contexts. With a live context and buffer,
null/invalid formats fail first (2007/2008); negative slots fail with 2006 even
after disposal. Null/disposed buffers ignore the format. Offset/stride errors
are deferred until a draw consumes the attribute (3610). This experiment still
limits bindings to the eight attributes accessible to its AGAL v1 shaders;
AIR accepted bindings at slot 8 in a separate probe.

The backend uses normalized `UNSIGNED_BYTE` vertex attributes; it does not
expand packed vertices or generate conversion shaders. Binding records are
reused, and stride validity is cached at binding time. Browser checks cover
repeated float/packed transitions, unchanged GPU handles/readback storage,
failed draws preserving pixels and GL validity, resize, ownership and teardown.
Recovery poisons a vertex binding with `bytes4` before losing each context.

One vector-upload discrepancy remains open. On the tested Wine AIR backend,
uploading `Vector.<Number>([1,1,1,1])` to a one-word stream and drawing it first
as `bytes4` produces zero RGB. Drawing it as `float1` first, then as `bytes4`,
exposes the expected float bit pattern (RGB 0,0,128). Changing or clearing the
binding alone did not resolve it. The experiment consistently reads raw buffer
bytes; it does not emulate that state-dependent result. The fixture covers
reinterpretation after a float draw. To reproduce the unresolved case, insert
a `bytes4` binding and capture immediately after its vector upload, before the
`float1` capture. Native AIR confirmation is needed before treating this as
general Flash behavior or a driver issue.

`Reconfigure.as` checks 48 AIR pixel samples for an unchanged back-buffer
configuration: retained color and depth, program/vertex/constant bindings,
scissor, blending, culling, returning from a texture pass, and clearing after
presentation. It covers ordinary and multisampled back buffers. Repeating the
same dimensions, depth setting and antialiasing request now preserves the GPU
resources and readback arrays, without capability or completeness queries.
Browser checks cover both depth settings, failed-resize rollback, disposal
and context loss. A changed request still takes the existing allocation path.

`FrameValidation.as` and its generated depth-disabled variant compare 514 trace
lines with AIR. Back-buffer readback requires a color clear, plus depth and stencil
clears when those attachments are enabled; separate clear masks accumulate.
Presentation and changed back-buffer configuration invalidate that state.
Readback always enforces it (3692), while drawing and presenting enforce it only
with error checking enabled. A failed presentation still returns to the back buffer.

Texture targets have separate initialization state (3777): any successful clear,
including mask zero, or a level-zero bitmap/byte upload initializes them. Uploading
only a smaller mip does not. Initialization survives presentation and depth toggles.
The fixture checks both target depth settings, all clear masks, repeated presentation,
resize, disposal, and that rejected operations leave the destination bitmap unchanged.
The adapter keeps this state in existing context/resource records; it adds no
per-frame objects or GPU queries. These checks do not claim full error-precedence
or invalid-argument parity.

`Lifecycle.as` checks explicit context recreation against AIR:
`dispose()` clears the slot immediately and queues a fresh context;
`dispose(false)` leaves it empty until another request. The new context
starts with no configured back buffer and error checking disabled, while
the slot keeps its position and visibility. Disposing an old context again
does not affect its replacement. The browser also verifies that closing the
host cancels queued recreation and that each retired context releases its
GPU resources.

`Recovery.as` exercises browser GPU loss with `WEBGL_lose_context`. The
host keeps the lost canvas until the browser signals restoration, while
the native adapter immediately retires the AS3 context and its resources.
Restoration releases that surface and queues a new context on a fresh
surface. The AS3 creation listener uploads new buffers and shaders and
draws a triangle again; the browser checks red, green and blue presentations
over two recovery cycles.
The recovered contexts have depth/stencil attachments; depth/culling/stencil state
set to reject all draws, zero blend factors and disabled color writes before loss must
not survive into the replacement.

These checks also cover retained vertex/index buffers, programs and textures rejecting
use after loss, fresh context defaults, preserved slot placement, duplicate
notifications and callbacks from retired surfaces. Closing the host during
loss or after recreation has been queued prevents resurrection and detaches
the browser listeners. The native boundary carries loss/restoration
notifications without browser or WebGL types.

Forced WebGL recovery is a browser integration check, not an AIR hardware-loss
oracle. The disposed-object behavior is separately covered by the AIR lifecycle
reference. This probe replaces the surface after restoration; it does not
restore GPU resources automatically or establish the production recovery design.

The lifecycle reference covers error IDs for an unconfigured clear (3698),
undersized back buffers (3780/3781), and operations on disposed contexts,
buffers and programs (3694). Disposed context getters and repeated resource
disposal are checked too. Other validation remains experimental; this is
not complete Flash error parity.

`Arithmetic.as` compares finite arithmetic and matrix results with AIR:
`add`, `sub`, `mul`, `div`, `min`, `max`, `dp3`, `dp4`, `abs`, `neg`, `sat`,
`m33`, `m44` and `m43`. The fixture checks swizzles, masked writes, temporary
registers that are both inputs and outputs, and both matrix-upload transpose
settings. It samples transformed geometry as well as fragment colors and
verifies that uploading a Matrix3D does not mutate it. Matrix uploads reuse
one scratch array and copy into the backend's constant storage.

The arithmetic reference also covers null matrices (TypeError 2007),
negative register indices (RangeError 2006) and invalid program types
(ArgumentError 2008). The prototype still limits constants to 128 vertex
and 28 fragment registers; AIR can accept uploads beyond those limits.
The parser rejects matrix spans beyond those limits before GPU allocation.
Matrix operands require consecutive, unswizzled constant or temporary registers;
three-row instructions require a destination mask within xyz (exact xyz for temporaries). Indirect reads,
other instructions and broader numeric edge-case parity remain future work.

`TemporaryMatrices.as` adds 144 AIR pixel samples for `m33`, `m44` and `m43`
reading matrices from temporary registers, as Away3D's normal mapping does.
Both shader stages cover independent destinations, destinations overlapping
input vectors or matrix rows, input swizzles and partial `m44` writes. Matrix
row spans are checked against the eight-register temporary bank. Three-row
temporary matrices require an exact `.xyz` write mask: AIR rejected `.xz`.
These remain GPU operations, translated only at program upload.

`ShaderMath.as` adds 309 AIR pixel samples for `frc`, `sqt`, `rsq`, `pow`,
`nrm`, `crs`, vertex `sge`/`slt`, and fragment `kil`. Both shader stages exercise
math with swizzled inputs, masked writes, independent destinations and supported
overlapping temporary registers. Discard tests select each scalar lane, cover
negative/zero/positive values before and after the color write, and discard
part of a triangle using an interpolated varying.

`Comparisons.as` checks fragment `sge`/`slt` with 368 independently calculated
pixel expectations: negative, positive and equal inputs, signed zero, both source
swizzles, every destination lane, vector/partial writes, either input overlapping
the destination and interpolated inputs crossing a comparison boundary. Results
are calculated with AS3 comparisons, following the
[AGAL rules](https://airsdk.dev/docs/development/appendixes/adobe-graphics-assembly-language-agal/agal-bytecode-format).
This is not an AIR pixel reference. The available Wine OpenGL backend logs
`Predicates not implemented` and drops the conditional assignments emitted by
AIR, making both true and false fragment comparisons produce one. Its Vulkan
path did not draw the probe; AIR software rendering failed shader compilation.
The optional oracle command runs the same self-check and fails on that setup,
even with `--update`; it does not save those broken results as a reference.
The translator now emits GLSL comparisons in either stage, with no new per-draw
JavaScript work. Native AIR confirmation remains outstanding.

This slice deliberately rejects other unresolved cases. Swizzled source
registers overlapping a root/power destination differed when they changed
a written lane. `sqt`/`pow` reject that overlap; identity and same-lane scalar
overlap are covered. The scalar probes check every lane in both stages and
`pow` with either or both operands sharing its destination. `nrm`/`crs` currently
require an exact `.xyz` destination mask: AIR rejected the partial `.y` probe.
`kil` requires a replicated scalar swizzle from a temporary or varying, a zero
destination, and an empty second operand. Other encodings fail before GPU
allocation. The numeric reference uses finite inputs in each operation's domain;
zero-length normalization, non-finite values and out-of-domain roots/powers do
not have parity coverage.

The new instructions are translated once at program upload. Execution stays in
the GPU shader and adds no per-draw JavaScript arrays or resource allocations.

`Texturing.as` checks AGAL `tex` and level-zero `Texture.uploadFromBitmapData`
against AIR. The fixture covers top-down UV orientation, nearest and linear
filtering, clamp and repeat wrapping, separate sampler states, reupload,
transparent pixels and premultiplied color, plus partially transparent clear
readback. The upload copies into one reusable RGBA staging array per texture;
draws reuse lazily created sampler objects. Browser checks verify staging
array identity and stable GPU handles across repeated uploads and draws,
texture bindings across a resize, and cleanup after disposal and context loss.

The texture reference covers unused bindings (3697), incompatible sampler
states for the same texture (3695), and drawing with a disposed texture (3663).
AIR accepts upload and binding calls on an explicitly disposed texture without
reviving it; an upload after its owner context is disposed fails with 3694.
The prototype retains only weak ownership records for retired textures.

This slice supports power-of-two 2D `bgra` textures, 1×1 through 2048×2048,
and cube `bgra` textures up to 1024×1024 per face,
with no LOD bias, sampler overrides or rectangle/compressed textures.
Upload dimensions must match the selected mip level. Each context
is limited to 128 textures and 64 MiB of texels (including mip chains), with another 64 MiB maximum
for CPU staging arrays; these are experimental resource limits.
Readback into opaque BitmapData is explicitly unsupported: AIR can preserve
non-opaque alpha there, which requires broader work on BitmapData's current
opaque-pixel invariant. Fractional clear-color quantization also differs
between backends; the fixture uses representable byte values.

`RenderTargets.as` checks level-zero 2D render targets against AIR: switching
between differently sized targets and the back buffer, retained color and
depth, depth disabled per target, top-down sampling and scissor coordinates,
culling, transparent color, texture upload followed by rendering, and generated
mipmaps when minifying the result. Textures created with either optimization
flag can be used as targets. `drawToBitmapData()` continues to read the back
buffer while a texture is selected; `present()` and a null target resume the
back buffer. Sampling the active target fails with AIR's error 3604.

Targets reuse a framebuffer and an optional depth/stencil attachment per
texture. Target changes do not copy through the CPU. Vertex output flips Y for
texture targets, with matching winding and scissor state, so sampled results
share the uploaded texture orientation. Color writes mark mipmaps dirty;
leaving a changed target generates its mip chain on the GPU. Warm switches
allocate no GPU handles and do not query framebuffer completeness. Browser
checks cover repeated passes, an antialiased back buffer, foreign/disposed
textures, framebuffer/depth allocation failures, incomplete attachments,
feedback rejection, disposal and context loss. Failed switches preserve the
previous target; all tracked GPU handles are released on teardown.

This slice limits render targets to power-of-two 2D textures from 8×8 through
2048×2048, with no target antialiasing, cube faces or multiple color outputs.
A 1×1 AIR rasterization probe differed; smaller targets remain unverified.
Resizing the back buffer while a texture is selected is explicitly rejected.
Target depth storage has a separate 64 MiB budget. Full validation/error parity
and fractional clear-color rounding across GPU drivers remain future work.

`Mipmaps.as` checks nearest and linear mip selection with both texture filters,
including trilinear interpolation, non-square chains down to 1×1, LOD clamping,
level reupload and presentation. Its 45-line AIR reference includes unuploaded
base data (3605), incomplete chains (3700) and an out-of-range level (3674).
Every level is uploaded explicitly; the backend does not generate mipmaps.
All levels share the texture's existing base-sized CPU staging array. The twelve
filter/wrap/mip combinations use lazily cached sampler objects. Browser checks
verify stable staging storage and GPU handles across mip reuploads, with cleanup
after disposal and context loss. Mip sampling adds no per-draw arrays.

`CubeTextures.as` compares all six cube faces with AIR, including asymmetric
quadrants to detect flips, nearest/linear filtering, all three mip modes,
minification, face reupload and presentation.
The AIR reference also checks missing faces/mips (3700), an entirely unuploaded
cube (3605), invalid faces/levels (3673/3674), mismatched sampler dimensions (3754),
and rebinding an explicitly disposed texture (3663). AIR requires the full cube
mip chain even when mip filtering is disabled.

All six faces and mip levels reuse one face-sized CPU staging array. The GPU
budget counts every face and mip; shader sampling stays on the GPU. Browser
checks verify staging identity, stable GPU handles during repeated uploads,
unbinding, resize, disposal, cross-context rejection and loss cleanup. This
adds no per-draw JavaScript arrays. Edge seams, hardware-dependent filtering
rounding and broader cube validation remain unverified. AIR can keep drawing
an already-bound texture after its disposal until it is rebound; this experiment
still releases and unbinds immediately, as it already did for 2D textures.

`Multisampling.as` checks antialiasing quality requests, interior readback,
scissor interaction, presentation followed by clear, and resize against AIR.
Quality is a device-dependent request: this experiment picks a supported color
and depth sample count no greater than the request, capped at 4×; it falls back
to no antialiasing when no common count is available. Negative and unusually
large integer requests are accepted by AIR. Exact edge coverage is GPU-dependent
and is not compared pixel-for-pixel against AIR.

The backend draws into multisampled renderbuffers and resolves into its existing
single-sample texture only after color changes. Readback followed by presentation
reuses the resolve; depth-only clears do not invalidate it. Scissor state cannot
clip the resolve or presentation. Browser checks verify partially covered edges,
resolve counts, warm resource reuse, fallback, repeated resizing, disabling MSAA,
failed allocation/framebuffer rollback and full cleanup. Recovery also uses 4×
back buffers. Allocations occur at configuration, with no new per-draw arrays.
AS3 clear-before-read validation lives in the native adapter; the backend's
readback method remains available to renderer diagnostics after presentation.

`Scissor.as` checks top-left clipping against AIR, including fractional edge
rounding, empty and negative-sized rectangles, clipping to the viewport, and
error 3706 for a nonempty rectangle outside the target. Rectangles are copied
at the setter; clears ignore them, and clear/present/resize preserve their state.
Browser checks separately verify that presentation copies pixels outside the
scissor and that a replacement context starts with clipping disabled. Non-finite
rectangle coordinates remain explicitly unsupported in this experiment.

A local diagnostic of Away3D OpenFL's `Basic_View.swf` now draws its textured
plane: 59 draws/presentations over 60 ticks, no uncaught errors and no WebGL error.
This is a real-sample smoke check, not an AIR image comparison or general Away3D
compatibility claim. The sample binary is not included in this repository.

The local `Basic_Shading.swf` smoke check also draws its floor, sphere, cube and
torus with normal/specular mapping: 236 draws and 59 presentations over 60 ticks,
no uncaught or WebGL error. It exercises 4× back buffers, temporary matrix rows
and scalar in-place powers. As with Basic_View, this is not an AIR pixel-parity
claim, and its binary stays outside the repository.

The local `Basic_SkyBox.swf` check draws its mountain environment and reflective
torus: 118 draws and 59 presentations over 60 ticks, with no uncaught or WebGL
error. It exercises cube uploads and sampling without native overrides. This is
another smoke check, not AIR image parity; the sample binary is not included.

The local `Basic_Load3DS.swf` smoke check draws its textured ant and moving shadow:
239 presentations and 239 shadow-target passes over 240 ticks, without uncaught
or WebGL errors. Reusing unchanged back buffers reduced cumulative GPU handle
creation from 741 to 21; two runs created no further handles after warmup.
Live handles stayed at 17 at ticks 60, 120 and 240, and teardown released them
all. These are resource counts, not FPS measurements or a claim that the whole
player allocates nothing. This exercises render-to-texture and fragment comparisons
together; it does not establish AIR image parity. The downloaded sample stays
outside the repository.

`Depth.as` compares 53 pixel samples with AIR. It covers all eight depth
comparisons and four culling modes, the default strict `less` test with writes
enabled, clockwise front faces, reversed indices and mirrored geometry.
It also checks perspective depth, clipping outside the 0..w depth range,
far-plane inclusion, depth write masks, partial clear masks, and state
preservation across back-buffer resize. Clearing depth ignores the draw-time
write mask, then restores it for subsequent draws. Invalid enum values produce
ArgumentError 2008 even after disposal; valid depth/culling setters on a disposed
AS3 context are accepted without touching the backend.

Depth-enabled back buffers own a DEPTH24_STENCIL8 renderbuffer. Browser checks
count its lifetime through resize, depth disabling, failed allocation,
incomplete framebuffer creation, disposal and actual context loss. A failed
resize keeps the previous back buffer usable. Color-only targets still bypass
depth comparisons. Depth and culling state changes allocate no per-draw arrays
or GPU resources; an attachment is created only when configuring a depth-enabled
back buffer. The AIR oracle uses a depth-enabled window descriptor for this
fixture, as AIR requires its window and Context3D flags to agree.

Clear masks support color/depth/stencil bits (1/2/4), zero and the default
all-bits mask; broader numeric validation and precision parity remain future work.

`Stencil.as` compares 191 trace lines with AIR for all eight comparisons and actions,
including saturating/wrapping limits, independent front/back state, both windings,
and simultaneous depth/stencil failures. It reads stencil values through eight
masked color tests. Reference/read/write masks use their low eight bits; stencil
clears clamp to 255 and ignore draw-time write masks and scissor clipping, then
restore those settings. Selecting `none` leaves both faces' settings unchanged.

The fixture also covers unchanged configuration, resize, ordinary/4× back buffers,
presentation, retained texture-target stencil contents, target depth toggles,
target winding, invalid enums preserving state, and disposed setters. State changes
reuse two face records and skip unchanged GL calls. There are no new per-draw
allocations or GPU queries. Browser checks verify full-buffer resolve/presentation,
stable readback storage and GPU handles, color-only targets, teardown, and fresh
stencil defaults after context loss. Broader stencil error precedence and shader
discard interactions remain unverified.

`Blending.as` compares all 100 pairs of the ten source/destination blend factors
against AIR, including fractional color and alpha channels. Additional samples
cover default replacement, additive saturation, zero/full source alpha,
premultiplied source-over, clear independence and state preservation across resize
and presentation. Invalid factors leave the previous state intact and produce
ArgumentError 2008, including after disposal; valid setters on disposed AS3
contexts are ignored.

Blend factors apply to both color and alpha channels with additive blending.
The backend disables blending for `one`/`zero` replacement and uses WebGL blend
state for other combinations. State changes create no arrays or GPU resources.
The browser recovery test verifies fresh blend defaults after loss. These samples
match exactly on the tested backends; they do not establish rounding parity across
all GPU drivers.

`ColorMask.as` compares 77 pixel samples with AIR, including all 16 channel
masks with ordinary and 4× back buffers. Clears ignore the channel mask and
restore it for subsequent draws. The fixture covers alpha-only writes, a
color-disabled depth pass, depth-only clears, additive blending, unchanged
configuration, resize, presentation and texture-target transitions. A valid
setter on a disposed AS3 context is accepted without touching the backend.

The backend stores the mask in one integer and skips unchanged GL mask settings.
There are no new per-draw allocations or GPU queries. Browser checks verify that
resolve and presentation copy all channels even with color writes disabled,
repeated use preserves readback storage and GPU handles, teardown releases all
handles, and context recovery restores the default all-channel mask.

`Composition.as` exercises two Stage3D slots beneath ordinary Flash
graphics, including an opaque and a translucent overlay. The browser test
uses the existing Pixi view for the display list and separate canvas layers
for Stage3D. The host receives only slot indices, position, visibility and
resource operations. It removes each surface when its context is disposed.

The composition test compares eight interior pixel samples in nine states
against AIR: overlapping slots created in reverse order, visibility,
movement, clear without presentation, presentation, resize, negative
position/clipping and disposal. Slot 1 covers slot 0; the display list
covers both. The reference also checks that Stage3D surfaces stay opaque
with a zero clear alpha. A one-channel-value tolerance allows rounding of
the translucent overlay.

To regenerate those samples, the optional runner captures AIR's actual
window using ImageMagick's `import` on X11/XWayland. It activates a small
reference window; keep that window visible during the run. Captures go
under `out/composition-oracle/`, with sample values in
`composition-reference.json`.

```sh
node tests/context3d/composition-oracle.ts
node tests/context3d/composition-oracle.ts --update
```

This is **not enabled in the player, website, desktop app or game preview**.
The test installs natives before loading playerglobal and explicitly
tears down its host. Only the AGAL v1 instructions listed above plus `mov`,
float and packed-byte vertex attributes, vector/matrix uploads, depth/stencil testing, culling, blending,
color rendering and back buffers with optional multisampling are exercised, with sizes limited to
32×32 through 2048×2048.
Unsupported operations throw experimental errors, not a claim of
Flash-compatible validation.

Next gates are the unresolved shader cases above and broader render-target support,
alongside broader Flash error semantics and numeric coverage.
The separate WebGL contexts and canvas
layers isolate this probe; production integration still needs its own
presentation and resource-sharing design. These sample checks do not claim
complete pixel parity for arbitrary Stage3D content.
