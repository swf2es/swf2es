# Experimental Context3D backend

`@swf2es/context3d` provides resource/lifecycle contracts and AGAL 1, 2 and 3 to
GLSL ES 3.00 translation, for every Stage3D profile. Its core has no dependencies or browser types. The optional
`@swf2es/context3d/webgl` entry exports `WebGLContext3D`, which owns the supplied
WebGL2 context exclusively. It does not share GL state or resources with the
display list's renderer.

The WebGL entry re-exports the context owner from `webgl/context.ts`. That owner
keeps resource maps, byte accounting, bindings and draw/present ordering together.
`buffers.ts` and `textures.ts` handle uploads; `programs.ts` handles shader linking
and uniform locations; `targets.ts` handles framebuffer allocation and resolves. Limits
and render-state constants live beside those modules. These are internal splits;
the package entries and ownership contracts stay the same.

This package does not enable Stage3D playback. The separate
`@swf2es/player/context3d` entry installs experimental Flash bindings, and
`@swf2es/player-hosts/stage3d` places canvases and attaches browser loss/restoration
listeners. Install the bindings before loading playerglobal, and call their
returned teardown before destroying Scripting. Default playback still reports
unavailable Context3D through ErrorEvent #3702.

The host supplies a positioned, clipped stage container, with the transparent
display-list canvas above Stage3D slots 0..3. Supply a surface factory to
`stage3DCanvasHost`; it returns a canvas and a backend for each requested slot.
Create the WebGL2 context with `alpha: false`, `antialias: false`, `depth: false`,
`stencil: false` and `preserveDrawingBuffer: true`. The backend manages its own
back-buffer attachments and copies to the canvas only at `present()`.

An optional second constructor argument sets resource budgets, for example
`new WebGLContext3D(gl, { maxTextureBytes: 32 * 1024 * 1024 })`.
Default counts match AIR's 4,096 resources independently for vertex buffers,
index buffers, programs, 2D textures, rectangle textures and cube textures.
`maxVertexBuffers`, `maxIndexBuffers`, `maxPrograms`, `max2DTextures`,
`maxRectangleTextures` and `maxCubeTextures` change those limits. `maxBuffers`
and `maxTextures` retain aggregate caps, defaulting to 8,192 and 12,288; an
explicit lower cap still limits the combined types.

Byte limits are independent by resource type and follow the observed AIR baseline
allowances for buffers and BGRA textures:

| Resource | Default | Constructor option |
| --- | --- | --- |
| Vertex buffers | 256 MiB | `maxVertexBufferBytes` |
| Index buffers | 128 MiB | `maxIndexBufferBytes` |
| 2D textures | 512 MiB | `max2DTextureBytes` |
| Rectangle textures | 512 MiB | `maxRectangleTextureBytes` |
| Cube textures | 256 MiB | `maxCubeTextureBytes` |

AIR probes with BGRA textures at multiple sizes show a mip reservation of half the base size
for ordinary and cube textures. Their per-type quota charge uses that reservation;
rectangles charge only their base level. The aggregate `maxTextureBytes` budget
still tracks the complete mip chains actually allocated, defaulting to 1,280 MiB.
`maxBufferBytes` defaults to 384 MiB. Explicit lower aggregate overrides continue
to bound combined storage independently of these allowances.

