# Workers

What ActionScript 3's workers (`flash.system.Worker`, `WorkerDomain`,
`MessageChannel`, shared properties, a shareable `ByteArray` and
`flash.concurrent`'s `Mutex` and `Condition`) need of swf2es, how they map
onto a browser's and node's threads, and the order to build them in. The
first slice is built (see [Slice 1](#slice-1-message-passing-workers)); the
rest is the plan.

## What content needs

### Tamarin's tests

`oracle/avmplus/test/acceptance/as3/Workers` has 11 tests. avmshell runs
them all with every assertion passing (`tests/tamarin/baseline.json`; four
print nondeterministic output, so only their counts are compared). Its API is
the shell's own, not Flash's: `WorkerDomain.createWorkerFromPrimordial()` and
`createWorkerFromByteArray(bytes)`, no `MessageChannel`, no events, and
`avmplus.System.sleep` to wait. swf2es's runtime, as avmshell's
`natives/shell.ts`, keeps the primordial's shared properties as avmshell
does (the `worker-shared-properties` conformance case: an object copied by
AMF3 at the set and at each get, a ByteArray, Mutex or Condition kept as
itself) and throws "not supported" on creating a worker, so, by
`tests/tamarin/swf2es-baseline.json` (assertions passed and failed before
the test stops):

| Test | Needs | swf2es now |
|------|-------|------------|
| `Worker`, `WorkerDomain` | create, start, terminate, state, `listWorkers`, errors 1511 | 1 passed 2 failed, and 3 passed 1 failed: what precedes the first creation |
| `WorkerErrors`, `WorkerCreateMax`, `regress/bug774294`, `regress/bug774302` | the same | stop at the first creation, no assertion run |
| `ConditionAndMutexAPI` | Mutex and Condition on one thread | passes (12/12) |
| `ByteArrayAPI` | `atomicCompareAndSwapIntAt`/`Length`, `shareable` | 14/17: the three `shareable` assertions |
| `ByteArrayWorkersLzma` | an LZMA round trip on a shareable ByteArray on one thread, then a worker doing it again on the same bytes | 5 passed 1 failed of the six before the first creation, where it stops |
| `ByteArrayWorkers`, `RemoteCall` | five workers over one shareable ByteArray, a cross-thread Mutex, CAS, the primordial busy-waiting on the bytes | stop at the first creation |

The last three are what real threads need: the primordial spins reading
the shared bytes while five workers write them, and takes the shared Mutex
around `trace`. They run only where memory is truly shared.

A known avmshell bug is not ours to copy: `Condition.wait(ms)` returns
false at a whole second less a millisecond, from an overflow of its
nanoseconds.

### Crossbridge

The samples of Crossbridge's SDK (`samples/`), built with it (SWF 26) and
played in Chrome with swf2es before slice 1:

| Sample | Where it stops |
|--------|----------------|
| `01_HelloWorld/hello-*.swf` | `CRun::newThread`, `WorkerDomain.createWorker`: "creating a Worker is not supported yet" |
| `09_Pthreads/pthreads.swf`, `sound.swf`, `pthread_swc1.swf` | the same |
| `11_OpenMP/mandel.swf` | the same |
| `09_Pthreads/pthread_swc2.swf` | nothing traced, no error in 60 frames (its document class drives a SWC; to look at once workers run) |
| `10_MessageChannel/mc.swf` (40 MB uncompressed, its ABC alone takes the compiler some minutes) | TypeError 1009 in its own `Console.init` after `CModule.startBackground`, which swallowed the same "not supported" |

So every Crossbridge sample needs workers, even Hello World: its `Console`
runs `main()` on a background worker whenever `CModule.canUseWorkers`, which
is only whether `flash.system.Worker` resolves. It never reads
`Worker.isSupported`. What its runtime (`C_Run.abc`, `CModule.abc`,
`PlayerCreateWorker.abc` in the Crossbridge image) does:

- `retargetSWF` copies `rootSprite.loaderInfo.bytes`, which must be
  uncompressed (`FWS`, else it throws "loaderInfo.bytes is compressed"),
  and rewrites SymbolClass so that the document class is
  `C_Run.AlcWorkerSprite`; `createWorker` gets those bytes.
- `newThread` sets shared properties on the new worker before starting it:
  `flascc.threadId` (int), `flascc.threadArbMutex` (a Mutex), 32
  `flascc.threadArbCond.N` (Conditions), `flascc.ram` (the C heap, a
  ByteArray made shareable just before), `flascc.esp_init`,
  `flascc.thread_entry` (ints) and `flascc.thread_args` (a ByteArray
  holding an AMF3 Vector.<int>).
- The worker sets `flascc.ram` as its domain memory and runs the C code
  against it. The heap grows with `atomicCompareAndSwapLength`, from any
  thread.
- `startBackground`, on the primordial: takes `threadArbMutex`, starts the
  worker, then loops `threadArbConds[tid].wait(1)` and
  `serviceUIRequests()` until the worker has written its thread control
  block, then notifies all and unlocks. So the primordial does block, in
  waits of 1 ms, and a wait must release the mutex for the worker to take
  it.
- After that the primordial only pumps: `serviceUIRequests` on its frames
  runs what the threads queued for the UI thread (the console's writes,
  Flash API calls) through the shared heap and `threadArbMutex`.
- `C_Run.yield(ms)` is a `Condition.wait(ms)` on a private mutex: a sleep,
  on any thread.
- `10_MessageChannel` passes C++ values through `MessageChannel` and
  `channelMessage` events, from a thread's own event handler.

With slice 1's workers, Hello World and `mandel.swf` get one step
further: `createWorker` succeeds, and `newThread` stops at setting
`flascc.threadArbMutex`, "passing a Mutex to another worker is not
supported yet".

Crossbridge therefore needs, all at once: workers, a shareable ByteArray
whose memory every thread sees (as domain memory), Mutex and Condition
across threads with real blocking in workers and short blocking on the
primordial, and atomics on the bytes. Message passing alone runs none of
the samples.

### Flash's semantics, measured

The `worker-basics` player case (`tests/player/scripts/WorkerBasics.as`)
traced in adl (AIR 51), and is the reference for slice 1:

- `Worker.isSupported` and `WorkerDomain.isSupported` are true.
- `createWorker` gives a worker in state `new`; `listWorkers` lists only
  running workers, the primordial among them, so 1 before `start` and
  after `terminate`.
- A second `start` throws IllegalOperationError 1511 (avmshell throws a
  plain Error with the same number); `terminate` on the primordial
  IllegalOperationError 3732. `terminate` gives true for a running worker,
  false after.
- `workerState` comes as `running`, then `terminated`.
- `createMessageChannel(receiver)` on worker S makes a channel from S to
  the receiver. `receive` on any other worker throws ArgumentError 3737,
  `send` from any but S ArgumentError 3736. `receive` with nothing queued
  gives undefined. `messageAvailable` is true on either side while
  something is queued.
- A shared property is copied when set, by AMF3, as avmplus' `ChannelItem`
  does: each `getSharedProperty` gives a new copy, and changes made after
  the set are not seen. undefined deletes it. A MessageChannel is passed
  by reference: the same object comes back. A ByteArray read back by the
  worker that set it is the same object; another worker gets a copy.
- A background worker sees itself as `Worker.current`, not primordial,
  `running`, and reads what the primordial set before `start`.
- Messages sent before `start` are delivered once it runs, in order.

## Architecture

### One VM a thread

Each background worker is a thread of the host's running a VM of its own:
its own `codegen.wasm` instance, runtime and playerglobal, on the bytes
`createWorker` was given (`WorkerDomain.createWorker(bytes)`), with no
renderer, no sound and no input. In a browser the thread is a Web Worker;
in node (unit tests, and later the CLI's avmshell) a `worker_threads`
Worker. The worker plays its SWF headless, `Player` and `Scripting` as the
node tests use them: its document class is constructed, and its frames run
on a timer at the SWF's frame rate, so that its timers, `enterFrame` and
the events it is sent fire.

The player defines what crosses between threads (`hosts.ts`'s
`WorkerHost`, `workers/protocol.ts`); a host only starts threads and moves
messages. `runtime`, `codegen` and `format` stay as they are: free of DOM
and node types, and unaware of threads. A thread runs
`@swf2es/player/worker`'s `runWorkerThread` (`workers/thread.ts`), which
knows nothing of the kind of thread: it is posted codegen's compiled
`WebAssembly.Module` (a module posts without recompiling) with the
worker's `WorkerInit`, the SWF, the library ABCs as the primordial loaded
them and the shared properties set before `start`, makes its `Scripting`
and `Player`, and runs frames by `advance` on a timer.

`@swf2es/player-hosts` has two hosts: `webWorkerHost` (`/workers`) starts
a module Web Worker on its `web-worker.js`, and `nodeWorkerHost` (`/node`)
a `worker_threads` Worker on `node-worker.js`. A worker sees no import map,
so a page that serves the packages unbundled gives `webWorkerHost` a
script URL whose imports resolve: the player tests' server serves every
file again under `/worker/` with its bare specifiers resolved
(`tests/player/serve.ts`). A bundler that knows `new URL(…, import.meta.url)`
workers bundles the default. A player made without a worker host has
`Worker.isSupported` false, and `createWorker` throws swf2es's "not
supported" error; `@swf2es/web`, the demo site and the desktop app give
none yet (slice 6).

The primordial is the hub: every background thread talks only to the
thread that made it, which routes messages between workers. Workers made
by a background worker are left for later.

### What crosses, and how

As Flash and avmplus:

| Value | Crosses as |
|-------|------------|
| int, uint, Number, Boolean, null, String | itself |
| undefined | (deletes a shared property) |
| any other object, Vector, Array, XML | AMF3 bytes, by the runtime's writer, read by the other VM's, its aliases its own |
| ByteArray, not shareable | its bytes, copied at the set or send |
| ByteArray, shareable | its memory, shared (slice 3) |
| MessageChannel | a reference: one object a worker, by id |
| Mutex, Condition | a reference: shared state (slice 4) |

Only the top value is looked at so, as in avmplus: a MessageChannel inside
an Object is an empty AMF object on the other side. Slice 1 refuses a Mutex
or a Condition with "not supported" rather than copy it.

A shared property belongs to the worker it is set on, readable and
writable from both the worker and its parent. Slice 1 keeps a copy of
each worker's properties on both sides and posts each set to the other:
what the primordial sets before `start` is there when the worker starts,
and what one side sets reaches the other between its frames. Code that
spins synchronously waiting for the other side never sees it without
shared memory, and spins for ever: on `getSharedProperty` until the other
side changes it, or on a channel, `while (ch.messageAvailable) {}` on the
primordial until a worker takes what it sent, `while (!ch.messageAvailable) {}`
in a worker until a message comes. With shared memory (slice 4) the
properties and the queues live in it, read and written under a lock, and
are seen at once.

The primordial's own shared properties go to every worker, those set
before a worker starts with its `WorkerInit`.

A channel's queue likewise: slice 1 posts each message to the receiver's
thread, which dispatches `channelMessage` between its frames, as Flash
dispatches it on the receiver's event loop. `receive(true)`, which blocks
until a message comes, needs slice 4's shared queues, and throws "not
supported" with nothing queued. The sender's `messageAvailable` cannot see
the receiver's queue without shared memory either: on the primordial it is
true from a send to a background worker until that worker has run a frame
since, which is what Flash shows for messages sent before `start`; on a
background worker's side it is false. A channel's state is one at both
ends: closed by either, it is `closing` until the receiver has taken what
was queued, which only the receiver sees, so a sender on another worker
stays `closing` until the receiver tells it, and gets a second
`channelState` then. The primordial's copy of a channel between two other
workers follows it as it routes their closes.

A worker's lifecycle frees what it held: a terminated worker's SWF (its
thread had its own copy from `start`), its shared properties and its
channels are let go, and its Worker object once its last `workerState`
has been dispatched; a script that still holds one reads `terminated`.
A host that cannot start a thread at all, such as a page whose policy
forbids the worker's script, has `start` throw IllegalOperationError 3807,
Flash's error for a player whose workers are disabled, and the worker is
terminated. A thread that fails later, as on a SWF that is not one, is an
error nothing caught on the primordial, and the worker is terminated.

What the embedder gives the primordial is functions on its own thread,
which no message carries, so a worker's VM has none of it: no `fetch`
(a worker's loads fail as with no network), no sockets or WebSockets (not
even the global WebSocket the primordial defaults to), no
ExternalInterface, `fscommand`, `navigateToURL`, `sendToURL`, policy
files, file dialogs, clipboard or sound, and its SharedObjects are kept in
memory, for its life only. It reports the primordial's
`Security.sandboxType`. A worker never has more than the primordial; giving
it the primordial's hosts through the thread is later work.

Every worker compiles its SWF with the JIT, so with `new Function`: a page
whose Content-Security-Policy has no `'unsafe-eval'` cannot run workers
until slice 5 gives them modules compiled ahead of time.

A background worker's `trace` goes to the primordial's output, an error
nothing caught in it to the primordial's `onUncaught`, prefixed "a
background worker". For tests to step frames deterministically,
`Scripting.settled()` waits, as for a load, until each thread has run a
frame since the messages posted to it (its `idle` message): the primordial's
next frame then sees what the worker answered.

### Shared memory

A shareable ByteArray, domain memory over one, `atomicCompareAndSwap*`,
Mutex and Condition across threads all need a `SharedArrayBuffer`, which a
browser gives only to a cross-origin isolated page
(`globalThis.crossOriginIsolated`): its document served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` or `credentialless`. Where:

- **node** (unit tests, the CLI's avmshell) always has it.
- **The desktop app** serves its page through its own scheme
  (`apps/desktop/src/main/protocol.ts`), so it can add both headers to
  the page's responses itself; Electron's `enable-features=SharedArrayBuffer`
  switch is the fallback. Its SWFs' loads go through the main process's
  network, so COEP costs it nothing.
- **The player tests' server** can send both headers on the page.
- **A web page** must have its server send them, which an embedder
  decides. `require-corp` blocks every cross-origin subresource that does
  not opt in with CORP or CORS, the SWF's own loads included;
  `credentialless` lets no-cors ones through without cookies, which is
  the gentler choice for a page that plays Flash content (Chrome and
  Firefox; Safari has only `require-corp`). Both cut the page off from
  cross-origin popups it opened, which `navigateToURL` to `_blank` and
  ExternalInterface pages may rely on.
- **The demo site** on GitHub Pages cannot set headers. A service worker
  that adds them to every response (the coi-serviceworker technique) is
  the known way round, at the cost of a reload on the first visit.

A shareable ByteArray's memory is a growable `SharedArrayBuffer`
(`new SharedArrayBuffer(length, { maxByteLength })`), which every thread
sees grow in place, as Flash's does: Crossbridge grows its heap from any
thread with `atomicCompareAndSwapLength`. Its maximum reserves address
space only; the runtime's domain memory `DataView` is made over it, and
the atomics are `Atomics.compareExchange` on an `Int32Array` view.

What to do where a page is not isolated is a choice (see [Decisions](#decisions-for-the-user)).

### Blocking

`Mutex.lock` and `Condition.wait` block. A background worker can: a
mutex is an `Int32Array` word in shared memory, locked by
`Atomics.compareExchange` and waited on with `Atomics.wait`, a condition a
sequence word notified with `Atomics.notify`, and `wait` releases the mutex
while it waits, as Flash's.

A browser's main thread cannot `Atomics.wait`: it throws there.
`Atomics.waitAsync` can wait, but only by returning to the event loop,
which a `lock` or `wait` in the middle of an AS3 method cannot do. What
the primordial does in real content:

- Crossbridge: a startup handshake of `wait(1)` in a loop, then only short
  locks around its UI queue on each frame. Its threads hold the lock for
  short spans.
- Tamarin's `ByteArrayWorkers` and `RemoteCall`: busy loops reading the
  shared bytes, and short locks around `trace`.
- Flash itself lets the primordial block, subject to the script timeout:
  a `lock` or `wait` that does not return within 15 s throws the
  ScriptTimeoutError (1502), as any long script.

The options for the primordial:

1. **Spin**: `lock` loops on `Atomics.compareExchange`, `wait(ms)`
   releases the mutex and loops on `Atomics.load` of the condition's word
   until notified or timed out, then takes the mutex again. Both stop with
   Error 1502 after Flash's 15 s, which is Flash's own answer to a
   primordial that waits too long. The page is frozen meanwhile, as Flash's
   UI was. Exactly Flash's semantics for the content that exists, at the
   cost of CPU while spinning.
2. **tryLock only**: `lock` fails when contended. Wrong for Crossbridge's
   handshake.
3. **The primordial VM in a worker**, the stage drawn on the main thread
   from what it sends (the paused "VM in a worker, Pixi on main" plan of
   2026-10-19): the primordial may then truly block. It is the render
   worker project in full: the scene protocol, synchronous
   ExternalInterface both ways, `BitmapData.draw`. It would make blocking
   free, but blocking does not need it.

Recommended: spin (1) now, with the 15 s limit; reconsider 3 on its own
merits, as the render-worker evaluation planned, and let it take over
blocking if it lands.

## Slices

Each a PR, in this order:

1. **Message-passing workers** (this PR): `Worker.isSupported`,
   `WorkerDomain.createWorker` on a host's thread, `start`, `terminate`,
   `listWorkers`, `workerState`, shared properties of copied values,
   `MessageChannel` with copied values (`send`, `receive(false)`,
   `messageAvailable`, `channelMessage`, `close`, `channelState`), and the
   worker's `trace` in the page's output. A Web Worker host and a node
   `worker_threads` host. And avmshell's copies of the primordial's
   shared properties in the runtime. Tests: the `worker-basics` player
   case against Flash's trace in Chrome, the same case in node over a
   `worker_threads` thread (`tests/unit/player/scripting/workers.test.ts`),
   and the `worker-shared-properties` conformance case against avmshell.
   Unlocks: AS3 content that only passes messages (image or data
   processing workers). No Crossbridge sample.
2. **avmshell's workers** in the runtime's shell natives and the CLI, over
   node's threads: `createWorkerFromPrimordial`, `createWorkerFromByteArray`,
   `start`, `terminate`, `state`, `listWorkers`, shared properties. Tests:
   the six lifecycle Tamarin tests, and conformance cases checked against
   avmshell. Unlocks: avmshell-checked semantics for what the rest builds
   on.
3. **Shared memory**: a shareable ByteArray over a growable
   SharedArrayBuffer, passed by reference (one object a worker, as
   avmplus interns it), real `atomicCompareAndSwapIntAt` and `Length`,
   domain memory over a shared ByteArray; cross-origin isolation for the
   test server, the desktop app and the demo site, and the documented
   headers for other hosts. Tests: Tamarin's `ByteArrayAPI` (17/17), a
   player case with two workers writing one ByteArray.
4. **Blocking across threads**: Mutex and Condition in shared memory,
   `Atomics.wait` in workers, the spinning primordial with the 15 s limit,
   shared properties and channel queues in shared memory (seen at once,
   `receive(true)`). Tests: Tamarin's `ByteArrayWorkers`,
   `ByteArrayWorkersLzma` and `RemoteCall`, conformance cases for
   wait/notify. Unlocks: Crossbridge's Hello World, `pthreads`, `sound`,
   `pthread_swc1`, `mandel`, if nothing else in them is missing.
5. **Compiled code shared with workers**: a worker takes the primordial's
   compiled modules, as a module cache would give them, rather than
   compiling its SWF again: each Crossbridge thread is a worker, and
   `mc.swf` takes minutes to compile. The same path gives workers the
   modules compiled ahead of time (`precompiledModules`), so that a page
   without `'unsafe-eval'` runs them too. Tests: a worker's modules equal
   to the primordial's, a worker under the precompiled test's policy, and
   the desktop smoke test.
6. **The embeddings**: `@swf2es/web`'s configuration of the worker host,
   the demo site and the desktop app (isolated, so with shared memory).
   Tests: the web and desktop smoke tests start a worker. Unlocks
   `10_MessageChannel`, once 5 makes it start in time.

## Decisions for the user

- **A page that is not cross-origin isolated.** Flash reports
  `Worker.isSupported` true and shares memory. Without isolation a
  browser cannot share memory, so the choices are:
  1. workers that pass messages everywhere, and shared memory only where
     the page is isolated; elsewhere passing a shareable ByteArray, a
     Mutex or a Condition to another worker throws swf2es's "not
     supported" error naming cross-origin isolation, rather than copying
     it and leaving a program waiting on memory nobody writes;
  2. `Worker.isSupported` false and `createWorker` refused without
     isolation, as before slice 1;
  3. copies in place of shared memory, silently.

  Recommended: 1. It is honest (it fails loudly, where 3 hangs), keeps
  `isSupported` as Flash reports it for the content that only passes
  messages, and 2 does not help Crossbridge, which never reads
  `isSupported`. Flash Player 32 itself could refuse `Worker.start` when
  a user disabled shared memory after Spectre (error 3807, "Worker.start
  has been disabled by the user"); that could be the error instead, if its
  exact behaviour is checked first.
- **The primordial's blocking.** Recommended: spin, with Flash's 15 s
  script timeout (above). The alternative is the primordial in a worker,
  which is the render-worker project.
- **Which embedder policy the embeddings ask for.** `credentialless`
  keeps a SWF's cross-origin no-cors loads working but is not in Safari;
  `require-corp` works everywhere but blocks what does not opt in.
  Recommended: `credentialless` for `@swf2es/web`'s documented headers,
  the desktop app's own page either way, and the demo site behind a
  service worker that adds the headers.
- **Hiding workers from Crossbridge without isolation.** Crossbridge would
  fall back to running `main()` on the UI thread (`startAsync`) if
  `flash.system.Worker` did not resolve. Making it not resolve on a page
  that is not isolated would let the samples without pthreads play there,
  but changes what a SWF sees of playerglobal; not recommended without a
  setting.
