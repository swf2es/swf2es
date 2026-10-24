# Context3D rendering experiment

An opt-in vertical slice: a real AS3 SWF requests a Context3D, uploads
vertex/index buffers and AGAL, draws an indexed triangle, reads it through
BitmapData, presents, and disposes its resources.

```sh
pnpm build
node --test tests/context3d/agal.test.ts
node tests/context3d/run.ts
node tests/context3d/stress.ts
node tests/context3d/reclamation.ts
node tests/context3d/host.ts
node tests/desktop/stage3d.ts    # normal Electron View-menu opt-in (needs its binary)
# Longer local resource/memory soak:
node tests/context3d/stress.ts --loads 200
```

`page.ts` retains the browser runners' exports and routes them to `checks/`.
Those modules group playback, composition, resource limits/lifetime, targets,
uploads, samplers, state and multisampling checks. `checks/context.ts` supplies
the shared assertions, shader fixture and tracked WebGL context; it does not
own a running test's resources.

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
node tests/context3d/oracle.ts --scalarmath
node tests/context3d/oracle.ts --scissor
node tests/context3d/oracle.ts --mipmaps
node tests/context3d/oracle.ts --bitmapuploads
node tests/context3d/oracle.ts --samplerstates
node tests/context3d/oracle.ts --lodbias
node tests/context3d/oracle.ts --rectangletextures
node tests/context3d/oracle.ts --multisampling
node tests/context3d/oracle.ts --targetmultisampling
node tests/context3d/oracle.ts --temporarymatrices
node tests/context3d/oracle.ts --indirectconstants
node tests/context3d/oracle.ts --cubetextures
node tests/context3d/oracle.ts --rendertargets
node tests/context3d/oracle.ts --cubetargets
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
`@swf2es/context3d`; the adapter imports no Pixi or WebGL code. The WebGL2
backend owns its context and resources. Presentation copies the offscreen back buffer to
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

The optional WebGL constructor budgets cover buffer/program/texture counts and
separate byte limits for buffers, all texture mips/faces and target depth/stencil.
Browser checks cover invalid values before GPU allocation, exact boundaries,
immutable option snapshots, zero limits, raised counts, failed allocation
rollback, cached depth reuse and budget recovery after disposal. Default budgets
are unchanged; higher count limits do not raise the byte limits.

A local integration check of the public Away3D Perelith Knight SWF runs with
`maxBuffers: 4096` while retaining the default byte budgets. Across 3,600 ticks
it completes 3,599 presentations and 2,316,472 draws without AS or GL errors.
From tick 1,200 onward, counts remain at 400 buffers, four programs and six
textures, with unchanged tracked byte totals and GPU handles. Buffer storage
is about 7.8 MiB; post-GC heap plus backing storage stays within 0.07 MiB over
the remaining 2,400 ticks. Teardown releases all 427 created GL handles, returns
all byte counters to zero, and permits collection of the player, scripting,
backend and canvas. This uses hardware WebGL on Intel Iris Xe with a frame
clock; it is an execution/lifetime check rather than an FPS or AIR parity result.
The downloaded SWF and diagnostic harness remain outside the repository.

The public Away3D `Intermediate_Lines` Flash SWF renders its scrolling terrain,
three wireframe spheres and particles after adding `seq`. The downloaded SWF
replaces its terrain vertex buffer every frame without calling `dispose()`.
Before automatic reclamation, only six of its 64 vertex-buffer wrappers survived
collection at tick 60, while the backend retained 69 buffers (about 41 MiB);
a longer run reached the default 64 MiB buffer budget. The Flash adapter now
registers resource wrappers for cleanup and strongly retains active bindings.
An allocation failure first releases already collected wrappers whose finalizers
have not run, then retries once. There is no resource scan on draws or presents.
Explicit disposal and context loss/teardown cancel registrations immediately.
The unchanged SWF now completes 3,600 hardware-WebGL ticks, 3,599 presentations
and 17,995 draws with the default budgets and no forced GC during playback.
At six 600-tick checkpoints it retains 12–13 buffers (1.8–2.5 MiB), two programs
and one texture, with no AS/browser/GL errors and unchanged 32 MiB codegen memory.
Teardown releases all 3,621 created handles, returns every tracked byte counter
to zero and permits collection of the player, scripting, backend and canvas.
The sample and diagnostics stay outside the repository. This is an execution
check, not an FPS benchmark or an AIR pixel reference.

