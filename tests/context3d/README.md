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

`Lifecycle.as` checks explicit context recreation against AIR:
`dispose()` clears the slot immediately and queues a fresh context;
`dispose(false)` leaves it empty until another request. The new context
starts with no configured back buffer and error checking disabled, while
the slot keeps its position and visibility. Disposing an old context again
does not affect its replacement. The browser also verifies that closing the
host cancels queued recreation and that each retired context releases its
GPU resources.

The lifecycle reference covers error IDs for an unconfigured clear (3698),
undersized back buffers (3780/3781), and operations on disposed contexts,
buffers and programs (3694). Disposed context getters and repeated resource
disposal are checked too. Other validation remains experimental; this is
not complete Flash error parity.

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
tears down its host. Only baseline AGAL v1 `mov`, float vertex attributes,
vector uploads, opaque color rendering and non-antialiased color back
buffers are exercised, with sizes limited to 32×32 through 2048×2048.
Unsupported operations throw experimental errors, not a claim of
Flash-compatible validation.

Next gates are recovery from actual GPU context loss, broader Flash error
semantics, and AGAL/state/texture coverage. The separate WebGL contexts and canvas
layers isolate this probe; production integration still needs its own
presentation and resource-sharing design. These sample checks do not claim
complete pixel parity for arbitrary Stage3D content.
