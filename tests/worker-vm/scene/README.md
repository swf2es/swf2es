# Expanded 2D scene snapshots

This opt-in codec extends the small static-vector boundary in the playback
experiment. It records player display state without importing Pixi, executing
scripts or changing the production player. It is experimental test code, not a
worker player API. The original playback preview continues using its smaller
codec; the full host and its services are separate work.

The snapshot carries a complete scene or subtree, including a leaf root:

- Containers, ordering, affine and colour transforms, visibility and blend modes.
- Library shapes, static text, embedded fonts and morph ratios. Asset IDs are
  qualified by library, so independently loaded SWFs may reuse character IDs.
- Text content, formats, selection and already computed layout. UTF-16 code
  units, including lone surrogates, survive transport; glyphs reference the
  registered fonts rather than being laid out again by the receiver.
- Bitmap stores, aliases and pixels; resolved Graphics paths and paints,
  including mutable bitmap fills.
- Ordinary filters, explicit and timeline masks, scroll bounds, bitmap caching
  and scale-nine state.

3D content, displacement-map filters, unregistered assets and unsupported
shape content fail explicitly. This does not supply networking, input, audio,
storage, ExternalInterface compatibility or VM scheduling. The pixel fixture
covers embedded text, static text, morphs, library ID collisions, bitmap aliasing,
bitmap-filled Graphics, filters, explicit masks, reflections, colour transforms,
scrolling, caching and reordering. It does not exhaust every supported record.

## Ownership

Register each immutable library with `SceneLibraries.add()` on both sides.
`shareLibrary()` publishes SWF bytes and decoded library bitmap pixels once;
`readSharedLibrary()` reconstructs the receiver's library. Neither side may
modify these published buffers. IDs are positive and never reused within a
registry. `drop()` is a host operation, valid only after outstanding snapshots
and retained objects no longer need that library. The codec does not implement
asset retirement, a total asset memory limit or a host lifecycle.

`sharedFrames(capacity, slots)` allocates fixed-size slots for one producer and
one consumer. Snapshot records use Float64 storage: payloads must be aligned
to eight bytes, so use a capacity divisible by eight. `FrameWriter.write()` owns
a free payload while encoding, then
publishes it with Atomics. It returns `null` without invoking the encoder when
all slots are occupied. A failed encode returns its slot to the free pool and
does not publish or advance the sequence. Sequences do not wrap; exhaustion
requires replacing the channel.

`FrameReader.take()` acquires the newest published frame and releases older
unconsumed slots. Its caller must call `release()` once, after the last payload
read, even if decoding throws. `SceneMirror.apply()` validates the full record
structure before updating the retained graph. Changed arrays and bitmap pixels
are copied into receiver-owned storage, so a frame can be released before an
asynchronous draw. Returning a lease does not acknowledge that it was rendered.
The slot protocol uses no main-thread waits or spin loops.

Unchanged text and filter records are compared with their previously validated,
owned numeric copies before parsing. Matching records reuse the retained state;
changed records are parsed and validated before any graph updates. Text font
references are revalidated after the library registry changes. Reuse adds no
history of old frames or additional copies of these records.

Decoder scratch arrays grow with the largest snapshot and are reused. References
to parsed records and borrowed bitmap pixels are cleared after every apply,
including rejected frames; `dispose()` also releases the array storage. This
reduces temporary allocations but does not make decoding allocation-free:
changed records and retained graph updates can still allocate.

Retained containers keep their timeline-depth lookups between snapshots. Old
depths are removed before any new depths are assigned, so swaps cannot erase
another child's new entry. Reordering and reparenting still use the ordinary
display-list operations; duplicate depths resolve to the last child in scene
order. Rejected frames leave the lookups intact.

```ts
const writer = new FrameWriter(frames);
const snapshot = new SceneSnapshot(assets);
const sequence = writer.write((bytes) => snapshot.encode(sourceRoot, bytes));
// Notify the consumer only when sequence is non-null.

const frame = reader.take();
if (frame) {
  try {
    const root = mirror.apply(frame.bytes);
    // Keep root for rendering; its fields no longer borrow the payload.
  } finally {
    frame.release();
  }
}
```

For morphs, `encode()` can collect `MorphPresentation` receipts. After the
corresponding scene is actually drawn, the VM-side host can call
`presentedMorph()` to update script-visible drawn bounds for the captured pose
without changing a newer live ratio. Receipts and acknowledgements must remain
bounded by the host's outstanding presentations. Closing a host must stop draws,
release renderer resources, dispose mirrors and terminate its workers.

## Checks and measurement

After `pnpm build`:

```sh
node --test tests/worker-vm/scene*.test.ts
node tests/worker-vm/scene-run.ts
node tests/worker-vm/scene-run.ts --gpu
node tests/worker-vm/scene-bench.ts 8000 120
```

The browser check compares twelve changing scenes rendered directly, through a
local mirror and through a worker-published mirror. It overwrites released
payloads before rendering and compares every output pixel, including two
libraries with the same character ID. The Node checks cover retained state,
bitmap aliases, glyph references, malformed-frame recovery, subtree roots,
failed publication, backpressure, payload reuse and delayed morph receipts.
They also check changed and truncated retained records, and font retirement
after an identical text frame.
CI runs these Node and software-renderer checks explicitly. The hardware-GPU
comparison remains a local check; no experiment is added to the production host.

`scene-bench.ts` builds its own redistributable synthetic scene and measures
encoding CPU time. Use the same node/frame counts and repeat on both revisions
under comparable machine load. These timings do not measure FPS, GPU
presentation, input latency or cold-load responsiveness. Complete snapshots
still walk every node and compare retained text/filter values; changed records
are rebuilt. This is not a diff protocol or an allocation-free pipeline, and
does not establish a general worker performance benefit.

The fixed 27-value node header uses indexed writes, avoiding one temporary
numeric array per node. In a local CPU comparison, two encoders processed the
same sixteen captured scene states decoded into a retained source graph, in
alternating order outside VM execution and rendering. All 70.8 MB of compared
output matched byte-for-byte. Across
32 paired batches the indexed encoder was faster in 30, with a median paired
CPU saving of 16.1%. Background load varied, so absolute times and full-game
frame pacing are not inferred from this comparison. Six subsequent live VM
replays did not establish a material encoding or pacing gain. The synthetic command
above provides a redistributable workload for comparisons across revisions.

A separate decoder comparison applied the same sixteen captured snapshots
(about 7,500 nodes) to two retained mirrors, alternating batch order. Skipping
unchanged text/filter parsing was faster in 30 of 32 paired batches, with a
median paired CPU saving of 24.5%. This is a component measurement without VM
execution or rendering, not an FPS or garbage-collection pause measurement.
Six subsequent hardware-GPU replay runs used a benchmark-only 60 Hz VM target
and preparation before display. Median per-run decoding fell from 5.74 to
5.45 ms, but draw submissions fell from 56.3 to 54.2/s and draw-gap p95 rose
from 23.4 to 27.7 ms. System load varied. The component saving does not justify
promoting the candidate as a smoother playback mode.