`reclamation.ts` keeps one AS3 context alive while repeatedly abandoning or
explicitly disposing vertex/index buffers, programs and 2D/cube/rectangle
textures. Real browser collection must release their tracked storage and GPU
handles while resources held only by active bindings remain drawable. Failed
bindings preserve the previous resources; `present()` releases the render-target
binding. Wrapper-construction failures roll back backend allocations. The test
also holds actual finalizer notifications to exercise count/byte budget recovery
before delivery and stale callbacks after reclamation, recreation and real context
loss/restoration. Explicitly disposed wrappers remain reachable during part of the
test; live-context post-GC heap growth is bounded. Finalization timing remains
nondeterministic and does not replace explicit disposal or the hard budgets.

`stress.ts` repeatedly loads a real AS3 SWF with two Stage3D slots. Each load
churns vertex/index buffers, shaders, 2D/cube/rectangle textures, mip generation,
render targets, unchanged/changed back-buffer configurations, and pixel readback.
It keeps disposed AS wrappers alive until unloading and leaves some resources
for context teardown to release. It also injects failed resizes, recreates
contexts, periodically loses/restores an actual WebGL context, and closes the
host with creation queued.

The default 48-load check runs in `pnpm test`; `--loads 200` extends it locally.
Created/deleted GPU handles and attached/detached loss listeners are counted.
After garbage collection, weak references must show that retired AS roots,
resources, players, scripting instances, backends and canvases are collectible.
Heap plus backing storage is checked at multiple checkpoints after eight warm
loads, allowing 512 KiB plus 32 KiB per additional load for JIT/test bookkeeping.
Codegen memory must stay within its warmed high-water mark or 32 MiB, whichever
is larger. Results go to `out/stress-results.json`. These checks measure logical
GPU resource release and browser-reported JS memory, not a driver's physical
VRAM reclamation. The software WebGL run is reproducible; driver-specific soak
coverage remains separate.

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

`CubeTargets.as` compares 64 AIR trace lines, including 170 pixel samples,
for rendering into all six cube faces. It checks top-down orientation, face
retention, optimized/unoptimized cubes, switching through 2D/back-buffer targets,
presentation, feedback rejection and mip generation. AIR retains one shared
depth/stencil buffer across a cube's faces; the tests check that drawing or
clearing depth/stencil on one face affects tests on another, and that disabling
then re-enabling depth/stencil preserves its contents.

A clear (including mask zero) initializes the whole cube for render-target
validation; bitmap and ByteArray uploads alone do not. All six faces still need their mip
chains before sampling. Invalid face selectors fail with ArgumentError 3772
for cubes and 3771 for 2D textures. A null target ignores its face selector;
a disposed target validates the selector, then returns to the back buffer.
These are the covered cases, not complete argument/error-precedence parity.

The backend reuses one framebuffer and depth/stencil buffer per cube, plus one
framebuffer for mip generation. GPU blits regenerate only the rendered face;
calling `generateMipmap` on the whole cube would overwrite uploaded mips on
untouched faces, which AIR preserves. No CPU pixel copies or per-pass arrays are
needed. Browser checks inspect every mip/face, exercise 48 warm passes without
new GPU handles or readback arrays, reject feedback and foreign/disposed targets,
and inject framebuffer/mip-framebuffer/depth allocation failures. A failed face
switch preserves the previous face and attachments. Cleanup releases every GPU
handle. Recovery creates fresh cube targets on each restored context and rejects
retired targets; loss while a cube is active must not retain its resources.

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
three-row instructions require a destination mask within xyz (exact xyz for temporary
or indirect matrices). Other instructions and broader numeric edge-case parity remain future work.

`TemporaryMatrices.as` adds 144 AIR pixel samples for `m33`, `m44` and `m43`
reading matrices from temporary registers, as Away3D's normal mapping does.
Both shader stages cover independent destinations, destinations overlapping
input vectors or matrix rows, input swizzles and partial `m44` writes. Matrix
row spans are checked against the eight-register temporary bank. Three-row
temporary matrices require an exact `.xyz` write mask: AIR rejected `.xz`.
These remain GPU operations, translated only at program upload.

