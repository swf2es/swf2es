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

The adapter disposes GPU resources before the host removes the surface. After
browser context loss, the old surface stays attached so restoration can trigger
creation of a new context. The host detaches both listeners when removing it.
Uploads copy source storage before returning; `read()` reuses its output until
the next read. No AS objects or DOM objects cross the backend's core interface.

The current API and validation are experimental. Supported operations, AIR
references, unsupported formats/profiles and lifecycle stress tests are tracked
in [tests/context3d](../../tests/context3d/README.md). Web/desktop integration and
enabling production playback are separate work.
