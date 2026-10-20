# Context3D triangle experiment

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
```

`AMXMLC` and `ADL` select the SDK commands. The reference runner is separate
from `oracle/flash.ts`: that harness uses CPU display-list capture, which
does not capture Stage3D.

The native adapter exchanges buffers, programs and pixels through
`backend.ts`; it imports no Pixi or WebGL code. The WebGL2 backend owns its
context and resources. Presentation copies the offscreen back buffer to
the canvas, so a subsequent clear does not alter the presented image.
Readback reuses its storage and converts GL's bottom-up rows to top-down
RGBA before the native adapter writes BitmapData.

Browser checks cover the AIR trace, presentation preservation, unchanged
unavailable-context fallback, cancellation before creation, resource
ownership, shader swizzles and clip depth, failed shader replacement,
resize, disposal and refusal after context loss. They count actual
created/deleted GPU handles.

This is **not enabled in the player, website, desktop app or game preview**.
The test installs natives before loading playerglobal and explicitly
tears down its host. Only baseline AGAL v1 `mov`, float vertex attributes,
vector uploads, opaque color rendering and non-antialiased color back
buffers are exercised. Unsupported operations throw experimental errors,
not a claim of Flash-compatible validation.

Next gates are Stage3D composition beneath the display list (including
position, visibility and multiple slots), Flash error semantics, automatic
context recreation, then broader AGAL/state/texture coverage. The separate
WebGL context is an isolation choice for the probe, not a commitment to
duplicate GPU resources in the production renderer.