`IndirectConstants.as` adds 465 AIR pixel samples for indexed vertex constants.
Attributes, temporaries and constants can supply the index through any component.
The fixture covers different indices per vertex, source swizzles, masked writes,
the second arithmetic operand, overlapping index/destination temporaries, all three
matrix instructions, partial `m44` writes and reads crossing the bank boundary.
Indirect `m33` and `m43` require an exact `.xyz` destination mask: AIR rejects `.xz`.

The tested AIR D3D backend rounds indices to nearest, with ties to even, before
adding the immediate offset; out-of-range reads return zero. The shader uses
`roundEven` and checks bounds before converting to an integer. Fractional and
negative indices, ties, first/last registers and matrix rows beyond the last
register are covered. Offsets are restricted to 0–127, vertex constants to 128
registers, and index registers to their ordinary baseline ranges. Fragment
indirection, larger/signed offsets, nonfinite/extreme indices and cross-driver
rounding parity remain unverified and are not claimed.

Shaders using indirection share one uniform bank for direct and indexed reads.
Each draw uploads the existing 2 KiB Float32Array once; direct-only shaders retain
their sparse uploads. There are no new per-draw arrays, GPU handles or uniform
location queries. Browser checks verify storage identity across 32 draws, constant
updates, optimized-away indexed reads, failed uploads, direct/indirect replacement,
resize and disposal. Seventeen AGAL unit tests cover accepted and rejected encodings.

`ShaderMath.as` adds 309 AIR pixel samples for `frc`, `sqt`, `rsq`, `pow`,
`nrm`, `crs`, vertex `sge`/`slt`, and fragment `kil`. Both shader stages exercise
math with swizzled inputs, masked writes, independent destinations and supported
overlapping temporary registers. Discard tests select each scalar lane, cover
negative/zero/positive values before and after the color write, and discard
part of a triangle using an interpolated varying.

`ScalarMath.as` checks `rcp`, `log`, `exp`, `sin` and `cos` with 2,184 pixel
expectations in both AIR and the browser. Logarithm and exponent use base two;
trigonometric inputs use radians. The fixture calculates expected values in AS3
and allows one byte per RGB channel for shader approximation and quantization.
It checks finite inputs, negative reciprocal/trigonometric values, positive log
inputs below and above one, negative/positive exponents, reversed swizzles,
masked writes and safe temporary overlaps. Every lane is read as RGB, including
w, so readback alpha handling cannot hide a failure. Separate scalar writes cover
all four lanes. Both AIR runs passed the same independent expectations.

Translation happens only at program upload; these operations run on the GPU and
add no per-draw JavaScript work or allocations. Zero reciprocals, nonpositive
log inputs, nonfinite values, overflow/underflow and large-angle precision are
not covered by this fixture.

