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
one consumer. `FrameWriter.write()` owns a free payload while encoding, then
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

`scene-bench.ts` builds its own redistributable synthetic scene and measures
encoding CPU time. Use the same node/frame counts and repeat on both revisions
under comparable machine load. These timings do not measure FPS, GPU
presentation, input latency or cold-load responsiveness. Complete snapshots
still walk every node and rebuild text/filter records; this is not a diff
protocol and does not establish a general worker performance benefit.
