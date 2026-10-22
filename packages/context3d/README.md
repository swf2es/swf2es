# Experimental Context3D backend

`@swf2es/context3d` provides resource/lifecycle contracts and AGAL v1 to GLSL
translation. Its core has no dependencies or browser types. The optional
`@swf2es/context3d/webgl` entry exports `WebGLContext3D`, which owns the supplied
WebGL2 context exclusively. It does not share GL state or resources with Pixi.

This package does not enable Stage3D playback. The separate
`@swf2es/player/context3d` entry installs experimental Flash bindings, and
`@swf2es/player-hosts/stage3d` places canvases and attaches browser loss/restoration
listeners. Install the bindings before loading playerglobal, and call their
returned teardown before destroying Scripting. Normal playback still reports
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
64 MiB budgets for buffer storage, texture mip chains and texture-target
depth/stencil storage (`maxBufferBytes`, `maxTextureBytes`, `maxTargetDepthBytes`).
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
in [tests/context3d](../../tests/context3d/README.md). Web/desktop integration and
enabling production playback are separate work.

A future WebGPU backend can reuse the Flash adapter, resource contracts and AIR
fixtures. It still needs AGAL-to-WGSL translation, GPU resource/binding handling,
render-pipeline caching and device-loss recovery. Immediate readback needs a
separate execution design: `Context3D.read()` returns synchronously to Flash,
while WebGPU's [`GPUBuffer.mapAsync`](https://gpuweb.github.io/types/interfaces/GPUBuffer.html#mapAsync)
provides CPU access asynchronously. A worker bridge or another way to suspend
Flash execution would need validation before full compatibility could be claimed.