Target depth/stencil and multisample color storage retain separate 64 MiB host
policies (`maxTargetDepthBytes`, `maxTargetColorBytes`); equivalent AIR attachment
accounting remains unverified. Multisample storage counts actual samples and cube
targets include their cached single-sample resolve surface. All options must be
nonnegative safe integers, are copied at creation and allocate nothing eagerly.
Disposal returns both quota and storage capacity. These are logical allocation
accounts, not physical driver VRAM, and exclude back-buffer attachments.
Compressed textures ("compressed", "compressedAlpha") hold S3TC's DXT1 and
DXT5, which `Texture3D.uploadCompressed` takes as blocks; the player decodes
ATF to them (`@swf2es/native/atf`). The backend stores them with
`WEBGL_compressed_texture_s3tc` where the context has it, DXT1 with its bit of
alpha, as AIR draws a three-colour block's fourth texel transparent, and
decodes them to RGBA on the CPU (`dxt.ts`) where it has not. AIR charges their
quota at DXT1's eighth of the BGRA reservation and DXT5's quarter (a 2048
texture 3 MiB and 6 MiB: 170 and 85 fit), and the aggregate counts their
chains as S3TC's blocks even where the CPU decodes them to RGBA, so that every
GPU allocates alike. Compressed textures are at least 4x4 (Error #3745, here
`compressedSize`). A compressed texture also takes pixels, as AIR's does, and as AIR
compresses them, they are encoded to its blocks (`dxt.ts`), so that a GPU with
S3TC and one without draw them alike. The player injects its native whole-level
encoder through `setDxtEncoder`; standalone backends and native refusals use the
TypeScript encoder. `context3d` retains no dependency on `native`.
The RGBA staging array a texture uploads
through is made at its first pixel upload or CPU decoding, so compressed
textures uploaded as blocks on S3TC have none. Samplers must
read a texture as what it is, AGAL's format DXT1 or DXT5 for a compressed one
(#3763), where `samplerFormats` is set, as the player sets it for content from
SWF 17 on, or RGBA for the packed and half-float formats.

`bgrPacked565` and `bgraPacked4444` are stored at 8 bits a channel (RGB8 and
RGBA8), as AIR draws into them: an upload keeps each channel's high bits and
widens them back as Direct3D reads them (`0x12` becomes `0x10` in 5:6:5), from a
BitmapData's premultiplied pixels or from little-endian words (5:6:5 red high,
4:4:4:4 alpha, red, green, blue from the high nibble), two bytes a texel. 5:6:5
reads alpha 1. `rgbaHalfFloat` is RGBA16F, eight bytes a texel in R, G, B, A
order; a bitmap goes up as its bytes over 255. Drawing into one keeps values past
1, and needs `EXT_color_buffer_float`, which every desktop WebGL 2 has. A clear's
colour is cut to 8 bits a channel on every target, as AIR clears through
Direct3D's 8-bit colour, by truncation: 0.5 clears to 127, and a half-float
target within 0 to 1.

## Profiles

`Context3D.profile` sets what a context's programs, textures and targets may be
(`profileLimits`), as AIR 51.3 grants them under Wine, where it serves every
profile on Direct3D 9Ex (`tests/context3d`'s `Profiles.as`, `AGALProfiles.as`,
`AGALStandard.as`, `TextureFormats.as` and `MultipleTargets.as` hold the
references). Every profile has 16
sampler and vertex-stream slots, 250 vertex and 200 fragment constants for the
setters, cube faces up to 1024 and back buffers up to 16384. A constant setter
whose registers start or end past 250 or 200 is #2006 in every profile, a
matrix's four too; one within them writes them all, though an AGAL 1 program
reads only the first 128 and 28, and AGAL 2 the first 250 and 64:

