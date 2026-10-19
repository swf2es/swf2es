# Flash VM worker feasibility probe

These opt-in experiments run real AVM1 and AVM2 SWFs on main and in a browser
worker. One probes the ExternalInterface contract without a renderer; the other
tests synchronous bitmap drawing through the existing Drawer interface.

After `pnpm build`, run:

```sh
node tests/worker-vm/run.ts
node tests/worker-vm/run.ts --bitmap
node tests/worker-vm/run.ts --serve
```

The default command checks both boundaries in Chrome; `--bitmap` checks only the
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

## Next step

Design a minimal renderer-neutral scene-update path for visible playback, then
measure it on a repeatable workload. Full-player worker hosting, callback policy,
storage, audio, fonts, asset transport and frame pacing remain separate work.
