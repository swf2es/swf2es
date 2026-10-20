# Flash VM worker feasibility probe

The separate [expanded scene snapshot codec](scene/README.md) covers text,
bitmaps, Graphics, morphs and library namespaces with its own ownership and
pixel checks. It does not replace the minimal playback codec or add a full host.

These opt-in experiments run real AVM1 and AVM2 SWFs on main and in a browser
worker. They probe ExternalInterface, synchronous bitmap drawing through Drawer,
and a minimal renderer-neutral scene path for visible playback.

After `pnpm build`, run:

```sh
node tests/worker-vm/run.ts
node tests/worker-vm/run.ts --bitmap
node tests/worker-vm/run.ts --playback
node tests/worker-vm/run.ts --playback --gpu
node --test tests/worker-vm/playback-scene.test.ts
node tests/worker-vm/run.ts --serve
```

The default command checks all three experiments in Chrome; `--bitmap` checks only the
bitmap boundary. `--serve` builds the fixtures and serves the interactive preview
at the loopback URL it prints. Choose a VM, colour and repetition count, then run
the comparison. The preview uses asynchronous commands to start worker work;
it does not change the synchronous callback contract discussed below.

The runner uses the existing oracle container to compile its AS3 fixtures and
the Pixi fork's installed esbuild, with no new dependency. The loopback server
sets cross-origin isolation headers. Generated bundles, SWFs, comparison JSON
and images stay under the ignored `out/` directory. These probes run separately
from `pnpm test`; their browser and worker sources join `pnpm typecheck`.

## Findings on 19 October 2026

Both VMs boot and execute callbacks in the worker without a renderer. For each
VM, 126 synchronous result/error comparisons match direct main-thread execution,
including the order of nested page and SWF calls. Calls start from either side
and descend up to six levels, with errors injected at each level. The comparison
preserves the current host's behavior, including its conversion of page exceptions
to undefined; it does not introduce new exception-marshalling semantics.

The diagnostic bridge preserves these synchronous callbacks by spinning on main
and pumping only shared-memory requests. A controlled 100 ms worker delay blocks
main for about 100 ms: queued timers, animation callbacks and microtasks do not
run before the call returns. The same worker delay sent asynchronously lets main
continue running tasks. This is an event-loop experiment, not a game performance
or input-latency benchmark.

The nonblocking main policy still services calls originating in the worker but
explicitly rejects synchronous page-to-worker callbacks. Changing those callbacks
to return Promises would change the existing embedding contract. These results
leave the host compatibility policy open; they do not rule out running the VM
in a worker when a host accepts the relevant tradeoff.

## Experimental transport

Each direction has sixteen slots with a 16 KiB UTF-8 envelope limit. Atomic
ownership publishes complete requests and responses. The worker sleeps with
`Atomics.wait` and services nested requests while awaiting its result. Main's
diagnostic spin is confined to this experiment; it never calls `Atomics.wait`.
Text decoding copies the owned shared payload into an ordinary buffer.

Oversized requests, responses and excessive nesting are rejected, with a healthy
call checked afterward. A wait that times out closes the whole endpoint so a late
response cannot be reused. Closing from main wakes a waiting worker. Timeouts
cannot preempt an arbitrary synchronous handler that never returns.

Browser background:
[Atomics.wait](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait)
and [tasks and microtasks](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide/In_depth).

## Single renderer bitmap drawing

The second probe compares the normal VM/renderer on main, a VM worker using
main's renderer, and a VM worker with an additional worker-owned renderer.
All three use this checkout's pinned Pixi fork. The comparison worker bundles
the fork separately because DOMAdapter is outside the production browser
bundle's export list. Each mode also uses a main renderer to show the result.

Both VMs draw from their constructors and from callbacks, reading pixels
immediately after successive mutations. AVM1 replaces exported timeline symbols;
its MovieClip drawing API is not implemented. AVM2 edits live Graphics. The cases
cover order changes, removal and reinsertion, ignoring the source's own position,
flipped/translated draw matrices, colour transforms, clip rectangles and blends.
Twelve configurations compare the immediate reads and every pixel of a 40 x 32
bitmap across modes, including green and purple fills and repeated sequences.

