# Flash VM worker feasibility probe

This opt-in experiment runs real AVM1 and AVM2 SWFs on main and in a browser
worker through the existing ExternalInterface host contract. It constructs no
renderer and changes no player host or production entry point.

After `pnpm build`, run:

```sh
node tests/worker-vm/run.ts
```

The runner uses Chrome and the existing oracle container to compile its AS3
fixture. It reuses the Pixi fork's installed esbuild to bundle the experiment,
with no new dependency. It serves a loopback page with cross-origin isolation.
Generated bundles, SWFs and `results.json` stay under the ignored `out/` directory.
The probe is deliberately separate from `pnpm test`; its browser and worker
sources are included in `pnpm typecheck`.

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

## Next boundary

Prototype synchronous `BitmapData.draw` through one main-thread renderer, including
scene ordering and immediate pixel reads. Compare it with a worker-owned renderer
before building a general scene-update protocol. Full-player worker hosting,
storage, audio, fonts, asset transport and frame pacing remain separate work.
