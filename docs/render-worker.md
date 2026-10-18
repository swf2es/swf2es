# Shared-memory render worker prototype

The experimental modules in `packages/player/src/render/worker/` exercise a
SAB transport and an OffscreenCanvas renderer. They are internal, are not
exported by the player entry point, and are not selected by any player host.
The normal renderer remains the production path.

Run `node tests/player/worker.ts` after `pnpm build`; `--gpu` uses the machine's
GPU rather than SwiftShader. The runner serves an isolated localhost page,
bundles the test worker using the Pixi fork's existing esbuild dependency,
and compares its pixels with the main-thread renderer. No new dependency is
needed. The default run is part of `pnpm test`.

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

The codec supports 2D containers and immutable vector shapes from one SWF
library, with child order, transforms, visibility and colour transforms.
It also carries all Flash blend modes, timeline clip depths, script masks
whose objects and owners are inside the captured tree, and every filter
except displacement maps. Filter chains and their retained output are drawn
by the same Flash-compatible code as the main-thread renderer. The library's
SWF bytes are shared once; each thread parses its own library. Complete frames
contain flat numeric records referencing those assets. The worker retains its mirror objects across frames and uses the
existing `PixiView` and the pinned Pixi fork to draw them.

Unsupported content is rejected during encoding: text, bitmaps and image
fills, dynamic Graphics, morphs, buttons, displacement maps, masks outside the
captured tree, cached bitmaps, scroll rectangles, scale9 and 3D. This keeps a
successful snapshot from silently omitting a rendering feature. Decoding
validates the full snapshot, including filter tails and mask ownership, before
changing the mirror. Mask links are restored after all objects are attached, and
changed filter records replace the mirror's own copies; no retained filter
array points into a reusable shared slot.

Version 2 uses two Float64 header values (version and node count), followed
by 23 Float64 values per node: identity, parent row, library character,
flags, six matrix values, eight colour values, blend index, timeline depth
(NaN for none), clip depth, mask row (-1 for none), and filter-tail offset
(0 for none). Nonempty filter lists follow the rows in row order. They
contain a count, then each filter's kind and values; arrays have a length
prefix, booleans are 0/1, and bevel types use inner/outer/full indices.
The filter field order is part of this internal protocol's version.

This prototype favours explicit complete records over compact packing. At
50,000 nodes the fixed records alone use about 9.2 MB per slot, or 27.6 MB
for three slots, before filter tails and assets. That is transport storage,
not total player memory: each thread also has its library and scene objects,
and the renderer owns GPU resources. The current codec still allocates
while encoding and decoding; allocation and memory measurements are needed
before making a performance claim.

The worker installs Pixi's worker adapter and removes its DOM event system
inside that worker's isolate. The caller supplies that adapter; the test
bundles it with the worker, keeping its XML parser out of the normal browser
bundle. A host must retain input routing and synchronous
script-visible operations on the main thread. In particular, moving stage
rendering must preserve `BitmapData.draw` and immediate pixel reads, with any
extra main-thread renderer and GPU copies included in memory measurements.

Before integrating a host: extend the scene/asset protocol, test context
loss and error recovery, retain synchronous bitmap semantics, and measure
encoding, rendering, presentation/input latency, backpressure and both heaps.
The current pixel tests establish correctness for the limited scene; they
do not establish a performance gain on real SWFs.
