# Overview

swf2es plays SWF files in the browser and compiles their bytecode to
JavaScript. It has one compiler, which runs at two different times:

- **JIT**: the player runs `@swf2es/codegen` as a SWF loads, and compiles
  each of the SWF's ABCs whole to an ES module (see [A SWF's
  code](player.md#a-swfs-code)). An opt-in mode compiles method bodies on first
  factory use (see [Optional lazy compilation](compiler.md#optional-lazy-compilation)).
- **AOT**: node (or a server) runs the same compiler ahead of time, with the
  `swf2es` command (`packages/cli`), and the player takes its modules in
  place of compiling them (see [Compiling ahead of time and caching
  modules](modules.md#compiling-ahead-of-time-and-caching-modules)).

The compiler is written in AssemblyScript and ships as `codegen.wasm`, with
a thin TypeScript wrapper. The one wasm binary runs in browsers and workers, in
node, and in any server-side wasm runtime (for example wazero in a Go
server), so there is only one implementation to keep correct. It uses
AssemblyScript's minimal runtime, whose garbage the wrapper collects between
calls (see [benchmarks.md](../benchmarks.md#the-assemblyscript-runtime)).

The wrapper's `Codegen` (`createCodegen` in `packages/codegen/src`) is the
compiler's API; besides `identity`, `epoch`, `abcVersion`, `usage` and
`isLive`, which report on it:

- `reset` starts a domain, and `add` links an ABC into it, after those
  before, into one of its application domains: `childDomain` makes one,
  `found` records what one has found, `dropDomain` lets one go,
  `evictDomain` and `reviveDomain` set one aside and bring it back, and
  `compact` reuses the memory they freed (see [Parsing, linking and
  verifying](compiler.md#parsing-linking-and-verifying));
- the last ABC added compiles with `compile`, whole, to its module, source
  map and the entry of each method; with `compileModule`, to its module
  alone; or with `compileLazyModule`, to its tables and lazy factories,
  whose bodies compile with `compileMethods` on first factory use;
- `context`, `revision`, `compileModuleLogged` and `replay` serve a cache
  of modules (see [Caching modules](modules.md#caching-modules)).

The source map and the entries are written each in a call of its own,
after the module's garbage is collected, and only when asked for: written
with the module, a large ABC's entries alone took codegen's memory from 128
to 256 MiB, which wasm never gives back. All go through
`assembly/compile.ts`, which the test build (`assembly/testing.ts`, with
the reader, verifier and emitter exposed for the node tests) exports too,
so the tests exercise the code that ships, and the determinism check
compiles every chain through both builds.

## The JIT/AOT invariant

For the same input, both modes must produce byte-identical output. That
requires:

1. **Compilation is pure.** `format` and `codegen` use no DOM or node APIs, no
   clock and no randomness. Their tsconfigs load no DOM or node types, so the
   build rejects such code, and a unit test fails if `codegen.wasm` imports
   anything besides `env.abort`.
2. **The unit of translation is one method.** A method's output depends only on
   its ABC and the ABCs it is linked against, never on which other methods
   were compiled before it.
3. **Both modes use the same facts.** Optimizations use only what the ABC being
   compiled proves (final classes, sealed traits, typed slots). Anything that
   can change at runtime, such as a child SWF redefining a class, gets a
   runtime guard in both modes.
4. **Shared cache key.** Output is keyed by codegen's `moduleKey`, which
   the player's module cache and the swf2es command both take: the
   compiler's identity, the API version, and the module's context, every
   ABC its application domain sees, by hash, in load order, those loaded
   with it included, since a SWF's `DoABC`s are all added before any
   compiles, and what the domain was told it found (`found`) and has fixed
   of what resolves lazily (see [Caching modules](modules.md#caching-modules)). So
   the browser cache, AOT output served by a server, and JIT output are
   interchangeable. An ABC's layouts depend on those it links against,
   since its slot and dispatch ids follow its base classes', so a module
   also records their hashes and the runtime refuses it when the ABCs
   loaded before it differ.

CI checks both (`pnpm determinism`, `tests/conformance/determinism.ts`),
over the builtins, then each conformance case (also compiled with asc's
`-d`, for source maps) and as3pb:

- **Determinism:** each compiles to the same modules and source maps, byte
  for byte, in a compiler instance of its own, in one instance after the
  others, in the reverse order twice in a row, and in the build that checks
  every array access, so that nothing the compiler keeps between calls,
  such as its reused buffers, leaks into its output.
- **The JIT/AOT invariant:** each method compiled alone, as lazy JIT
  compiles it, is byte for byte its entry in its module: in order with a
  new emitter each, and in the reverse order with one emitter for all.
  Everything a method's code refers to is indexed by its ABC (multinames,
  namespaces, functions, descriptors), but for the classes and Vectors it
  refers to, which it has in a table of its own, numbered as it first
  refers to each (`((...T) => (scope, sup) => function ...)(cls(...))`).

## Packages

| Package   | Responsibility                                                  | May depend on             |
|-----------|-----------------------------------------------------------------|---------------------------|
| `native`  | the WebAssembly modules, each a sub-path with its own binary: `compress` (zlib and LZMA), `mp3` (minimp3) and `render` (fills with libtess2, lines and BitmapData's CPU kernels), C and Zig built by one Zig project | — |
| `format`  | SWF container and tags, a DoABC's bytes (codegen parses the ABC), AVM1 action blocks | native |
| `codegen` | bytecode → IR → ES modules, in AssemblyScript (`assembly/`)     | format                    |
| `runtime` | AS3 and AVM1 language semantics called by generated code        | format                    |
| `context3d` | experimental renderer contracts, AGAL translation and optional WebGL2 backend; the WebGL 2 device layer it shares with `render` | — |
| `render`  | the renderer ([renderer.md](../renderer.md)): scene list, planner and WebGL 2 backend | context3d |
| `player`  | display list, timeline, playerglobal, and the view that drives `render` | format, codegen, context3d, native, render, runtime |
| `cli`     | the `swf2es` command: a SWF's modules ahead of time, ABCs run as avmshell runs them | format, codegen, runtime |
| `player-hosts` | optional hosts for the player: Node TCP, a WebSocket relay, an IndexedDB module cache, modules compiled ahead of time, Stage3D canvas layers, Web Worker and node threads for `flash.system.Worker` | player |
| `web`     | the `<swf2es-player>` element, `replaceFlash`, the page's configuration | codegen, format, native, player, player-hosts |

`native`, `format`, `codegen` and `runtime` load no DOM or node types, so they run in
browsers, workers and node alike. `runtime` contains only the language, with
no display list, so it runs in node next to avmshell. It uses `format` for what both need, such as compression
(`@swf2es/native/compress`, below): ByteArray's `compress` and a SWF's body are the
same code. `decompressSwfPrefix` decodes a SWF's start alone, for its
FileAttributes (`fileAttributes`), from the first kilobytes of the body,
more only as it needs them, and keeps whatever decoded before a
failure, so a SWF cut short still has its header.

`@swf2es/native/compress` is one WebAssembly module that imports nothing, compiled
synchronously from base64 on first use. zlib 1.3.2 (`vendor/zlib`, swf2es/zlib)
inflates and deflates, so ByteArray's `compress` and `deflate` write
zlib's own bytes; the LZMA SDK 26.05's encoder (`vendor/lzma-sdk`,
swf2es/lzma-sdk, the release as published; only `C/LzmaEnc.c`,
`C/LzFind.c`, `C/LzmaDec.c` and their headers, all public domain) writes
ByteArray's LZMA with avmplus' settings (level 9, a 1 MB dictionary or
less for less data, no end marker), and its LzmaDec, which avmplus uses
too, decodes: a properties byte past 224 is refused, a dictionary is 4 KB
at least, and it fails as soon as it would read past the stream's end, so a
header's length costs at most some 7000 bytes for each of the stream's;
a ZWS whose header names more than 8192 times its stream is refused
before decoding. Each call resets a bump arena in the module's memory;
an output of unknown size is the arena's top allocation and grows in
place, so a header that names more than the stream holds costs nothing
until the bytes are there, and nothing is copied as it grows. Memory
never shrinks, so an instance whose memory passed 8 MiB is dropped after
its call, as is one whose call threw, and the next starts a new one.
What a failed decode wrote stays in the module and goes with its
instance: a bomb cut short is never copied out only to be dropped. An
output that does not fit is `CompressedDataTooLargeError`, which
ByteArray turns into MemoryError 1000 as avmplus does, where corrupt
data is IOError 2058. Its own code is `src/compress/root.zig`, which
gives the libraries the arena through their allocator callbacks, and the
TypeScript wrapper.

`native` is one Zig project (`build.zig`) for every binary:
`packages/native/build.ts` runs the bitmap kernel's tests and then `zig
build` with a pinned Zig 0.17.0 (whose clang compiles the vendored C,
unchanged, against the libc stubs in `include/`), writes each module into
its `binary.ts` with a digest of its inputs, and the vendored
C's notices, verbatim, into `LICENSE.third-party`. `pnpm build` checks the
digests and the notices; CI rebuilds the binaries and requires them
unchanged. `compress` and `mp3` each compile their own module; the
renderer's tessellator and line builder and BitmapData's kernel share
one, `render`, which each instantiates apart, with its own memory and
lifetime. `codegen` knows the runtime's function names and signatures
but never imports its implementation. pnpm only links the packages each
`package.json` lists, so the build rejects undeclared imports, and
`tests/unit/boundaries.test.ts` checks the declarations and the tsconfigs.

`@swf2es/context3d` exposes renderer-neutral resource contracts and AGAL v1
translation. Its core is built without DOM or node types; the separate
`@swf2es/context3d/webgl` entry owns a WebGL2 context and its GPU resources.
Neither entry depends on player AS objects. The two TypeScript projects
keep browser types out of the core while the normal package build checks both.
A third, `@swf2es/context3d/device`, is what a WebGL 2 context's one owner
sets it through, shared with `@swf2es/render`'s backend: linking programs,
and a cache of its state, so that nothing is set twice
([renderer.md](../renderer.md#the-backend)).

`@swf2es/render` is the renderer ([renderer.md](../renderer.md)). Its core
(scene list, rows, geometries, the planner and the command buffer it
writes) loads no DOM or node types and is tested as data;
`@swf2es/render/webgl` executes the commands. The player drives it
through `RenderView` (`@swf2es/player/scene`, kept off the player's index
so that a host that draws nothing loads none of it), which owns its
canvas and walks the display list into the scene list.
Flash bindings and validation are an explicit experimental entry,
`@swf2es/player/context3d`. `installContext3D` must run before loading
playerglobal, and its returned teardown must run before destroying Scripting.
It does not install itself or change default playback.

`@swf2es/player-hosts/stage3d` supplies canvas placement and browser loss/restoration
listeners. Its host takes a surface factory, so it need not import a GPU backend.
The caller supplies the clipped stage container and puts the display-list canvas
above Stage3D slots 0..3. A lost surface stays attached until restoration or
teardown; removing it detaches its listeners. `tests/context3d` exercises these
package entries against AIR references and repeated-load resource checks.
`@swf2es/web` accepts an experimental `configure({ stage3D: surfaceFactory })`
for subsequent loads. It lazily installs the optional bindings before libraries,
owns each load's layers and closes them before destroying Scripting. Its display
canvas supports transparency from creation and clears to transparent black while
Stage3D contexts exist; the stage background sits below the opaque viewports.
An isolated stack keeps different players' layers from interleaving. Viewport
positions follow embedding scale/alignment, while configured buffer dimensions
stay in pixels, as AIR's window capture verifies. Resize/DPR changes never
silently reconfigure AS buffers. An optional surface `destroy` hook releases the
browser context after resources and listeners are gone, also on attachment failure.
Web teardown disposes the display-list scene before the renderer so cached font
measurements cannot retain the scene through text style listeners.
Default playback still reports unavailable Context3D. The desktop View menu
offers an experimental opt-in, saved as a strict boolean in settings.json.
Changing it reloads the page and current movie; startup lazily imports the
backend only when enabled. The desktop's surface factory inherits the backend's
independent per-type resource counts and AIR-backed buffer/texture byte limits.
Composition, AS3 Stage layout, loss/recovery and teardown use the web host.
The demo site also offers Stage3D as an unchecked experimental option. It loads
the backend only when selected and uses the same resource limits as the desktop,
Flash Player's own: lower budgets refused scenes that play in Flash, with Error
#3691 on every frame. Changing the option restarts the current SWF; closing
during the backend import invalidates that load. The site's build includes the
optional modules and their import-map entries under the GitHub Pages subpath.
Its fullscreen button fits the composed Stage3D player to the screen with a
CSS transform, preserving the SWF viewport and back-buffer sizes. The 2D overlay
and input use the same presentation scale. Leaving fullscreen restores responsive
layout; ordinary playback retains its existing fullscreen resizing.
Best-resolution buffers and default enablement remain separate work.

The opt-in Context3D installation enables live Stage scale/alignment settings.
The web host then shares them with player natives through Scripting's synchronous
`onStageLayout` callback. Ordinary loads retain fixed Stage getters, ignored
setters and authored dimensions; AVM1 and default embedding alignment keep their
existing behavior when both opposite edges are named. It resizes the display
viewport before `resizeStage` dispatches a Stage-only RESIZE event in noScale;
other scale modes retain the SWF's authored dimensions. RenderView's viewport
(`setViewport`) keeps the display list's translation and pointer coordinates
aligned.
Context3D canvases retain their explicit back-buffer sizes across embedding and
DPR changes. These host hooks do not depend on ActionScript workers.

`format`'s `readActions` lists a SWF's AVM1 action blocks ([avm1.md](../avm1.md)):
DoAction, DoInitAction, a PlaceObject2 or 3's clip actions record by record
(event flags of 16 bits up to SWF 5 and 32 from 6, keyPress's key code) and
a button's actions (DefineButton's one, DefineButton2's conditions and key
codes), each with its owner and its range in the SWF's bytes, in tag order.
A block's index in that list is a pure function of the bytes, so the JIT and
the AOT compiler number blocks alike; `readPlace` and `readButton`, given the
list, give the indices of their own. The records are read as adl reads
them where it differs from Ruffle: only flags of 0 end a place's records, a
record runs only for the events the place's field of all events also has,
and a clip action that runs past its tag stops the whole SWF in Flash as
the first event of the place's field of all events comes, so its tag has no
blocks and is listed in `corrupt`, its events in `corruptEvents`. A malformed button action ends
its button's list and keeps the records before it.

`codegen` compiles that list to one ES module a SWF (`Codegen.compileActions`,
`assembly/avm1/`): `export default function (rt)` whose `rt.version(v)`
gives the operations of the SWF's version once, `V`, and which returns an
entry per block, in the list's order, each the array of its regions'
functions, the block's code first and then its functions' bodies, each in
the dispatcher form. A block compiles alone to its entry byte for byte
(`compileActionBlocks`), as `pnpm determinism` checks; its key
(`actionsKey`) names the compiler, the version and the SHA-256 of the SWF's
decompressed bytes. What the module calls, and what is built of it so far,
is in [avm1.md](../avm1.md).

`runtime/src/avm1/` has AVM1's values and their conversions by version
(`numbers.ts`'s number formatting and string-to-number, Ruffle's,
translated, which adl traces alike), its arithmetic, comparison, logical,
bitwise and string actions (`operators.ts`), the operations of each version
that `rt.version(v)` gives, made once and shared, and the `Host` through
which they reach the player's display list. An object's `valueOf` and
`toString`, which the conversions call, are hooks (`objects` in
`values.ts`) that the steps bringing objects fill. The player's `Avm1`
(`player/src/avm1/avm1.ts`) prepares lazy blocks as `start` loads a main
AVM1 SWF, compiles each on first execution with the same codegen
(`player/src/avm1/compile.ts`), gives each clip, button and text field
its AS2 face (`player/src/avm1/globals/MovieClip.ts`, a `DisplayNative`
of the runtime's), plays the clips the newest first and runs the blocks
their frames queue, in Flash's order: a `Player` given one, as the web
element and the test page give an AVM1 SWF with actions, runs them; an
ActionScript 3 SWF's never run.

Apps, in `apps/`, are what people run rather than import: `desktop`, the
Electron app (see [The desktop app](desktop.md#the-desktop-app)), `site`, the demo
site on GitHub Pages (see [The demo site](site.md#the-demo-site)), and later a
browser extension. An app may use any package, and no package may use an app; an
app is private, never published. The boundaries test checks both.

Third-party C swf2es forks lives in `vendor/`, a git submodule each, kept
apart from `packages/` because it is neither swf2es's code nor under its
licence: zlib, the LZMA SDK, minimp3 and libtess2, compiled into
`native`'s binaries (above), never linked by pnpm. The boundaries test
checks that `vendor/` holds those alone.

## Milestone 1

Met, and kept for the record. The as3pb protobuf benchmark
(`tests/programs`), compiled by swf2es and run in node:

- its trace output matches avmshell byte for byte;
- it is faster than the AwayFL JIT on the same benchmark (headless, its
  first run: ByteArray 525 ms, domain memory 689 ms; PepperFlash 188 ms /
  83 ms). Met since #23, at 207 ms / 251 ms
  ([benchmarks.md](../benchmarks.md#generated-code-as3pb));
- the Tamarin `ecma3/` and `as3/Types/` suites run through the conformance
  runner, with their pass rate tracked.

Out of scope for milestone 1: E4X, `Proxy`, `with`, playerglobal, SWF
timelines.
