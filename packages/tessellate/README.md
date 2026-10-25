# Optional native fill tessellation

`@swf2es/tessellate` compiles the small double-precision patch in
`vendor/libtess2` to Wasm with the pinned Zig compiler. `build.zig` compiles
the vendored C and the arena/API adapter in `src/root.zig` together, translating
the C header with `b.addTranslateC`, as the MP3 and compression packages do.
libtess2 remains
under SGI Free Software License B; its notice ships as `LICENSE.libtess2`.
`pnpm --filter @swf2es/tessellate build:wasm` regenerates the checked-in
binary. Normal builds verify the source digest; CI checks byte reproducibility.

Opt in when constructing a view:

```ts
import { PixiView } from "@swf2es/player";
import { Tessellator } from "@swf2es/tessellate";

const tessellator = new Tessellator();
const view = new PixiView(renderer, { fillTessellator: tessellator.tessellate });
```

The player retains its existing curve flattening, paint and draw order.
It passes every contour of one fill together, using even-odd or non-zero
winding, with non-zero for masks. Rejection or an exception selects the
existing JS fill construction. The chosen result is retained by the
context factory so copies do not retry the tessellator. Dynamic drawings
and morph ratios construct new results when their contents change.

Each native call copies positions and indices into JS-owned typed arrays.
Positions remain doubles; indices use 16 bits through 65,536 vertices and
32 bits above that. A native layer's position views share a contiguous owned
buffer, which Pixi can retain directly when the draw transforms are identities.
No cached geometry aliases Wasm scratch. Pixi consumes these through
`GraphicsContext.fillGeometry`, generating the usual paint UVs and batches;
the immutable source buffers survive path retirement and context restoration.
The hook also accepts another tessellator with the same structural result.

The absolute memory ceiling is 128 MiB, including static data, the C stack
and the arena. Instances above 8 MiB are discarded after the call. Options
can lower the limit or retained capacity. Invalid
coordinates (including values outside ±2^23), malformed contours, more
than one million input vertices, allocation failure and native failure
return `null`. A throwing failure import replaces libtess2's longjmp;
that instance is always discarded before another call. Arena reset alone
does not shrink Wasm memory. `dispose()` drops retained scratch without
affecting previous output.

This integration is experimental and does not change the default.
Run the player references and context-loss checks with
`SWF2ES_NATIVE_FILLS=1` to exercise it. Alternate triangulations can change
edge samples; pixel differences must be resolved against Flash before
considering a default change. Standalone measurements and their limits
are described in `tools/native-tessellation/README.md`.
