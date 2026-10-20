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
node tests/context3d/oracle.ts --shader-math
node tests/context3d/oracle.ts --scissor
node tests/context3d/oracle.ts --mipmaps
node tests/context3d/oracle.ts --multisampling
node tests/context3d/oracle.ts --temporarymatrices
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
The recovered contexts have depth/stencil attachments; depth/culling state set to
reject all draws and zero blend factors before loss must not survive into the replacement.

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

`ShaderMath.as` adds 213 AIR pixel samples for `frc`, `sqt`, `rsq`, `pow`,
`nrm`, `crs`, vertex `sge`/`slt`, and fragment `kil`. Both shader stages exercise
math with swizzled inputs, masked writes, independent destinations and supported
overlapping temporary registers. Discard tests select each scalar lane, cover
negative/zero/positive values before and after the color write, and discard
part of a triangle using an interpolated varying.

This slice deliberately rejects unresolved cases. AIR's fragment comparisons
did not agree with ordinary GLSL comparisons in the probes, even with separate
input registers, so fragment `sge`/`slt` remain unsupported. Swizzled source
registers overlapping a root/power destination also differed; `sqt`/`pow` reject
that overlap, while identity-swizzled overlap is covered. `nrm`/`crs` currently
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
with no LOD bias, sampler overrides, cube/rectangle/compressed textures
or render-to-texture. Upload dimensions must match the selected mip level. Each context
is limited to 128 textures and 64 MiB of texels (including mip chains), with another 64 MiB maximum
for CPU staging arrays; these are experimental resource limits.
Readback into opaque BitmapData is explicitly unsupported: AIR can preserve
non-opaque alpha there, which requires broader work on BitmapData's current
opaque-pixel invariant. Fractional clear-color quantization also differs
between backends; the fixture uses representable byte values.

`Mipmaps.as` checks nearest and linear mip selection with both texture filters,
including trilinear interpolation, non-square chains down to 1×1, LOD clamping,
level reupload and presentation. Its 45-line AIR reference includes unuploaded
base data (3605), incomplete chains (3700) and an out-of-range level (3674).
Every level is uploaded explicitly; the backend does not generate mipmaps.
All levels share the texture's existing base-sized CPU staging array. The twelve
filter/wrap/mip combinations use lazily cached sampler objects. Browser checks
verify stable staging storage and GPU handles across mip reuploads, with cleanup
after disposal and context loss. Mip sampling adds no per-draw arrays.

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
AIR's requirement to clear after present before AS3 readback (3692) remains part
of the broader frame-validation work; this slice does not add that validation.

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

Stencil testing and nonzero stencil clear values remain unsupported. Clear
masks support color/depth/stencil bits (1/2/4), zero and the default all-bits
mask; broader numeric validation and precision parity remain future work.

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
float vertex attributes, vector/matrix uploads, depth testing, culling, blending,
color rendering and non-antialiased back buffers are exercised, with sizes limited to
32×32 through 2048×2048.
Unsupported operations throw experimental errors, not a claim of
Flash-compatible validation.

Next gates are the unresolved shader cases above and render-to-texture,
alongside broader Flash error semantics and numeric coverage.
The separate WebGL contexts and canvas
layers isolate this probe; production integration still needs its own
presentation and resource-sharing design. These sample checks do not claim
complete pixel parity for arbitrary Stage3D content.
