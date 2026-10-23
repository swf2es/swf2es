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
`new WebGLContext3D(gl, { maxBuffers: 4096 })` for models with many animation
frames. Defaults are 128 buffers, programs and textures each, with separate
64 MiB budgets for buffer storage, texture mip chains, texture-target
depth/stencil storage and multisample target color storage (`maxBufferBytes`,
`maxTextureBytes`, `maxTargetDepthBytes`, `maxTargetColorBytes`).
Multisample storage counts actual samples; cube targets also count a cached
single-sample color surface used during resolution.
`maxBuffers`, `maxPrograms` and `maxTextures` change the count limits. Raising a
count leaves the byte budgets intact. Values must be nonnegative safe integers;
zero denies new allocations in that category. Options are copied at creation,
and disposal returns each resource's budget. These counts cover tracked storage,
not the driver's physical VRAM, back-buffer attachments or all CPU staging memory.

The adapter disposes GPU resources before the host removes the surface. After
browser context loss, the old surface stays attached so restoration can trigger
creation of a new context. The host detaches both listeners when removing it.
Uploads copy source storage before returning; `read()` reuses its output until
the next read. No AS objects or DOM objects cross the backend's core interface.
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
      context: new WebGLContext3D(gl),
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

Stage3D positions follow the embedding's `scale`/`salign` placement. Configured
buffer sizes remain in pixels; resizing or changing device pixel ratio never
implicitly reallocates them. The host clips the viewports, makes the display
list transparent while contexts exist, and keeps overlapping players' canvases
in separate stacks. The web host honors ActionScript changes to
`Stage.scaleMode` and `Stage.align`. In `noScale`, Stage dimensions follow the
embedding's CSS size and resize events are synchronous after placement updates;
other modes report the authored dimensions. Display-list pixels and input use
the same viewport, including coordinates outside the authored rectangle.
A DPR change affects display-list resolution without changing Stage dimensions
or reallocating Stage3D buffers. Script settings override embedding defaults
independently. Desktop layout controls, best-resolution buffers and enabling the
public demo remain later changes. None of this uses the unfinished Worker API.

A future WebGPU backend can reuse the Flash adapter, resource contracts and AIR
fixtures. It still needs AGAL-to-WGSL translation, GPU resource/binding handling,
render-pipeline caching and device-loss recovery. Immediate readback needs a
separate execution design: `Context3D.read()` returns synchronously to Flash,
while WebGPU's [`GPUBuffer.mapAsync`](https://gpuweb.github.io/types/interfaces/GPUBuffer.html#mapAsync)
provides CPU access asynchronously. A worker bridge or another way to suspend
Flash execution would need validation before full compatibility could be claimed.