In the main-renderer mode, Drawer.snapshot sends the current solid drawing
subtree with each request, so changes cannot lag behind the draw. Main rasterizes
with its usual PixiView, writes premultiplied pixels into a bounded shared buffer,
and publishes an ordered response. The worker copies the pixels before continuing
the Flash call. Main uses the nonblocking bridge policy and performs zero spins.

This probe takes the CPU snapshot path for remote draws; it reads back each
snapshot and does not maintain GPU-resident BitmapData across threads. Snapshots
are capped at 128 x 128 pixels, with bounded message envelopes and subtree size.
The small subtree format accepts solid shapes and Graphics; unsupported effects
and other display types fail explicitly. It is not a general scene/frame protocol.

The preview checks full bitmap equality and shows callback elapsed time and
renderer instance count. Those times include draw/readback work, transport and
fixture allocation, with different bundle shapes and shader warmup. They are
diagnostics, not a throughput or frame-pacing benchmark.

## Standalone playback comparison

`--serve` also prints a playback preview URL. It accepts a local SWF or a URL
served with suitable CORS headers. Choose an arrangement, animation label and
one to 32 visual copies, then load/restart to switch arrangements. Test one mode
at a time. The bundled redistributable fixture exercises constructor bitmap
drawing, immediate pixel reads, moving and mirrored shapes, changing filters,
child reordering and removal/reinsertion.

In both VM-worker arrangements, main owns the visible Pixi renderer. The optional
second Pixi renderer lives beside the VM and handles bitmap operations. A scene
without bitmap calls leaves that renderer idle; its presence alone does not
offload visible rendering. The preview exposes bitmap call counts, VM frames,
render submissions and timing counters on `globalThis.playbackPreview.stats`.
Submission counts are not GPU presentation measurements.

The VM advances on its own worker timer. It publishes complete 2D frames through
an owned SharedArrayBuffer slot, and continues advancing while main draws the
previous frame. When the slot is occupied, subsequent states coalesce instead
of queueing frames or overwriting data being read. Main copies the fields into
retained display objects before releasing the slot. Static vector assets and
filter records are registered once with structured messages. This is a complete
snapshot experiment, not a compact diff protocol or an optimized transport.

The scene path currently accepts containers, static vector fills/strokes and
ordinary filters, colours and blend modes. Unsupported content fails visibly:
text, bitmap objects/image fills, Graphics, morphs, masks, scrolling, scale9,
displacement and 3D. It supports one standalone SWF, not loaded libraries, input,
audio or full-game host services. ExternalInterface is stubbed as an isolated
preview host; it does not solve the synchronous embedding contract above.

There is one bounded visible-frame slot and one separate snapshot slot (about
5.5 MiB each), plus a 4 MiB bitmap-result buffer, in worker modes. Frames permit
32,768 nodes. Each session permits 8,192 shape assets and 8,192 filter lists,
with a 64 MiB JSON-size estimate across registrations. Remote snapshots are
limited to 1,024 x 1,024 pixels. These bounds do not describe total heap/GPU use.
Main-thread mode allocates no worker transport. Closing or failing a session
cancels pending commands, wakes the bridge and terminates the worker.

Nine displayed frames and immediate bitmap results match across all three modes
on software GL and the hardware GPU. A busy worker leaves main tasks running;
backpressure coalesces frames while main is blocked. The separate Node check
covers slot ownership, reparenting, rejected captures and malformed-frame
recovery. Private user content and its captures are kept outside tracked files.

## Next step

Measure sustained playback with warmed, alternating runs on the same content and
canvas size. Extend supported display features only as real workloads require.
Full-player worker hosting, callback policy, storage, audio, fonts, asset
retirement and frame pacing remain separate work.
