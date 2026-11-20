# Workers

What ActionScript 3's workers (`flash.system.Worker`, `WorkerDomain`,
`MessageChannel`, shared properties, a shareable `ByteArray` and
`flash.concurrent`'s `Mutex` and `Condition`) need of swf2es, and how
they map onto a browser's and node's threads.

## What content needs

### Tamarin's tests

`oracle/avmplus/test/acceptance/as3/Workers` has 11 tests. avmshell runs
them all with every assertion passing (`tests/tamarin/baseline.json`; four
print nondeterministic output, so only their counts are compared). Its API is
the shell's own, not Flash's: `WorkerDomain.createWorkerFromPrimordial()` and
`createWorkerFromByteArray(bytes)`, no `MessageChannel`, no events, and
`avmplus.System.sleep` to wait. swf2es runs them as avmshell does, its
background workers on node's threads (see
[avmshell's workers](#avmshells-workers)); all 76 of avmshell's checks
pass (`tests/tamarin/swf2es-baseline.json`):

| Test | Needs |
|------|-------|
| `Worker`, `WorkerDomain`, `WorkerErrors`, `WorkerCreateMax`, `regress/bug774294`, `regress/bug774302` | create, start, terminate, state, `listWorkers`, errors 1511 |
| `ConditionAndMutexAPI` | Mutex and Condition on one thread |
| `ByteArrayAPI` | `atomicCompareAndSwapIntAt`/`Length`, `shareable` |
| `ByteArrayWorkersLzma` | an LZMA round trip on a shareable ByteArray on one thread, then a worker doing it again on the same bytes |
| `ByteArrayWorkers`, `RemoteCall` | five workers over one shareable ByteArray, a cross-thread Mutex, CAS, the primordial busy-waiting on the bytes |

The last three are what real threads need: the primordial spins reading
the shared bytes while five workers write them, and takes the shared
Mutex around `trace`. They run only where memory is truly shared.

The `worker-mutex` conformance case holds the rest of what avmshell shows
of Mutex and Condition across workers: each crosses by reference, one
object a worker; a notify picks the waiters in the order they waited, and
they take the mutex again in that order; `wait` gives true only when its
time ran out, a notify with no waiter is lost, a wait lets go of a mutex
however many times it was held; and a worker terminated while it holds a
mutex lets go of it.

A known avmshell bug is not ours to copy: `Condition.wait(ms)` returns
false at a whole second less a millisecond, from an overflow of its
nanoseconds. Nor is one of the oracle's: a waiter that is terminated is
still reported running, and a notify then reaches none of the other
waiters; swf2es passes over it.

### Crossbridge

Every sample of Crossbridge's SDK (`samples/`, built with it as SWF 26)
needs workers, even Hello World: its `Console`
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

Through `<swf2es-player>` with its default worker host, in headless
Chrome on the player tests' isolated page, on the demo site isolated by
its service worker, and in the desktop app:

| Sample | Now |
|--------|-----|
| `01_HelloWorld/hello-*.swf` (all four) | run: "Hello World" on the stage, the thread exits; 10 of 10 cold runs of each play |
| `09_Pthreads/pthread_swc1.swf` | runs: its thread proc runs and is joined |
| `09_Pthreads/pthread_swc2.swf` | starts its two threads, once its root gets `addedToStage` after its constructor, as Flash and AIR send it |
| `09_Pthreads/pthreads.swf` | runs: the mouse's moves reach its thread, which prints each |
| `11_OpenMP/mandel.swf` | runs; each click adds a thread, up to 6 measured: its own count of frames a second stays between about 55 and 140 at every count, as its zoom deepens, with no gain from more threads |

Each piece below was found missing on the way: a worker a background
worker makes (each pthread is one, made by the C main thread's worker),
a primordial that takes such a request while it waits (Crossbridge's
primordial waits for the main thread, which waits for the thread it
starts), Web Workers started ahead (a browser starts one only while the
page's thread is in its event loop), and shared properties seen at once
(the primordial reads `flascc.uiThread.*` back while it waits). The
callbacks C code registers with AS3 events (`AS3_DELEGATE`) run on the
primordial through Crossbridge's function pointer table (`ptr2fun`),
which needs a script's methods to run in an empty scope chain, as
avmplus runs them (#532).

Crossbridge therefore needs, all at once: workers, a shareable ByteArray
whose memory every thread sees (as domain memory), Mutex and Condition
across threads with real blocking in workers and short blocking on the
primordial, and atomics on the bytes. Message passing alone runs none of
the samples.

### Flash's semantics, measured

The `worker-basics` player case (`tests/player/scripts/WorkerBasics.as`)
traced in adl (AIR 51), and is the reference:

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
renderer, no sound and no input. It compiles none of the ABCs it shares
with the primordial: it loads the primordial's modules (see [Compiled
code](#compiled-code)). In a browser the thread is a Web Worker;
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
and `Player`, and runs frames by `advance` on a timer. The worker runs at
the latest API version of its series, whatever the primordial's: adl runs
a worker of a SWF 17 root so, which sees what that root does not and
neither its root's version nor its SWF's own would show (the
`versioned-worker` case), though avmshell's workers run at their
primordial's.

`@swf2es/player-hosts` has two hosts: `webWorkerHost` (`/workers`) starts
a module Web Worker on its `web-worker.js`, and `nodeWorkerHost` (`/node`)
a `worker_threads` Worker on `node-worker.js`. A worker sees no import
map, so `webWorkerHost`'s default script is the package's `dist/thread/`,
which `build-thread.ts` writes after tsc: `web-worker.js` and every
module it imports, from the packages under it too, with their bare
specifiers made relative paths inside the tree, which therefore loads
wherever the package is served. A script from another origin, as a
CDN's, which a browser refuses to start a worker on, starts through a
`blob:` module of the page's that imports it (see
[The embeddings](#the-embeddings)). The player tests' page still gives
its own: its server serves every file again under `/worker/` with its
bare specifiers resolved (`tests/player/serve.ts`). A player made
without a worker host has `Worker.isSupported` false, and
`createWorker` throws swf2es's "not supported" error.

### The embeddings

`@swf2es/web` gives every player a `webWorkerHost` by default, as Flash
had workers on: `configure({ workers: false })` turns them off for the
page, and an element's `workers` attribute, `"false"` or `"true"`, for
its own SWFs over the configuration (docs/architecture/web.md, "Workers
in the page"). `configure({ workerUrl })` names another script, a
bundler's. A player's host starts Web Workers ahead only for a SWF
whose ABCs name `WorkerDomain`, which may block on one at once, and the
element awaits them, ten seconds at most, before the SWF's first frame;
other SWFs start none until they ask. The page's workers started ahead go ten seconds
after its last player that used them does.

The demo site and the desktop app are both cross-origin isolated, the
site through its service worker, which serves the worker script too, and
the app through its protocol. The site plays from the browser build,
whose `worker.js` is the workers' script; the app takes the default, its
protocol serving it under `/modules/player-hosts/thread/`, and its import
map names `@swf2es/player-hosts/workers`, which the element imports only
when a SWF has workers, and without which its SWFs play without them. On a
page that is not isolated, workers pass messages, and sharing a
shareable ByteArray, a Mutex or a Condition throws the error that says it
needs isolation (see [Shared memory](#shared-memory)).

The primordial is the hub: every background thread talks only to the
primordial, which routes messages between workers. A background worker
may make workers too, which the primordial starts on its host for it:
the worker that makes one puts the request in a queue in shared memory
and tells the primordial, which takes the queue when told and also
whenever it waits in a lock or a wait (`Sync.poll`), as Crossbridge's
primordial waits for the C main thread, which waits for the thread it is
starting. The maker sees its worker `running` as soon as the worker's own
thread says so in shared memory; its `workerState` events come through
the primordial. This needs shared memory: without it a background worker
cannot make one. The workers a background worker made run on when it is
terminated, as avmshell's do; the primordial runs them.

### What crosses, and how

As Flash and avmplus:

| Value | Crosses as |
|-------|------------|
| int, uint, Number, Boolean, null, String | itself |
| undefined | (deletes a shared property) |
| any other object, Vector, Array, XML | AMF3 bytes, by the runtime's writer, read by the other VM's, its aliases its own |
| ByteArray, not shareable | its bytes, copied at the set or send |
| ByteArray, shareable | its memory, shared: one ByteArray a worker for it, as avmplus interns its Buffer |
| MessageChannel | a reference: one object a worker, by id |
| Mutex, Condition | a reference: its address in the memory every worker shares (see [Blocking](#blocking)); one object a worker |

Only the top value is looked at so, as in avmplus: a MessageChannel inside
an Object is an empty AMF object on the other side.

A shared property belongs to the worker it is set on, readable and
writable from both the worker and its parent. Where memory is shared, the
properties are a table in it (`Sync`'s table, rewritten whole under its
lock with a version a VM reads again on), so a set is seen by the next
get on any worker, as in avmshell. A value is kept packed as it crosses
(`workers/wire.ts`), a shareable ByteArray's memory by its id: a VM finds
the memory in the messages it has had, so one that reads a ByteArray
another worker shared while it never returned to its event loop since
gets swf2es's "not supported" error. A VM's own set keeps its token, so
that a ByteArray reads back as itself to the worker that set it.

Where memory is not shared, each side keeps a copy of each worker's
properties and posts each set to the other: what the primordial sets
before `start` is there when the worker starts, and what one side sets
reaches the other between its frames. Code that spins synchronously
waiting for the other side never sees it then, and spins for ever: on
`getSharedProperty` until the other side changes it, or on a channel.

The primordial's own shared properties go to every worker, those set
before a worker starts with its `WorkerInit`.

A channel's queue likewise. Where memory is shared it is in it (`Sync`'s
queues, of packed values): `send` adds to it at once, `messageAvailable`
is exact at both ends, and `receive(true)` blocks until a message comes
or the channel closes, with `Atomics.wait` in a worker and spinning on a
page's main thread (see [Blocking](#blocking)); a message the memory has
no room for (it holds up to 1 GB) fails with MemoryError 1000, as a
property too large for it does. A notice still goes to the
receiver's thread, which dispatches `channelMessage` between its frames,
as Flash dispatches it on the receiver's event loop, and brings it the
memory of a shareable ByteArray the message names. Where it is not, each
message is posted to the receiver's thread; `receive(true)` with nothing
queued throws "not supported", and the sender's `messageAvailable`, which
cannot see the receiver's queue, is true on the primordial from a send to
a background worker until that worker has run a frame since, which is
what Flash shows for messages sent before `start`, and false on a
background worker's side. A channel's state is one at both
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

A worker evaluates what it is handed as the primordial did: the modules
the primordial evaluated, by `new Function`, and those it imported, as
the modules compiled ahead of time are under a Content-Security-Policy
without `'unsafe-eval'` (`precompiledModules` with `importModules`), by
importing them from the same URLs. So a page that plays a SWF from its
modules compiled ahead of time runs its workers under that policy too,
their own scripts served with it; a worker on ABCs the primordial did
not compile ahead of time, or with lazy compilation, compiles them, and
needs `'unsafe-eval'` as the primordial would.

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
`Cross-Origin-Embedder-Policy: require-corp` or `credentialless`. node
(unit tests, the CLI's avmshell) always has it. A web page must have its
server send them, which an embedder decides: `require-corp` blocks every
cross-origin subresource that does not opt in with CORP or CORS, the
SWF's own loads included; `credentialless` lets no-cors ones through
without cookies, the gentler choice for a page that plays Flash content
(Chrome and Firefox; Safari has only `require-corp`). COOP
`same-origin` cuts the page off from cross-origin popups it opened, which
`navigateToURL` to `_blank` and ExternalInterface pages may rely on. Where swf2es's own pages get
them is below.

A shareable ByteArray (`Bytes` in `natives/bytes.ts`, the sharing in
`natives/shared-bytes.ts`) keeps memory of its own until it first
crosses to another worker: its bytes then move, once, to a growable
`SharedArrayBuffer` (`new SharedArrayBuffer(capacity, {
maxByteLength })`, up to the 2 GB a ByteArray holds, or as much as the
host reserves), and its length to a word of a second, small one
(`SharedBytesMemory`, with an id). Every worker's ByteArray for it uses
those, as avmplus' ByteArrays share one `Buffer`, and each VM keeps one
ByteArray for an id, as avmplus interns one for a Buffer:

- Its buffer and DataView track the memory's length, so growth by any
  worker, which is `grow` in place, is seen by all; the memory cannot
  shrink, so a smaller capacity zeroes what it would have dropped.
- Its length is an accessor of the shared word on that object alone: every
  read sees another worker's change and every write is seen. A ByteArray
  that shares nothing keeps its plain field, so its natives cost what
  they did before sharing existed (measured on `as3pb`).
- `shareable` cannot be set back to false, as in avmplus. `clear()` empties
  it for every worker, zeroing the memory before it makes the length 0,
  so that a worker growing it then writes into zeroes; `compress()` and the others
  rewrite the bytes in place for all.
- `atomicCompareAndSwapIntAt` and `casi32` are `Atomics.compareExchange` on
  an `Int32Array` over the bytes; `atomicCompareAndSwapLength` reads the
  length once, grows the capacity, then swaps the length word, so that of
  workers growing it at once one wins. The memory only ever grows, so a
  swap that fails undoes nothing another worker did. Nor is what a
  smaller buffer would drop zeroed when the length is lowered: avmplus
  zeroes it under a safepoint, and without one the zeroing would race
  with a worker growing the length again and writing there, so on a
  shared ByteArray bytes past a lowered length may come back when it
  grows again.
  Writes past the end raise the length by a compare and swap, never
  lowering what another worker made it.
- Domain memory over it is reached by the loads and stores generated code
  makes in place through a view of its own (`SharedMemoryView`), which
  calls `rt.li32` and the like, against `rt.memoryLength`, the length this
  thread last saw: only an address past it reads the length again
  (`Runtime.refreshMemory`) before it is rejected, so another worker's
  growth is seen, and memory that is not shared is reached through its
  DataView as before. A worker that shrinks it is seen at the next access
  past the old length, not at once.

The player's workers (`scripting/workers.ts`) pass the memory in their
messages, a shared property or a channel's, which a structured clone
shares. avmshell's (`natives/shell.ts`) keep it in a shared property by
its id; the host makes the memory known to the other threads
(`ShellWorkerHost.share` and `shared`): the CLI posts it on a
BroadcastChannel of the primordial's threads, and a thread reads that
channel synchronously (`receiveMessageOnPort`) when a property names
memory it has not seen, as its code never returns to its event loop. A
thread started later is given what its parent has seen; one that was
still starting when a memory was shared, and missed it on the channel,
asks the primordial's memory thread (`shell-memories.ts`), which
subscribed before any other thread started, and waits for its answer. The CLI's threads
keep what was shared until the primordial ends.

Where memory cannot be shared, a page that is not cross-origin isolated,
workers that only pass messages run as anywhere, `Worker.isSupported` is
true as Flash reports it, and passing a shareable ByteArray to another
worker throws "sharing a shareable ByteArray with another worker needs
shared memory, which a browser gives only a cross-origin isolated page
(...)", rather than copy it and leave a program waiting on memory nobody
writes; a Mutex or a Condition the same ("sharing a Mutex with another
worker needs shared memory, ..."), rather than a lock no other worker
takes. A background worker cannot make a worker there either. Mutexes
and Conditions work on the one thread, and a `Condition.wait` without a
timeout spins to the script timeout, as nothing can notify it.

The alternatives were worse: `Worker.isSupported` false without
isolation would not help Crossbridge, which never reads it, and would
stop content that only passes messages; copies in place of shared memory
would hang silently where this fails loudly. Nor is `flash.system.Worker`
hidden there, though Crossbridge would then run `main()` on the UI thread
(`startAsync`): that would change what a SWF sees of playerglobal. Flash
Player 32 could refuse `Worker.start` when a user had turned shared
memory off after Spectre (error 3807, "Worker.start has been disabled by
the user"); that error could replace swf2es's own once its exact
behaviour is checked.

Where swf2es's own pages are isolated:

- **The player tests' server** (`tests/player/serve.ts`) sends COOP
  `same-origin` and COEP `credentialless` with every response, its
  workers' scripts too; a test can ask for a page that is not
  (`tests/player/isolation.ts` plays there).
- **The desktop app** (`apps/desktop/src/main/protocol.ts`) sends both
  with its own pages and modules, its workers' scripts among them; the
  smoke test checks the page is isolated, and plays `worker-mutex`.
- **The demo site** registers a service worker at its root
  (`apps/site/src/service-worker.ts`, `isolation.ts`) that adds both to the
  site's own responses; the first visit loads the page again once it
  serves it, or at once after a reload that bypassed it (Shift-reload),
  and other origins' responses pass as they are. A browser
  that is still not isolated with it, Safari without `credentialless`, is
  not reloaded again. `tests/site/run.ts` serves the site without the
  headers, as Pages does, checks it becomes isolated, and plays
  `worker-mutex` there.
- **Another page** that embeds the player with a worker host serves its
  document, and its workers' scripts, with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`, which
  needs every cross-origin subresource to opt in) for a shareable
  ByteArray to cross; without them, workers pass messages only.

All of swf2es's own pages ask for `credentialless`, which keeps a SWF's
cross-origin no-cors loads working; Safari, which lacks it, stays
unisolated rather than have `require-corp` block what does not opt in.

### Blocking

`Mutex.lock` and `Condition.wait` block. They live in a heap of int32
words every thread of a primordial's shares (`natives/sync.ts`'s
`SyncMemory`, a growable SharedArrayBuffer, given to each worker at its
start), which also holds the channels' queues, the player's shared
property table and the queue of requests for the primordial, so that
none of them needs memory to be posted after it: a Mutex or a Condition
is an address there, the same in every worker, and each VM keeps one
object for it, as avmplus interns one for its State. As avmplus'
ConcurrencyGlue:

- A mutex is its holder's number and how many times it holds it, and a
  queue of the threads waiting for it, which take it in the order they
  came. `tryLock` fails while any thread waits, as avmplus' `hasWaiters`.
- A condition is its mutex and a queue of waiting threads. `wait` lets go
  of the mutex however many times it was held, sleeps until a notify
  picks its thread or its time runs out, then takes the mutex again,
  that many times; it gives true only when its time ran out (and false
  for a wait without a timeout). A notify picks waiters in the order they
  came and moves them to the mutex's queue in that order, so they take
  the mutex again in it. A notify with no waiter is lost.
- A worker that is terminated is not stopped at once: its thread runs on
  until it or its host stops it, and may be writing what a mutex it holds
  guards. So terminating it only marks it stopping (`Sync.stop`): a
  notify passes over it, a mutex's queue does not wait for it, and its
  thread gets `SyncTerminated` for anything more it asks of the memory,
  which no script catches, so the script that asked stops there, as
  avmplus interrupts a terminated worker at its waits. The locks it holds,
  a mutex or the heap's own short locks (its allocator, a queue, the
  table), are free to take only once no code of it can run any more
  (`Sync.end`):
  - an avmshell worker's code ends with that script, so it is ended there,
    as it is when it ends its code;
  - a player's worker plays on to the end of its frame, so its own thread
    (`workers/thread.ts`) looks after each frame, and every 10 ms between
    them, whether it was terminated, and if so stops its player for good
    and only then says it has ended: at once where it is idle or waits, at
    the end of the frame where it plays;
  - one that does not, as a script that loops without asking anything, is
    stopped by its host after a second, and is ended once the host says
    its thread has gone: node's `exit`, but a browser says nothing, and
    Chrome lets a busy Web Worker's script run on for 2.5 to 4 s after its
    `terminate` (measured in Chrome 156), so a Web Worker is taken to have
    stopped 8 s after it (Firefox and Safari were not measured).

  Only the primordial, which runs the threads, stops one; a background
  worker that terminates a worker it made asks the primordial through its
  queue of requests, which it takes even while it waits. An avmshell
  worker terminated by its parent is given 100 ms to stop at its next
  wait or sleep before its thread is stopped.

A thread blocks with `Atomics.wait`, in steps of at most 50 ms, between
which it looks whether a holder has ended and the primordial takes its
requests.

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

So the primordial spins: `lock` loops on `Atomics.compareExchange`, and
`wait(ms)` lets go of the mutex and loops on `Atomics.load` of the
condition's word until notified or timed out, then takes the mutex
again, with a backoff that never sleeps. Both fail with Error 1502
(ScriptTimeoutError in a player) once they have spun for 15 s without
returning to the event loop, Flash's own answer to a primordial that
waits too long; the limit is on the spin, not on each wait, because
Crossbridge's startup waits a millisecond at a time in a loop. The page
is frozen meanwhile, as Flash's UI was: exactly Flash's semantics for the
content that exists, at the cost of CPU while spinning. `tryLock` alone
would break Crossbridge's handshake. Running the primordial's VM in a
worker, the stage drawn on the main thread from what it sends, would let
it truly block, but that is the whole render-worker project (a scene
protocol, synchronous ExternalInterface both ways, `BitmapData.draw`);
if it lands, it can take blocking over.

A browser also starts a Web Worker only while the page's thread is in its
event loop, so a primordial that starts a worker and waits for it in the
same script, as Crossbridge's does, would wait for ever. Nor does a
started worker take what the page posts it until the page's thread has
run its own task for the worker script's end, which in Chrome may come
after the worker's first message; a start posted then waits for the page
to stop blocking. `webWorkerHost`
therefore keeps a few Web Workers loaded ahead (as many as the machine
has cores, from two up to four, by default, shared by the page's hosts for
one script and let go ten seconds after the last player that used them
is), as Emscripten's thread pool does: a
worker that starts takes one, which runs what it is posted whatever the
page's thread does, and another is started in its place. A Web Worker
counts as loaded once it answers a message the host posted it as it made
it, so once what the page posts reaches it. Its `ready`
resolves once they have loaded, for a page to await before it plays a
SWF that blocks at once. A script that starts more workers than that
while it blocks waits for one that is not loaded, and fails with the
script timeout. Node's threads start without the parent's event loop.

For tests that step a SWF's frames, `settled()` counts a worker blocked
in a lock or a wait as settled, as nothing but another worker ends that.

### Compiled code

A worker on the primordial's SWF, as each Crossbridge thread is (its
`retargetSWF` rewrites the SymbolClass, so the bytes differ, the ABCs do
not), would compile the same ABCs again: the libraries, about 0.1 s, and
the SWF, 0.3 s for `mandel.swf`, three minutes for `mc.swf`'s 40 MB. So
the primordial hands its workers its modules (`scripting/handover.ts`).

The compiler is deterministic: the same calls on a fresh one compile the
same modules. The primordial, given a worker host, keeps a journal of
each call that changes what its compiler compiles to (each ABC added, by
its hash, its domain and whether a library; each finding reported; each
domain made; each module compiled, read from the module cache or
imported), with each module's source, or the URL it was imported from,
and the log of what compiling it fixed (`compileModuleLogged`), until its
main SWF has linked. A SWF whose ABCs do not name `WorkerDomain` records
none of its own modules, which is decided before they compile, and lets
go of the libraries' then; a player let go of lets go of them all. A
module read from the cache that then fails to load is not handed, and
the journal ends there. The sources are kept as Blobs, which a browser keeps out
of the page's heap and a message carries to a thread without a copy. A
worker journals its own calls the same way, and loads the primordial's
module for a compile while its journal is the primordial's so far and
its ABCs are the same bytes, and none if they were compiled at another
API version than its own (`HandedModules.apiVersion`); from the first call that differs, as on
ABCs of another SWF after the libraries', it compiles. Where it is not
ABCs of the primordial's that it loads, it therefore compiles what it
would have, and a worker on other bytes still takes the libraries'
modules.

What the logs fix is replayed only if the worker's compiler is used
again, for a method compiled lazily or a SWF the worker loads, before
that use (`ModuleHandover.guard`): replaying verifies every method again,
about half a compile (86 s of `mc.swf`'s 176), and a worker that only
runs what it was handed never needs it. The modules are those the
worker's compile would have written, which the unit tests check, so code
compiled ahead of time and by the JIT stays the same, and the compiler
itself does not change.

Not chosen:

- Module cache keys (`moduleKey`), as a cache is read: a key names the
  log so far, so a worker would replay every module's log to key the
  next, the cost above.
- The page's IndexedDB module cache, read by the worker: the cache is
  the embedder's choice and off by default, a key needs the replays
  above, the primordial's write may not have landed when Crossbridge
  starts a thread in the same frame, and node has no IndexedDB. Where an
  embedder gives one, the primordial's reads from it are in its journal,
  so its workers get those modules too.

Measured with Crossbridge's `mandel.swf`, three runs each, the worker
compiling its SWF (before) against loading the primordial's modules,
from the worker's start to its first message after its SWF's code ran:

| | Before | After |
|---|---|---|
| Chrome (headless, software GL, through `<swf2es-player>`), a thread a click adds | 650 to 920 ms | 365 to 535 ms |
| the same, the C main thread's worker, which the primordial waits for | 1350 to 1390 ms | 813 to 819 ms |
| the same, the SWF's load to its first frame drawn | 2366 to 2391 ms | 1753 to 1872 ms |
| node's threads, the second worker | 791 to 820 ms | 531 to 546 ms |
| node, the process's memory once both workers ran | 562 to 567 MB | 522 to 534 MB |

What is left of a worker's start is its thread's own: loading the
player's modules, evaluating the modules it is handed, and making its
VM. `mc.swf` and `02_Interop/bitmapdata.swf` (40 MB) compile in
three to four minutes on the primordial, then fail with 1009 in their
`Console.init` before they make any worker, in node too, which is
another gap.

### avmshell's workers

The runtime's shell natives (`natives/shell.ts`) run avmshell's Worker
and WorkerDomain as avmplus' Aggregate and Isolate do, with
`natives/shell-workers.ts` keeping what every thread must see in memory
they share (`ShellWorkersMemory`, two growable SharedArrayBuffers): each
worker's state and parent, by its number (0 the primordial), and every
worker's shared properties in one table under a lock, with a version that
tells a VM when to read it again. A property set on any thread is seen by
the next get on any other, so a primordial that waits in `System.sleep`
(an `Atomics.wait`) for a worker's answer sees it, as in avmshell. Values
are kept as avmplus' ChannelItem keeps them: a Number as itself, a
ByteArray's bytes copied at the set (the VM that set it gets its own
object back, another one object of its own for the item), anything else
as AMF3, a shareable ByteArray's memory by its id (see [Shared
memory](#shared-memory)), and a Mutex or a Condition by its address in the
workers' sync memory, which `ShellWorkersMemory` carries (see
[Blocking](#blocking)).

A thread may be stopped anywhere, so none is stopped holding the lock:
`terminate` lets the properties of the worker, and of the workers it
started, theirs and so on, go while it holds the lock, then marks them
`terminated`, and only then stops the thread. A terminated worker changes
nothing holding the lock: its next property access throws, which ends
its code, as a worker another one terminated, whose thread it does not
hold, ends at that access too. It may still take the lock to find that
out, having waited for it while it was terminated, and be stopped there,
so a lock held by a terminated worker is taken from it; a worker that
ends lets its properties go and marks itself last, under the lock, so
that nothing it still does holding it is taken over.

The runtime knows no threads: `RuntimeOptions.workers`, a host, starts
one for a worker, given its `ShellWorkerInit` (its number, the memory, and
its code or null for the primordial's), and the thread makes a runtime
with `RuntimeOptions.worker` set to it. The CLI's host (`threads.ts`)
starts a `worker_threads` Worker on `shell-thread.js`, posted codegen's
compiled module, the libraries and the primordial's ABCs; it marks the
worker running (`startShellWorker`), runs its code with `runShell` and,
when that ends, marks it terminated, or `exception` after an exception
nothing caught, and lets its properties go (`endShellWorker`). The
workers it started run on, as in avmshell: their threads are its
thread's, so it waits for them before it ends. `swf2es
run`, the conformance runner and the Tamarin runner all give it, the
last two with their lines posted back to the runner, the CLI with each
thread writing to stdout itself.

Where swf2es differs from the oracle's avmshell:

- `terminate` on a running worker stops its thread and makes it
  `terminated` at once. avmshell reports it `running` until it reaches an
  interrupt check, and the oracle's avmshell runs without them, so a
  worker spinning in a loop is never stopped there, and the shell waits
  for it at exit, for ever.
- Terminating a worker terminates the workers it started too, whose
  threads node stops with its thread; in avmshell they run on.
- A worker terminated by one that did not start it, and so does not hold
  its thread, is `terminated` at once but runs on until its next shared
  property access, sleep, lock or wait, or its end.
- A terminated worker's code stops at its next `System.sleep`, lock or
  wait, as it would at avmshell's interrupt checks; the Mutexes it holds
  are let go then, or once its thread has stopped. A worker that
  terminates itself stops at once, as avmshell's does: no catch around
  the call runs (the `worker-self-terminate` conformance case).
- A worker's lines reach the runners only when their event loop runs,
  so after the primordial's own in the tests, where avmshell interleaves
  them as they come; the CLI writes them as they come.
- When the primordial's ABCs end, its workers' threads are stopped, as
  avmshell interrupts them; what a thread had printed and not yet posted
  may be lost.

## Tests

- **Against avmshell:** Tamarin's `as3/Workers` (76 of 76 checks), and
  the conformance cases `worker-shared-properties`, `worker-threads`,
  `worker-shareable`, `worker-mutex`, `worker-self-terminate` and
  `worker-api-version`.
- **Against adl's trace:** the player cases `worker-basics`,
  `worker-shared-bytes` and `worker-mutex`, in Chrome and on node's
  threads (`tests/unit/player/scripting/workers.test.ts`).
- **The sync memory** on node's threads (`tests/unit/runtime/sync.test.ts`):
  contention, ordering, timeouts, holders and waiters that end, queues
  and the spinning timeout.
- **Compiled code handed over** equals what the worker would compile
  (`tests/unit/player/scripting/handover.test.ts`), and a worker runs
  under a policy without `'unsafe-eval'` (`tests/player/precompiled.ts`).
- **Isolation:** `tests/player/isolation.ts` on a page that is not
  isolated; `tests/web/run.ts` through the element, with workers on, off
  by attribute and by `configure`, from another origin, and the page's
  Web Workers let go after its last player; `tests/site/run.ts` and the
  desktop smoke test play `worker-mutex` on their isolated pages.