`Comparisons.as` checks vertex and fragment `sge`/`slt`/`seq` with 1,452 independently
calculated pixel expectations: negative, positive and equal inputs, signed zero,
adjacent float values, both source swizzles, every destination lane, vector/partial
writes, either input overlapping the destination and interpolated fragment inputs
crossing a comparison boundary. Results
are calculated with AS3 comparisons, following the
[AGAL rules](https://airsdk.dev/docs/development/appendixes/adobe-graphics-assembly-language-agal/agal-bytecode-format).
This is not an AIR pixel reference. The available Wine OpenGL backend logs
`Predicates not implemented` and drops the conditional assignments emitted by
AIR, making both true and false fragment comparisons produce one. Vertex `seq`
also produces one for unequal inputs, including 1.5 versus 1, on that setup;
the fixture fails rather than recording this as expected behavior. Its Vulkan
path did not draw the probe; AIR software rendering failed shader compilation.
The optional oracle command runs the same self-check and fails on that setup,
even with `--update`; it does not save those broken results as a reference.
The translator now emits GLSL comparisons in either stage, with no new per-draw
JavaScript work. Native AIR confirmation remains outstanding.

This slice deliberately rejects other unresolved cases. Swizzled source
registers overlapping a reciprocal/root/power/log/exponent destination differed
when they changed a written lane. `rcp`/`sqt`/`pow`/`log`/`exp` reject that overlap;
identity and same-lane scalar overlap are covered. Sine/cosine also pass reversed
overlapping writes. The scalar probes check every lane in both stages and
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
cube `bgra` textures up to 1024×1024 per face, and single-level rectangle
`bgra` textures with arbitrary dimensions from 1 through 2048, with signed LOD
bias. Compressed textures remain unsupported.
2D bitmap uploads clip from the top-left and clear uncovered pixels without
scaling, including non-power-of-two sources and sources reused across mip levels.
Cube bitmap uploads still require exact face/mip dimensions. This differs from
AIR, which accepts other source sizes for cube faces and mips. A full-sized
bitmap reused for a smaller cube mip is rejected with AS3 Error #3708 here.
Cube crop/pad behavior and AIR-backed cases remain a follow-up rather than part
of this 2D slice. Each context has independent 4,096-resource caps for 2D,
rectangle and cube textures and a shared 64 MiB texel budget including mip chains.
Byte budgets remain an experimental host policy rather than AIR's larger storage
allowances.
Readback into opaque BitmapData is explicitly unsupported: AIR can preserve
non-opaque alpha there, which requires broader work on BitmapData's current
opaque-pixel invariant. Fractional clear-color quantization also differs
between backends; the fixture uses representable byte values.

`BitmapUploads.as` checks 2D source-size handling against AIR: matching, larger,
smaller, mixed-axis and non-power-of-two bitmaps at the base level and smaller
mips. Odd source sizes include levels 1, 2 and 4. Its 42 sampled pixels distinguish
cropping from scaling, padding from retaining previous contents, and verify
copying before source disposal. The
browser checks also exercise 81 uploads through one bounded staging array,
preserve even and odd source row strides at every mip, clear only the active
mip's bytes, and allocate no GPU handles during warmed uploads. Invalid dimensions/lengths never reach
WebGL; cube size validation remains unchanged. This covers engines that reuse
a full-size bitmap while drawing each mip's content into its top-left corner.

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
2048×2048 and cube faces from 8×8 through 1024×1024, with optional target
antialiasing and a single color output.
A 1×1 AIR rasterization probe differed; smaller targets remain unverified.
Resizing the back buffer while a texture is selected is explicitly rejected.
Target depth storage has a separate 64 MiB budget. Full validation/error parity
and fractional clear-color rounding across GPU drivers remain future work.

`Mipmaps.as` checks nearest and linear mip selection with both texture filters,
including trilinear interpolation, non-square chains down to 1×1, LOD clamping,
level reupload and presentation. Its 45-line AIR reference includes unuploaded
base data (3605), incomplete chains (3700) and an out-of-range level (3674).
Every level is uploaded explicitly; the backend does not generate mipmaps.
All levels share the texture's existing base-sized CPU staging array. The shader's twelve
filter/wrap/mip combinations use lazily cached sampler objects. Browser checks
verify stable staging storage and GPU handles across mip reuploads, with cleanup
after disposal and context loss. Mip sampling adds no per-draw arrays.

`SamplerStates.as` adds 268 AIR trace lines, including 1,056 pixel samples, for
`setSamplerStateAt` and the AGAL `ignoresampler` flag. Runtime overrides cover
nearest/linear and 2×/4×/8×/16× anisotropic filtering, all three mip modes, and clamp/repeat independently
on U and V. A fresh context starts with clamp/nearest/no mip filtering on the
tested AIR backend. State setters accept slots 0–15; the current shaders still
address only slots 0–7.

Selecting a program applies its ordinary sampler settings even when selecting
the same program again. `ignoresampler` preserves the slot's current state.
Uploading a selected program also applies its settings; uploading an unselected
program does not. Runtime state survives texture rebinding, presentation and
resize. Draw-time mip completeness and same-texture state conflicts use these
effective settings. Cube samplers require clamp on both axes (Error 3753).
The fixture covers those transitions, independent slots, cube sampling, failed
setters preserving state, null/invalid arguments and disposed contexts. Enums
are validated before slot ranges; valid calls on disposed contexts are ignored.

A fixed 16-byte table stores the slot settings. The 72 supported combinations
share cached WebGL sampler handles across textures and programs. Browser checks
cover 306 draws per capability configuration (204 after warming the cache),
2D/cube/rectangle textures, wrap/mip rejections, sampler-allocation failure, reuse,
failed shader replacement, resize and teardown. AGAL filter flags and runtime
overrides use the same sampler cache. Recovery draws through `ignoresampler`
with a base-only texture after deliberately setting anisotropic/mip filtering in
the previous context, verifying fresh defaults. Setters and warmed draws add no
arrays or GPU queries.

The WebGL backend enables `EXT_texture_filter_anisotropic` on its first
anisotropic draw and queries the limit once per context. Requests are clamped to
that limit; a missing extension uses linear filtering with the requested mip
mode. Separate browser runs cover native capabilities, a reduced 2× limit and
extension absence. The AIR samples use uniform mip levels to verify acceptance
and state transitions without claiming driver-independent anisotropic pixels.

Fractional trilinear precision is not an exact-parity claim: with this fixture's
quarter-colored base level, scale 6 produced a color-channel difference of up to 5/255
between AIR and the browser. Scale `4 * sqrt(2)` also exposed nearest-mip
selection differences at the half-LOD boundary. The exact reference uses
integer LODs for trilinear sampling and stays away from that nearest-mip boundary;
browser checks additionally inspect the selected GL filter and anisotropy.
Broader sampler encodings and full validation precedence remain open.

`LodBias.as` compares 390 pixel samples with AIR for signed AGAL texture LOD
bias, including negative/positive eighth-level fractions, both encoded extremes,
nearest/trilinear/no mip filtering, 2D and cube textures, and clamping to the
available mip chain. Repeated uses of one sampler slot must use the same bias
(upload Error 3696); different slots can sample the same texture with different
biases. Runtime sampler overrides and `ignoresampler` retain the shader's bias.
The reference also covers selected-program reupload, texture rebinding, resize
and presentation. Its solid-color mip levels and controlled derivatives exercise
fractional bias without asserting general cross-driver filtering precision.

Bias is emitted as a GLSL texture-call constant at upload; there are no new
per-draw arrays, uniforms, GPU queries or sampler handles. Unit tests decode all
256 byte values for 2D and cube samplers. Browser sampler lifetime checks now
use positive/negative biased programs and verify a failed conflicting-bias
replacement preserves the previous program and creates no GPU handles.
Hardware LOD-bias limits and implicit-derivative/filter precision remain
driver-dependent; the checked AIR/browser backends match this reference exactly.

`RectangleTextures.as` compares 60 trace lines and 100 pixel samples with AIR
for non-power-of-two BGRA textures. They
use normalized coordinates with an ordinary AGAL 2D sampler. Repeat wrapping
fails with 3753 and mip filtering with 3755, including runtime overrides;
`ignoresampler` uses the retained effective state. Bitmap uploads clip at the
top-left and pad uncovered pixels with transparent black. ByteArray uploads
preserve raw BGRA bytes, position and endian settings. The fixture covers
source mutation, failed uploads, ordinary/rectangle rebinding, presentation,
creation validation, explicit disposal and retired owners. Null upload sources
fail first; explicitly disposed rectangle textures ignore other uploads even
after owner disposal. Ordinary bitmap texture uploads retain their separate
AIR-tested precedence.

Rectangle targets reuse the existing framebuffer/depth path and never generate
mipmaps. The reference checks clear/draw orientation, depth attachment toggles,
feedback rejection and retained contents across presentation and target switches.
Browser checks exercise ten warm upload/render cycles without new GPU handles
or staging/readback arrays, clipping with a different source row stride, transparent
padding, byte uploads, invalid levels/ranges, foreign owners, failed framebuffer/
depth allocation, disposal and actual context loss. Rectangle storage contains
only one GPU mip level and one reusable RGBA staging array; oversized bitmap
uploads do not allocate an intermediate clipped image.

This remains a BGRA-only slice. Other formats, broader profile/dimension and
validation coverage, and hardware-dependent filtering precision remain open.
The experimental render-target minimum of 8×8 still applies.

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

`TargetMultisampling.as` grounds baseline-profile antialiasing requests for 2D,
rectangle and cube targets in AIR. It checks interior colors, retained color
across rebindings and quality changes, independent single/multisample depth
storage, and uploads after a cached target has been used. First-use uncleared
MSAA pixels vary on AIR's driver, so portable references clear them explicitly.
Exact edge coverage remains GPU-dependent.

The backend caches multisample color and optional depth/stencil per texture,
resolves changed color on target exit, then updates mipmaps. A shader copies
retained single-sample color when returning from non-MSAA draws or switching
cube faces. Cube resolves pass through a cached 2D surface before a GPU copy:
a minimal SwiftShader test reproduced scrambled direct MSAA-to-cube blits,
while Intel hardware drew correctly. All copies remain on the GPU.

Multisample color plus cube resolve storage has a separate 64 MiB default
budget (`maxTargetColorBytes`); actual sample counts also scale depth accounting
under `maxTargetDepthBytes`. Browser checks cover partial edge coverage,
resolve reuse after depth-only clears, all six patterned cube faces, warm handle
reuse, failed fresh/cached target allocations, framebuffer rollback, quota
release, fallback, resizing and context-loss teardown. Supported count queries
are cached, and warmed draws create no new JavaScript arrays or GPU handles.

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
node tests/context3d/viewport-oracle.ts
node tests/context3d/stage-layout-oracle.ts [--update]
```

This is **off by default in the player, website and desktop app**.
The test imports `@swf2es/player/context3d`, installs natives before loading
playerglobal and explicitly tears down its host. Only the AGAL v1 instructions listed above plus `mov`,
float and packed-byte vertex attributes, vector/matrix uploads, depth/stencil testing, culling, blending,
color rendering and back buffers with optional multisampling are exercised, with sizes limited to
32×32 through 2048×2048.
Unsupported operations throw experimental errors, not a claim of
Flash-compatible validation.

Next gates are the unresolved shader cases above and broader texture
formats, alongside broader Flash error semantics and numeric coverage.
The separate WebGL contexts and canvas
layers isolate this probe; production integration still needs its own
presentation and resource-sharing design. These sample checks do not claim
complete pixel parity for arbitrary Stage3D content.

## Package layout and production integration

The implementation is extracted into [packages/context3d](../../packages/context3d/README.md).
`@swf2es/context3d` exposes renderer-neutral resource/lifecycle contracts and AGAL
translation, built without DOM or node types. The optional
`@swf2es/context3d/webgl` entry owns WebGL resources. Neither entry imports player
AS objects or Pixi. The normal build checks both projects.

The AS native adapter and Flash validation are in `player`, exposed through the
separate experimental `@swf2es/player/context3d` entry. `installContext3D` runs
before loading playerglobal and returns teardown to call before destroying
Scripting. The default player entry never imports or installs it; ordinary
playback retains the ErrorEvent #3702 fallback.

The native entry registers Stage3D and delegates to `playerglobal/context3d/`:
`lifecycle.ts` owns context creation, recovery and resource reclamation;
`context.ts` registers Context3D commands; `resources.ts` registers buffer,
program and texture commands. They share one installation's ownership maps and
capture their helpers during registration, without rebuilding them for draws.

`@swf2es/player-hosts/stage3d` owns canvas placement and loss/restoration wiring.
`stage3DCanvasHost` takes a surface factory and a caller-supplied clipped parent;
the display-list canvas stays above slots 0..3. It keeps a lost surface attached
until restoration or teardown and detaches both listeners on removal. The
composition references and repeated-load stress tests use this host and the
built package entries, including weak-reference checks for retired hosts.

The web element can opt in with `configure({ stage3D: surfaceFactory })`, as shown
in the package README. Each load owns its layers, and tears them down before
destroying Scripting, including replacement, removal, failed attachment and
cancelled startup. Default loads retain the unavailable-context fallback.
An optional surface `destroy` callback releases its browser context after its
resources, loss listeners and DOM attachment are gone.

`host.ts` runs the actual web element against the nine AIR composition states and
`viewport-reference.json`: eight AIR layouts, 18 pixel points each, covering
four scale modes with top-left and centered alignment. AIR scales a viewport's
position but leaves its configured width/height in pixels. Checks cover resize,
DPR 2, zero-size hosts, overlapping players, explicit reload, queued creation,
cancelled library startup, attachment rollback and real context loss/restoration.
Twenty repeated loads alternate explicit destroy and DOM removal, with extra
reloads; every handle/listener is released and retired players, scripting,
backends, canvases and elements must be collectible. Heap plus backing storage
may grow at most 1 MiB between warm load 4 and load 20.

Web teardown also disposes its display-list scene before its renderer. The web
suite checks collection of device-font scenes held by Pixi's measurement cache,
including when Stage3D is disabled.

`StageLayout.as` and `stage-layout-reference.json` add AIR references for live
ActionScript settings: nine layouts with 22 pixel points each, including content
beyond the authored rectangle and negative stage coordinates. The reference
also records case-sensitive scale-mode validation, null errors, canonical TBLR
alignment flags and synchronous resize-event fields. Top/left win when both
opposite edges are requested. Entering `noScale` updates dimensions and sends
resize only if the dimensions change; leaving it restores authored dimensions
without resize. The optional oracle records the live setter/event sequence in
one AIR window and captures each pixel layout in a fresh window: Wine can retain
the preceding layout's pixels in a reused Stage3D window. The browser suite
checks actual live pixel changes against those independent samples.

The web host applies script changes synchronously, before a resize listener runs.
`noScale` draws the whole visible viewport and maps mouse/touch/wheel/context-menu
coordinates through its aligned origin. A listener can select another scale mode
without the outer resize restoring stale layout. Browser checks cover real input
beyond authored bounds, alignment changes, embedding resize, DPR changes without
extra resize events or Stage3D buffer allocations, and display-only playback with
Stage3D disabled. Script settings override the embedding's defaults separately;
even assigning the existing value establishes that override. Teardown detaches
the layout callback and the repeated-load collection checks still apply.

Desktop layout controls, best-resolution buffers and production enablement
remain later work. These hooks are independent of the unfinished ActionScript
Worker API. Broader formats, profiles and validation gaps remain listed above.

The desktop's opt-in surface factory uses the backend's independent 4,096-resource
count limits and separate 64 MiB byte budgets. `tests/desktop/stage3d-limits.ts`
runs that actual factory inside the desktop integration test: 12,288 mixed
2D/rectangle/cube allocations, per-type count rejection before GL allocation,
capacity recovery after disposal, and the exact 64 MiB boundary including full
mip chains. It tracks texture handles through explicit disposal and context
teardown, checks GL errors and releases the browser context.

`StageWorker.as` covers the combined web startup path: the primordial presents
a green Stage3D surface while a real background Worker sends a channel reply.
The host waits for both before checking pixels, then destroys the player and
checks collection through the existing lifetime harness. This exercises the
worker-host readiness path together with opt-in Context3D bindings.
The desktop integration test runs the same fixture through normal SWF opening,
checks cross-origin isolation and the green presentation after the worker reply.
It also aborts the optional backend import: the movie must keep playing with
ErrorEvent #3702, and a page reload must allow the backend to load successfully.

Live Stage getters, setter validation, resize events and leading-edge alignment
are gated by the Context3D opt-in. Default playback keeps dev's ignored Stage
setters, fixed getters and authored dimensions. The host regression loads the
same StageLayout fixture without a surface factory and checks the 96×96 Stage
in a 192×144 embed, no RESIZE and no artwork in the margin. Shared embedding
alignment retains the old LR/TB centering for ordinary AS3 and AVM1 loads.

Pointer, touch and context-menu picking use the translated viewport rectangle.
The host test clicks the visible negative-coordinate artwork under bottom-right
noScale alignment and checks stageX/stageY and Stage.mouseX/mouseY at (-12,-12),
while the pure picking test rejects coordinates beyond each viewport edge.

`ResourceLimits.as` retains all six resource kinds at once, reaches AIR's 4,096
limit independently for each, observes Error #3691, then disposes/replaces one
at capacity. Separate buffer/texture aggregate overrides still bound combined
counts without raising the shared byte budgets. `ContextRequests.as` checks AIR's
mode/profile/null errors, pending coalescing, profile-vector selection and
replacement of an existing context, with explicit error checking enabled when
probing its retired predecessor. `AGALValidation.as` checks unwritten temporary
registers/components, masked reads, complete outputs and varying linkage against
AIR. Every encoded source-swizzle lane is validated, including masked MOV and
dp3 operands. These references are captured and independently repeated in adl.

Backend checks reject antialiased host contexts before GPU allocation and count
index reads with eight attributes over 6,000 indices: one cold scan and none on
warm draws. Partial uploads, sparse vertex streams, range changes and disposal
must invalidate caches without losing pixels or retaining handles. The normal
host checks asynchronous unsupported-profile fallback, worker isolation from the
Stage3D factory, and closing/collecting a player while a worker is still sending
messages. Worker-pool spares are distinct from running Flash worker threads.

Stage3D and the display list occupy separate canvases. Blend effects on the 2D
list sample transparency rather than Stage3D pixels; cross-layer blend parity is
an experimental limitation. Default `Playback.destroy()` also disposes its Pixi
scene before its renderer, intentionally releasing cached text-style listeners;
ordinary web collection checks cover this shared change.