| Profile | AGAL | Texture | RectangleTexture | rgbaHalfFloat | Colour outputs |
| --- | --- | --- | --- | --- | --- |
| `baselineConstrained` | 1 | 2048 | none (#3782) | no (#3759) | 1 |
| `baseline` | 1 | 2048 | 2048 | no | 1 |
| `baselineExtended` | 1 | 4096 | 4096 | no | 1 |
| `standardConstrained` | 1, 2 | 4096 | 4096 | yes | 1 |
| `standard` | 1, 2 | 4096 | 4096 | yes | 4 |
| `standardExtended` | 1, 2, 3 | 4096 | 4096 | yes | 4 |

What each AGAL version's programs may use (version 0 is 1; a version past the
profile's is #3725):

| | AGAL 1 | AGAL 2 | AGAL 3 |
| --- | --- | --- | --- |
| Tokens a program | 200 | 1024 | 2048 |
| `va` | 8 | 8 | 16 |
| `vc` / `fc` | 128 / 28 | 250 / 64 | 250 / 200 |
| `vt`, `ft` | 8 (7 in `baselineConstrained`) | 26 | 26 |
| `v` | 8 | 10 (8 in `standardConstrained`) | 10 |
| `fs` | 8 | 16 (8 in `standardConstrained`) | 16 |
| `oc` | 1 | 4 (1 in `standardConstrained`) | 4 |
| `od` | — | `od.x` (none in `standardConstrained`) | `od.x` |

AGAL 2 adds `ddx` and `ddy` (fragment programs, not in conditionals; `ddy` grows
down the target, as AIR's), and the conditionals `ife`, `ine`, `ifg` and `ifl`
(scalar operands, compared as `==`, `!=`, `>` and `<`), `els` and `eif`, at most
four deep. Both branches run for every pixel and only their writes are
predicated, as Direct3D's predication runs them, so derivatives stay defined:
nothing branches in GLSL. AIR's rules hold: no output written in a conditional
(#3751), no empty branch (#3748), a texture read in one takes a varying alone
(#3741), and after `eif` a temporary counts as written where the `els` branch
wrote it, or, with no `els`, where it was before the `if`. `od` writes the
depth, clamped by the depth buffer. AIR's indirect reads reach the first 128
vertex constants in every version and read 0 past them, so a program's bank
stays `vc[128]`, indexed as AGAL 1's is; constants past it are uniforms of their
own. Fragment programs have no indirect reads (#3639). AIR reads `iid` from
vertex stream 15. In every version `sne` compares, two constant operands are
refused (#3625, as are `kil`, `ddx` and `ddy` of a constant), each colour output
is written once (#3744) from `oc0` up without gaps (#3775), and samplers take
the four wraps and any format, which a draw then checks.

Colour outputs 1 to 3 (`setColorOutput`) draw beside the target: the player
binds them for `setRenderToTexture`'s `colorOutputIndex`, refuses them beside the
back buffer (#3728) or unlike the target in size, format, depth or antialiasing
(#3729), and a draw whose program writes another number of outputs (#3774).
`setRenderToBackBuffer` and `present` unbind them. The backend attaches them to
the target's framebuffer only while they are bound, so a target drawn alone
pays nothing.

Left out, and why:

- `drawTrianglesInstanced` and `createVertexBufferForInstances`, which AIR has
  and Flash Player 32's playerglobal does not; `iid` reads stream 15 meanwhile.
- Colour outputs on an antialiased target (#3708): AIR takes them.
- The same texture bound to two outputs, which AIR draws into with the later one.
- `baselineConstrained` fragment programs are held to 96 instructions (#3715),
  ps_2_0's 64 arithmetic and 32 texture ones, counted as AGAL's: AIR counts
  Direct3D's, of which a matrix, `nrm` or a comparison takes several.
- A RectangleTexture as large as the back buffer where that is larger than the
  profile's size, which AIR's message names but no test has checked.
- Conditionals in vertex programs: AIR's validation takes them, then under Wine
  its Direct3D 9 compile fails (#3613), so no reference shows what they draw;
  swf2es runs them as it runs a fragment program's.

Core failures carry typed reasons. The Flash adapter maps them to catchable AS3
errors, including resource limits (#3691), disposed objects (#3694), draw bounds
and AGAL validation/linkage. Every profile is served; the software render mode
reports an asynchronous ErrorEvent #3702 so content can retry. Concurrent requests
coalesce; requesting again after creation retires the preceding context and
creates a new one. Broader unchecked-error precedence remains experimental.
The constructor rejects antialiased host contexts before allocating GPU handles:
its explicit resolve/present path requires `antialias: false`.

The adapter disposes GPU resources before the host removes the surface. After
browser context loss, the old surface stays attached so restoration can trigger
creation of a new context. The host detaches both listeners when removing it.
Uploads copy source storage before returning; `read()` reuses its output until
the next read. No AS objects or DOM objects cross the backend's core interface.
Bitmap uploads for 2D, rectangle and cube textures copy the top-left source
region and clear uncovered pixels without scaling. A mip upload can reuse a
larger bitmap; the backend preserves its row stride and reuses the texture's
base-sized staging array. Cube uploads update only the selected face and mip.
ByteArray uploads keep their exact selected-mip byte requirements.
An optional `Stage3DSurface.destroy` hook runs once when the surface is removed,
after backend disposal and listener removal; it also runs after failed attachment.
Use it to release the browser context without interfering with loss/restoration.

Sampler filters include nearest, linear and 2×/4×/8×/16× anisotropic filtering.
WebGL uses cached sampler objects and clamps anisotropy to the extension's
hardware limit. Without `EXT_texture_filter_anisotropic`, those requests use
linear filtering with the requested mip mode. Capability queries happen only on
the first anisotropic draw; warmed sampler changes allocate no new GPU objects.

Texture targets support hardware-dependent antialiasing requests up to 4×,
falling back to single-sample rendering when no compatible count is available.
The backend caches target attachments, retains color/depth across rebindings,
and resolves changed color before generating mipmaps. Warm target switches
allocate no GPU handles. Cube resolves use a cached 2D surface and a GPU copy,
which avoids corrupted direct multisample-to-cube blits in SwiftShader.

The Flash adapter reclaims resources after their AS wrappers become unreachable.
Active vertex, program, texture and render-target bindings keep their wrappers
alive until replaced, cleared or disposed. Explicit disposal and context teardown
release storage immediately. Allocation failures also reclaim already collected
wrappers whose finalizers have not run, then retry once. Garbage collection is
not prompt or guaranteed; explicit disposal remains preferable, and the hard
resource budgets still apply. Direct backend callers own their resources and
must dispose them or the context.

The current API and validation are experimental. Supported operations, AIR
references, unsupported formats/profiles and lifecycle stress tests are tracked
in [tests/context3d](../../tests/context3d/README.md). Stage3D playback is off by
default in the web element, and on in the desktop app, whose View menu turns it
off. A web host can explicitly opt in before loading its first player:

```ts
import { configure } from "@swf2es/web";
import { WebGLContext3D } from "@swf2es/context3d/webgl";

configure({
  stage3D: () => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is unavailable");
    }

    return {
      canvas,
      context: new WebGLContext3D(gl, {
        maxBufferBytes: 64 * 1024 * 1024,
        maxTextureBytes: 128 * 1024 * 1024,
        maxTargetDepthBytes: 16 * 1024 * 1024,
        maxTargetColorBytes: 16 * 1024 * 1024,
      }),
      destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
    };
  },
});
```

Each requested slot needs a fresh surface. In place of the factory, `stage3D` takes
a loader, `{ load: () => import("./my-stage3d.js").then((m) => m.create) }`, which
the element calls at a SWF's first `requestContext3D`: a SWF that never asks loads
no backend, and one whose load fails gets #3702. `configure({ stage3D: null })` disables
the experiment for subsequent loads. The web element owns native installation,
composition, cancellation, restoration and teardown for each load. GPU backend
selection stays with the host; the default web entry does not eagerly import
the optional bindings or a backend. No new dependencies are required by `web`.

The web package sets no backend budgets: a factory using `new WebGLContext3D(gl)`
inherits the larger AIR-sized defaults, as the desktop factory does. This browser
example explicitly selects lower aggregate and attachment budgets per context;
they are host policy, not AIR limits or a guarantee against context loss. Tune
them for the workload and account for concurrent slots and players. The limits
exclude driver overhead and back-buffer attachments, so the browser can still
lose a context before a logical allocation limit is reached. The public demo
keeps Stage3D off by default; its experimental checkbox opts in with these lower budgets.

Stage3D positions follow the embedding's `scale`/`salign` placement. Configured
buffer sizes remain in pixels; resizing or changing device pixel ratio never
implicitly reallocates them. The host clips the viewports, makes the display
list transparent while contexts exist, and keeps overlapping players' canvases
in separate stacks. The web host honors ActionScript changes to
`Stage.scaleMode` and `Stage.align`, with Stage3D opted in or not; only the
opt-in gives the top and left edges precedence when an alignment names both
opposite edges. In `noScale`, Stage dimensions follow the
embedding's CSS size and resize events are synchronous after placement updates;
other modes report the authored dimensions. Display-list pixels and input use
the same viewport, including coordinates outside the authored rectangle.
A DPR change affects display-list resolution without changing Stage dimensions
or reallocating Stage3D buffers. Script settings override embedding defaults
independently. The desktop app offers the same host through View › Stage3D
(Experimental), off by default, with a remembered choice that restarts the
movie when changed. It uses the backend's per-type resource count limits and
byte budgets. The public demo lazily loads the backend when Stage3D is selected
and restarts the current SWF when the option changes. Its Restart and Close
controls release the preceding contexts. Best-resolution buffers remain later
work. None of this changes the ActionScript Worker API.

A future WebGPU backend can reuse the Flash adapter, resource contracts and AIR
fixtures. It still needs AGAL-to-WGSL translation, GPU resource/binding handling,
render-pipeline caching and device-loss recovery. Immediate readback needs a
separate execution design: `Context3D.read()` returns synchronously to Flash,
while WebGPU's [`GPUBuffer.mapAsync`](https://gpuweb.github.io/types/interfaces/GPUBuffer.html#mapAsync)
provides CPU access asynchronously. A worker bridge or another way to suspend
Flash execution would need validation before full compatibility could be claimed.

The display list and Stage3D use separate canvases. Display-list blend effects
sample the transparent 2D back buffer rather than Stage3D color, so blending
across those layers is an experimental limitation. `Playback.destroy()` disposes
the display-list scene before the renderer on ordinary loads as well as Stage3D
loads; this intentional shared cleanup releases cached text-style listeners.

Draw validation caches index-range summaries by upload version, retaining at most
16 ranges of 128 or more indices when a buffer is drawn in alternating parts. Fully uploaded
vertex prefixes need no per-attribute index scan; sparse validation caches also
include the vertex version. Uploads, changed ranges/bindings and disposal
invalidate the relevant records. Warm draws add no validation arrays or GPU
handles.

The owned VAO keeps each vertex layout until its buffer, offset or format changes.
Program switches enable and disable only attributes whose use changes. Buffer
uploads keep the layouts but still invalidate draw validation; every draw checks
its current bindings and uploaded ranges. This adds no VAOs or GPU buffers.

The backend also reuses program, VAO, framebuffer and viewport bindings between
draws. Temporary framebuffer work, read/draw framebuffer splits and program
replacement invalidate that cache. Each program retains its target-orientation
uniform and sampler-unit assignments until they change or it is replaced;
texture and sampler validation still runs on every draw.

Depth-write/compare settings, blend factors and cull faces are retained between
setters. Repeating a value makes no GL call; changing blend factors or cull faces
while already enabled does not enable them again. Clears and internal MSAA copies
restore their temporary state changes before returning.

The owned VAO retains its index-buffer binding across draws, presentation and
internal copies. Index-buffer allocation, uploads and disposal invalidate that
binding cache; vertex uploads leave it intact. Draw validation still runs before
reusing a binding.

Each texture unit retains its last texture/sampler pair across draws and
presentations. Changing either uses the normal three binding calls. Uploads and
internal copies invalidate unit zero; unbinding and disposal invalidate the
affected units. The cache uses eight bytes of flags, with no extra GPU resources.

Each linked program remembers the write versions last uploaded for its constants.
Draws upload only active registers written since that program's preceding draw;
indirectly addressed vertex constants are uploaded as one bank after a write.
Switching programs or targets preserves those versions, while successful program
replacement resets them. Direct registers also retain their last uploaded float32
bits, so rewriting equal values or restoring a program's material needs no upload.
Signed zero and NaN payloads are compared exactly. Version and value
arrays retain at most 3,744 bytes per program and are released on disposal;
the context's two banks retain another 1,248 bytes of versions together.
Shader translation and arithmetic are unchanged. See the
[backend benchmark](../../tests/context3d/README.md) for upload counts and timings.
