# Experimental Context3D backend

`@swf2es/context3d` provides resource/lifecycle contracts and AGAL v1 to GLSL
translation. Its core has no dependencies or browser types. The optional
`@swf2es/context3d/webgl` entry exports `WebGLContext3D`, which owns the supplied
WebGL2 context exclusively. It does not share GL state or resources with Pixi.

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
Compressed and `rgbaHalfFloat` textures are currently unsupported and return
Error #3708 before backend allocation. Their AIR quotas have not been measured;
the BGRA charge must not be reused for those formats when they are implemented.

Core failures carry typed reasons. The Flash adapter maps them to catchable AS3
errors, including resource limits (#3691), disposed objects (#3694), draw bounds
and AGAL validation/linkage. Known unavailable modes or profiles report an
asynchronous ErrorEvent #3702 so content can retry baseline. Concurrent requests
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
in [tests/context3d](../../tests/context3d/README.md). Stage3D playback remains off
by default. A web host can explicitly opt in before loading its first player:

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

Each requested slot needs a fresh surface. `configure({ stage3D: null })` disables
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
in separate stacks. With Stage3D opted in, the web host honors ActionScript
changes to `Stage.scaleMode` and `Stage.align`. Ordinary playback retains dev's
fixed Stage getters, ignored setters and authored dimensions, including its
existing embedding alignment when both opposite edges are named. In `noScale`, Stage dimensions follow the
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

Draw validation caches index-range summaries by upload version. Fully uploaded
vertex prefixes need no per-attribute index scan; sparse validation caches also
include the vertex version. Uploads, changed ranges/bindings and disposal
invalidate the relevant records. Warm draws add no validation arrays or GPU
handles.
