# Native fill tessellation

`@swf2es/tessellate` compiles the small double-precision patch in
`vendor/libtess2` to Wasm with the pinned Zig compiler. `build.zig` compiles
the vendored C and the arena/API adapter in `src/root.zig` together, translating
the C header with `b.addTranslateC`, as the MP3 and compression packages do.
libtess2 remains
under SGI Free Software License B; its notice ships as `LICENSE.libtess2`.
`pnpm --filter @swf2es/tessellate build:wasm` regenerates the checked-in
binary. Normal builds verify the source digest; CI checks byte reproducibility.

`@swf2es/web` uses native fills by default. Each playback lazily loads and
owns a tessellator, then releases its scratch on teardown.
`configure({ nativeFills: false })` keeps new playbacks on the JS path and
skips native loading. Missing modules or unavailable Wasm also use JS.

When constructing a `PixiView` directly, opt in through its generic hook:

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

Different triangle layouts can change subpixel edge coverage and interior
gradient or bitmap interpolation. At low quality this can switch a whole
boundary pixel. AIR comparisons do not show either backend consistently
closer to Flash; enabling native fills accepts these differences.

Run the player references and context-loss checks with
`SWF2ES_NATIVE_FILLS=1` to exercise the native hook in those tests.
`node tests/fuzz/tessellate.ts [cases] [seed]`
checks both fill rules against independent ray crossings; the default test
suite includes 2,000 fills and 24,000 coverage samples. Synthetic fixtures
also check coincident edges, holes and detail at large coordinates.

## Experimental contour preparation

`configure({ nativeContours: true })` opts new web playbacks into native
edge joining for SWF shapes whose layers have not already been prepared.
It is independent of `nativeFills`, and off by default. Direct hosts can use
`new PixiView(renderer, { contourJoiner: tessellator.joinContours })`.
The native package is loaded when either option needs it; the playback
owns the same bounded scratch instance for joining and tessellation.

`joinContours(edges)` takes directed edges in twips, with NaN `cx` marking
a straight edge. It preserves first-unused-edge priority, contour order,
curve commands and double precision. Safe-integer endpoints use struct
keys. Fractional/nonfinite/unsafe endpoints, more than 262,144 edges,
allocation failure or unavailable Wasm return `null` for JS fallback.
The remaining shape preparation and curve flattening stay in the player.

Each successful fill copies its flat commands once into a JS-owned
`Float64Array`; its returned paths are views of that owned buffer. They
survive later native calls, memory growth, disposal and context restoration.
One retained path keeps that fill's command buffer; unrelated fills do not
share it. No cached path views Wasm memory. The existing memory ceiling
and retained-capacity policy apply to contour calls too.

The renderer passes the optional joiner when it first prepares a static
SWF shape. Shared lazy characters keep only the resulting paths, never
the joiner or its Wasm owner. The first preparation result, including JS
fallback, is cached. Earlier bounds/hit-test access may already have
prepared a shape through JS. Morph blends, glyph outlines and dynamic
Graphics retain their existing construction paths in this integration.
Fill readers accept owned typed contours; editable Graphics commands and
stroke paths remain number arrays.

Set `SWF2ES_NATIVE_CONTOURS=1` for the player references, context-loss and
resize tests. It can be combined with `SWF2ES_NATIVE_FILLS=1` to exercise
both stages. The option remains experimental: fixed-input allocation and
CPU gains do not establish a repeatable whole-game or GC-time improvement.
