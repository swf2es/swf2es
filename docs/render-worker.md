# Shared-memory render worker prototype

The experimental modules in `packages/player/src/render/worker/` exercise a
SAB transport and an OffscreenCanvas renderer. They are internal, are not
exported by the player entry point. `WorkerView` is an opt-in experimental host
adapter; the normal renderer remains the production path.

Run `node tests/player/worker.ts` after `pnpm build`; `--gpu` uses the machine's
GPU rather than SwiftShader. The runner serves an isolated localhost page,
bundles the test worker using the Pixi fork's existing esbuild dependency,
and compares its pixels with the main-thread renderer. No new dependency is
needed. The default run is part of `pnpm test`. `node tests/player/worker-host.ts`
checks the host adapter, including resize/input, delayed library registration,
acknowledged morph bounds, fallback, restart and disposal. Both accept `--gpu`.

## Ownership and transport

There is one producer and one consumer. Each fixed-size shared slot moves
through free, writing, ready and reading. The producer claims a free slot with
an atomic compare/exchange, writes its ordinary payload bytes, then publishes
its length and increasing sequence number before atomically marking it ready.
The consumer acquires the newest ready slot and retains ownership until all
its reads finish. Only then may the producer reuse that slot.

Older ready snapshots can be discarded, but a reading slot cannot be reused.
If every slot is occupied, publication returns `null` without running the
encoder or waiting. The caller retains its source state and publishes its
latest complete snapshot after space becomes available. This rule relies on
complete snapshots: a future diff protocol must retain unacknowledged changes
instead of discarding mutations with a presentation.

Frame notifications are small `postMessage` controls. Payloads remain in the
shared buffers. The main thread never uses `Atomics.wait`; the test worker
also keeps its event loop serviceable while deliberately holding a frame.
Sequence numbers stop before signed 32-bit overflow; the host must replace
the buffers before that limit. Capacity changes likewise need replacement
buffers and a handoff, rather than resizing an occupied slot.

SAB needs a secure, cross-origin-isolated host; the test server supplies COOP
and COEP headers only when requested. See [SharedArrayBuffer's requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements).
A transferable-buffer transport can later use the same scene records. It is
not a prerequisite for the shared-memory path.

## Scene coverage

The codec supports 2D containers, shapes and morphs, dynamic Graphics, button
states, static text, TextFields and Bitmap objects. It carries child order, transforms, visibility, colour
transforms, all Flash blend modes, timeline clip depths, script masks within
the captured tree, and every filter except displacement maps. The worker
retains mirror objects across frames and draws through the existing `PixiView`
and pinned Pixi fork. The internal classes are `SceneSnapshot` and `SceneMirror`.

Each static asset has a library ID and a character ID. After linking and image
decoding, `shareLibrary` copies the SWF bytes and its authoritative decoded
bitmap pixels into immutable shared asset buffers. The worker reads those
with `readSharedLibrary`; it does not decode images independently or receive
script objects. Both sides register the same positive, never-reused library
ID in `SceneLibraries`. Registration must finish before publishing a frame
that references the library. Retire a library only after every snapshot that
references it has been released or discarded. Retiring one registration keeps
cached shape objects that another registered library still shares.

Text layout stays on main, where scripts read it synchronously. A TextField's
snapshot includes its laid-out lines, character positions, embedded font/glyph
references, formats, scroll, background/border and selection. The worker's
TextObject reads that layout directly instead of measuring and wrapping it
again. Strings preserve UTF-16 code units, including lone surrogates. Device
text rasterizes through Pixi's worker canvas and needs the same fonts on both
sides; system fonts are covered by the tests. A host using CSS-loaded fonts
must make them available to the worker too.

Every complete frame contains a copy of each distinct live Bitmap store's
premultiplied ARGB pixels, packed at four bytes a pixel, plus its identity and
version. Two Bitmaps showing one store share a mirror store. Unchanged versions
retain the mirror's CPU/GPU copy, but their pixels are still present in the
frame so skipping a presentation cannot lose an update. Mirror pixels own
their memory, and retired stores are disposed. Dirty-rectangle staging remains
future work. Immutable library bitmap fills use the shared asset pixels.
Graphics bitmap fills and textured triangles share the same per-frame store
records as Bitmap objects, including change notifications for retained geometry.
Bitmap strokes on library shapes remain unsupported.

A main-thread `BitmapData.draw` can leave pixels newer on its GPU. Encoding
reads the store's `readable` pixels, which synchronously brings that copy back
before publication. The browser test uses a fresh main-thread drawer that has
never drawn the stage, followed by an immediate pixel read while the worker
renders the stage. This preserves the bitmap operation's semantics; the readback
cost and the extra main-thread renderer's GPU resources must be included in performance and memory measurements.

Graphics snapshots copy resolved layers: paths, gradients, winding, line styles,
closing strokes and textured triangles, including the triangles drawn under a
mirrored transform. The worker retains unchanged geometry. A button contributes
only its currently visible display-list children; its other states, input and
scripts remain on main. Morphs reference their registered asset and ratio. Capture
does not call `drawn()` on the source. The host records morphs for each bounded
pending slot and commits only the acknowledged ratio, without changing the ratio
scripts currently see. Dropped frames do not commit main-thread morph bounds.

Rendered scroll rectangles, scale9 grids and explicit cache flags are copied to
the mirror. A pending scrollRect that main has not committed yet does not take
effect early. Unsupported content is rejected during encoding: displacement
maps, masks outside the captured tree, stale shape caches and 3D.
Decoding validates the full snapshot before changing the mirror, including
variable content, fonts and mask ownership.
Mask links are restored after attachment; retained arrays never point into a
reusable shared slot. Changed text and filters invalidate their existing
mirror objects; unchanged values retain their records and layout.

Version 5 uses two Float64 header values (version and node count), followed
by 27 Float64 values per node: identity, parent row, character ID, kind/visibility
flags, six matrix values, eight colour values, blend index, timeline depth
(NaN for none), clip depth, mask row (-1 for none), filter-tail offset,
library ID, content-tail offset, drawing-tail offset and display-state offset. Zero offsets mean no
payload. Each row's nonempty filter list, text/bitmap/morph content and Graphics
layers and display state follow the rows in row order.
Filter lists contain a count, then kind and values; arrays have a length prefix,
booleans are 0/1, and bevel types use inner/outer/full indices. Bitmap records
can reference pixels already defined earlier in the same complete frame.
The text property/format order and filter field order belong to the version.

This prototype favours explicit complete records over compact packing. At
50,000 nodes the fixed records alone use about 10.8 MB per slot, or 32.4 MB for
three slots, before variable content and assets. That is transport storage,
not total player memory: each thread also has library and scene objects, and
the renderer owns GPU resources. Encoding/decoding still allocates; memory,
allocation, readback and presentation measurements are required before making
a performance claim.

The worker installs Pixi's worker adapter and removes its DOM event system
inside that worker's isolate. The caller supplies that adapter; the test
bundles it with the worker, keeping its XML parser out of the normal browser
bundle. A host must retain input routing and synchronous
script-visible operations on the main thread. In particular, moving stage
rendering must preserve `BitmapData.draw` and immediate pixel reads, with any
extra main-thread renderer and GPU copies included in memory measurements.

The browser tests reject a malformed frame, draw a valid frame afterwards, and
lose and restore the worker's WebGL context twice with filters, text and bitmap
fills still visible. Failed presentations release their slots. Filter caches
invalidate after restoration in both renderers.

## Experimental host adapter

`WorkerView` keeps the main canvas for input and synchronous bitmap drawing,
and places a noninteractive worker canvas above it. Its caller keeps the main
`PixiView` as the scripting drawer and renders with that view whenever
`WorkerView.render(state)` returns false. Size, resolution, background, quality
and sample counts travel in each shared slot, together with the required library
generation. A newer snapshot cannot take an older control message's settings.
If the worker has not processed the required registrations, it skips that
presentation and asks for the current complete frame again.

Register each SWF after image decoding, before publishing its objects. The
adapter keeps registrations until destruction and bounds them at 256 MiB of
shared assets and 512 libraries; these limits exclude library objects and GPU
resources. Initial transport is three 8 MiB slots, growing by recreation up to
32 MiB per slot. Asset retirement during a session remains future work.

The fork's optional `EventSystem.rootTarget` keeps stage input independent of a
synchronous offscreen draw on the main renderer. The adapter commits acknowledged
morph ratios, retries transient unsupported scenes at most once per second,
hides late frames after fallback, and recreates the worker, canvas, buffers and
registrations once after an error or timeout. Another failure leaves main
rendering active. Destruction terminates the worker and releases registrations.
Hosts must retain the latest redraw when publication encounters backpressure.

Build a worker with this checkout's pinned adapter using
`node tools/render-worker.ts output.js /asset-prefix/`. The prefix serves
`pixi/pixi.mjs`; the worker does not depend on a page's import map. Hosts must
serve COOP/COEP headers, expose active/fallback status, preserve quality/input and
call `destroy` before destroying the main renderer.

The adapter exposes cumulative encoding, decoding, rendering and acknowledgement
latency counters, publication/presentation/drop counts, asset and transport sizes,
and restart/fallback state. These are diagnostics, not a benchmark of total
memory, GPU completion or input-to-display latency. Full bitmap staging, readback,
two heaps and GPU resources still require measurements. The tests establish
correctness for the covered scenes; they do not establish a performance gain.
