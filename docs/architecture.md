# Architecture

swf2es plays SWF files in the browser and compiles their bytecode to
JavaScript. It has one compiler, which runs at two different times:

- **JIT**: the player runs `@swf2es/codegen` as a SWF loads, and compiles
  each of the SWF's ABCs whole to an ES module (see [A SWF's
  code](#a-swfs-code)). An opt-in mode compiles method bodies on first
  factory use (see [Optional lazy compilation](#optional-lazy-compilation)).
- **AOT**: node (or a server) runs the same compiler ahead of time, with the
  `swf2es` command (`packages/cli`), and the player takes its modules in
  place of compiling them (see [Compiling ahead of time and caching
  modules](#compiling-ahead-of-time-and-caching-modules)).

The compiler is written in AssemblyScript and ships as `codegen.wasm`, with
a thin TypeScript wrapper. The one wasm binary runs in browsers and workers, in
node, and in any server-side wasm runtime (for example wazero in a Go
server), so there is only one implementation to keep correct. It uses
AssemblyScript's minimal runtime, whose garbage the wrapper collects between
calls (see [benchmarks.md](benchmarks.md#the-assemblyscript-runtime)).

The wrapper's `Codegen` (`createCodegen` in `packages/codegen/src`) is the
compiler's API; besides `identity`, `epoch`, `abcVersion`, `usage` and
`isLive`, which report on it:

- `reset` starts a domain, and `add` links an ABC into it, after those
  before, into one of its application domains: `childDomain` makes one,
  `found` records what one has found, `dropDomain` lets one go,
  `evictDomain` and `reviveDomain` set one aside and bring it back, and
  `compact` reuses the memory they freed (see [Parsing, linking and
  verifying](#parsing-linking-and-verifying));
- the last ABC added compiles with `compile`, whole, to its module, source
  map and the entry of each method; with `compileModule`, to its module
  alone; or with `compileLazyModule`, to its tables and lazy factories,
  whose bodies compile with `compileMethods` on first factory use;
- `context`, `revision`, `compileModuleLogged` and `replay` serve a cache
  of modules (see [Caching modules](#caching-modules)).

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
   of what resolves lazily (see [Caching modules](#caching-modules)). So
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
| `native`  | the WebAssembly modules, each a sub-path with its own binary and lifetime: `compress` (zlib and LZMA), `mp3` (minimp3), `tessellate` (libtess2 fills) and `bitmap` (CPU kernels), C and Zig built by one Zig project | — |
| `format`  | SWF container and tags, a DoABC's bytes (codegen parses the ABC), AVM1 action blocks | native |
| `codegen` | bytecode → IR → ES modules, in AssemblyScript (`assembly/`)     | format                    |
| `runtime` | AS3 and AVM1 language semantics called by generated code        | format                    |
| `context3d` | experimental renderer contracts, AGAL translation and optional WebGL2 backend | — |
| `player`  | display list, timeline, playerglobal, PixiJS renderer           | format, codegen, context3d, native, runtime |
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

`native` is one Zig project (`build.zig`) for every sub-path's binary:
`packages/native/build.ts` runs the bitmap kernel's tests and then `zig
build` with a pinned Zig 0.17.0 (whose clang compiles the vendored C,
unchanged, against the libc stubs in `include/`), writes each module into
its sub-path's `binary.ts` with a digest of its inputs, and the vendored
C's notices, verbatim, into `LICENSE.third-party`. `pnpm build` checks the
digests and the notices; CI rebuilds the binaries and requires them
unchanged. Each sub-path still compiles and instantiates its own module,
with its own memory and lifetime, and imports only its own. `codegen` knows the runtime's function names and signatures
but never imports its implementation. pnpm only links the packages each
`package.json` lists, so the build rejects undeclared imports, and
`tests/unit/boundaries.test.ts` checks the declarations and the tsconfigs.

`@swf2es/context3d` exposes renderer-neutral resource contracts and AGAL v1
translation. Its core is built without DOM or node types; the separate
`@swf2es/context3d/webgl` entry owns a WebGL2 context and its GPU resources.
Neither entry depends on player AS objects or Pixi. The two TypeScript projects
keep browser types out of the core while the normal package build checks both.
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
the backend only when selected and uses lower per-context host budgets than the
desktop: 64 MiB buffers, 128 MiB textures and 16 MiB each for target depth/stencil
and multisample color. Changing the option restarts the current SWF; closing
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
other scale modes retain the SWF's authored dimensions. PixiView's viewport
keeps display-list translation, its hit area and pointer coordinates aligned.
Context3D canvases retain their explicit back-buffer sizes across embedding and
DPR changes. These host hooks do not depend on ActionScript workers.

`format`'s `readActions` lists a SWF's AVM1 action blocks ([avm1.md](avm1.md)):
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
is in [avm1.md](avm1.md).

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
Electron app (see [The desktop app](#the-desktop-app)), `site`, the demo
site on GitHub Pages (see [The demo site](#the-demo-site)), and later a
browser extension. An app may use any package, and no package may use an app; an
app is private, never published. The boundaries test checks both.

Third-party code swf2es forks lives in `vendor/`, a git submodule each,
kept apart from `packages/` because it is neither swf2es's code nor under
its licence, and is built with its own tools rather than `tsc -b`.
`vendor/pixijs` is [swf2es/pixijs](https://github.com/swf2es/pixijs), PixiJS
(MIT) pinned to a commit of its `swf2es` branch; its `SWF2ES.md` says why
and what changes there. It is the workspace package `pixi.js`, under its
own name and version, so `player` and `web`, the only packages that may use
it, import `"pixi.js"` as from npm and declare it as `workspace:*`; the
boundaries test checks both. `.pnpmfile.cjs` trims its manifest to the
tools its build needs, at the versions of its own `package-lock.json`, and
`tools/pixijs.ts`, the first step of `pnpm build`, runs its rollup and
declaration builds for `lib/`, byte for byte what npm's `pixi.js` would
hold at the fork's commit. The bundle the pages load as `"pixi.js"`
(`dist/pixi.mjs`) is swf2es's own instead: the fork's bundle plugins over
an entry that exports only the names the player, `web` and the test page
import (`BROWSER_EXPORTS`, held to their imports by a unit test) and runs
only the side-effect modules they need, tree-shaken. Pixi's accessibility
overlay, DOMContainer and the Assets loaders are left out; the WebGPU and
Canvas renderers, the player's fallbacks without WebGL, are chunks loaded
only then. A host that bundles `@swf2es/web` itself takes Pixi from
`lib/` and its own bundler decides the same.

The player overwrites no method of Pixi's. What is Pixi's own
behaviour, a bug fix or a memory or speed fix any user of Pixi would
want, is changed in the fork; what is the player's policy, Flash's
semantics, when a render group settles, the colour transform's shader,
runs through extension points the fork adds for it (a pipe's
`aloneDrawer` and `shaderFor`, a system's `onContextBuilt`,
`onBuildInstructions` and `filterAreaHook`, and the like), which
`render/hooks.ts` sets on each renderer the player draws with.

## Parsing, linking and verifying

avmplus checks an ABC in three places, and swf2es checks it in the same
three, with the same VerifyError numbers:

1. **Parsing** (`codegen/assembly/avm2/abc`): everything avmplus rejects while
   parsing that one ABC can decide on its own: counts, pool indices, trait
   kinds and names, class order, a method bound to two owners.
2. **Linking**, when classes are defined: anything that needs classes from
   other ABCs or playerglobal, such as base classes, interfaces, overrides
   and name clashes.
   The ABCs loaded together form a domain (`codegen/assembly/avm2/link`), which
   interns strings and namespaces across them and finds script definitions
   by qualified name. Builtin ABCs mark their namespace URIs with the API
   version that introduced a name; as in avmplus, user code sees the names
   of its own version and series (Flash Player's by default), so AIR-only
   and VM-internal names stay hidden. While an ABC loads, its classes link
   to base classes and interfaces defined by earlier ABCs' scripts or by
   its own earlier classes, as avmplus' `AbcParser` links them.
   The domain's ABCs are loaded into application domains, a tree whose
   root is 0, as avmplus' DomainMgr keeps them: an ABC sees the names its
   own application domain and its ancestors define, the first from the
   root down, unless the runtime has reported that the domain finds
   another (`found`: what its caches hold, by name or as a type), and its
   module names as `linked` the ABCs it sees, in load order.
   Each class's, script's and activation's traits then lay out their
   members, binding names to slot and dispatch ids after their base's
   (`link/traits.ts`). Types resolve later, when a class is first used:
   slot types, method signatures, and the override and interface checks
   that compare them. A type is the id of a traits, including void and
   null, or `*`.
   An application domain the runtime has let go of is dropped with its
   descendants (`dropDomain`), and one the host has no use for now, as
   once its ABCs are compiled, is evicted with them (`evictDomain`): no
   other sees their ABCs, which compile no more and keep their indices.
   `compact` rebuilds the domain only when that keeps codegen's memory
   from growing: when the tables, by an estimate from their rows, with
   what a compile's garbage and the rebuild itself take, come near
   memory's size, and those ABCs weigh 4 MB and enough to bring them
   back below. Before that a rebuild would reclaim nothing that matters,
   as wasm memory never shrinks. `usage` tells the estimate, and
   `compact` asks the same before it collects and rebuilds; a host calls
   it when it has time, as the player does when idle. A rebuild
   links the live ABCs again, in their places, and does again, where it
   happened, what the domain has logged: each finding recorded, and the
   first answer to what resolves lazily, a traits' types, a method's
   signature, an ABC's first verification and the scopes it finds. Those
   see the ABCs there were when first asked; an ancestor may define the
   same name since, which a lookup would find now. So a live ABC links,
   resolves and compiles as it did, since no ABC let go of was ever seen
   by it, and the collector frees all the others took, the names only
   they spelled included: wasm memory never shrinks, but what was freed
   is used again. A rebuild of a large application's domain takes tens of
   milliseconds, its first verifications most. An evicted domain is
   revived (`reviveDomain`) with its evicted ancestors, the first a child
   of a live domain, given their ABCs again if a rebuild let go of them:
   one rebuild links them in their places, their log done again with
   them. `reset` counts an epoch, which `dropDomain` checks, so that a
   drop meant for a domain of before a reset does nothing.
3. **Verifying a method**, when it is first compiled: its signature's types
   and its bytecode.

An ABC with errors in more than one stage may report a different first
error than avmshell. Well-formed ABCs are unaffected.

## Compiling a method

Each method goes through the same steps, in `codegen`:

1. **Decode** (`abc/code.ts`): the reachable instructions, as the avmplus
   verifier reads them.
2. **Verify and build the IR**, as avmplus' `Verifier` does its checks,
   with its VerifyError numbers (`abc/code.ts`, and for finding, getting,
   setting and calling properties `abc/properties.ts`). A first pass keeps a frame state per block
   (the locals, scope stack and operand stack, each value with its type,
   whether it is known not null, and whether it is a with scope), merges it
   where control flow joins, and walks a block again when its entry state
   changes, until none does. avmplus knows a value not null after a null
   check of it, but not the local it copies, so a frame state also keeps
   which locals are neither null nor undefined at run time: checked since
   they were last set, as a copy of them on the stack was, or compared with
   a `pushnull` or `pushundefined` (`==`, not `===`; a value only typed
   void, as a native's result, may be anything) or tested true where a
   branch goes on, on every path in; a handler gets the locals as they were where its range threw.
   That takes away only checks that cannot fail, and changes no type the
   verifier sees. A second pass walks the blocks in code order
   with their final states; there `newclass` and `newfunction` capture the
   scope chains the methods they create run in, and the same pass will
   write the IR, so what is compiled is exactly what was verified. An ABC's
   methods are verified from its scripts outward, as each becomes
   creatable; methods nothing can create are never verified, as in avmplus.
   Where avmplus changed after the oracle's avmshell was built, swf2es
   follows the newer Flash Player: since PSIRT 3037, a method that can
   throw into a handler needs `max_stack` of at least 1, which the
   oracle's avmshell does not check.
3. **The IR** (`ir/ir.ts`) is register form with types, not SSA. A
   register is an index into the verifier's frame: locals `l_n`, then scope
   entries `sc_n`, then stack slots `s_d`, so `getlocal1; getlocal2; add;
   setlocal3` is `s0 = getlocal1 l1; s1 = getlocal2 l2; s0 = add s0 s1;
   l3 = setlocal3 s0`. An instruction reads consecutive registers and
   writes one, with the verifier's type there (`int`, `uint`, `Number`,
   `Boolean`, `String`, a class, `null`, `*`) and whether it is known not
   null. Each block keeps its entry state, so a lowering can follow every
   register's type: `add` then `convert_i` on two `int`s is `(a + b) | 0`.
   The instructions are what avmplus' verifier tells its code generator:
   the ABC instruction, or the verifier's decision made explicit, as a
   slot bound early (`getslot`), a method called by dispatch id
   (`callmethod`), where a name was found (`getscopeobject`,
   `getouterscope`, `finddef`, the global scope), and every coercion and
   null check. V8 does SSA-level optimization on the JavaScript anyway.
   The tables are flat, like the parser's, and reused across methods.
4. **Control flow** (`emit/structure.ts`). First a per-method dispatcher
   (`for (;;) switch (block) { ... }`), which handles any control flow,
   irreducible or obfuscated included. Then structured JavaScript (loops, `if`,
   labelled `break`) from the dominator tree for the reducible code compilers
   emit, falling back to the dispatcher. Conformance tests check that both
   give the same results.
5. **Emission** writes JavaScript as UTF-8 into a growable byte buffer: no
   JavaScript strings, and names are copied straight from the ABC. A
   method's instructions are `emit/method.ts`'s; arithmetic, comparisons
   and conversions `emit/values.ts`'s, domain memory `emit/memory.ts`'s,
   how types, namespaces and constants are named `emit/refs.ts`'s, and the
   module around the methods `emit/module.ts`'s.

### Generated code

Each ABC compiles to one ES module. Every method becomes a JavaScript
function whose registers are `var` variables, and whose blocks are
structured JavaScript, as Norman Ramsey's "Beyond Relooper" translates a
reducible control-flow graph by its dominator tree:

- a loop header (the target of a back edge) is `L3: for (;;) { ... }`;
- a merge node (more than one forward edge in) is a labelled block,
  `L5: { ... }`, followed by its own code;
- a branch to a loop header is `continue L3`, to a merge node `break L5`,
  and to a block it is the only way into, that block's code in place;
- every path ends in a branch, return or throw, so nothing falls out of a
  loop or through a case.

A block starts only where something branches to, so a conditional branch
may be in the middle of one; it is then an `if` whose body branches, and
the block goes on after it.

An exception handler's block counts as entered from every block its
range covers, so it is a child of the block that dominates them all, and
is written as a merge node is, with a `try` inside the labelled block:
`L7: { try { ... } catch (e) { ...; break L7; } }`, then the handler's
code; how its `catch` finds the handler is below.

Where that translation does not apply, a dispatcher runs the blocks:
`for (;;) switch (b) { case 0: ...; b = 2; continue; }`. It handles any
control flow: an irreducible graph (a loop entered in more than one
place), or handlers whose `try`s cannot enclose the code they cover, in
the order avmplus looks for them. With handlers, the whole loop is in
`try`/`catch`; the catch picks the handler covering the throwing
instruction, matches the exception's type, and continues at its block
with the exception as the only stack value, or rethrows.

Scope and stack registers that only copy another register or a constant
are not written: a `getlocal`, `dup`, `getscopeobject`, `getglobalscope`,
the IR's nip, or a `pushscope` of a local leaves its register a copy, read
as what it copies, until that changes. A forward dataflow over the blocks
(`emit/copies.ts`) finds the copies each block is entered with on every
way in, a loop's back edges included, so a branch writes only the copies
its target does not know; locals are always written, so a handler, which
starts with none, finds them as they are wherever its range threw. A value
the next instruction only moves to a local or a scope (a `setlocal` or
`pushscope`, after conversions that change nothing) goes there straight;
one it duplicates to set a local (`dup; setlocal`) goes to the local, and
the stack register is its copy. A conversion that changes nothing writes
no code.

The code is written short where that costs nothing at run time:
`undefined` is `void 0`, and a return of it a bare `return;`, each of
which V8 compiles to the same bytecode as `undefined`; and registers a
run of `kill`s or `popscope`s leaves undefined are one statement,
`sc2 = sc1 = l3 = void 0;`. A method's code is not indented: it was
not nested by its blocks either, only shifted, a tenth of a module's
bytes; each statement keeps a line of its own, for stacks, the source
map and a debugger's steps.

A null check is `r ?? nn(r)`, where `nn`, the module's, throws the
runtime's TypeError for the value, 1009 for null and 1010 for undefined.
It is made where the instruction it checks for reads the register, when
that instruction reads it before doing anything that can throw or be
seen, as a property's get, set or call does: `s0 = (s1 ?? nn(s1)).$2`,
`rt.getProperty(l1 ?? nn(l1), M[3])`. Otherwise, as when a conversion
of an argument comes between, it is a statement of its own, `s1 ??
nn(s1);`. A method's count of arguments is checked first, as avmplus'
`argcOk` does, and its ArgumentError 1063 thrown by the module's `ac`:
`if (arguments.length - 1 >>> 0 > 2) ac(1, arguments.length);` for one
to three. Neither `nn`'s frame nor `ac`'s is named with a `$`, so the
stack a host is shown starts at the method, as before.

Each module has a source map (version 3) from the ABC's `debugfile` and
`debugline`, where an ABC compiled with them has them (asc's `-d`): the
method emitter marks where the code for each AS3 line starts as it writes
it, and the map finds the marks' lines and columns in the module. A block
starts with the line the instructions before it in the ABC left, and code
after a block written in place inside another goes back to the other's.
With it, stacks name AS3 lines and a debugger steps through the AS3;
`node tests/conformance/debug.ts <case> --lines` compiles a case with `-d`
to try it.

The IR's types decide the JavaScript from the start where that is simple:
`int` arithmetic ends in `| 0`, `uint` in `>>> 0`, a slot bound early is a
field access, a method bound early a direct call, a coercion to a class
`rt.coerceTo` (no builtin for the runtime to look for), and a typed
Vector's element `rt.vectorGetInt` and the like, one for each kind of
element, so that each sees one kind of array. A domain memory load or
store at an `int` or `uint` address is in place, on the runtime's view
of the memory after a range check, and calls the runtime (`rt.li32` and
the like) only for an address out of range, which it rejects as avmplus
does. Anything typed `*` goes through the runtime, which does what
avmplus does at run time.

Two ints or uints multiplied and the product made an int or uint by the
next instruction, in the same block, are `Math.imul`: avmplus' JIT
multiplies them as ints (`CodegenLIR::coerceNumberToInt`), which wraps,
where the double product loses the low bits past 2^53, and compiled C
such as Crossbridge's depends on it. Its interpreter multiplies doubles,
and it runs the static initializers, scripts' and classes', so those
stay double products. The JIT also wraps a product that reaches the
conversion later in the block or through a local, which swf2es does not
follow yet; `int-multiply.as` keeps to the forms it does.

### The object model

An AS3 object is a JavaScript object made from its traits' prototype,
which `newclass` builds from the module's layout:

- **Slots** are fields named by slot id (`$0`, `$1`, ...), set to their
  initial values when the object is made, so an early bound slot is one
  property access and cannot collide with any dynamic name. They are set by
  name, by a function the module has for each traits (`fill`, see below):
  V8 makes an object a dictionary once stores by a computed key give it a
  seventeenth property, and every access to it a lookup. The function sets
  the slots highest first, the base's included, so a class's objects keep
  one shape, and as each class has its own, its stores see that shape
  alone and stay inline. It is code in the module, not made from text at
  run time, so a page without 'unsafe-eval' runs it too. Objects of a class
  of 24 slots were made nine times as fast so, and read four times as
  fast; of 5 slots, made a third faster.
- **Methods, getters and setters** are on the prototype, named by dispatch
  id, so `callmethod` is a direct call and overriding is JavaScript's own
  inheritance.
- **Dynamic properties** of dynamic classes live in their own map, apart
  from slots and methods.
- **Names**: each traits has its own bindings by namespace and name, and
  a lookup goes on to its base's, as avmplus' does. The runtime's multiname
  lookup (getproperty, setproperty, callproperty with a name that did not
  bind early) searches as avmplus does: bindings, then dynamic properties,
  then the AS3 prototype chain, which each object reaches through `$p`.
- **Inline caches**: each multiname a module makes keeps what its lookups
  found on the traits of the objects they were made on, for up to eight
  traits (`property-cache.ts`): the binding, as the slot's field and type, the
  getter, setter or method, or that it is a dynamic property's. The next
  get, set or call of the name on an object with those traits does that
  directly, which is what the lookup would decide, since that depends only
  on the traits and the name, whose namespaces and versions are fixed. A
  dynamic property's entry still looks for it on the object, and leaves
  the prototypes to the full lookup. Describing traits, and setting up a
  class's or script's methods and hooks, bumps an epoch that empties every
  cache, and so does a Loader's unload. An entry holds its traits and
  their code, so emptying drops those references at once, not as the name
  is next filled: otherwise a name the main SWF used on a loaded SWF's
  objects would keep that SWF alive after its unload. A name that has
  replaced 16 entries keeps the ones it has until the epoch moves, as a
  name seen on more traits than it keeps would otherwise replace one on
  every miss. A primitive's bindings are cached by its class's traits, not
  its prototype's properties. Not cached: a name made at run time, a name
  a hook resolves (a Proxy's, XML's), an element's index and a
  Dictionary's key.
- **A class object** is an instance of its static traits, whose base is
  Class's instance traits; it holds its instances' traits (`$it`) and its
  AS3 `prototype`. Class is dynamic, so class objects are, as the builtins
  need (`String.fromCharCode = function ...`).

Values are JavaScript's own: `undefined`, `null`, numbers for `Number`,
`int` and `uint`, booleans, strings. AIR's scalar `float` uses `FloatValue`
with a binary32 payload, rounded by `Math.fround` when produced. The tag
preserves its identity through `*`, calls, properties and arrays: AIR treats
`float(1) === Number(1)` as false. Two float operands produce a rounded float;
a mixed float/Number operation produces Number. Known Number arithmetic
keeps its direct JavaScript operators. Float values crossing method and
object/array storage boundaries use small tags; zero, negative zero and NaN
are shared. Locals known to hold floats at every use, and float temporaries
within a basic block, keep their payloads as JS numbers, with `Math.fround`
at float operations. Live temporaries crossing control-flow edges are boxed;
locals with mixed or unknown types keep the general tagged representation.
Typed float-vector accesses also read and write unboxed payloads.

AIR ABC 47.16 and above insert one scalar float pool after the doubles;
current AIR omits the experimental Tamarin float4 pool. The scalar
`pushfloat`, `convert_f` and `unplus` instructions are version-gated, and
`float4` instructions remain rejected. The separate builtin `floatLibrary`,
generated from `as3/builtin/src/float.as`, declares the primitive beside the
Flash builtins without replacing them. The player and CLI load it once on demand
when AIR float bytecode is encountered, before adding any ABC of that SWF;
direct compiler/runtime users can supply
`avm2.floatLibrary` as a builtin after `builtin.abc`. AIR's AMF3 float and
float-vector markers are preserved, including signed zero and NaN. The
`air-float` player case holds AIR's reference traces; its source is under
`tests/conformance/cases/air`, outside the avmshell-only runner.

A namespace value is the runtime's
interned namespace, whose class is Namespace. Arrays and most Vectors keep
their elements in a JavaScript array, `$a`. For `Vector.<float>`, `$a` holds
a `FloatVector`: a `Float32Array` buffer, a logical length and spare capacity
grown by about 1.5x. Explicit-length construction allocates exactly that
length; setting length to zero releases the buffer. Dynamic reads and
callbacks box their float values, while enumeration, JSON and AMF respect
the logical length and float identity without storing a tag per element.
A script's global object is an instance of its traits like any other.
Errors thrown by the runtime are AS3 `Error` objects with avmplus'
error numbers. Their messages are the release player's, as avmshell's
are: `Error #1009`, and nothing more, since AS3 can read and print them.
With the runtime's `debugger` option they are the debugger player's,
`Error #1009: Cannot access a property or method of a null object
reference.`, and `System.isDebugger` is true.

### Modules and the bootstrap

The compiler computes every traits' layout, so a module states it and the
runtime never derives one. An ABC's module exports a function of the
runtime, `rt`, that returns:

- **names**: the ABC's namespaces and multinames as runtime objects,
  interned by the compiler's rules (kind and URI, API version, a private
  namespace per ABC entry);
- **methods**: a factory per method, `(scope, sup) => function (...) { ... }`,
  so that each `newclass` or `newfunction` binds the scope chain it
  captured, and a class's methods the base class their super instructions
  use; a factory names only the parameters its method uses, `() =>` for
  one that uses neither;
- **traits**: for each class, its base class and interfaces by name,
  resolved when the class is created as avmplus resolves them, its own
  bindings by namespace and name, its slots' defaults, and its methods,
  getters and setters by dispatch id; and, for traits of up to 128 slots,
  `fill: (o, v) => { o.$n = ...; ... o.$0 = ...; }`, which sets a new
  object's slots, its base's too. A value is a literal where it is one
  however the module is compiled, a type's default or a constant of the
  module's own ABC; a namespace, or a base's constant from another ABC, it
  takes from `v`, the runtime's initial values by slot. Traits without one,
  a catch scope's or past 128 slots where V8 keeps no object fast, are set
  by key;
- **scripts**: each script's traits and initializer, run the first time
  something asks for a name it defines, as avmplus runs them.
- **hash** and **linked**: the hash of its ABC and of the ABCs loaded
  before it that its application domain sees, in order (`domainLinked`). Its layouts depend on
  those ABCs, so the runtime refuses to load it after any others.

The runtime starts with builtin.abc, then the ABCs that follow it (for
avmshell's programs, shell_toplevel.abc):

1. make the traits of Object, Class and Function, empty, before any module
   loads: global objects and class objects are made with them as their
   bases before their classes exist;
2. load the builtin modules: their scripts' names become visible, and
   nothing runs;
3. run a script the first time a name it defines is looked up (`finddef`,
   `findpropstrict`, `getlex` of a global name, a coercion to a class) and
   the entry point, the last script, of each module that is not a builtin,
   as avmshell does.

The first lookup of any builtin name runs the builtin script that defines
Object, Class and Function. Its `newclass` of Object fills in Object's
traits; class objects made before Class exists already inherit from
Class's traits, so they see its bindings and prototype once it does. A
coercion to Object, Class or Function checks against their traits, so it
works while they are being made, as avmplus' does.

A native method is bound by its class's and its own qualified name, as
avmplus binds its C++ ones: `"Math.floor"` for a static method,
`"String#indexOf"` for an instance method, and the name alone for a
script's function; accessors as `"get:"` and `"set:"` names, and a name
outside the public namespace with its namespace's URI, `"uri::name"`. A
native the runtime lacks throws an error naming it when called, not when
loaded. The natives reach a runtime as a record by name, or as a provider
`(rt) => natives` that the runtime calls on itself once it is made, so
that a module of natives can close over the runtime it serves, as a class
of natives written with `registerNativeClass` does.

Generated methods follow one calling convention. A slot is the field `$n`,
by its slot id from 0, and a method, getter or setter is `$mn` on the
prototype, by its dispatch id; dynamic properties are kept apart from
both. A method of a primitive receiver is called through its class's
prototype, `rt.prototypeOf(int).$mn.call(x, ...)`. A method's own scope
registers and the chain it captured are passed to the runtime together
when it looks a name up or creates a function or class, with a bit per
scope for the with scopes.

In a method with exception handlers, the handlers' ranges split the code
into regions, and the variable `t` holds the region of the instruction
running, set only where it changes. Each handler's `try` encloses the code
its range covers, and maybe other code; its `catch` takes the exception
only if `t` is one of its regions and the exception's type matches, and
otherwise rethrows it to the next `try` out. The `try`s covering each
region are open innermost first in the order of the ABC's table, so the
handler that gets an exception is the first in the table that covers the
instruction and matches, as avmplus finds it. It gets the exception as its
only stack value; with no match, the exception goes on to the caller. The
emitter checks that order as it writes each block, and writes the method
with the dispatcher where it does not hold: one `try`/`catch` around the
loop, whose `catch` tries the handlers covering `t`'s region in the
table's order and goes on at the first match's block.

### Optional lazy compilation

The default player compiles each ABC whole when it loads (see [A SWF's
code](#a-swfs-code)). `new Scripting(codegen, { lazyCompilation: true })`
opts into compiling uncached AVM2 bodies on first factory use. The web
embedder exposes the same option through `configure({ lazyCompilation:
true })`. It remains experimental and off by default.

The module's names, layouts, scripts and verification are prepared before
execution, so their scopes resolve against the same domain as eager code.
A lazy factory compiles its entry once, replaces its slot in F and returns
the entry's original function. Later calls run that function directly;
creating another closure may revisit the cached factory. Native methods,
missing bodies and verification errors retain their eager factories. AOT
still emits whole modules. Existing whole modules in the module cache are
consumed normally; partial lazy modules are never written to that cache.
The compiler must belong to this player for its lifetime: resetting it
rejects a later deferred compile rather than using another movie's ABC.

Entries transfer from Wasm as UTF-8. The wrapper collects after a lazy
skeleton, after memory growth, every 64 calls, or 256 KiB of method source
since the last collection.
It does not collect after every method, which costs substantially more.
Verification results are kept per lazy ABC, cleared when its domain is
dropped or evicted, and regenerated after a compiler-domain rebuild.
Lazy mode retains compiler domains until runtime-domain collection instead
of evicting them immediately after linking: deferred bodies still need their
ABCs. Normal domain dropping and idle compaction still apply. Destroying
a player clears shared property caches so their last getter or method
cannot keep the destroyed player alive.

The first method request is not the first verification: verification runs
when the module's skeleton is built. It still verifies the ABC as a whole,
so lazy mode does not eliminate this startup cost. Dynamic Function entries
need identifiable stack frames; unsupported engines and policies fall back
to whole-module compilation. Per-method sourceURLs have the form
`swf2es-26.js/$f63.js`; frame parsing maps them to their module for both domain
lookup and caller security checks. Class-reference tables are built under
the original module's domain, even when another SWF is loading.

Each entry is built with a strict `Function` whose parameters are the
module's tables and helpers (`rt`, `nn`, `ac`, `ns`, `cls`, `N`, `S`, `M`,
`V`, `F`, `A`). This keeps their lookups lexical, as in the eager module;
direct `eval` would instead introduce dynamic scope lookups. Strictness
matches the original ES module. The entry itself is byte for byte its
factory in the whole module, the same JIT/AOT invariant the compiler's
method-at-a-time tests enforce.

See [the AVM2 benchmark](benchmarks.md#avm2-eager-and-lazy-compilation) for
startup, first-use and warmed measurements. The potential saving depends
on which factories the application binds: methods bind when a class or
script is initialized, and a nested function when `newfunction` runs, not
on each ActionScript call. A class whose every method is bound immediately
may gain little while paying additional per-entry compilation costs.

## The runtime and the standard library

Generated code calls `@swf2es/runtime` for the object model, multiname
lookup, coercions and exceptions (`packages/runtime/src/avm2`); it grows as
far as each step needs. The engine is at the top. `runtime.ts` is the
`Runtime` class, whose methods are what compiled code calls as `rt`:
property access, calls and construction, coercions, for-in, exceptions and
domain memory, with the inline caches' hookup. Around it, each a model of
its own or a stage the hot paths do not run through: `descriptors.ts`, the
values and descriptors a compiled module is built against; `options.ts`,
what a host gives a runtime; `hooks.ts`, what a builtin or a player's class
plugs in to allocate, index, resolve names or be called; `traits.ts`, the
layout model (`Traits`, the binding kinds, the class and Vector references);
`domain.ts`, application domains and the lookup of a name along a domain's
chain; `modules.ts`, the modules loaded into them and which module's code
a stack is in; `method-factories.ts`, the natives and the methods with no
generated body as a module binds them; `classes.ts`, OP_newclass, which makes a class from its descriptor;
`enumeration.ts`, the names a for-in goes through; `property-cache.ts`, the
inline caches; `names.ts`, namespaces and multinames; `number-strings.ts`,
numbers to and from strings as ToNumber and ToString convert them; `numbers.ts`,
`messages.ts`, and `amf.ts`, which ByteArray and later the player's
networking use.

The builtins' natives are in `natives/`, a file per
family of classes (`object`, `array`, `string`, `regexp`, `number`,
`vector`, `bytearray`, `date`, `json`, `dictionary`...), registered in
`natives/index.ts`, with what makes some builtin classes differ from others:
Arrays' and Vectors' element storage, and what calling or constructing
`int`, `String`, `Object`, `Array` or a Vector does. A Dictionary keyed
weakly (`new Dictionary(true)`, `weak-keys.ts`) keeps no key alive, as
Flash's does not: its values in a `WeakMap`, its keys' order as `WeakRef`s,
and a for-in's names of its keys held weakly too, so that a for-in left off
keeps none. Kept strongly, an application's registry of display objects in
one held every room's clips, which played on as orphans. avmshell's own classes,
which a player has not, are in `natives/shell.ts`. playerglobal is the
player's (`packages/player/src/playerglobal/flash/display/...`, a path per
package, so a class's file follows from its qualified name).

The debugger player's error messages are avmplus' own, generated from its `ErrorConstants.cpp` into `messages.ts`, which
stays MPL-2.0, and Flash Player's own over them, 2000 and up, generated
into `player-messages.ts` from the table Flash itself prints as
`Error.getErrorMessage` of every number (Ruffle's corpus,
`error_geterrormessage`); the release player and avmshell print the
number alone.

Where avmplus' behaviour is its own algorithm rather than a language rule,
the runtime translates it, so that its output is avmplus' byte for byte:
number formatting (`numbers.ts`), Array's sort (`natives/sort.ts`),
ByteArray with its capacity and UTF-8 (`natives/bytearray.ts`), AMF3
(`amf.ts`), JSON (`natives/json.ts`), Date's formats (`natives/date.ts`),
XML (`natives/xml/`: `chars.ts` and `parser.ts` tokenize text, `node.ts`
is the tree, `build.ts` makes trees from text and values, `values.ts` the
XML and XMLList objects, `names.ts` their names, Namespaces and QNames,
`access.ts` E4X's internal methods, `strings.ts` toString and toXMLString,
`operators.ts` == and +, and `xml.ts` the classes' hooks and natives) and
describeType (`natives/describe.ts`).
Each of these files is MPL-2.0, as its source is, and says so at its top.
avmshell's `File` reads and writes `RuntimeOptions.files`, in memory by
default. Date is JavaScript's Date, with avmplus' string formats.
flash.concurrent's Mutex and Condition are avmplus', in a heap of int32
words every worker of a primordial's shares (`natives/concurrent.ts`,
`natives/sync.ts`): `RuntimeOptions.sync` names it and the worker a
runtime runs, by default memory of its own, or for avmshell's workers
their `ShellWorkersMemory`'s. A thread blocks with `Atomics.wait`, or
spins where it cannot, up to Flash's script timeout (Error 1502). ByteArray's atomic operations and `casi32` are
`Atomics` on a shareable ByteArray's memory once another worker shares it
(a growable SharedArrayBuffer, see [workers.md](workers.md)). Crossbridge's code
uses them all as it starts. avmshell's Worker and WorkerDomain
(`natives/shell.ts`, `natives/shell-workers.ts`) keep each worker's state,
parent and shared properties in memory every thread sees, a
SharedArrayBuffer, so that one worker sees at once what another set, and
start each background worker on a thread of `RuntimeOptions.workers`, the
host's, which runs a runtime made with that worker's `RuntimeOptions.worker`
(see [workers.md](workers.md)).

### Application domains

Domain memory is avmshell's `avmplus.Domain`'s: 1024 bytes of scratch
memory until a ByteArray is set as it. Each Domain is one of the runtime's application
domains (`Domain` in `domain.ts`), as avmplus' DomainMgr keeps them: a
name a domain's chain defines already is not added again, and a lookup
takes what a domain of the chain has found before, from the name's own
domain up, else the first loaded, from the root down, and keeps it, so a
child that found its own class keeps it when its parent defines the name
later. A type, a coercion's or a base class's, is found the same way
through caches of its own, as avmplus finds traits, so a class a child
found by name is not the type it finds once its parent defines the name,
and a class extending it is rejected, as avmplus rejects it. What a
name finds being kept, `Runtime.classNamed`, the player's lookup of a
class by its qualified name, keeps the class in the domain
(`Domain.named`) once its script has made it: the player names a class
for each object and event it makes.

Every name a module makes is looked up in the domain the module was
loaded into (`Runtime.loadInto`); everything else loads into the root. The
Domain's `loadBytes` compiles its ABC through `RuntimeOptions.compileAbc`,
which the host gives, as the runtime does not include the compiler, into
the compiler's application domain of the same number, after what the
domain sees then: its parent's ABCs, with those the parent loaded after
the child was made, and its own, in load order. With it go the domain's
findings that are not the first definition from the root down, what its
caches hold (`Runtime.compileUnit`), so the compiler binds the ABC's names
and types as the runtime will find them. It runs the ABC at once. The
compiler binds them as the domain finds them when it compiles; avmplus
binds each method's when it verifies it, on its first call, so a name
nothing has found yet that a parent defines in between binds differently.

`Domain.currentDomain` is the domain of the innermost code on the stack
that a module defines, as avmplus' code context, so a child's method
called by the parent's code sees the child's. The runtime finds a frame's
module by the script the stack names, recorded when the module loads, so
a host gives each module a script of its own, a `sourceURL` comment for
code it evaluates (`Runtime.codeDomain`). A frame that names no script,
as JavaScriptCore's of a Function's code, is no module's: the module a
load's stack does not name is left out, not taken for the host's code
the next frame is.

JavaScriptCore also makes a strict `return f(...)` a
proper tail call, dropping the caller's frame, so the runtime calls a
function value, a bound method or a getter for a SWF's code, and calls
on to its own functions that do (`call` to `callValue`, `callProperty`
to `callBound`, Function's `call` and `apply`, a Proxy's methods), in no
tail position: its frames stay between the callee and the code that
called the runtime, as anything reading the stack expects. It is written
`let r; r = f(...); return r;`, not `const r = f(...); return r;`, which
minifiers (terser's and esbuild's) fold back into `return f(...)`; this
form they keep, as `return r = f(...), r`. Measured in JavaScriptCore's
shell, as3pb's run and the untyped benchmark took the same within their
spread either way.

### describeType

`avmplus.describeTypeJSON`, which `describeType` and playerglobal's
`flash.utils.describeType` build their XML from, is avmplus' TypeDescriber
translated (`natives/describe.ts`): the value's traits, or its class's
instance traits with `USE_ITRAITS`, named as `getQualifiedClassName`
names them (`*` for none, `void` and `null` for those values), its
bases up the chain, every interface it implements, its constructor's
parameters when it has any, and for each name bound in a public
namespace, the base's first and a derived class's binding over it, the
variable's type and access, the accessor's type, access and declaring
class, the method's return type, parameters and declaring class, with
the namespace's URI when it has one and the metadata when asked.
`HIDE_NSURI_METHODS` drops the names in a namespace with a URI that a
base class uses, by the namespace's identity, which in avmplus carries
its API version: so Object's AS3 methods hide under a class, a script's
own AS3 methods show until a class derives from it, and the player keys
the hidden set by URI and version alike. `HIDE_OBJECT` drops Object's
own; the bindings a class gets in its interfaces' namespaces are not
members and do not show; a binding above the caller's API version is
left out, the caller taken to be the latest player's, as avmshell runs
(a SWF's own version is not yet consulted), which hides the builtins'
`[API(CONFIG::VM_INTERNAL)]` members: VM_INTERNAL is the last mark of
the table an ABC was built with, 42 in the AIR 15 SDK's, which the
oracle's playerglobal has, 52 in `core/api-versions.h`, which the
submodule's builtin has, so the compiler reads a builtin ABC's highest
mark, from 42 up, as its internal one. For that the compiler emits what the
runtime needed nothing of before: each method's signature beside its
factory (return type, parameter types, how many are required), the
constructor's in the class descriptor, and a class's and its traits'
metadata whole, name and key-value pairs (the ABC lists all the keys,
then all the values, as avmplus reads them, not the pairs the
specification shows), from which the runtime derives the `[Transient]`
flags AMF and JSON use; a builtin's `Version`, `native` and `API`
metadata stay out, as avmplus leaves them. avmplus iterates its bindings
in a hashtable keyed by interned string addresses, so the order of the
arrays is not one the player can reproduce, and the conformance case
sorts them, as Ruffle's tests do. `getQualifiedClassName` names a number
`int` only within avmplus' 29-bit int atom, and the builtin Vector
classes `Vector.<int>`, `Vector.<uint>`, `Vector.<Number>` and
`Vector.<*>`, as avmplus renames them.

### Corners of avmplus

A few of avmplus' corners the corpus met, each fixed by avmshell's word
(`class-calls`, `enumerability`, `function-prototype`, `proxy`): an
interface cannot be constructed, a VerifyError 1001 naming its
constructor as a method nothing implements; `Object()` makes an object
for nothing, null or undefined and returns its first argument otherwise,
however many; `Vector.<T>(x)` is `x` for a Vector of that class, reads any
other object as an array-like by `length` and index, a ByteArray's bytes
included, and refuses a primitive or null (1034); a Vector's elements are
not enumerable to `propertyIsEnumerable` though `hasOwnProperty` has them
in range; a name set not enumerable stays so when set again but is
enumerable anew once deleted and set; a class's static initializer may
name its own class as a type, which avmplus resolves from traits, so the
runtime keeps the classes being defined by name until their script slot
holds them. `arguments.callee` is the method's own Function object, the
one `newfunction` made where there is one, so `arguments.callee === f`,
else one made for the method once, as avmplus' MethodClosure: the
compiler hands `rt.arguments` the function itself. `flash.utils.Proxy`
is a property hook on its traits (`natives/proxy.ts`), as XML's is, with
the difference that a method the traits bind stays the method where XML
hides the methods of its names behind its children (`hidesMethods`):
every unbound name goes to the `flash_proxy` methods as ProxyObject
sends it, a written name as a QName in its namespace, the empty URI for
a set of several, an index as its string, `in` with the string, and an
unbound call, `hasOwnProperty` or `toString` included, to
`callProperty`; for-in walks `nextNameIndex`, `nextName` and `nextValue`.

### The standard library

avmplus' standard library (`Object`, `Array`, `String`, `Math`, `Date`,
`RegExp`, `JSON`, `Vector`, `ByteArray` and so on) is mostly AS3 compiled
into `builtin.abc`; only its `native` methods are C++. swf2es compiles
`builtin.abc` itself and implements the natives in TypeScript, matched by
class and method name as avmplus matches its C++ ones. The `builtin.abc`
and `shell_toplevel.abc` the runtime, the player and the tests load are
the avmplus submodule's own, `oracle/avmplus/generated/`, built by its
`core/builtin.py` from its sources; the oracle's SDK ships older ones,
of AIR 15's time, without `Array.removeAt` and `insertAt` and their
Vector counterparts (SWF 30's), and its avmshell keeps its own copy
inside the binary, so what avmshell runs is the older library whatever
file is beside it. The two differ in those ten natives alone, and where
the submodule's library is newer than the oracle's avmshell, the oracle
cannot judge; Flash's traces in Ruffle's corpus do. A host gives the
libraries' bytes, and the player compiles them as any ABC, or takes their
modules from a module cache, as the swf2es command writes them with
`--emit-libraries`. builtin.abc's AS3 sources are MPL-2.0, and so are its
compiled modules.

The playerglobal (`flash.*`) the player loads is its own,
`playerglobalLibrary`, compiled from `as3/playerglobal/src` by ASC 1 in
the oracle's image as avmplus compiles its libraries (`tools/playerglobal.ts`,
`pnpm as3:playerglobal`), into `playerglobal/playerglobal-library.ts`. Each
public definition of Flash Player's playerglobal has a file there: Ruffle's
AS3 where both are plain AS3 (MIT OR Apache-2.0, as each file says), else
Flash Player's API with bodies of swf2es's own over the player's natives.
A method native in Flash Player's playerglobal is native in ours, which the
player's TypeScript implements; private natives are declared with the
signatures it binds. `--check` holds the compiled API to Flash Player's
(names, version marks, types, defaults, flags), and a unit test holds the
committed file to its sources; `SWF2ES_PLAYERGLOBAL=adobe` runs the tests on
Flash Player's own instead. No version mark goes past the reference's 41:
a builtin's highest mark from 42 up is the VM's internal one
(`API_FirstInternalMark`), which a higher mark would make public.

### Running ABCs as avmshell does

`swf2es run file.abc [more.abc ...]` (`packages/cli`, `commands/run.ts`)
is avmshell in node: avmshell's libraries, builtin.abc and
shell_toplevel.abc (from `oracle/avmplus/generated/`, or `--lib`), each
compiled by `codegen.wasm` and loaded into one runtime, their scripts run
on first use; then each ABC in the order given, added to the root domain,
compiled and its entry point run, as avmshell runs each file once the one
before has. What they trace and print goes to stdout. An ABC rejected
with a VerifyError, or an exception nothing catches, is printed there as
avmshell prints it (`VerifyError: Error #1107`, `TypeError: Error
#1009`), and ends the run with avmshell's exit status, 1. avmshell's `File`
reads and writes the working directory. A SWF is refused: its code needs
the player's playerglobal, which the command does not depend on. avmshell's
background workers run on node's threads (`threads.ts`, each thread
`shell-thread.ts`): each compiles its libraries and its code, the ABCs
given or those of `createWorkerFromByteArray`, with codegen.wasm's module
posted to it, and writes what it prints to stdout itself. They stop when
the ABCs given end, as avmshell interrupts its workers then.

The command and the tests that run ABCs share one host, `runShell` in
`shell.ts`: one compiler domain for the runtime, each ABC compiled into the
application domain the runtime loads it into, so that an ABC
`Domain.loadBytes` loads compiles against what its domain sees, with the
findings the runtime reports (`RuntimeOptions.compileAbc`). The
conformance runner and the Tamarin runner give it the test build of
codegen (`tests/conformance/abc-compiler.ts`), which `pnpm test:checked`
checks every array access of, a loader that keeps source maps, and for
Tamarin the builtins' modules compiled once for every test. Their
background workers' threads compile with the release build, and post
what they print back to the runner's lines.

## Compiling ahead of time and caching modules

A module need not be compiled in the page: the swf2es command writes it
ahead of time, and a host may keep what the player compiled across page
loads. Both reach the player as a module cache, and both rely on the
player adding and compiling ABCs exactly as the command does.

### Ahead-of-time compilation

`swf2es compile <file.swf|file.abc> --lib builtin.abc --lib
playerglobal.abc [-o dir]` (`packages/cli`, `commands/compile.ts`; a bare
`swf2es <file>` is the same) compiles a SWF's DoABCs, or a bare ABC, as the
player compiles them for a SWF it loads as its main movie, so that each
module is byte for byte the player's (`compileAhead` in `aot.ts`, which
follows `Code` in `packages/player/src/scripting/code.ts` step by step):
the compiler reset with Flash Player's API version; each library added
to the root application domain and compiled before the next is added,
kept or not, since the first answers a compile fixes in the domain are
what later ABCs compile against; then the SWF's ABCs, in tag order, all
added to a child of the root before the first compiles. A change to how
the player adds or compiles a SWF's code is made in both, and
`tests/unit/cli/aot.test.ts` holds them to it: for some of the player's
cases, a SWF of two DoABCs, one lazy, and as3pb's ABC against avmshell's
libraries, the command's modules, the libraries' included, are the
player's, which its own `Code.link` compiles in node.

The libraries are the host's, so `--lib` names them, in load order; the
command does not depend on the player, so it cannot take the player's
playerglobalLibrary itself. With none given, it takes builtin.abc
and playerglobal-swf2es.abc from `tests/player/out/libraries/`, where the
player's tests write them, and
says what to pass when they are not there. The player loads only the
libraries its host gives `loadLibraries`, builtin and playerglobal by
default: a host that also loads one of the player's own, as
`airLibrary`, gets the same modules only from a command given the same
libraries in the same order. A file that ends inside a DoABC is refused.
An AVM1 SWF, whose FileAttributes lacks the ActionScript 3 flag, compiles
to one module of its action blocks, `avm1.js`, and takes no library
(`compileActionsAhead`): the player runs its code as AVM1 and never
compiles its DoABCs.

It writes a module per ABC, `abc-<n>.js` (`lib-<n>.js` for the libraries
with `--emit-libraries`), beside it `abc-<n>.log`, what its compile fixed
in codegen's domain (`compileModuleLogged`), and `manifest.json`, whose
`manifestVersion` is 2: the compiler, by `COMPILER_VERSION` and the
identity stamped into `codegen.wasm` (`Codegen.identity`; version 1 named
it by its file's SHA-256, which is not what keys name); the API version;
the input's kind, SWF version and SHA-256; and for each library and ABC
its name, SHA-256, module and log, the module's key and the module's and
the log's lengths, and for an ABC its lazy flag. An AVM1 SWF's manifest
lists no library nor ABC but an `avm1` entry, added without a new
version since a reader of the others' entries need not know it: its
module, the SHA-256 of the SWF's decompressed bytes, how many blocks it
has, and, from a compiler with an identity, its key (`actionsKey`) and
length. The key is the one the
player's module cache looks the module up by when it loads the input as
its main movie, with the same libraries (see Caching modules): codegen's
`moduleKey`, which both take, so that they cannot drift apart, taken
before the module compiles, as the player takes it before it asks its
cache. A compiler without an identity writes no keys nor logs. Each
module names its ABC's hash and those it was linked against, which the
runtime checks as it loads it.

A host gives the player these modules as a module cache: see [Modules
compiled ahead of time in the player](#modules-compiled-ahead-of-time-in-the-player).
Skipping a compile is not enough: what a compile resolves in codegen's
domain, the first answers to a traits' types or a method's signature, is
what later ABCs, such as a child SWF's loaded into the same domain,
compile against, so the player replays each module's log in place of its
compile. The key names the domain's context, so a module is found only
where its compile would have had that context: the SWF loaded after the same
libraries into a domain that sees nothing else, as the main movie, or by a
`Loader` into `new ApplicationDomain(null)`, a sibling of the main movie's.
Loaded into the main movie's domain or under it, the SWF compiles, as do
the libraries without `--emit-libraries`.

### Caching modules

A host may give `Scripting` a `ModuleCache` (`hosts.ts`), which keeps the
modules the compiler writes across page loads; `player-hosts/indexeddb`
is one in IndexedDB. A module read back is the string `compileModule`
returned, so JIT and AOT output stay one.

Compiling a module is not only its text: it fixes in the compiler's
domain the first answers of what resolves lazily (a traits' types, a
method's signature, an ABC's verified scopes), which see the ABCs there
are when first asked, and which later modules compile against. Were a
module from the cache to skip that, a slot of type A in a child domain,
resolved only after the main domain had gained another A, would resolve
to that one, and a later module calling a method on it would compile to
another dispatch id under the same key. So the cache keeps with each
module what its compile added to the domain's log (`compileModuleLogged`),
the log a rebuild replays (see [Parsing, linking and
verifying](#parsing-linking-and-verifying)), and the player replays it in
place of compiling (`Codegen.replay`): the domain is then as the compile
would have left it, but for the weights `compact` goes by.

A module is keyed by a SHA-256 of all it depends on (codegen's
`moduleKey`, which the swf2es command keys by too): the compiler's
identity, the API version, and its context (`Codegen.context`): every ABC
its application domain sees, by hash and whether it is a library, in load
order, those added after it included (a SWF's DoABCs are all added before
any compiles, so the first may extend a class of the last), its own place
among them, and the domain's log about them in order, each entry with how
many of them there were when it happened: the lazy answers fixed so far
and what the domain and its ancestors were told they found. ABCs are named
by their place among those it sees, so the same ABCs loaded at other
indices, beside other domains, key alike. The compiler's identity is a
hash of codegen.wasm's bytes, which its build stamps into the binary as a
custom section (`packages/codegen/stamp.ts`) and `createCodegen` reads as
`Codegen.identity`, not the host's word nor `COMPILER_VERSION`, which
moves only by hand; a compiler without the section uses no cache. The
log's entries made while only the libraries were added, some hundred
thousand characters, are the same in every later module's context, so
the key names them by a digest taken once per compiler epoch
(`Code.digestLibraries`), and the context written for each module leaves
them out: keyed whole, and taken twice a module, they cost 4.5 ms a
module, hit or miss.

`Code.link` adds a SWF's ABCs, then, with a cache, makes each module ready
in order, reading it and replaying its log or compiling it, then
evaluates and loads them all into the runtime at once, as without a
cache, whose path is unchanged and awaits nothing more. A read lets other
loads come between, so where `Codegen.revision` says the compiler's
domain changed meanwhile the key is taken again, and read again if it
changed, a few times at most. The player links one SWF at a time
(`Loads.preparing`), and one linked into a domain that a module's sees,
between that module's adding and its loading, the runtime refuses with or
without a cache (its linked check), so this guards against what does not
happen yet. An ABC smaller than `MIN_CACHED_ABC`, 8 KB, is compiled and
the cache not asked: its key, read and replay would cost about what its
compile does (see the constant). A cache may ask for smaller ones with
its `minBytes`, as one of modules compiled ahead of time does for every
one.

Anything the cache does wrong is a miss: an error; an answer that is not
a module and a log of the lengths stored with them, as a write cut short
at a line's end would be a shorter log that replays; a log that fails
part way, which would be a bug and leaves the domain as no compile would,
so the module is compiled and the entry deleted, not stored; a module
that does not evaluate (a truncated write) or that the runtime refuses
before loading anything of it (its linked ABCs differ), which is compiled,
the domain already replayed, and its entry deleted: the SWF's later
modules were readied since, so the key it would be stored under is not
the one this compile has. One that loaded part of itself and then threw
cannot be compiled in its place: its entry is deleted, and the load fails.

The IndexedDB cache keeps each module's size and last use in a store of
their own, so that eviction, of the least recently used once the modules
pass `maxBytes` (256 MiB by default, counted as UTF-16), reads no module.
It writes a module once the page is idle: a write that a load's next read
waited behind took that read from 4 to 45 ms. A get that cannot mark its
module used still returns it. A later version opened in another tab
closes its connection, and the next call opens it again; `close` lets a
host do the same. A database that did not open within `openTimeout`, or
failed to, is done without for `retryAfter` (30 s), then tried again.

Measured in headless Chrome on a large real-world SWF (one ABC of 1.2 MB,
a module of 8.17 million characters), medians of seven runs, to its first
frame drawn: a cold load took 810 ms, of which codegen 254 ms for the
SWF's module and 76 for the libraries', `new Function` 59 and the
module's first run 120. Read back from IndexedDB, the 8 MB module took
20–45 ms, and replaying its log 56 ms, most of it verifying the ABC again,
which its log asks for since verifying finds closures' scopes. With the
cache, a load after a browser restart took 654 ms rather than 785, and a
reload in the same renderer 283 rather than 511; the first load, which
compiles and stores, took 886. A module read back took V8 some 30 ms
longer to evaluate than one just compiled (`new Function` and the
module's first run, 199 ms against 169 after a restart), not looked into
yet. V8 kept no code for the cached source across a restart, as it keeps
none for `new Function`; a classic script from a cacheable URL, which it
does keep code for, saved a further 130 ms there, but no URL is stable
for a module from IndexedDB, and a Blob URL's script took longer than
`new Function`.

### Modules compiled ahead of time in the player

The swf2es command's modules reach the player as a cache too:
`precompiledModules(manifestUrl)` (`player-hosts/precompiled`) reads the
command's `manifest.json` at its first get and answers a key it names
with the module and the log beside it, read by the host's `read` or
fetched; `put` does nothing, `delete` has it answer that key no more on
this page, as it cannot delete its files, and its `minBytes` is 0, so that
no module of a SWF compiled ahead of time compiles. The command keys each
module with the player's own `moduleKey`, so a key the manifest lacks,
another compiler's (keys name its identity), a SWF in another context
or after other libraries, a manifest of another version or none, is a
miss, and the player compiles; and what the player does with a bad entry
of any cache holds for these, a missing or truncated file a miss, a
module that fails to load compiled in its place. Each file is read by a
URL of its key (`abc-0.js?<key>`), so that an HTTP cache never pairs a
manifest with another build's module or log of the same name, which
matters most for an imported module, whose length is not checked. The
manifest is to be served `no-cache`: a stale one names the old keys, and
`?<oldkey>` would fetch the new build's file under them. A CDN that drops
the query from its cache key loses this protection.
`chainCaches(aot, indexedDb)` asks its caches in order, the first that
holds a module answering, gives a compiled module to each, and passes
over one that fails: the modules compiled ahead of time first, then those
the page compiled before, then a compile. An entry the player cannot use,
not whole or not importing, it deletes, naming the entry, and asks for
once more; the chain gives that deletion only to the member that gave
that entry, tracked by the entry, not the key, as two reads of one key
may overlap, and that member answers the key no more, so that a bad
precompiled module falls through to the one the IndexedDB cache kept
after the first load compiled it, rather than compiling on every load. A replay or a
load that fails is past asking again, the domain already changed. Its
`minBytes` is its smallest member's, so every member is asked for the
ABCs that one asks for.

A cache's entry may give a `url` to import the module from in place of
its text: with `importModules`, `precompiledModules` gives each module's
URL beside the manifest and reads only its log. A module is one exported
function and nothing else (`export default function (rt) { ... }`), so
the very file the command wrote, the one the byte-for-byte checks compare,
is an ES module as it is: no wrapper is needed, and an ES module is
strict, as the `Function` the player builds says it is. The player
imports it before it replays the log, so an import that fails is a miss
and a compile, and uses its URL, as the frames of its code name it, for
`Runtime.codeDomain` and `codeUrl` in place of a sourceURL of its own.
What a document imports it keeps for as long as it lives, unlike a
`Function`'s code, which goes with the SWF, so this suits the main movie's
modules, which the page keeps anyway. A document has one module per URL,
and the runtime tells modules' domains apart by the URL their frames
name, so a player that imports a URL again, as a SWF loaded twice into
sibling domains, both keyed as the main movie, imports it with a
fragment of its own (`#swf2es-<n>`), which the engine takes for another
module and its frames name. Each such import is a module the page keeps,
so a SWF that loads the same precompiled child again and again into
`new ApplicationDomain(null)` grows the page's memory with each load.

Measured in headless Chrome on the SWF above, each run a new browser on
one profile, so that IndexedDB and the HTTP cache persist and V8's code
cache with it, medians of nine, interleaved, to its first frame drawn,
from fetching the SWF, with codegen.wasm and the libraries: compiled, 772
ms (the libraries 129, the SWF 603); from IndexedDB, 613 (85, 483); from
the command's modules evaluated, 553 (77, 435), and imported, 552 (76,
434), the files served cacheable. What is left of the SWF's part no
cache saves: its log's replay, its module's evaluation and first run,
and its first frame. Imported, the modules gained
nothing from V8's code cache, unlike the classic script above, and lost
nothing to it: a page that may evaluate takes them either way.

### Pages without 'unsafe-eval'

A page whose Content-Security-Policy has no `'unsafe-eval'` refuses
`new Function`, so the player can run there only modules it imports:
those compiled ahead of time, given by `precompiledModules` with
`importModules`, the libraries' among them (`--emit-libraries`), from the
page's origin or another its `script-src` allows, which must also answer
with CORS headers, as a module script from another origin is fetched
with CORS. Codegen still runs:
the player adds each ABC to it, keys each module by its context and
replays each log there, so that the domain is as compiling would have
left it, which no host can skip, and `codegen.wasm`, like `@swf2es/native/compress`'s
module, which decompresses the SWF, needs
`'wasm-unsafe-eval'` to be compiled. A policy for such a page is
`script-src 'self' 'wasm-unsafe-eval'`, without `'unsafe-eval'`. Any
module the cache lacks is compiled and its evaluation refused
(`EvalError`), the load failing: a child SWF loaded into a context the
command did not compile for, or a module of another compiler's.

Pixi too builds code with `new Function` unless its `pixi.js/unsafe-eval`
is imported, which a host drawing on such a page
imports with Pixi (`tests/player/precompiled.ts`, whose page imports the
bundle's `packages/unsafe-eval.mjs`, which patches the classes the player
draws with, plays a SWF so under that policy and draws it as without one).

## The player

The player keeps Flash's display list and timeline
(`packages/player/src`: `display/timeline.ts` reads a SWF's definitions and
frames, `display/display.ts` gathers the display list, whose kinds of
display object each have a module of their own: `displayobject.ts`,
`container.ts`, `movieclip.ts`, `buttonobject.ts`, `shapeobject.ts`,
`textobjects.ts`, `bitmapobject.ts`, `videoobject.ts`, with `walk.ts` for
the frame's walks and `instantiate.ts` for what a character makes), and
PixiJS only mirrors it
(`render/view.ts`): a container per display object, kept from frame to frame
and updated where the display object marks itself changed.

### Source layout

`packages/player/src` is grouped by what each part of the player does,
and the player's paths in this document are relative to it:

- `index.ts` is the package's default entry point; the separate experimental
  `@swf2es/player/context3d` entry installs Stage3D natives only when requested.
  `workers/thread.ts` is the entry a background worker imports
  (`@swf2es/player/worker`, with the primordial's messages in `workers/protocol.ts`);
  `player.ts` runs a SWF,
  `scripting.ts` connects it to the runtime and the compiler, with its
  parts in `scripting/`: `code.ts` compiles and links the SWFs' code
  into their application domains and tells whose code runs, `sha256.ts`
  names the ABCs it compiles, `events.ts` dispatches events to AS3
  listeners, `lifecycle.ts` tells display objects they were added or
  removed and keeps the orphans, `loads.ts` takes what Loaders and
  URLStreams ask for through the host and gives it to a frame,
  `symbols.ts` keeps what SymbolClass
  bound classes to, the fonts registered and the sounds' shared decodes,
  `timers.ts` keeps the clock and the timers that fire by it,
  `clipboard.ts` what the clipboard holds and when scripts may touch it,
  `workers.ts` the workers as one VM sees them, `handover.ts` the
  modules the primordial hands them (see [Workers](#workers)).
  `hosts.ts`
  holds what a host may supply in place of the browser (navigation,
  shared objects' storage, the platform Capabilities reports, the
  clipboard's writes) with the browser's defaults, and the interfaces of what only a host supplies
  (ExternalInterface's page, a renderer's draws, fetches, sockets, the
  threads workers run on).
- `display/`: the display list and the timeline, and what they are made
  of: shapes, morphs, drawings and what they read back as, bounds and hit
  tests, 9-slice scaling, geometry, 3D matrices, colour transforms,
  gradients' ramps, and filters as records of their values.
- `text/`: text fields' model and layout, static text, fonts and CSS.
- `bitmap/`: the pixel store and its operations on the CPU, bitmap
  filters, decoded images and PNG encoding.
- `media/`: sound: decoding and the host's device (`audio.ts`), MP3
  frames' headers (`mp3.ts`), what `Sound.extract` reads (`extract.ts`),
  and the sounds the player plays, the timeline's and scripts' channels
  (`sounds.ts`).
- `input/`: the pointer and the keyboard.
- `render/`: the PixiJS view (`view.ts`, the walk that keeps each
  object's node, `node.ts`, in step) and what only it uses: what an
  object itself draws (`art.ts`), how it is blended (`compositing.ts`),
  3D objects' planes (`planes.ts`), released nodes kept for reuse
  (`spares.ts`), BitmapData.draw's sampling (`snapshot.ts`), the pointer
  on the canvas (`pointer.ts`), shapes'
  fills tessellated (`tessellate.ts`) and lines stroked (`strokes.ts`)
  into shared contexts, where the player plugs into the Pixi fork's
  extension points (`hooks.ts`), render groups settling (`settle.ts`),
  the Graphics that draws a shared context (`shared.ts`), what the view
  and Pixi pool and how much (`pools.ts`),
  text drawn (`text.ts`), bitmaps' and gradients' textures
  (`bitmaps.ts`), drawTriangles' textured triangles (`triangles.ts`), batchers kept for new groups (`batchers.ts`), the
  transform table, colour transforms, blend modes, filters and resolves
  on the GPU.
- `playerglobal/`: the `flash.*` classes, a path per package and class,
  and the AIR classes the player declares itself (`air/`, see
  [AIR's WebSocket](#airs-websocket)).

`playerglobal/` holds AS3's bindings only, and depends one way: its
natives and hooks import the rest of the player, and the rest imports
playerglobal once, where `scripting.ts` registers `playerNatives` and
`playerHooks` from `playerglobal/index.ts` with the runtime. What the
player needs for itself, though a `flash.*` class shows it to scripts,
lives outside it: event dispatch, the host interfaces, the timeline's
sounds and the channels' state, a display object's root.
`tests/unit/boundaries.test.ts` rejects any other import of it.

`Scripting` (`scripting.ts`) is the runtime with playerglobal registered,
the display object its `create` hook takes, and the frame: its events,
frame scripts, gotos' cycles and the construction of what timelines
placed. What else scripts need that keeps state of its own is a part it
holds, a class in `scripting/` given the `Scripting` for what they
share: `code`, `symbols`, `lifecycle`, `loads`, `timers` and `workers`. The natives
and the player reach a part through it, as `s.loads.requestLoad`; the
host's own calls, `loadLibraries` and `settled`, stay on `Scripting`.

The unit tests mirror this tree: `tests/unit/player/<path>.test.ts` tests
`<path>.ts`, a playerglobal class's under
`playerglobal/flash/<package>/<Class>.test.ts`. `tests/unit/mirror.test.ts`
rejects a test that mirrors no source, but for the few that cut across
modules, which it lists with their reasons.

### Scripts and the display list

An AS3 SWF's display objects are AS3 objects: a timeline child whose
symbol has a class (`SymbolClass`) is an instance of that class, the root
is one of the document class, and `new Sprite()` in a script is on the
display list once added. The player keeps one object with two faces, as
Ruffle and AwayFL do: the runtime allocates every instance of
`flash.display::DisplayObject` and its subclasses through a `create` hook
on that class (hooks' allocation is inherited through `Traits.create`),
which attaches a player `DisplayObject` as `$display`, and the player's
object points back with `object`. The natives of the display classes
(`packages/player/src/playerglobal/flash/display/...`) read and write
`$display`. They are written as a class of getters, setters and methods,
whose members `registerNativeClass` (the runtime's `natives/define.ts`,
beside `plain`) registers under the names the compiler binds, `Class#get:x`, `Class#set:x`,
`Class#method` and `Class.method` for a static, each through `plain()`,
so it runs with the AS3 object as `this`; the class is only how they are
written, and a private native is registered by name beside it. The class
lives in the factory that makes the natives, so it closes over its
`Scripting`; an AVM1 movie's children, and a timeline child without a
class, have `object === null`, and nothing in `display/display.ts` or `render/view.ts`
depends on which VM drives them.

Construction follows Flash's order, which playerglobal's own constructors
fix: `Sprite()` calls its private native `constructChildren()` after
`constructsuper`, so a symbol's first frame's children's classes are
constructed before the subclass's constructor body runs and can reach
them by name. The player constructs a timeline child whose symbol has a
class by making its player object, placing its first frame's children,
setting it as the one pending, and calling `rt.construct(cls)`: the
`create` hook takes the pending object instead of making one, and
`constructChildren` makes the placed children alive, so the constructor
finds them in `numChildren` before `super()` and constructed after it, as
the main and a loaded root do too (`instantiation_on_enter_frame`). A `new
Sprite()` from a script finds nothing pending, gets a fresh player object,
and places its first frame in `constructChildren`. Only a MovieClip plays
its timeline: the `create` hook stops a symbol of more than one frame whose
class extends Sprite but not MovieClip, the root's included, on its first
frame, as Flash does, where fl.controls' components keep their skins on a
second frame (the `sprite-frames` case). A frame played on
places its new children at once, but makes their AS3 objects only after
`ENTER_FRAME`, in a construct phase before `frameConstructed`: until then
a script counts them in `numChildren` and `getChildAt` gives null. Their
classes are ready as the frame plays, their scripts run, and one taken off
before the phase is never made (`delayed_symbolclass`). A goto makes what
it places at once. `EventDispatcher()` calls its private native
`ctor`, and `InteractiveObject()` calls `addEventListener`, so event
dispatch is part of the first slice: listeners by type and phase on the
player object, `dispatchEvent` through the player's parent chain
(`scripting/events.ts`), and the frame events the player broadcasts.
The player makes its events of an object put on the list or taken off
only where a listener on the object or above it would hear them: where
none does, no script runs, and none could tell. An event keeps its
fields in AS3, Event's and its subclasses' private variables, which
compiled code reads as slots: dispatch writes the target, current target
and phase into Event's and reads its flags there, by the slots
`eventFields` finds once (under Flash Player's playerglobal, the fields
its natives keep). An EventDispatcher made with a target dispatches as
that target, along its parent chain, its own listeners seeing the target
as the current one (`event-fields`).

A display object nobody named is named as its AS3 object is made,
`instance` and the next of one count for the player, which every SWF it
loads shares: a timeline child the SWF names takes none, nor does the
main SWF's root, `root1`, and the stage has no name (`instance-names`).
Only a name from the SWF gives its parent a property of it.

### The frame

A frame runs in the order Flash runs one, which the Flash oracle fixed
case by case: the timelines advanced, which places children and
constructs their classes as it goes; `ENTER_FRAME`; `FRAME_CONSTRUCTED`;
the frame scripts `addFrameScript` registered, once for each frame a clip
enters and again for what a script's goto changes; `EXIT_FRAME`; `RENDER`
when a script invalidated the stage; then the frame is drawn. The first
frame, after the document class is constructed, has no `ENTER_FRAME`
(`events`). The frame events are broadcasts: each display object that
listens hears its own, on the display list or not, in the order the
objects first listened, with no capture or bubble phase. And `SymbolClass`
binds its classes after an eager `DoABC` has run its initializer, so an
instance that initializer makes of a bound class has no timeline children,
and one the constructor makes has (`init`). A goto a frame script asks for
waits until the script returns: `currentFrame` and the children read as
before it through the rest of the script, then the jump happens and the
frame it lands on has its script run in the same phase (`gotos`), before
the script of any child the jump placed, which is constructed with its
parent already on the landing frame (`gotoChild`); a goto from anywhere
else happens at once. All the timelines advance before any frame script
runs, parents' scripts before their children's (`nested`); the clips
whose scripts are to run are fixed as the phase begins, so one a script
removes still runs its own (`loads`, `orphans`).

A frame walks the whole display list once to find the clips that
advance, and once for each round of frame scripts, which a busy scene of
some 13,000 objects felt. A walk reads each object's `frameChildren`, a
container's own children array, a button's states, one empty list for
the rest, and its `kind`, not its class, and calls into no object with
nothing under it. Each container keeps the list of clips and buttons at
and under it in that order (`walkList`), with where each clip's own end,
for one that sits a frame out with all it holds; a clip or container that
comes, goes or moves under it drops the lists from its parent up, and the
next walk makes them again, copying those still kept below (a list of
fewer than 32 is not kept, but walked again within its parent's). A
shape or text swapped, as a timeline swaps them on every frame, drops
none. So a frame visits the clips alone, not every container: in
`walk-bench.ts`'s 13,000 objects a tick went from 284 to 117 µs and a
round of scripts from 122 to 44, for some 25 bytes an object. A
button's states, which it changes without its parent knowing, are walked
as they are. Another round runs only when the last ran a script and
something a round reads changed since it walked, which `scriptWork`
counts: a clip's frame, its frame scripts, `makingChildren` or
`timelineChild`, a children list or a button's states, an object made
alive, the orphans, what scripts made and the scripts' phase. A round
leaves each clip it lists on a frame whose script ran, or held back as it
would be again, so with none of those changed another finds nothing; a
frame whose scripts only stop their clips or set properties takes one. The
checked build's tests (`pnpm test:checked`) run each round left out
anyway and fail if it finds anything to do.

In a SWF of version 9 or earlier, a clip a script sends to a frame, by a
goto from its frame script, its listener or another clip's, sits the next
frame out with everything in it: none of them advances, and from the
frame after they go on as before (`goto-children`, recorded as version
9). A goto to the frame it is on counts, so one sent there at every
`ENTER_FRAME` stands still with all in it; a clip off the display list
sits its next frame out there and no later one; and a kid sent to a frame
in the frame its parent was sits out the parent's frame only, not one
more. The player keeps the frame count of the goto on the clip, not a
flag. From version 10 a goto leaves the frames that follow as they were.
The version is the clip's own SWF's, which the case does not try across
a loaded SWF.

From version 10 a goto, once it happens, runs a frame of its own: what it
placed is made alive, and anything frames placed that is still waiting to
be, then `FRAME_CONSTRUCTED` is broadcast, the frame scripts due anywhere
on the display list run, the goto's new frame's among them, and
`EXIT_FRAME` is broadcast, all before the goto returns to a listener that
asked for it, or before the frame script that asked for it is left behind
(`goto-cycle`, `goto-cycle-nested`). A goto in one of those scripts runs
its own inside, and the frame's own phases then find the scripts already
run. A script's goto on itself waits for it even while another clip's
cycle runs inside it. Two scripts that send their clip to each other's
frame nest cycles without end; Flash gives up some 1400 deep, and the
player throws AS3's stack overflow, #1023, at 256, after which no goto
cycle runs for the rest of the frame, so scripts that catch it cannot
start it over. A frame script that asks for a goto and then throws still
has its goto, and the scripts after it still run, as adl has it. What a
goto's cycle runs throws no error into the goto's caller: an error a
script, listener or constructor in the cycle throws is reported as
uncaught, and the cycle and its caller go on, as in Flash and Ruffle.
The goto itself still throws to its caller its own errors: the stack
overflow, #1023, and an unknown scene or label, #2108 and #2109.

A button made in a SWF after version 9 whose up state has a clip runs
such a frame too, once its states are made and its parent has its named
property, before its own constructor: the frame scripts due on the
display list, the orphans' and those of what scripts made, its states'
among them. A clip whose `super()` is making that button has its first
frame's script run there if it registered it before `super()`; else it
keeps it for later when a timeline placed it, by a frame or a frame
script's goto, or a script made it with `new` outside the frame's own
frame scripts, and one a frame script made loses it, as adl shows
(`button-frame-order`, Ruffle's `frame_script_button_order`). Before its
`FRAME_CONSTRUCTED`, that frame makes alive what is placed and not yet
alive, as a frame's construct phase does: so a goto places every child
of the frame it lands on before it makes any alive, and a button among
them makes the rest alive in its early frame, ahead of the clip whose
constructor is making it, as adl shows (`goto-place-first`). A parent's
`FRAME_CONSTRUCTED` listener then finds them all: Flash's own component
parameters are set from one, once for each frame, and a clip made after
it kept none.

A goto plays or stops its clip as it happens, before the frame it lands
on has its script run, so a `stop()` or `play()` there has the last word:
a clip whose every frame stops stays where `gotoAndPlay` from another
clip's script or a listener sends it. A goto a frame script asks for of
its own clip plays or stops it only once the script has returned, over a
`play()` or `stop()` the script calls after it; `nextFrame` and
`prevFrame` past either end stop the clip where it is (`goto-stops`).
`isPlaying` is Flash's own flag apart from the playhead, false for a clip
no script has played, and true still after a deferred `gotoAndStop` or
a `nextFrame` past the end, as adl shows; the player reads the playhead.

A root's scenes and labels come from its DefineSceneAndFrameLabelData;
a timeline without one, or whose data names no scene, a sprite's always,
is one scene named "" whose labels are its FrameLabel tags (`scenes`,
`frame-labels`). The first scene starts at frame 1 whatever its data says,
and a goto finds the FrameLabel tags' labels where the data lists none,
though scripts read none there (the corpus's `movieclip_currentlabels_dupes2`
and `movieclip_goto_scene_last_frame_label`). To a script,
`currentFrame` counts from its scene's first frame, while `totalFrames`
is the whole timeline's. `currentScene.labels`, which `currentLabels`
reads, are the scene's labels counted from its first frame;
`currentLabel` is the last label at or before the frame in any scene;
and `currentFrameLabel` reads FrameLabel tags alone, scene data or not.
`scenes` and `currentScene` make new objects at each read. A goto's
frame number counts from the scene it names, or the clip's, and a label
is found in that scene only: an unknown scene throws #2108, and an
unknown label #2109 where the timeline has named scenes, while in an
unnamed one it is the number 0, frame 1. `prevScene` and `nextScene` go
to the first frame of the scene before or after, or of their own past
either end, and play.

### Errors nothing caught

An error nothing caught is reported, and what was running goes on, as
adl shows. A listener's error never reaches the dispatcher: the
listeners after it still run, and a script's `dispatchEvent` returns as
if none had thrown, whoever dispatched, the player (frame events, a
Timer's, a Loader's, a Socket's, the pointer's and the keyboard's) or a
script. So does the error of a frame script, of a Timer's own tick, of
a load's delivery, of a constructor the timeline or a goto runs, and of
a document class's constructor: the scripts, loads and children after
it still come. The main SWF's root plays on as far as its constructor
got, its first frame's script and its listeners kept, as adl shows; a
load whose document class throws has no INIT or COMPLETE. A host that
passes `onUncaught` to Scripting gets each error as it happens, those
between frames, in a pointer, keyboard or ExternalInterface handler,
included, and `Player.start` and `Player.advance` then throw none; an
error the hook itself throws is kept and thrown as the frame ends. Without it, the frame throws them
once it has run to its end: one alone, or several as an
AggregateError, the one that stopped the frame early, if any, first;
those between frames come with the next frame's. An ExternalInterface
callback's own error goes back to the page that called it. A child its
parent's first frame places is made in the parent's `super()`, and its
error still reaches the parent's constructor.

An AS3 error keeps the JavaScript stack it was made on, out of AS3's
sight (the release player's `getStackTrace` gives null), for a host to
say where an error nothing caught came from: `Runtime.stackOf` gives its
lines from the first compiled method's, whose names begin with `$`.

### A timeline's places over a child

A `PlaceObject` with the move flag that names another character at an
occupied depth makes no new object in Flash: the child stays, the same
AS3 object with its matrix, sign and angle, and only a `Shape`,
`MorphShape` or `StaticText` no script has touched takes the new
character's graphic: a `Shape` or `MorphShape` a shape's or a morph's,
either kind for either, and a `StaticText` a text's glyphs
(`static-text-replace`). Flash also gives a `Shape` a text's glyphs and a
`StaticText` a shape's fills, which the player does not. A clip, a
touched object, and a `Shape` a sprite is placed over all stay as they
were. What touches, by the `replaces` case's 26 depths: the transform
properties (`x = x` counts), `alpha`, `filters`, `blendMode`,
`scrollRect`, `opaqueBackground` and `scale9Grid`, each set to what it
was, and the `transform` setters; what does not: `visible`, `mask` and
`cacheAsBitmap`, whatever they are set to (`scripted-touch`), `metaData`,
`accessibilityProperties`, and `name`, which Flash refuses for a
timeline-placed object with error #2078. The player keeps a `scripted`
flag on the display object for that.

A `Shape` Flash caches as a bitmap (by `cacheAsBitmap`, PlaceObject3's
flag, or filters, for each of which Flash reads `cacheAsBitmap` true)
takes the new shape all the same, but Flash goes on drawing the bitmap it
cached of the old one while the two have the same bounds; with other
bounds it draws the new one (`cache-replace`, `scripted-touch`). The
cache goes stale for good, and the new shape shows, once the object's
scale, turn or skew, its colour or its filters change, or its parent's
scale, or once a frame is drawn with the cache off; a move, by a script
or the timeline, keeps it, as reads of its width do. A mask clips by the
shape it is, not the one its cache shows. The player keeps the shape it
showed, with the matrix and colour it was cached at (`StaleCache`), and
draws it until one of those changes. A `StaticText` draws its new glyphs
cached or not. A clip that loops back over a replaced, cached child is
not covered: adl makes the child anew there yet draws the replacement.

A goto forward does the same, whatever the frames between named at the depth;
a rewind keeps a child placed before the target only if the character
the frames finally name is its own, and makes a new one for another
(Ruffle's `place_object_replace_2`: the same object through two forward
jumps, a new one on the rewind that ends on the other shape). A `PlaceObject`
without the move flag at a depth already taken is let be, whatever it
names, playing or in a goto's replay (`same-depth`, the corpus's
`place_object_same_depth_frame`), and one with the move flag that names a
character where nothing is places nothing (`rewind-first`). A rewind, the loop to the first frame
among them, takes off what the timeline placed after the target, but for
a child at a depth the frames replayed end on a place without the move
flag at, with the child's ratio: that child stays, a clip its character
too, and takes the place, its transform given anew as for a first
placing, and the moves after it; an untouched `Shape` or `MorphShape`
takes the place's shape or morph there, as a move's would (`morph-shapes`,
where the loop puts a morph back over a shape placed later)
(`same-depth`, `rewind-first`); what comes before that place at the
depth, a removal among it, does not matter. The ratio decides, not the
character: authoring tools give each placement a ratio of its own, and
adl shows a rewind take a child whose ratio is not the one the frames
replayed give for another object, whenever it was placed. A later clip of
another ratio, and a clip, shape, morph or text field the first frame
placed that a move after the target gave another ratio, are made anew;
a later child of the same ratio stays (`rewind-ratio`, `rewind-kinds`;
Ruffle's `survives_rewind` compares the ratio only for children placed
after the target, and for morphs, and takes a place with no ratio for a
match where Flash takes it for 0). A clip's own loop makes the
children it places anew alive in the frame's construct phase, after
ENTER_FRAME, as playing on to a frame does; what it takes off is gone by
ENTER_FRAME (`loop-ratio`). Flash's matrix is
exact at the quarter turns, 0 and not the doubles' cosine of 90°, so the
player's is.

A child a script has transformed takes nothing more from the timeline's
places that a script could set: no matrix, colour transform, ratio,
visibility, blend mode or filters, from a move or from the place a
rewind or the loop takes it back to, which leaves what the script set
(`scripted-moves`). Flash keeps this per object, not per property:
setting `x`, even to what it was, keeps the colour transform the moves
give from it too. What touches is the transform properties, `alpha`,
`filters`, `blendMode`, `scrollRect`, `opaqueBackground`, `scale9Grid`
and the `transform` setters, each set to what it was or not, a text
field's `width` and `height` too, which size its field rather than scale
it; a `filters` list refused with #2005 is none; `visible`, `mask` and
`cacheAsBitmap` are no touch here either. The player keeps a `transformed`
flag for this, which every touch sets with `scripted`. A MorphShape a script moved
stays at its ratio. Ruffle's `transformed_by_script` does the same, set
by fewer setters: not by `blendMode`, `filters`, `scrollRect`,
`opaqueBackground` or `scale9Grid`. In adl the 3D setters touch as well,
`z`, `rotationX`, `rotationY`, `rotationZ`, `scaleZ` and
`transform.matrix3D`, and so they do in the player.

### Orphans

A clip a script takes off the display list plays on in Flash, an
orphan, and so does one a script makes with `new` and never adds: its
timeline advances and its frame scripts run each frame, with `parent`
and `stage` null, until it is put back, where it carries on from the
frame it reached, or until it is collected (the `orphans` case; Ruffle
keeps them by weak reference, and so does the player
(`scripting/lifecycle.ts`), with `WeakRef`, so
an orphan nothing refers to stops as Flash's does, and a test that wants
one to play on holds it). What refers to it includes the frame events it
listens for: an `ENTER_FRAME` listener keeps a clip alive in Flash, the
well-known leak, and the player's broadcast sets hold their listeners as
strongly. Flash frees an orphan nothing refers to almost at once, by
reference counting, where the browser's collector may wait minutes, and
a game's removed characters would play on by the thousand; so an orphan
plays for 120 frames at most, then stops on a frame whose script has
run, its timeline sounds stopped, and carries on from there if a script
puts it back. The player cannot see what a script holds, so one held
stops too, where Flash's plays on; one whose subtree listens for a
frame's events plays on, as those hold it in Flash as well. A clip a script makes with `new`, added or not, runs its first
frame's script at the end of that frame's script phase, after the
display list's, in the order made, and sits out the next frame's
advance: made in frame 1, it is on its frame 1 through frame 2 and on
frame 2 in frame 3. The order Flash runs the orphans' scripts in, among
themselves and against the display list's, shifts with the case's layout
(three recordings gave three orders), so the player has an order of its
own, the orphans before the display list, the most recently created clip
first, each subtree in tree order, and the case reports what the clips
logged rather than tracing from them.
The timeline's removal is different: the clip advances and runs the
script of the frame that removed it and then stops for good; and the
property the parent had under the clip's instance name is set to null,
where a script's `removeChild` leaves it. `unloadAndStop` stops a
`Loader`'s content before letting it go, so it does not become an orphan;
`unload` lets it play on, as Flash does.

### A SWF's code

The player loads a SWF's code through `@swf2es/codegen`'s `Codegen`: each
`DoABC`, in tag order, is added to one domain after the builtins and
playerglobal's declarations, all of a SWF's before any of them compiles,
since avmplus has a frame's ABCs loaded before it verifies a method, so a
class in the first tag may extend or name one in the last (the corpus's
`property_priority`, five tags by mxmlc); each is then compiled whole,
by its index in the domain, unless a module cache has it (see [Caching
modules](#caching-modules)), loaded, and run
unless the tag's lazy flag defers it to its first use, as Flash defers it.
`SymbolClass` then binds character ids to classes by qualified name
through the runtime's name resolution; id 0 is the document class,
constructed on the root clip before the first frame.

A module is loaded as the factory a strict `Function` returns, not
imported: a document keeps every module it imports while it lives, so the
code of SWFs long unloaded stayed (some 4.5 MB a player made again, its
libraries' code and all), where a function's code goes once nothing
refers to it. JavaScriptCore's frames name no script for a
`Function`'s code, whatever its `sourceURL`, so there, as a `Function`
made once tells (`scripting/evaluate.ts`), a SWF's module is evaluated
in a document as a classic script from a Blob URL of its own, which its
frames name and whose code goes with the SWF as a `Function`'s does,
and by a `Function` once a script does not run where a `Function`
does: refused by a Content-Security-Policy without `blob:` in
`script-src` or by Trusted Types, not loaded within 5 s, or loaded but
not run, as by a DOM that runs no scripts. Until one has run, the
modules' scripts go one at a time, so that such a policy reports one
refusal, not one a module. A module whose script did not run is
evaluated by a `Function` all the same, which throws its source's error
where it has one. Without a script, as in a Worker, which has no
document, or under such a policy, JavaScriptCore's frames tell no SWF's
code from the host's, and every SWF's code is the main SWF's to
`Runtime.codeDomain`: its domain for `currentDomain`, a load's default
domain and the rest. The scripts load asynchronously, so a SWF's modules
are all evaluated before any loads into the runtime; where none waits,
the link goes on in the same turn. Measured in WebKitGTK's MiniBrowser, loading
and unloading children as `tests/player/leak.ts` does, the heap after a
collection grew 8.4 KB a load over 290 loads; with a `Function` each,
every child's code taken for the host's made each load's default domain
a child of the last, a chain kept whole, 145 to 234 KB a load. A script
took some 0.2 ms longer to evaluate than a `Function` for a module of
110 KB.

What the player keeps of a loaded SWF beside the SWF itself, the domain and origin of each module's script for the stack,
its symbols and its fonts for those registered later, it keeps
weakly, so that the SWF, its code included, goes with its last object
(some 300 KB a load of a small SWF stayed otherwise). Once a runtime
domain is collected, which its descendants' keep from happening while
they live, the compiler drops its application domain (see [Parsing, linking and verifying](#parsing-linking-and-verifying)), and
`Code` its ABCs' hashes and the findings it told the compiler. A
collection may come hundreds of loads later, so `Code` evicts a loaded
SWF's domain from the compiler as soon as its ABCs are compiled, unless
a link is in progress in it or under it, and keeps their bytes to revive
it, with its evicted ancestors, when a SWF is loaded into it or under it;
a domain revived stays, as one loaded into again, and the root's and the
main SWF's are never evicted. After a drop or an eviction it asks the
compiler to compact when the page is next idle (`requestIdleCallback`,
else a timer), not in a load's frame. The compiler's memory then holds
the live domains' ABCs, not every ABC loaded since the last collection.
Over 8000 loads of a large application's small SWFs, none collected,
its memory stayed at the 128 MB compiling the main SWF had grown it to,
with no rebuild for the first 1600 loads and eleven in all, some 75 ms
each in node; without them it grew to 256 MB some 3000 loads on, and
to 512 MB by 8000. Each module is given only the hashes of the ABCs it
names as linked (`domainLinked`): joining every ABC's for each compile
had grown it to 256 MB by 7500 loads on its own.

That a module's code keeps its Abc has a limit: emitted code reaches `A`
only for `newclass` and `newactivation`, so a module with neither keeps
it only through its domain's globals, its scripts' entries, and not even
those if every name it defines was defined in the chain before; code of
such a module may then still run after its Abc went, and codeUrl and
codeLibrary fall back to the main SWF's. Lazy compilation keeps each
returned method's originating Abc in a WeakMap keyed by that method, so
entries built apart from their module retain their code origin even when
the body itself never reads A. The
symbols bound to names nothing defined (`Symbols.unbound`) are still
kept for good, their libraries with them.

`tests/player/leak.ts` loads SWFs over and over, by Loaders and in
players made again, and checks that the heap stays bounded, that
codegen's memory does not grow where one player loads them all, and that
a text field kept from a SWF let go still takes a font registered after
a collection.

### Loading SWFs and images

A `Loader` is a container whose one child is the root of the SWF it
loaded, and a `LoaderInfo` is made for each `Loader` and one for the main
SWF: a root display object carries its SWF's, and `loaderInfo` and `root`
on a display object are the nearest root's up from it, null off the
display list, as Flash has it (Ruffle's `loaderinfo_root` trace; a
loaded SWF's root is its own root from its constructor on). Its values
are the loaded SWF's: `bytesLoaded` and `bytesTotal`, `content`, `url`
and `loaderURL`, `contentType`, the header's version, frame rate, width
and height, `loader`, `applicationDomain`, `bytes`. The main SWF's
dispatches `init`, final `progress`, and then `complete` at the end of its
first frame, after its scripts and `exitFrame`. A preloader that subscribes
in frame 1 can advance from that final progress before `complete`, as AIR
does when a SWF is streamed over HTTP. `MainLoadProgress` checks that order
in eager and lazy compilation. Content loaded by `loadBytes` keeps its
different sequence: progress precedes its construction, so a listener it
installs in frame 1 sees only `init` and `complete`.

PNG, JPEG and GIF files use the same Loader queue, sniffed from their bytes
and decoded through the host's image decoder. The content is a `Bitmap` with
its own `loaderInfo` and `root`; image dimensions and MIME type become available
after progress and before `INIT`. SWF-only metadata throws Error #2098 for an
image, and dimensions throw #2099 before any content is ready. Alpha capability
comes from the file's format and transparency metadata, including unused
transparent colors. Partial-alpha PNG channels use Flash's eight-bit shift
when premultiplied. The `loader-images`, `loader-image-alpha` and
`loader-image-formats` cases compare these behaviors with AIR; unit tests cover
URL loading, decoder failures, cancellation and replacement during decoding.

`parameters` is a new object at each ask, so a script's changes to one
stay in it. The main SWF's, which the stage's and every root's under it
report too, are the query of the URL the host gave `Scripting` as `url`
and then the flashvars it gave as `parameters`, which override a name
the query has, as Ruffle's do (Flash's order was not checked: its
harness can give neither). A SWF loaded by URL has its URL's query from
its second `PROGRESS` on, decoded, `+` as a space, a name without `=`
empty, an empty name left out and the last of a name kept; one from
bytes has none here, which adl could not tell from the loader's own
query (Ruffle passes that on). A `LoaderContext`'s `parameters` take the place of the
query from the call on, and a value in them that is not a String, null
included, is refused at the call with `IllegalOperationError` #2196. An
unload leaves none (the `loader-parameters` case and the node tests).
The player's AVM1 has no variables yet, so an AVM1 root's `_root`
variables get no flashvars.

The order is Flash's, traced by adl (the `loads` case; the Flash Player
traces in Ruffle's corpus agree where they overlap). `loadBytes` tells
the whole of the progress in the call, `PROGRESS` with nothing loaded and
again with all of it, `bytes` set and `url` still null, and has no
`OPEN`; a `load` of a URL has `OPEN` once the bytes come. The content
comes in a later frame, for `loadBytes` the next, after `ENTER_FRAME`
and before `FRAME_CONSTRUCTED`:
its SWF's code runs, its document class is constructed with `parent` and
`stage` null and its timeline's first frame in place, it gets `ADDED`
while it still has no parent, then `url` and `content` are set and it is
made the `Loader`'s child, `ADDED` again and `ADDED_TO_STAGE` if the
loader is on the stage. Its first frame's script runs in the frame's
script phase, after its parents', and `INIT` and `COMPLETE` follow
`EXIT_FRAME`, before `RENDER`. The content's timeline advances from the
next frame on, with the stage's frame rate. `unload` takes the content
out at once and keeps the `Loader`; a frame script the content had queued
still runs. The URL of content loaded from bytes is the loading SWF's
with `/[[DYNAMIC]]/n` appended, and `ApplicationDomain.currentDomain` is
a new object at each ask, as in Flash, so two are never `==`.

The loaded SWF's code goes through `Codegen` and the runtime as the main
SWF's does (`scripting/loads.ts`). Linking is asynchronous (its ABCs are hashed by `crypto.subtle`), so a load
asked for is compiled and linked between frames, in the order asked, and
each takes its place in the first frame after its code is linked; a host
that steps frames by hand awaits `Scripting.settled()` between them, as
the tests do, to see Flash's frame. Flash has a `loadBytes`' content in
the frame after the call whatever its size (the `loader-bytes-frames`
case): it parses the SWF before that frame's `ENTER_FRAME`, which comes
late by the parse's time, a few to a few tens of milliseconds in adl for
0.5 MB of ABC (8 MB of sounds cost nothing). Its timers count that time:
those due by the frame's slot fire between frames before it, those due
during the parse fire once each in the frame after `ENTER_FRAME`, a
repeating one's lost ticks dropped, and the rest at their times after.
Content counts on the content coming first, as a timer of a second set at
the call that reads the `Loader`'s child. Compiling such an ABC takes a
few hundred milliseconds here, seconds on a slow machine, so
`Player.advance` holds the next frame while a load from bytes due next
still compiles: the frames stop at the frame's slot and do not catch up
the time held; the timers count it, but none due after the slot fires
until the held frame has played, its content made and `INIT` and
`COMPLETE` told, the call in which the load came included. Each wait
lasts ten seconds at most, so that a load that never ends does not stop
the player. Several loads from bytes asked in one frame all come in the
next, here in the order asked; adl completes them in an order of its
own, neither that order nor its reverse. `SymbolClass` bindings are the
library's, since character ids collide across SWFs. The player package
has no I/O: `load` of a URL asks the host for the bytes through a
function the `Scripting` is given, with a resolved URL, method, headers,
copied body and `AbortSignal`. A fetch that fails, or bytes that are no SWF,
end in `IO_ERROR` on the `LoaderInfo` in the frame. `close` drops a
pending load and aborts its fetch; `unload`, and a new load on the same
`Loader`, do that and take the content out at the call, the `LoaderInfo`
knowing nothing again (Ruffle's `loader_reuse` trace), so a `Loader`
never holds two; the content let go of has `UNLOAD` dispatched on the
`LoaderInfo`, its `content` and byte counts already cleared and the child
still attached, before `REMOVED` (the `loads-init` case). A load closed
or replaced from one of its own events, `OPEN`, `PROGRESS`, the content's
constructor or `INIT` among them, ends there: an unload from `INIT` has
no `COMPLETE`, as Flash has none. An `unload` asked for from `REMOVED`
finds the content already let go of, and a load asked for there is the
one that counts. What a `LoaderInfo` knows of its SWF's header
(`swfVersion`, `frameRate`, `width`...) is refused
before the SWF is loaded, Error #2099, as Flash refuses it. `applicationDomain`
is null before loading and after unloading; a byte load publishes its domain
after the synchronous progress events, before its content is placed.
The SWF a `Loader` belongs to, which its content's
`loaderURL` reports and its relative URLs resolve against, is in Flash
the one whose code made it, even before the first load; the runtime does not
track callers, so it is the SWF the `Loader` is on the display list of when
it loads, else the main one (Ruffle's `loader_loaderurl` adds the loader first, as SWFs
usually do).

An AVM1 SWF (no FileAttributes, or one without the ActionScript 3 flag)
loads as Flash loads one into AS3: the content is an `AVM1Movie`, a
`DisplayObject` whose other face is the AVM1 root's clip, so AS3 sees
none of its children; `actionScriptVersion` is 2, and the header's
version, frame rate and size are the SWF's, `parameters` the context's
or the URL's as for an AS3 SWF. `new AVM1Movie()` is refused, #2012.
Flash makes a `loadBytes`' `AVM1Movie` in the call, which names it then,
and has it in the `Loader` at the end of that frame, after `EXIT_FRAME`,
with its `INIT` and `COMPLETE`, the last asked first; the movie keeps its
first frame through the next frame's advance (the `avm1-movie` case, as
adl traces and draws it). One with images comes at the end of the frame
after they are decoded, or ends in #2124 if the decoder refuses them.
One from a URL comes as an AS3 SWF's content does, `OPEN`, the progress
and the child in the frame's construct phase, `INIT` and `COMPLETE` at
its end, and plays on from the next frame: that follows Ruffle, which
loads both kinds alike, not adl, whose harness loads only from bytes.
The `AVM1Movie` is no `InteractiveObject`: hits on its noninteractive
artwork go to its `Loader` (the corpus's `mouse_pick_loader_avm1`). Its
AVM1 buttons and selectable fields take mouse input themselves, without
AS3 mouse events on the Loader. `input/avm1.ts` joins their picks into
the AS3 display-list search, respecting transforms, masks, scrolls,
overlays and `mouseChildren`. Global AVM1 mouse listeners run before the
pick, even in a hidden or detached loaded movie; button events go only
to the winning movie, with hover and capture reconciled as the display
list changes. Each loaded movie reuses `Avm1Pointer`, and unloading drops
its input state. Ordinary AS3 content creates no such input manager.
These rules follow an authored native Flash Player 32 probe.
The movie's timeline plays at the stage's
frame rate as an AVM1 main SWF's does, and, as an AVM1 timeline, has as
many frames as its ShowFrame tags end, whatever its header says, and stays
on its last without an End tag. The loaded movie now runs its AVM1
actions in its own realm, using the parent player's codegen and host
services. A movie from bytes runs its first-frame script after the
following frame's AS3 ENTER_FRAME; a URL-loaded movie runs it in the load
frame. Subsequent frames tick that VM once, and the AS3 timeline walker
skips its subtree. Timeline sounds
and script-driven playback run with the child. Unloading destroys the
child VM and its connections without closing the parent's audio device.
Keyboard and wheel routing into these loaded movies, and `AVM1Movie`'s
`call` and `addCallback`, remain incomplete; those methods still throw #2014.

`LocalConnection` uses one native broker (`player/src/localconnection.ts`)
shared by a player's AS3 and loaded AVM1 movies. A standalone AVM1 player
has its own broker; an embedding may explicitly share a `LocalConnections`
instance across players. Connections live in a map keyed by ASCII-folded
names, prefixed with the SWF's domain unless the name starts with `_`.
Messages snapshot arguments as bounded bytes (40 KiB) and use the
sender's existing host-event queue. AVM1 sends AMF0; AS3 sends AMF3 to
preserve ByteArray, XML, Vector and class aliases, converting the snapshot
to AMF0 only when an AVM1 receiver needs it. AMF3 scratch buffers are
reused except for externalizable streams that may escape the call. A broker
with no messages does no frame work. Receiver methods, domain permissions
and sender status events enter the appropriate VM, never sharing live script objects. Closing or
destroying a receiver frees its name. This is in-process messaging, not
Flash's machine-wide transport: browser tabs and desktop processes do not
share connections.

`URLStream` uses the same host fetch, which gives bytes (or a failure), HTTP
status and headers. A `URLRequest`'s GET string or URLVariables data is appended to the query;
GET ByteArray data is currently left out and has not been checked against Flash;
other methods send its string, URLVariables or ByteArray data as the body.
Only POST forwards custom headers in the browser player, as Flash Player does;
the host's fetch decides which requests its environment permits. Each
request says what it is for (`purpose`), as Flash's security model told
them apart: a Loader's or Sound's `content`, which Flash let a SWF load
from any domain, a URLStream's `data`, which it let a SWF read from
another domain only as that domain's policy file allowed, and
sendToURL's `send`; a browser's fetch ignores it, and a host that judges
requests as Flash did (the desktop app) reads it. Such a host also gets
the policy files `Security.loadPolicyFile` names, resolved against the
SWF (`loadPolicyFile`), and names the sandbox `Security.sandboxType`
reports (`sandboxType`, "remote" by default). The result
arrives on the player thread in a later frame.
A successful stream reports `OPEN`, `PROGRESS`, `HTTP_STATUS`, `COMPLETE`;
a failed one reports `HTTP_STATUS` before `IO_ERROR`. A URL load through
`Loader` reports status on its `LoaderInfo` between `INIT` and `COMPLETE`,
or before `IO_ERROR` on failure. A local file reports status 0 and no
response headers. The host's response URL and headers are not surfaced by
the Flash Player path; AIR-only `HTTP_RESPONSE_STATUS` is not sent.
Stream fetches are independent of Loader's ordered preparation, so a
stalled stream cannot hold up a later Loader; `settled()` waits for both
when a host explicitly asks it to. A new load or `close` aborts the old
request, and `close` without one throws IOError #2029 as Flash does; reads use the
runtime's ByteArray DataInput implementation. Relative
URLs resolve against the main SWF until the runtime tracks the creator of
each stream.

`navigateToURL` hands the request, taken and resolved as `URLStream`'s is,
and the window name (null when none is given, "blank" in any case and
with or without its underscore as `_blank`, as Ruffle's corpus records
Flash doing) to `Scripting`'s `navigate` host; an empty URL is ignored, as
Ruffle's navigators ignore it. `sendToURL` sends its request through the
host fetch and drops the response, as Flash ignores it. Both throw
TypeError #2007 for a null request, then for a null `url`, as adl does.

A browser navigates only by GET or POST, so a request with any other
method goes as a GET, its data appended to the query, as Flash's does from
a browser.

The browser's default `navigate` is deliberately conservative, since a SWF
is not to be trusted by the page that embeds it. Only `http:` and `https:`
URLs open, so a `javascript:` URL cannot run script in the page. The
targets that would replace the page or a frame around it, `_self`,
`_parent`, `_top` and an empty name, are dropped, as Ruffle's web navigator
drops them without script access. Every other target, a name included,
opens a new window (`_blank`): a name reaches an existing window or frame
of that name, the page's own among them, even with `noopener`, so naming a
window to reuse it does not work. A GET opens with `window.open` and
`noopener`; a POST goes as a hidden form with `rel="noopener"` into a new
window, the only way a browser posts into one, its body read as form data
whatever it is, as Ruffle sends a string's, so a JSON or ByteArray body is
sent form-encoded. A host that trusts its SWFs further, or models
`allowScriptAccess` and `allowNetworking`, gives a `navigate` of its own.
Without a window, as in node, nothing opens; the test page gives none.

`Socket` uses an optional host transport supplied to `Scripting`. The host
opens the TCP connection and reports open, bytes, close and failure; the
player delivers those reports on its next frame. ActionScript's reads and
buffered writes use ByteArray's DataInput/DataOutput implementation; `flush`
sends the pending bytes. A local close invalidates late host reports and
does not dispatch `CLOSE`, while a remote close does. Without a socket host,
connect fails on a later frame; reads, writes and close on an invalid socket
throw IOError #2002. The browser player has no default raw TCP transport:
an embedding page must provide one through its own permitted bridge.
`@swf2es/player-hosts/node` supplies a direct Node TCP transport;
`@swf2es/player-hosts/websocket` sends binary frames through a WebSocket
relay whose URL the embedder chooses. They live outside `player` so its
browser entrypoint has no Node I/O dependency. WebSocket message boundaries
are only transport chunks; ActionScript reads the resulting byte stream.
AIR's `localAddress`, `localPort`, `remoteAddress` and `remotePort` read as
adl's do: null and 0 before a connection and after `close()`, "" and 0
while one opens and after it fails, and once open the ends the host gives
with its open report, kept after the peer closes. The Node host gives its
socket's; a WebSocket relay's are not the script's, so they stay "" and 0,
what Flash reads while it does not know them.

The Flash cases use `loadBytes`, the inner SWF carried in the outer's
script as base64; the oracle runs under AIR, which refuses code from
bytes unless the `LoaderContext` has `allowCodeImport`, which Flash
Player does not need.

The player's application domains are the runtime's and the compiler's
(see [Application domains](#application-domains) and [Parsing, linking and
verifying](#parsing-linking-and-verifying)). The root is Flash's system
domain, the player's own classes; the main SWF loads into a child of it
(`Scripting.mainDomain`), so `new ApplicationDomain(null)` sees none of
the main SWF's classes, and the main SWF's `parentDomain` is null, as
Flash hides the system domain. A Loader loads into its `LoaderContext`'s
`applicationDomain`, or by default into a new child of the domain of the
code that asked: the parent cannot see the loaded SWF's classes by name,
a class it defines again is ignored for the one its domain's chain has,
and `LoaderInfo.applicationDomain.getDefinition` finds its own
(`loader_duplicate_class`). The domain of the code that asks, for
`ApplicationDomain.currentDomain`, `getDefinitionByName` and a load's
default, is `Runtime.codeDomain`'s, so each module is evaluated under a
`sourceURL` of its own, or as a script of its own (`scripting/evaluate.ts`), and the player's own modules load as builtin,
whose frames do not count, as avmplus skips builtin code. SymbolClass
binds a character to the class its name finds in the SWF's domain, by
the module that defines it, so the same name in another domain is
another class; a class keeps the symbol first bound to it, so another
SWF binding a parent's class makes its own timeline's instances of the
class, but `new` makes the first's. `ApplicationDomain.getDefinition`
lets the error of a lazy script's initializer through, running it again
at each call, where `hasDefinition` says false and a lookup by code keeps
the script as run, as avmplus does (`Runtime.definitionNamed`, the
`definitions` case).

A SWF the player loads is in the position the oracle's harness puts
every SWF in, so what the harness could not judge for a main movie, the
document class's `stage` in its constructor among it, compares exactly
once the case loads its SWF.

### Time

The player keeps a clock of its own, in milliseconds, apart from the
frame count: with `realTime: null`, `getTimer` reads it and `Timer`
fires by it, and sounds go by it always. A frame
stepped by `Player.tick()` moves the clock by one frame's duration at
the stage's frame rate, the first frame's included, so a test that steps
frames gets the same clock every time; a host playing in real time calls
`Player.advance(dt)` with the time passed, which plays frames on a grid
of the frame's duration and, without streamed audio, drops those a long
frame or a stall lost, as Flash does, rather than catch up with them as
Ruffle does. Measured in
adl at 24 fps with a 200 ms busy loop in some frames' ENTER_FRAME, Flash
runs the next frame at once after the long one, the one after at its
slot on the grid (8 to 9 ms later, 24 ms after three long frames in a
row), then 41 to 42 ms apart again: never two back to back, and the lost
frames are gone, the movie slowing down. Content that moves by the wall
clock between frames counts on that: a large real-world SWF's walk stops
when two ENTER_FRAMEs move it less than a pixel, which frames run back
to back to catch up, with no time between them, did on every hitch. So a
call runs as many frames as the host's typical interval holds, the lower
median of its last nine calls, never the current one: one, where the
SWF's frame is as long as the display's or longer, two for a 120 fps SWF
at 60 Hz, five at most; until it has seen three calls, one. A typical
interval over 36 ms is no display's (none refreshes slower than about 30
Hz) but the host lagging, often by the frames themselves, and gets one
frame a call, so that the content slows down as Flash's does rather than
feed its own lag with frames run back to back. A host that keeps time
tells `advance` how long its last call took (`busy`, which
`@swf2es/web`'s loop passes): where that came to more than a frame's
duration for each frame played, the frames overran, and the call runs
one, as Flash runs the frame after an overrun alone. Drawing is left
out of it: it costs the same however many frames a call plays, so with
it a call of one frame would look overrun where two would fit. The interval
alone cannot tell: AS2 content that holds a 60 fps movie to 30 by spinning
on `getTimer` until 33 ms after its last frame makes calls 33 to 36 ms
apart, a display's interval by time, and two frames a call then waited
66 ms every other call. What is owed beyond that
is dropped but for the part of a frame, which keeps the grid's phase;
not within half an interval of the next frame, though, where a call that
came a little early would leave a frame owed under ordinary jitter and
the next drop it. A `dt` that is not a finite positive number counts as
none. A SWF faster than the display still runs its frames back to back,
so a walk placed by the wall clock at 60 fps on a 30 Hz display can still
stop short. Streamed audio instead requests catch-up from its device
cursor: the player runs up to 60 logical frames per call, preserving
every frame's scripts and events, while the host draws only once after
that batch. A stop, seek or removal cancels the old stream's remaining
catch-up. The device cursor, rather than wall time, keeps a suspended
AudioContext from requesting frames for audio it has not played. This
applies to streams in nested clips and AVM1 content loaded by AS3 too;
event sounds keep the ordinary pacing. Extra frames get half the previous
presentation interval as a CPU budget, bounded to 8–50 ms, so sustained
render lag still leaves time for affordable timeline work. The budget and
frame-count bound make batches yield, so a long stall does not
block input indefinitely. This cannot guarantee sync when scripts alone
cannot run at the required rate. Native Flash 32,
with a 600 ms busy loop at 25 fps, ran the streamed timeline's frames
6–20 back to back, including their actions, while the equivalent
non-streamed movie resumed at ordinary pace. `advance` returns how
many frames it ran, and `Player.changes` counts what may change the
picture: each frame, each key, each call from the page into an
ExternalInterface callback, each `updateAfterEvent`, and the pointer
events that change what shows at once: a hover that moves on or off a
button or a sprite in `buttonMode`, as Ruffle redraws for, and, more
than Ruffle, any press, release or leave, which may move focus and a
caret, and a drag selecting text. A plain move does not: what its
listeners change shows at the next frame, as in Flash, so a fast mouse
draws a 24 fps SWF 24 times a second, not at the screen's rate.
An input's `updateAfterEvent` also prepares the requested redraw between
timeline frames: it dispatches `RENDER` if the stage was invalidated and
applies pending scroll rectangles. Invalidation alone requests no extra redraw;
a frame or timer that already prepared the request consumes it.
Loads and socket data are delivered in a frame. A host draws when it moved,
not on every animation frame: at 60 Hz a 24 fps SWF drew each picture
two or three times over, and drawing it once took a quarter to a third
of Chrome's CPU off 32 animated characters, the pictures alike. Frame
pacing and the clock are related but not one counter: the clock may run
on within a frame later, where the frame count cannot. `getTimer` tells
real time, as Flash's does: the whole milliseconds, truncated, since the
`Scripting` was made, by `performance.now` or the `realTime` clock a
host gives, running on while a script does, so that code timing itself
within a frame, as benchmarks and Crossbridge's C do, sees the time
pass, and a game's motion follows the time between frames. `realTime:
null` makes it tell the frame clock instead, rounded as it was, the same
on every run: the player's cases and the corpus (`tests/player/page.ts`)
and the node tests that trace it ask for that.
Timers follow the same choice. With a real clock they fire as Flash
fires them, measured in adl: in each frame right after ENTER_FRAME and
before the frame's construction, every timer due fires once, in the
order the timers were started, and next falls due its delay after it
fired, so the ticks a long frame or a stall lost are dropped, not caught
up with (a 10 ms timer fires once after a 200 ms frame, and `currentCount`
counts only the firings). A timer shorter than the frame interval also
fires between frames at its time, at most once a check; one as long as a
frame or longer waits for a frame, so a 45 or 50 ms timer at 24 fps fires
every other frame though the player checks between. In adl a 10 ms timer
fires two to four times a 24 fps frame, a 1 ms one about once a
millisecond at 1 fps; there is no floor above 1 ms, for `setInterval`
neither. Flash truncates a delay to whole milliseconds: `Timer(1000 /
24)` is 41 ms, shorter than the frame, and fired in 117 of 120 frames,
`Timer(1000 / 30)` in 150 of 150 and `Timer(1000 / 60)` in 287 of 300;
`Timer(40)` at 25 fps, the frame's length, fired in 106 of 125, and one
a millisecond longer than the frame in about 55 to 70 % (five seconds
each in adl). Our hosts check at each `advance(dt)` that plays no frame,
60 times a second for a 24 fps SWF, so a timer shorter than that fires
at each call: two or three times a frame. Their calls do not fall on the
SWF's grid, though: a 25 fps SWF's frames come 33 and 50 ms apart at 60
Hz. So the timers keep the host's time, the sum of the `dt`s it passed,
on which a frame has its exact place on the grid, the time it fell due;
a timer as long as a frame or longer is due by that, and every timer
fired in a frame next falls due from it, as does one as long as a frame
started in a frame. A timer of the frame's length then fires every
frame, however the calls fall and jitter, where adl's fired in 85 % of
them, its own frames jittering; one a millisecond longer fires every
other frame, adl's in 55 to 70 %. A short one is due in a frame by the
call's time, less a frame for each the call plays after it, so that a
frame run late does not hold it back, and a SWF faster than the display
fires it in each of its frames, not once a call; between frames it also
waits its whole delay since it last fired, the least interval adl showed.
At 60 Hz the checks come every 16.7 ms where Flash's come every few, so a
timer shorter than that fires two or three times a 24 fps frame where
adl's fired two to four, and a 20 ms one each 33 ms between frames where
Flash's fired each 20 to 25. The host's time follows the `dt`s it
passes, not the real clock, which only places it at the first call and
tells the time between calls. `updateAfterEvent` in a timer
fired between frames has the stage render then, with RENDER if a script
invalidated it, as Flash does; an invalidation without it waits for the
frame. Ruffle fires its timers after the frame from the same real clock
but catches missed ticks up, ten at most a call, clamps delays to 10 ms
and fires long timers between frames too. With `realTime: null` timers
fire by the frame clock: a frame moves it on and every due time in it
fires, at the same point after ENTER_FRAME, the same on every run, which
the cases and the corpus's `timer*` tests rely on.

`flash.utils.Timer` is playerglobal's own in all but three natives: the
counting, `delay`'s range (RangeError #2066), `reset` and the events are
AS3; the player keeps the timers started (`scripting/timers.ts`, with
the clocks), each with its delay and the closure to call, fires the ones
due as above (by the frame clock, each firing the earliest due so that
two timers interleave as their times do, two due at once in the order
scheduled), and tells `running`. The timers are a heap by due time, as
asyncio keeps its callbacks: a scan of all of them per firing costs
2.5 ms a frame at a thousand timers where the heap costs 0.3, and
nothing either way below a hundred.
Flash fires timers between frames at their own times, so by the frame
clock, while a timer's closure runs the time is the one it fell due at,
which a timer started from it counts from and `getTimer` tells: three
timers set one from another at 100 ms each land at 400, 500 and 600 ms,
as in Flash, not a frame later each (the corpus's `timer_finished`).
`setTimeout` and `setInterval` are AS3 over `Timer`. The corpus's
`timer*` tests, Flash's traces of timers against frames, are the
reference by the frame clock, with node tests of the real clock's
passes against an injected clock (`tests/unit/player/scripting/timers.test.ts`).

### The pointer

`MouseEvent` keeps its local coordinates and flags on the event. Its stage
coordinates are read through the target's current display matrix, so moving
the target after dispatch changes them without changing `localX` or `localY`.
Without a target a finite local coordinate gives stage coordinate zero, and
an unset one stays NaN (`mouseevent_constr` and `mouseevent_stagexy` in the
corpus). AIR's `playerglobal.abc` adds `commandKey`, `controlKey` and
`clickCount` to `MouseEvent.toString`; the Flash Player trace in
`mouseevent_valueof_tostring` has none of them, so that one output still
differs though its native values match.

`PixiView.bindPointer(player)` takes the pointer's position on the canvas,
scaled to the SWF's stage, within the box CSS `object-fit` shows the
canvas's pixels in (`contain`, `scale-down`, `cover` or `none`, centred as
the default `object-position` has it, inside borders and padding), and
passes it to the
player's own hit test. It shows the cursor the player chooses, as Ruffle
does: a hand over a button that uses one, disabled or not, or under the
nearest sprite in `buttonMode` whose `useHandCursor` and `enabled` are
true, and an I-beam over selectable text; a link in text shows no hand
yet. That is `Mouse.cursor`'s `"auto"`; `"arrow"`, `"button"`, `"ibeam"`
and `"hand"` force CSS `default`, `pointer`, `text` and `grab` over
the whole stage (`"hand"` is Flash's dragging hand, as Ruffle shows it),
and any other name is ArgumentError 2008, as in Flash. `Mouse.hide()`
makes it none over the stage, at once, wherever a script calls it, even
over a forced one, and `Mouse.show()` brings back the one it hid; the
pointer still picks its targets while it is hidden, as in Flash and
Ruffle. `Mouse.registerCursor`
checks its `MouseCursorData` as Flash does (frames of at most 32 by 32,
a hot spot within 0 to 31) and makes the first frame a PNG `data:` URL,
with no DOM, that `Mouse.cursor` can then name before Flash's own names;
CSS cursors do not animate, so a cursor of several frames shows its
first. `supportsCursor` and `supportsNativeCursor` are true, as in
desktop Flash.
The display list decides the target, so masks, scroll rectangles, depth,
visibility, `mouseEnabled` and `mouseChildren` use the same objects that
scripts see; Pixi's render tree does not choose a Flash target. The
pointer sends `mouseOver`, `mouseOut`, `rollOver`, `rollOut`, `mouseMove`,
`mouseDown`, `mouseUp`, `click` and `doubleClick` through EventDispatcher's capture and
bubble phases, and the stage's `mouseLeave`, in the order Flash Player 32
traced them (a probe logging every event with its target, run in
Electron's PepperFlash and driven over the DevTools protocol, the
`MouseOrder` test of `tests/unit/player/input/pointer.test.ts`): a
pointer at a new point sends `mouseMove` to what is under it first, then
moves the hover, `mouseOut` and the `rollOut`s from what it was over up to
the common ancestor, the `rollOver`s from the new object up, then
`mouseOver`. A press or a release at a new point is that move, with
`buttonDown` as it was before, then the press or release; one where the
pointer already was is its own events, then any hover that changed. A
move to where the pointer is sends nothing. The empty stage takes
`mouseMove`, `mouseDown`, `mouseUp` and `click`, but nothing is over it:
leaving an object for it is a `mouseOut` whose `relatedObject` is null,
and no `mouseOver`. The pointer leaving the player with its button up is
`mouseOut` and `rollOut`s at the stage point (-1, -1), though `mouseX`
and `mouseY` stay where they were, then `mouseLeave`. With the button
down after a press on the player, the mouse stays its own, as Flash's
plug-in kept it: no leave, the moves outside go to the stage, and so
does the release, and the leave comes at the next move outside after it.
A leave is sent once until the pointer is back, so a right button's
release outside, which holds nothing, leaves no second time; a left
button let go where the host told of no release (outside the browser, or
while another button stays down, which Chrome tells as a move) is
released at the next move that shows it, and left where that is outside.
`updateAfterEvent` changes none of this. The second click of a double
is a `doubleClick` in the click's place where the target's own
`doubleClickEnabled` is true, its parent's counting for nothing, and a
third a click again, as Flash Player 32 traced them. The plug-in took the
browser's count of clicks, and counted none whose first was on another
object; the player counts a press on the last one's target within half a
second and two pixels of it, Ruffle's rule, as the browser's own would.
Ruffle sends
`mouseMove` first too, and no `mouseLeave`.
A mouse that stands still is picked for again at each frame's end, after
its `exitFrame` and before its `render`, as Flash Player 32 does: an
object a script moves, hides, disables or takes off the list from under
it gets its outs, one that comes under it its overs, with no
`mouseMove`, and the cursor follows. One taken off the list hears no
`mouseOut`, only the `rollOut`s of the ancestors it had when the hover
came, the root's too, as Flash sends them. Flash notices an object moved
in under the mouse a frame later than one moved out (its pick seems to
go by where the last render drew it); the player notices both at once.
Nor does Flash notice a text field that shrinks out from under a still
mouse until the mouse next moves; the player sends its outs at the
frame's end, as for any other object.
The pick runs only when something a pick reads changed since the last
(`pickWork`: whatever invalidates an object, and `mouseEnabled`,
`mouseChildren`, a `hitArea` or a button's `enabled`), so a still scene
costs nothing, and a busy one a pick a frame, what one mouse move costs.
The pick carries the point down the list into each object's space, making
no matrix per object, and passes over a container whose bounds miss it:
bounds each object keeps in its own space (`pickBounds`), marked stale by
a change in it or under it, and not by its own move, which only its
ancestors' bounds see. They are worked out only for what stood still over
the last two picks, as what changes on most frames costs less gone
through than measured; a timeline shape is checked against its recorded
bounds before its fills. A button's hit test state is in no container,
so a button and those above it are measured each time, as is a sprite
with a `hitArea`, which may be anywhere on the list, its bounds taken
through the stage into the sprite's. A NaN in bounds, from a NaN or
infinite matrix or an infinite drawing, rules no point out.
On 400 rigs of 12 moving parts (10,000 objects), a pick takes 0.01 ms
where it took 0.5 ms and 125 KB, and
`tests/player/bench.ts --scripted 400 --still --hover` ticks as without a
mouse over the stage, 0.3 to 0.4 ms, where it took 0.8; where every part
is new each frame, a pick after a tick takes 0.2 to 0.3 ms, against 0.7.
`DisplayObject.mouseX` and `mouseY` follow the last pointer position.
The pick follows Flash's order, as Ruffle's `mouse_pick_avm2` has it:
interactive children before artwork, and a hit on what takes no pointer
goes up only once nothing else under the point has taken it, to the
nearest ancestor whose `mouseEnabled` is true, past any number that are
false. The main SWF's root is never the target, as Flash Player 32
traced it (the `MouseGaps` probe of the same test file): its own art, a
hit passed up to it, and all of it with its `mouseChildren` false go to
the stage, while it stays over as an ancestor; a sprite a script puts on
the stage beside it takes its hits as any other; a loaded SWF's root a
script puts on the stage itself is taken for the main root, which no
probe has measured. What a
mask, a scroll rect or a timeline's mask layer hides takes no pointer
(`mouse_pick_masking`): a list scrolled under a mask layer is clicked
only where it shows. `hitTestPoint` asks no mask layer above the object
it tests, as Flash's does not (the corpus's `from_shumway/hittesting`:
a point a layer hides still hits), and `getObjectsUnderPoint` none
either. A move is
posted rather than handled at once, and the player handles the last one
posted when it next advances, or before the next press, release, leave
or key, whichever comes first: a browser sends about one a frame, a
headless one or a fast mouse more, and each picks from the whole list.
A pointer that crosses a small object between two frames so sends it no
`mouseOver`. A path's polygon, flattened for hit tests, is kept with it.
A sprite with a `hitArea` is hit where the area draws, wherever the area
is on the display list and shown or not, and not by its own drawing; its
interactive children still pick unless its `mouseChildren` is false, and
an area off the list hits nothing. Ruffle stores AVM2's `hitArea` and
picks without it. adl leaves the area's own `mouseEnabled` as it was
(`sprite-hit-area`), so a shown, enabled area on top takes the pointer
itself, as Flash's documentation warns; `hitTestPoint` and
`getObjectsUnderPoint` ignore it. A drag keeps, as it moves and when it
ends, the topmost object drawn under the pointer outside the dragged
sprite, which `dropTarget` reads: the shape, not the sprite that takes
the pointer, as Flash's trace of the corpus's `sprite_dropTarget` names
the shapes in its sprites, and null over nothing. Neither can be played
in adl, which the harness gives no pointer, so the unit tests carry them.
The wheel sends `mouseWheel` to what is under the pointer, bubbling and
not cancelable, its `delta` lines up positive, and a text field there
whose `mouseWheelEnabled` is true then scrolls by as many lines, as the
corpus's `mouse_wheel_events` has Flash trace them (its `scroll` event is
not sent yet). PepperFlash on Linux, the Flash Player 32 at hand, gave no
`mouseWheel` at all for the DevTools protocol's wheel, and let the page
scroll under it; Adobe documents the delta as the lines a notch
scrolls, 3 by Windows' default, as Ruffle's own tests send it. The host makes a browser's notch 3 lines, whether it gives 3 lines
or about 100 pixels (fewer on a zoomed page or a scaled screen, a
multiple for notches run together), and adds a touchpad's pixels up, 100
to 3 lines, sending nothing for a part of one. That is untried on
macOS, whose wheels and touchpads give pixels of their own measure. It keeps the page from
scrolling only where the SWF takes the wheel: a `mouseWheel` listener on
the target or an ancestor, or a field that can scroll; elsewhere the page
has it. With Ctrl, as a touchpad's pinch comes too, the page zooms and the
SWF hears nothing. Right and middle buttons, and
Flash's drag and focus rules, still need their own cases.

### Touch

`Multitouch` reports the host's touch screen: `maxTouchPoints` is the
browser's `navigator.maxTouchPoints` (or the `maxTouchPoints` a host gives
`Scripting`), `supportsTouchEvents` whether it is above zero, and
`Capabilities.touchscreenType` `"finger"` then, `"none"` otherwise.
Without a touch screen, adl and Flash Player 32 both start `inputMode`
at `"none"` and keep it there whatever a script sets, after checking the
value (TypeError #2007 for null, ArgumentError #2008 for a name not
MultitouchInputMode's), and the player does the same (the `touch-natives`
case); with one, it starts at `"gesture"`, as Adobe's reference has
Flash start, and takes every mode. No gesture is recognized:
`supportsGestureEvents` is false and `supportedGestures` null, so gesture
mode leaves touches to the mouse, and scripts can only make and dispatch
the gesture events themselves.

`bindPointer` sends the pointer events whose `pointerType` is `"touch"`
to `input/touch.ts`; a pen is a mouse. The browser's primary touch, the
first finger down while none was, moves the mouse, in every mode, as
Flash's plug-in did (AIR's `mapTouchToMouse`, true by default, turns
that off in touchPoint mode): a press is a move to the point, where the
mouse was elsewhere, and a press, as Flash Player 32 handled a browser's
emulated touch, then moves, then a release, which clicks as a mouse's
does; the lifted finger leaves the mouse where it was, with no rollOut.
In touchPoint mode every touch is TouchEvents too, picked as the pointer
picks and in the mouse's order: a move's `touchMove`, then `touchOut` and
`touchRollOut` from what the point was over and `touchRollOver` and
`touchOver` on what it is over (none on the empty stage); for a begin
the hover, then `touchBegin`; for an end `touchEnd`, a `touchTap` where
it ends on the object it began on, and, once lifted, `touchOut` and
`touchRollOut`, as a lifted finger is over nothing. `touchPointID` is the pointerId, the
local point is the target's, `sizeX` and `sizeY` the contact's size in
stage units and `pressure` the browser's. Each step's touch events come
before the mouse events of the same step. A point's moves are posted as
the pointer's are, the last of each point handled at the next flush. A
touch the browser cancels ends where it last was, with a `touchEnd` whose
AIR `isTouchPointCanceled` is true but no `touchTap`, and its mouse with
`mouseUp` but no click; a pointer id that begins again before its end
came first takes the old point out of what it was over and lets its
mouse go, without a click. Each step reads `inputMode` and
`mapTouchToMouse` as they are then, so a change in the middle of a touch
applies from its next step: a touch begun in gesture mode may end with
touch events and no begin, and one begun in touchPoint mode with none.
What Flash did there is not known. A touch's begin, end and tap are a
user's gesture for the clipboard, as a press is; the browser itself
counts only a touch's release as the user's activation, so a write in
`touchBegin`, or in the `mouseDown` a touch makes, may be refused by its
async API. The canvas keeps Pixi's `touch-action:
none` whatever the mode: Flash's plug-in took every touch on it, and a
SWF that drags with the mouse needs it, as a page that scrolled under the
finger would cancel the drag. None of the order between touch and mouse
events could be measured: adl under Wine and Flash Player 32 on Linux
report no touch screen and dispatch no TouchEvent. The order is the
reference's ("the first point of contact dispatches a mouse event and a
touch event") and the W3C's, touch first; Ruffle dispatches no
TouchEvent. Nor could the TouchEvents' own order: a move before its hover
is the mouse's, measured, taken over.

### Keyboard and focus

A host gives the player its keys (`bindKeyboard`, `input/keyboard.ts`): each
goes to `stage.focus`, or the stage where nothing has focus, as a
`KeyboardEvent` that bubbles, the browser's legacy key code standing for
Flash's, which it matches. A focused input field then edits with it, in
Ruffle's order: a `TextEvent.TEXT_INPUT` with the character as typed,
which a listener may cancel, then `restrict` and `maxChars` filter it,
it goes in at the caret, over the selection, and `Event.CHANGE` follows.
Backspace, Delete, the arrows, Home and End move and delete, Up and Down
by a line, Shift extends the selection, Ctrl+A selects all (Ctrl with
Alt is AltGr, and types), and Enter adds a line only to a multiline
field. A press in a selectable field puts its caret at the nearer side
of the character pressed, and a drag from there selects, by words after
a double click and by lines after a triple click, as Ruffle's does (two
presses within half a second and two pixels make a double). A click
gives focus to any text field and to whatever Tab may focus, and a click
on anything else takes focus from what Tab may focus, after a cancelable
`mouseFocusChange` on what had it. Tab may focus input fields, buttons
and sprites in `buttonMode` unless `tabEnabled` says otherwise, not a
timeline on the stage itself, and nothing inside a container whose
`tabChildren` is false; it moves by `tabIndex` where any has one, else
by where each starts on the stage, after a cancelable `keyFocusChange`.
`stage.focus` set by a script moves focus too, and every move is a
`focusOut` and a `focusIn`, each naming the other. An object taken off
the list or hidden loses focus. A focused field draws its caret,
unblinking, a pixel wide in the colour of the text before it, and its
selection shaded, line by line, both clipped to the lines shown; a
focused selectable dynamic field shows its selection too. A key the
player used, an edit or a caret moved in a field or a Tab that moved
focus, the host keeps from the browser; any other, a game's arrows say,
still reaches the page too, which may scroll by it. A focused selectable
field that takes no typing moves its caret and selection with the same
keys, and selects all with Ctrl+A. adl cannot be typed into, so none of
this is recorded against Flash; there is no IME, and no scrolling to
keep the caret in view.

A key's release goes elsewhere when the page or the window loses focus
while it is held, and never reaches the player. The host tells the
player its focus (`Player.setActive`, bound by `bindActivation`,
`input/activation.ts`): the window's blur and focus, the document's
visibility, and the element's focus moving to the page around it, as a
plug-in lost focus to its page. A page without focus or hidden as the
host binds starts the player inactive, before its scripts listen, so
its first focus is an `ACTIVATE`. Losing focus, the player lets go of
the keys AVM1's `Key` holds with no keyUp: Flash sends none then, which
is why content clears its own keys on `Event.DEACTIVATE`, and a release
the user never made could set off a game's action. The mouse's buttons
stay the pointer's, which finds a release it missed at its next move.
It then broadcasts `deactivate`, and gaining focus back `activate`, to
every EventDispatcher that listens, display object or not, as Adobe
documents them, at the target alone. Unlike a frame's broadcasts, these
listeners are held weakly (`WeakTargets`, `scripting/events.ts`): a
listener for them keeps no object alive and no orphan playing. A change
applies once the JavaScript that told it has returned, or at the next
frame: the page may move its focus inside an ExternalInterface call,
and no listener runs inside another script. Only the last state told
counts, so a blur and a focus together send nothing. A host that never
calls it leaves the player active.

### Context menus

`Player.contextMenu` snapshots an AVM2 menu on demand, using the input
hit test and the nearest ancestor with a `ContextMenu`. Root artwork
targets the root for menus, as Flash Player 32 does. `menuSelect` runs
before the custom items are read, so its listeners can replace items or
change their captions, visibility and enabled state. A selection sends
`menuItemSelect` to the captured item, with the original `mouseTarget`
and `contextMenuOwner`, in a clipboard gesture. Later item changes do
not rewrite a menu already open. Destruction makes its callbacks inert.

`render/context-menu.ts`, bound with the pointer, presents the snapshot
in a DOM popover shared by the web element and desktop player. Captions
are text, never markup. Only an open menu holds DOM nodes and document
listeners; closing, blur, outside focus, resize or unbinding releases
them. The top layer escapes a web element's overflow and works in full
screen. Arrow keys, Home, End, Enter, Escape and Tab navigate or dismiss
the menu; the popup takes those keys before the SWF does. An embedder
can capture and prevent the canvas's `contextmenu` event to provide its own UI.

The first implementation supports AVM2 custom items, separators,
visibility, disabled items, quality actions and an About entry.
`ContextMenu.isSupported` is true. `Stage.showDefaultContextMenu`,
the web element's `menu="false"`, and `hideBuiltInItems` control
built-in quality entries while keeping custom entries. AVM1 custom
menus, programmatic `ContextMenu.display`, AIR menu trees and the
other Flash built-in actions remain unimplemented. The model is
renderer-independent so those can reuse the presentation.

### The clipboard

Flash Player 10 let a script write the clipboard only while it handled
a user's event, a key, a mouse button, a copy or a cut, and read it only
while it handled a paste, as the
[Clipboard reference](https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/flash/desktop/Clipboard.html)
and the
[developer's guide](https://help.adobe.com/en_US/as3/dev/WS2F6A31B9-1AE6-4b23-9C12-57A33F4F0516.html)
tell; the player keeps those rules in `scripting/clipboard.ts`, which
holds the clipboard by Flash's native format names (`air:text`,
`air:html`, `air:rtf`, `air:url`, and a script's own formats as
`air:reference:` and `air:serialization:` entries). The pointer's
presses and releases, a touch's begin, end and tap, and every key run as a gesture, in which
`canWriteContents` is true; a paste runs as one in which
`canReadContents` is too. playerglobal's AS3 checks both and throws its
SecurityErrors; the natives (`playerglobal/flash/desktop/Clipboard.ts`)
store and give back, run a `setDataHandler` handler when its format is
first read, and refuse `new Clipboard()` with IllegalOperationError
#2178, Flash Player having the system's alone. `clear` and `clearData`
outside a gesture throw SecurityError #2191, and `System.setClipboard`
Error #2176, as Ruffle has the plug-in throw it; a null string is
TypeError #2007. Bitmaps and files are AIR's, and are not kept.

The keys go through the text field with focus, as Ruffle's
`text_control_input` has them: Ctrl+C copies its selection, but not a
password's; Ctrl+X does so and deletes it, in an input field only, with
Event.CHANGE; Ctrl+V types the clipboard's text into an input field as
if typed, a TextEvent first that a listener may cancel, then `restrict`
and `maxChars`, its line breaks as `"\r"` in a multiline field and
dropped from a single-line one, with every other control character,
and nothing at all from an empty clipboard. A TextField dispatches no
Event.COPY, CUT, PASTE or SELECT_ALL, Flash's reference says; any other
object with focus hears them for the same keys, PASTE bubbling as in
Flash Player and the others not, and writes or reads the clipboard in
them. With nothing in focus, none is heard, and Ctrl+A is the page's.

The browser's own copy, cut and paste events carry the data both ways:
`bindKeyboard` lets Ctrl+C, X and V through to the browser, which sends
the focused element the event, and the player answers it at once, the
copy's data set on the event and the paste's read from it, which needs
no permission. A script's write in any other gesture, a click's
`System.setClipboard` say, goes to the host's `ClipboardHost`, by
default the async Clipboard API's `writeText`, or `write` with HTML,
which a browser allows during a user's activation; null in node, where
the clipboard is the player's memory alone and a paste without the
host's data pastes what the SWF last copied. Nothing reads the system's
clipboard but a paste, as in Flash. The context menu's built-in Cut,
Copy, Paste, Delete and Select All are not implemented yet; a paste
from the popup would need the async API's `readText`, which asks the
user's leave. `tests/web` presses the keys in Chrome.

### ExternalInterface

`ExternalInterface` is available only when the embedding page gives
`Scripting` an `externalInterface` host. Its public methods stay in
`playerglobal.abc`; the player supplies their private native bridge:
initialization, enumerable property names, callbacks, and the synchronous
JavaScript and XML call paths. The host receives the JavaScript source or
XML invocation and decides what to execute; the player does not evaluate
script text. Without a host, `available` is false, `objectID` is null,
and calls and callback registration throw Error #2067 as Flash does in a
container without a bridge.

A callback the page calls goes through playerglobal's `_callIn` either
way it can: with an array of AVM2 values, applied as they are and
answered with JavaScript source (`_toJS`), which the host would have to
evaluate; or, given null for the array, read from an XML invocation, as
Flash's plug-in sent one, whose arrays and objects playerglobal makes
AS3 ones, and answered in XML for `returntype="xml"`. The browser host
(`@swf2es/web`, see [The web embedding](#the-web-embedding)) takes the
second, so a page's calls into a SWF need no eval.

#### Which SWF is calling

A host may refuse some SWFs (`allows`): each native asks it about the SWF
whose code is calling, as Flash checked allowScriptAccess against the
calling SWF's domain, so a child that a same-domain SWF loads from
elsewhere finds ExternalInterface as if there were no bridge. fscommand
gives its host the same URLs. The check never takes the main SWF's word
where it cannot tell (`Code.securityUrls`).

The caller is a SWF only when its own code called the gate directly,
which the player reads from the stack:

- The stack is taken whole, the engine's `stackTraceLimit` lifted for that
  one capture: its default of ten frames lost the caller under an
  `Array.forEach` of `ExternalInterface.call`.
- The player's frames above the native are counted off, then the library
  function the SWF called (playerglobal's `ExternalInterface.call`,
  `fscommand`, `Loader.loadBytes`), and the frame after must be a SWF
  module's: a direct call.
- `fscommand`, a package-level function, a SWF reaches by its name through
  the runtime, `Runtime.call`, `callValue` and the method closure's
  wrapper, so that one chain is accepted too, frame for frame, at the
  sites the player measures once, at the first check, by making such a
  call to a probe of its own (`Code.byNameChain`) (the build's own sites, minified or not; if the probe does
  not see the chain, no call matches).
- Anything else there, the player's or the runtime's code that calls a
  function value (a listener a dispatchEvent calls, an Array's forEach or
  sort, `.call`, `.apply`, `o.f()`, a timer), or a frame line it cannot
  read, leaves the caller untold.

A frame line's location is read inside its last parentheses in V8's
frames, and after its first `@` in the others, whose URLs may hold one
(`/npm/p@1.0/m.js`) (`avm2.frameSites`), so a name cannot
stand for a location; and a SWF cannot set one anyway: codegen names
functions, methods, getters and classes from `[A-Za-z0-9_$]`, a SWF has no
eval or `new Function`, an AS3 function's JavaScript `name` is not its to
set, and a module's `sourceURL` is the player's.

Where the caller is untold, the URL of every SWF whose code was ever
loaded is asked, and all must pass, so single-origin content works from
timers and callbacks, and mixed-origin content fails closed. Ever, not
now: an unloaded child's timers and closures outlive its modules, which
the player holds weakly, so the URLs are kept in a set that never
shrinks. A loadBytes' content is the calling SWF's, as Flash gave it the
loader's domain, not the main SWF's; where the caller cannot be told, it
is the one origin's while only one ever loaded, else no one's, an opaque
URL no check allows. A load a redirect took elsewhere is the final URL's
(`FetchResult.url`), for its LoaderInfo and its checks alike.

That has a cost in mixed-origin content: ExternalInterface reached by a
late-bound path from the SWF's own code, `ExternalInterface.call.apply(...)`,
the common `callJS(...args)` wrapper that uses `.apply`, `.call`, `o.call`
on an Object-typed reference, `getDefinitionByName(...)["call"]`, is
treated as an untold caller and denied. A `Function`-typed local called as
`f(...)` goes the same way through the runtime as a call by name, and
counts as the calling SWF's. Single-origin content is unaffected.

Only V8's stacks are read so. JavaScriptCore elides tail calls, which the
runtime keeps out of its call paths, and names a SWF's module by its Blob
URL, but the libraries' modules, made by `Function` there, name no script,
as a native's frame does: a frame that names none could be either, so its
stacks, and SpiderMonkey's, which have the same form, leave every caller
untold until the libraries name theirs too. If the page froze
`Error.stackTraceLimit` (SES lockdown), the caller is untold too.

The player has no sandbox between SWFs, though, and the check knows
only which SWF's code made the call. A cross-origin child can call the
main SWF's functions, or a grandchild's: a main-SWF function that
forwards its arguments to ExternalInterface acts as the main SWF for
whichever SWF called it. Main-SWF code that itself calls a function
value a child supplied, ExternalInterface.call returned by a child's
getter, fetched from a Worker's shared property, or kept in a reference
the child stored, fails closed on V8 where it goes through `.call`,
`.apply` or a property call (`o.f()`), but a plain `f(...)` of a local
cannot be told from a call by name, and acts as the main SWF. A page that
loads SWFs it does not trust beside ones it does should give none of them
script access.

### AIR's WebSocket

AIR 51's `air.net.WebSocket` and `flash.events.WebSocketEvent` are
newer than the oracle's playerglobal, and Adobe's airglobal that has
them may not be committed. The player declares them itself, in AS3 of its
own under `as3/air/src` (`air/net/WebSocket.as`,
`flash/events/WebSocketEvent.as`), with AIR's API as adl shows it. `tests/player/air-library.ts` compiles them with ASC in the
oracle's container against builtin and playerglobal into one ABC,
committed as `playerglobal/air-library.ts`, and a unit test compiles them
again and compares. ASC keeps no default values for a native method's
parameters, so `connect` and `close` are AS3 calling private natives.
Loaded as a builtin, which native methods need, an unmarked URI that
playerglobal marks, the empty one or `flash.events`, would be VM-internal
and hidden from the SWF's code (see
[Parsing, linking and verifying](#parsing-linking-and-verifying)), so the script marks each
package namespace's URI with API version 0, every version's, through a
marked copy of its string. A host that plays AIR content passes
`airLibrary` to `loadLibraries` after playerglobal; Flash Player has no
such classes, so it is not loaded by default.

The natives (`playerglobal/air/net/WebSocket.ts`) run over a
`WebSocketHost` (`hosts.ts`), by default the global WebSocket, a
browser's or node's; `webSocket: null` has every connect fail. What they
throw and dispatch is what adl does: TypeError 2007 for a null URL, then
IllegalOperationError 2082 for a second connect, a WebSocket connecting
only once, then ArgumentError 2147 for a scheme other than `ws://` or
`wss://`; ArgumentError 1508 for data that is not a String or a
ByteArray, whose bytes go from the start whatever the opcode; Event.CONNECT,
WebSocketEvent.DATA with a ByteArray each read of `data` rewinds, and
Event.CLOSE when the server closes, with `closeReason` its code, none
after `close()`; IOError 2002 for a send or close once closed;
ArgumentError 2014 for setting `protocol` once open, which becomes the
subprotocol the server chose, `connect`'s vector offered, not
`protocol`. A send or close while connecting ends the connection, an
IOErrorEvent with the URL and a close, as adl's handshake breaks on the
frame. A failed connection is an IOErrorEvent with its host, as adl's
refused one; a browser does not tell a refused connection from a
refused handshake, which adl reports with the URL and a close. A host
that throws a `SecurityError`, as a browser does for a blocked port,
gives a SecurityErrorEvent. Before connect, where adl crashes, a send or
close throws IOError 2002. `startServer` throws AIR's IllegalOperationError
for a method its profile lacks, as `Updater.update` in adl.

A browser sends no frame but text, binary and close, and close codes
1000 and 3000 to 4999 alone. AIR sends any opcode's low four bits as
they are: text and binary go, `fmtCLOSE` closes with the payload's
first two bytes as the code (AIR sends no reason either, and then
dispatches the close), and pings, pongs and reserved opcodes are
dropped, since the browser answers the server's pings itself and AIR
dispatches nothing for a pong. `close` with a code a browser refuses
closes without one. There is no `certificateError`: a browser rejects a
bad certificate as any failed connection. A text message's leading BOM
is sent, as AIR sends the bytes, but one received is gone, as a browser
decodes it away, where adl's `data` keeps its three bytes. Two of adl's
races the player does not run: a send in the close listener of a
connection a send or close ended while connecting goes in adl, where it
throws #2002 here, and adl at times dispatches a close after `close()`
when a send goes out while it closes, where the player never does.
WebSocketEvent has no `clone` of its own, in AIR as here, so a
redispatched one is a plain Event.

`Player.destroy` (`Scripting.destroy`) closes every WebSocket and
flash.net.Socket still open, as [Shutting down](#shutting-down) tells.
Not done yet: one is not closed when its SWF alone is unloaded. Where adl is at fault the
player is not: adl stops reading at an empty message, which the player
dispatches, and a close frame without a code throws #2030 in it.

### Screen capabilities

`flash.system.Capabilities` reads screen resolution, pixel aspect ratio and
DPI from the `Scripting` instance. A host may supply any of the four values
through `screenCapabilities`; omitted values fall back separately. Values are
copied when the player is made, so another player can report a different
screen. By default, resolution comes from the browser's `screen` (zero in a
non-browser host), pixel aspect ratio is 1 and DPI is 72. The corpus harness
supplies the screen on which its Flash traces were recorded.

### Globalization

`flash.globalization` (`playerglobal/flash/globalization/`) is Flash on
Windows' as AIR's adl shows it (the `*-formatter-natives`,
`collator-natives`, `string-tools-natives` and `locale-id-natives` cases),
with its locale data from the host's `Intl`, ICU's, where Flash takes the
system's. Its rules are its own and are followed here; only the data is
ICU's.

- **Locales.** A name is kept as Flash keeps it: one it takes apart, its
  subtags parted by single hyphens or underscores, canonical (`EN_us` as
  `en-US`, variants in upper case), one parted otherwise as it came
  (`en--us`, `en.US`, `en US`), one it cannot take apart (extensions, a
  variant of digits alone, a language of one letter or nine, a keyword
  other than calendar, collation, currency or numbers) in lower case. It
  resolves to a locale Intl supports: the language's likely region where
  none is given (`de` is `de-DE`, Chinese named by region, `zh-TW`),
  `usingFallbackWarning` and the likely region for a region whose data ICU
  does not resolve to (`en-ZZ`; `nb-NO` resolves to `nb`, Norway's), and
  the default, `usingDefaultWarning`, for a language Intl does not know or
  knows by another code (`iw`, `in`, `tl`, `und`). The default, also for
  `""` and `i-default`, is `PlatformCapabilities.locale`, the browser's
  language unless a host sets it; the player's tests start Chrome in
  en-US, as adl's machine is. Methods and setters set
  `lastOperationStatus`; getters leave it. What Intl gives a locale is
  read once per locale; a name's resolution is kept for the last 64 names
  only, as a SWF may make any number of them and every player shares the
  cache (a unit test holds it to that).
- **Numbers and currencies** take only their settings from Intl: the
  separators, digits, grouping, the negative format, the currency's
  digits, its narrow symbol (`$` in Hong Kong) and, for its formats,
  Intl's currency and accounting formats with a narrow symbol, matched
  against Windows' sixteen negative and four positive ones. A region's
  currency comes from a table, as Intl has none; an area of several
  countries (`419`, `150`) has Windows' XDR with no symbol. Formatting is
  Flash's: the number printed with nine decimals, then rounded half up to
  `fractionalDigits` (2 by default, Windows'; padded to a thousand at
  most, where adl crashes), grouped by `groupingPattern` (five fields at
  most), its digits from `digitsType` (`invalidAttrValue` for a
  surrogate, a noncharacter or past Unicode's last, `illegalArgumentError`
  past int's range), cut at a NUL as Flash's C strings are. Separators of
  four characters or more are illegal, and a NUL ends one. `parse` finds
  the first number anywhere, signed by the negative format around it at
  most a plain, no-break, narrow or ideographic space away, U+2212 a minus
  too; `parseNumber` and a currency's `parse` take a string that holds
  nothing else but spaces, a currency one space from its number and any
  more spaces its own.
- **Dates** are formatted by Flash's LDML pattern, interpreted here as
  Windows does: Gregorian, European digits, long and medium alike, a long
  month's genitive when a day is its nearest field, the letters it cannot
  format left out with `unsupportedError`, a run too long cut and an
  unclosed quote closed with `usingFallbackWarning` (and the pattern so
  kept formatted), an unknown letter or a pattern past 255 characters,
  counted past a NUL, rejected with `patternSyntaxError`, one that closing
  its quote takes past them emptied with `bufferOverflowError`, a NUL
  ending it. A pattern with the date (or one of the letters of it Flash
  cannot format) formats only Windows' dates, from 1601 to 14 September
  30828, a year past 65535 wrapping as a 16-bit year does, local times
  past JavaScript's range too, and gives `""` with `illegalArgumentError`
  otherwise; one of the time alone formats any. An invalid date is
  midnight of 1 January 1970 to a pattern without the date in UTC and to
  one of the date alone in local time, and refused otherwise. The
  locale's patterns are read off Intl's parts for its full date, its
  numeric date and its medium and short times, the cased letters of their
  literals quoted (`d 'de' MMMM`). The shortest weekday names are CLDR's
  short width, which Intl does not give: a cased script's short names cut
  to two letters, other scripts' short ones of two characters at most,
  else the narrow ones, and the short ones wherever that would name two
  days alike (Vietnamese, Portuguese).
- **Collation** is `Intl.Collator`, with Windows' word sort, hyphens and
  apostrophes compared last, `ß` as `ss`, symbols ignored with
  punctuation, and the empty string apart from one of what is ignored;
  width and kana are folded before comparing, as Intl has no options for
  them. `numericComparison` is kept and reports `unsupportedError`, as in
  adl, without changing the order.
- **Case** is mapped a character at a time, as Windows does: no locale's
  rules but Turkish, Azerbaijani and Lithuanian ones (Greek keeps its
  accents), a character whose full mapping expands taking its simple one
  where its decomposition gives one (`ᾳ` to `ᾼ`, Lithuanian `Ì` to `ì`).
- **LocaleID** fills in the script and region of the whole name from
  Intl's likely subtags (`zh-TW` is Hant), but for `und` and the codes
  Windows does not know (`ji`, `jw`, `sh`). `determinePreferredLocales`
  gives, for each locale wanted, those of its language and script: the
  same locale (as Windows names it, `zh-Hant-HK` being `zh-HK`), those its
  likely locale is, another locale wanted, other regions, then the
  language alone; `und` matches only itself.

What ICU's data gives differently from the system adl runs on, and so
the cases leave out: separators (French and Swiss German group with
U+202F and U+2019 where Windows has U+00A0 and an apostrophe; Arabic
locales' are Arabic; Russian's and Bulgarian's date spaces are no-break
where Windows' are narrow), symbols and formats of some currencies
(Egyptian, Iranian, Norwegian's, Indonesian's and Malay's position,
Turkish's parentheses, Curaçao's symbol), Finnish weekdays (`sunnuntai`
for `sunnuntaina`), German abbreviated weekdays without a dot, the
shortest weekday names where CLDR's short width is not two letters
(Spanish `DO`, Catalan `dg.`, Arabic, Thai), Korean day periods, kana and
width in collation, Windows' likely regions and scripts for some
languages (`ar` is Saudi Arabia's, `ckb`, `mzn` have none, `mo` is
Moldova's), script subtags, variants and keywords in Windows' resolved
names (`az-Latn-AZ`, `ca-ES-VALENCIA`, `de-DE@collation=phonebook`,
`zh-Hans-HK`), and `no` without a region. Chrome's ICU leaves out some
locales' data (Georgian, Armenian, Mongolian, Basque, Galician, Kazakh,
Irish, Hawaiian, Nynorsk among them): those fall back to the default or
format with ICU's root data. Windows' collation is its own in what it
ignores as a symbol (an emoji or ™ it does not) and in matching mode,
where a precomposed letter differs from its decomposition and "áb" from
"ab". Some pattern corners differ: a run cut short before an unclosed
quote (`MMMMMMM'`), and the unsupported `W` with invalid and early dates.
Local times far in the future follow the runtime's Date, which, as
avmplus, applies no daylight saving after 2038. The oddities of adl
under Wine are not reproduced: an era printed twice (`ADAD`), a lone `*`
grouping pattern grouping by eleven, astral digits printed as
replacement characters, a crash for a thousand fractional digits.
`getAvailableLocaleIDNames` lists each region's likely locale that Intl
supports, as Intl lists none.

### File dialogs

AS3's `FileReference` and `FileReferenceList`, and AS2's `flash.net`
versions, share `files.ts`: a host supplies selected files' metadata and
reads, and save destinations' writes, through `fileHost`. The browser's
host opens a hidden file input while transient user activation is still
present. `load()` reads the chosen File into a ByteArray. Saving asks
`showSaveFilePicker` where available; otherwise it starts a Blob download.
The latter cannot report whether the browser ultimately saved the file.
Without a host or user activation, a dialog reports cancellation in a
later frame, preserving the headless player's fallback.

Uploads encode multipart form data, or send the selected bytes directly
for `uploadUnencoded`; downloads fetch only after choosing a destination.
Unencoded uploads retain their URLRequest method and headers. Hosts still
decide which methods are allowed: the desktop SWF network permits GET and
POST and rejects PUT, while browser fetch can send PUT subject to CORS.
Both pass through the existing host fetch as `data` requests, retaining
CORS or the host's sandbox and policy checks. Completion and errors cross
into player frames. Cancellation and player destruction suppress stale
callbacks and abort transfers; progress reports the complete byte count,
not streaming increments. The browser has no creation timestamp and uses
the file's modification timestamp for creationDate as well.

The desktop host uses Electron's native dialogs. The main process checks
that a recent click or key requested the dialog, keeps paths behind
opaque IDs, and accepts reads and writes only for IDs granted by a dialog.
The renderer releases them on player destruction; navigation revokes them.
The unit tests exercise both VMs' bindings and transfers with controlled
hosts; the web tests exercise Chrome's actual file input and File reads.

### What a browser player lacks

Some of playerglobal stands for what the player does not have, and acts
as Flash does without it (the `system-natives` case). `Stage.stage3Ds` are Flash's four Stage3Ds, whose
positions are kept within -8192 to 8191, ArgumentError 2006 beyond, and
by default each request for a Context3D gets ErrorEvent #3702 in the next frame, as
Flash without a GPU gives, so content can fall back to the display list.
`stageVideos` is empty, and a `Video` is a box of the size it was made
at, 320 by 240 where either is 0, RangeError 2006 for a negative one,
which bounds, scales and hits as Flash's and shows nothing: no stream or
camera plays in it, and a timeline's DefineVideoStream is not read yet.
Camera and Microphone are Flash's on a machine with neither (the
`camera-microphone` case): supported, but `names` empty and no camera or
microphone to get; one made with `new` reads as zeros and nulls whatever
is set, its copies and setters throwing only TypeError 2007 for a null.
Once `getEnhancedMicrophone` is called, whatever it gives, every
Microphone shares one MicrophoneEnhancedOptions, copied in and out.
NetConnection has its local mode, `connect(null)`, with Flash's status
events and its properties, ArgumentError 2126 for those of a connection
it does not have; an HTTP URI is kept, and a `call` over it, Flash
Remoting, is not supported yet. `fscommand` goes to the host's
`fsCommand` if it gives one; the SWF chooses both strings, so a host must
never evaluate them or use them as a URL or as HTML. `Stage.color` is the
SWF's background until set, opaque; `Player.background` follows it, and
setting it moves `changes`, so a host that reads `background` as it draws
(as `@swf2es/web`'s `playback.ts` does) shows it, while one that reads it only when it makes
its renderer does not. The rest of the stage's properties are a desktop
browser player's (`colorCorrectionSupport` "unsupported", scale factors
1, no soft keyboard, orientation unknown). `getObjectsUnderPoint` gives
the descendants that draw under a point of the stage, parents first, as
Flash does, leaving out masks, a timeline's or a script's, and all an
invisible container holds, as the pointer's pick does;
`areInaccessibleObjectsUnderPoint` is false, there being no sandbox to
hide them.

The legacy `flash.xml.XMLDocument` is playerglobal's own code over the
runtime's XML tokenizer, avmplus' that E4X reads with too, exported for
it: `XMLParser.getNext` fills an `XMLTag` with each tag, an element's
attributes as an object, and playerglobal builds the tree and throws its
errors from the status (the `legacy-xml` case). `XMLNode`'s escaping
replaces the five XML characters.

### Workers

`flash.system.Worker` runs each background worker as a VM of its own on a
thread the host starts (`WorkerHost`, hosts.ts): its own codegen, runtime
and playerglobal playing the SWF `createWorker` was given, headless, its
frames on a timer at the SWF's rate (`workers/thread.ts`, the entry of
`@swf2es/player/worker`). `player-hosts` has the threads: `webWorkerHost`
starts module Web Workers, `nodeWorkerHost` node's `worker_threads`, each
given codegen's compiled module. A worker on the primordial's ABCs loads
the modules the primordial compiled, read from its cache or imported, in
place of compiling them (`scripting/handover.ts`). Without a host,
`Worker.isSupported` is false. `scripting/workers.ts` is what one VM sees: the primordial routes
every message between workers, and shared properties and channels' messages
cross as copies, made as avmplus' `ChannelItem` makes them, but for a
shareable ByteArray's memory, which the threads share where the page is
cross-origin isolated. What content needs, shared memory and
blocking, and the order the rest comes in are in
[docs/workers.md](workers.md).

### Shutting down

A page that takes its player away calls `Player.destroy`. No frame plays
after it: `advance` and `tick` do nothing. With scripts, `Scripting.destroy`
then stops every sound and closes the audio host (`AudioHost.close`, which
closes the browser's AudioContext, whose thread a page otherwise keeps),
terminates the background workers' threads, closes the Sockets' and
WebSockets' connections still open, and aborts
the fetches under way of the host's `fetch`. First it writes the
SharedObjects scripts opened and changed since they were read or last
written, as Flash wrote them as a SWF unloaded, so data a SWF set without
flushing is kept; never a removal, since an object whose stored file the
player could not read starts empty, and writing it back would lose the
save. Scripting wraps the hosts
it is given to keep each connection from its connect until either end
closes it or it fails, so the natives keep no list of their own. Left open, a
connection went on receiving and queueing for a player no one played,
its listeners holding the player. What the host made for the player, its
renderer, input bindings and loop, the host lets go itself, as
`@swf2es/web`'s element does.

### Rendering

A branch with at least 64 immediate art objects across its subtree owns
a Pixi render group. Children already grouped do not count again, so
wrappers do not all gain a group. Each group keeps its own instructions
and batches: changing an animated branch's children no longer repacks
unrelated scenery. Promotion persists when the branch shrinks, avoiding
repeated batcher destruction. Masks and their targets must belong to the
same group; references to partners outside a subtree prevent grouping,
and a mask moved outside an existing group removes that group. Timeline
masks stay with their siblings. A fresh view for BitmapData.draw does not
group. An off-list branch keeps its group hierarchy and batches for five
seconds so it can return without rebuilding. At most 64 groups that have never
returned are parked; new one-off branches evict the oldest batches. Evicted
batchers, up to 16 groups' worth (`render/batchers.ts`), go to the next group a view makes rather
than being freed while a new group allocates its own; a root rendered once,
as BitmapData.draw's, allocates its own, since Pixi destroys it after. On
WebGL 2 the batches are kept on the GPU alone (the fork's
`BatcherPipe.gpuResident`): every group's batchers pack into one set of
buffers per batcher kind, lent for each build and grown to the largest,
and what a build packed is written to the batcher's GPU buffers as it
ends; an element updated in place is packed apart and written, runs of
neighbours together, before the batches draw. A batcher kept its buffers
for as long as it lived, grown to the most it ever packed, so a renderer
of many groups held all their vertices on the CPU too: `bench.ts
--branches 64` held 45 MB of them. After a lost context, groups are built
again from the display list when needed (the fork's `RenderGroupSystem`). Elsewhere a
batcher keeps its own buffers, cut back once they stay mostly empty.
The colour batcher's shader ignores Pixi's group colour, since
its vertex colour transform already includes every ancestor. The
`render-groups` case checks colours, masks moved between branches, scrolls,
filters, and a branch shrinking and growing against Flash. The
`bench.ts --branches N --gpu` workload changes a quarter of N independent
coloured branches while the rest stay still.

An invisible group keeps clean instructions, but a structural or view
change retires its obsolete instructions and GPU batches. Transforms and
render callbacks still update; the group stays dirty until it is revealed.
Only the view's mask-contained groups opt into this through
`RenderGroupSystem.canDeferInvisibleGroup`. Host-owned groups, cached
textures and explicit render roots keep Pixi's existing update path.
Rendering a child as a root ignores the visibility of its scene parent,
as a bitmap draw requires. `hidden-render-groups` compares reveal,
reparenting and bitmap draws with Flash; `hidden-groups.ts` checks nested
masks and filters, context restoration and collection of retired objects.

A shape's fills are immutable `GraphicsContext`s shared by its instances
(`render/tessellate.ts`),
counted as they take and give them back, and destroyed once none has held
them for 5 s: kept for as long as their shape lived, every shape a long
session had shown kept its fills, their geometry and their coloured
copies, hundreds of MB. They are built
from Flash's edges (`display/shapes.ts`: each edge goes to its right fill
forward and its left fill reversed, joined into contours; one with the
same fill on both sides, a seam Flash Pro leaves inside a fill, goes to
neither, so it cannot change the winding, `shared-fill-edges`) and filled
even-odd through a containment tree of nonintersecting contours, holes cut: all of a
region's at once, before the islands in them, since Pixi's `cut()` also
lands a hole in the fill before the last once the last has one
(`fill-holes`). A contour is in another by a point of it off the other's
outline (`glyph-contours`). Crossing or touching contours instead take
`render/fill-polygons.ts`: an edge sweep finds their crossings, then each
horizontal band between vertices and crossings is filled as disjoint
trapezoids under its winding rule. Curves use the same fine chords as
rendering; separate convex contours skip the edge sweep. No overlapping
paint is needed, including for translucent fills, gradients, bitmaps and
masks (`crossing-fills`, `crossing-cones`). The resulting contexts are
cached as usual. A Graphics drawing used as a stencil mask uses non-zero
regardless of `drawPath`'s winding, while static shapes keep their authored
winding (`static-mask-winding`). Changing a drawing's mask role rebuilds
its fills, and a fresh view borrows only from the same role.
The detector excludes disjoint contour bounds and bounding boxes strictly
inside a convex contour before building edges. It reuses numeric scratch,
retaining at most 4,096 edges, contour records or levels after a call;
larger calls release the scratch. Band levels are collected only after a
crossing is found, and finished polygons own their coordinates separately.
`node --expose-gc tests/bench/fills.ts <ref> --allocs` compares construction
time and sampled allocations with the two render modules from a git ref.
Its lines (`render/strokes.ts`) are drawn in the stage's axes, because Flash
strokes a transformed line with one width all along, not the local width
stretched by the transform: so a line's context depends on the linear
part of its transform on the stage, and is kept by layer and that
transform, shared by every instance that sees the layer alike (a crowd
of one creature in step) and found again when one comes back to it (a
loop's next turn). A transform is a turn or a mirror times a symmetric
stretch, and a line scaled both ways is as wide through any turn of it:
such a layer's lines are stroked through the stretch alone and turned by
their Graphics' matrix, so a limb that turns on every frame, or a
squashed particle that spins, shares one context through every angle,
and a turn that keeps the stretch leaves its lines as they are.
The stretch is then settled on a grid of its logarithm, in a step of at
most 1/64 and fine enough that the lines' edges stand within a fiftieth
of a screen pixel of their place (`settledStretch`): stroked through the
grid's stretch and taken back by its inverse, the lines follow the path
exactly, and only their width sees the difference. A character that
breathes, scaling a percent or two on every frame, had a stretch for
each frame of each loop, and a crowd of them made its lines faster than
the cache could keep them; settled, a pulse has a few (`bench.ts --town
60`: 75,000 contexts in 300 frames, 2,500 settled, and a frame's sync
and draw from 9 to 2.5 ms). One with a line scaled one way alone, which turns with it, or a
transform near collapse, which rounding would distort, keeps the
transform exactly. Contexts are counted as instances take and give
them back. An object that leaves the list, and those of its
descendants that leave with it (not one moved to a parent on the list,
which draws it), keep what they drew 5 s, at most 1024 of them, for a
pool's object or a panel hidden and shown to come back to as it was
(`bench.ts --toggle N`, `--toggle-static N`); then they give their
contexts back, drawn again if they return, their lines for the screen's
scale of then. Their Graphics, emptied of their geometry, are kept, up
to 4096, for the next shape drawn to take: a frame-by-frame timeline
takes its children off and puts new ones on every frame, and making and
destroying their Graphics was most of a swap's cost (`bench.ts --rig N
--swap`). Pixi keeps a Graphics it has
drawn, with its geometry, for a minute after it was last drawn, and a
timeline that makes its children anew on every frame, as a goto back
does, so held gigabytes. A BitmapData's draw of an object off the list
borrows the stage's fills and lines where they are still kept. A
Graphics of a shared context (a shape's, a blend's or a glyph's fills,
or lines) does not listen on it, as no such context changes once built:
a listener a Graphics made each destroy search them all, so a text of n
glyphs of one font took O(n²) to go. Once Pixi has built a view's fills
or lines, their paths go altogether, the bounds measured and the vertices
weighed first (`render/tessellate.ts`, `remakeable`): Pixi draws them from
their tessellation, kept from its collection of what went unused for a
minute, which would build them again from their paths, and a batched copy
is made anew from the layer, which its shape keeps anyway. Kept, the
flattened points were a second copy of every outline, some 8 MB in
`bench.ts --town 200`. A glyph's fill, which every view shares, keeps
them, for each renderer to build it.
A line context no one holds stays idle 30
s, by the clock, not renders, which a host may make many of between
frames, at most 4096 of them and half a million of their vertices (some
70 MB), before it is destroyed: kept 5 s, a third of the lines a crowded
room made were ones it had made before and dropped, an animation's
rarer turns coming back after tens of seconds (`bench.ts --pulse 16
--pace 150`, whose stretches come round again some 7 s apart, made 11
contexts a frame kept 5 s and 2 kept 30). A drawing's lines
are its own, as it changes. No line is thinner than a pixel of the
screen, which is how wide Flash draws a hairline however far its stage
is zoomed: `PixiView.screenScale` screen pixels to a stage pixel, the
renderer's resolution unless the host says otherwise, as the test page,
drawing finer to average down, does. A host showing the stage at three
times its size so draws thin outlines a screen pixel wide, as Flash
does, not three.
Shapes are shared across SWFs too: a DefineShape tag whose bytes another
SWF defined alike gives that SWF's shape, held weakly, so a crowd whose
members each load the same SWF draws with one set of fills and lines, not
one per load, whose lines alone overran the idle limit and were
tessellated again on every turn of their loop. A shape filled with a
bitmap keeps to its own SWF, whose bitmap it is. A shape is drawn into its
layers when first asked for, not as its SWF is read: of the 17,000 shapes
a large application had loaded after ten minutes, 14,000 had no instance,
and their layers, 191 MB of the 222 MB all held, were never used. The tag
is read once as the SWF is, for the bounds and the bitmaps its fills take
as the SWF has them then, and again when it is first drawn; the SWF's
bytes, which its sounds and placements keep, are there to read it from.
A morph shape (DefineMorphShape, DefineMorphShape2) is two shapes whose
edges pair in order; a `MorphShape` shows their blend at the ratio its
placements give (`display/morph.ts`), a shape like any other, so it draws,
bounds and hit-tests as one. The blend mixes where the ends' points lie,
not their deltas, a straight edge paired with a curve as a curve, and
keeps them to whole twips, so a closed path stays closed for `display/shapes.ts`
to join. A morph keeps only its 64 latest blends, which instances in step
share, and which a looping tween finds again on its next turn: with 16, a
tween of 37 frames made each anew on every turn, its fills tessellated
again, some 400 shapes a second in a crowded room. A blend's fills are shared by the instances drawn at it, counted
as they take and give them back, and go once the morph drops the blend,
or idle 5 s, as a shape's do: a tween asks for a new ratio on each
frame, while a crowd in step, or a timeline that places the morph anew on
each frame, would otherwise tessellate the same blend for every instance. Its lines
are shared as a shape's, a blend's layers never changing. Flash takes a
new ratio on only as it draws: a script that moves the timeline and
asks for bounds before the next render gets the last drawn blend's
(`morph-shapes`, the corpus's `hittest_morph`). Only a timeline makes a
`MorphShape`; a script's `new` is refused, #2012.
Tessellating lines, round joins most of all, was the largest part of a
frame of a dozen animated instances; `bench.ts --rig N` measures it.
Fills and lines are drawn unbatched, each Graphics a draw of its own
geometry under its transform. Pixi batches small Graphics by packing
their vertices, already transformed, into one buffer, which it packs and
uploads again whenever its render group changes structure: on most
frames of an animation, whose timelines add and remove children. Larger
ones it draws alone anyway, so batches and those alternate, switching
programs at each. Unbatched, a shape's geometry is uploaded once: more
draw calls, but far fewer program switches and uploads, and `bench.ts
--rig 32` draws in half the time on a GPU and a quarter of it under
software GL. But a crowded scene is mostly still: of some 4,400 draws a
frame in a room of a dozen characters, half were in render groups no
timeline had rebuilt for seconds. A render group not rebuilt for 2 s has
its Graphics batched (`render/settle.ts`), each drawing a batched copy of its shared context,
as a colour transform does: packed once, as nothing rebuilds the group,
and drawn in a few calls, which took a frame's render from 17–18 ms to
15. Rebuilt again by anything but its batching, the group draws them
alone again.

Drawn alone, each Graphics was still a draw call of its own, binding its
context's buffers and setting its uniforms: of `bench.ts --rig 400`'s
main-thread render, 9,600 draws a frame, that was most. Where the
renderer is WebGL 2 with `WEBGL_multi_draw`, a transform table draws
them instead (`render/table.ts`): each context's local vertices are copied
once into one atlas buffer, as Pixi packed them for it, and Graphics
drawn alone one after another in a group's instructions make a run,
drawn as one multi-draw of their index ranges. Each draw reads its
transform and tint from a row of a float texture by `gl_DrawID`, so a
frame writes and uploads a row for each and moves no vertex, and the
shader is Pixi's graphics shader with the uniforms read from the row. A
context with a texture, a gradient's or a bitmap's, or a Graphics that
rounds to pixels, is drawn by Pixi's pipe in its place in the run, as is
all of a run in a context restored without the extension, or past the
rows a texture may hold. Contexts are placed on most frames of an
animation, its lines stroked for a new stretch, so only the vertices and
indices added since the last draw are uploaded: `bench.ts --rig 400
--fresh`, whose parts take a new size on every frame, uploads 0.5 MB a
frame where uploading the atlas whole sent 7. The atlas is kept on the
GPU alone: what a frame places is gathered in arrays of 65,536 vertices
and written in a call or two, and a full atlas grows by half with the GPU
copying what it held (the fork's `resizeOnGpu`), so no copy of it stays
on the CPU, where `bench.ts --town 200` held 127 MB of one; a lost
context's atlas starts again empty, its contexts copied in as they are
drawn. A context rebuilt or destroyed leaves a hole, and between frames
the atlas starts again from scratch once the holes pass 65,536 vertices
and the live ones, at half again what is live; the table never shrinks
from its peak. On a desktop GPU the render's main-thread time
fell from 9–10 to 2 ms on `--rig 400` and `--rig 400 --fresh`, 0.7 to
0.1 on `--rig 32`, 1.2 to 0.5 on `--rig 32 --swap`, 18 to 8 on `--rig
400 --swap` and 2.5 to 0.2 on the 2,000 shapes, with GL's own time
halved as well; under software GL the same. A filter ends a run, and
where creatures carry a dozen filters each, runs are a few Graphics
long: there a multi-draw cost Chrome's GPU process some 5 to 15 µs more
than its draws one by one, and saved the main thread under a microsecond
a draw. On `bench.ts --rig 128 --filtered K --gpu`, runs of 2 to 10
draws took a frame 1 to 5 ms longer than Pixi's own draws, and runs of
22 broke even, so a run of fewer than 16 draws, whether its contexts'
batches are fewer or a blend mode or a Graphics the table cannot draw
has cut it short, is not a multi-draw (`--min-run` times other
thresholds). It is drawn from the atlas a call a draw instead: its rows
passed in the uniform array at once, the atlas bound once, and each draw
told its row by a uniform, as `gl_DrawID` is 0 in a draw of its own.
Pixi's pipe, which drew such runs at first (`--no-loop`), binds each
context's buffers and sets each Graphics' uniforms. In a recorded crowded
scene, some 1,100 of 2,000 draws a frame came in such runs, between
filters; drawn from the atlas, the render took 13% less main-thread time
(15.3 to 13.3 ms a frame on average, with the two alternating in blocks
of frames in one replay), and on `--rig 128 --filtered 2 --gpu` a frame
went from some 21 to 17 ms, GL's own time from 7.7 to 5.8. A multi-draw
of those short runs saved no more main-thread time and cost GL more,
again. Under software GL the
table won at every length, by 5 ms on runs of 6, but a player's GPU is
what counts. A run of up to 40 draws takes its rows in a uniform array,
not the table texture, as an upload between draws cost a few µs more a
run (0.5 ms a frame on 128 runs of 22); a longer one uploads its rows in
one call, the whole lines they span if more than one. The rows are
uploaded between draws that read the table, which a driver may make wait
for the earlier draws (ANGLE on D3D11 or Metal, unmeasured). Small
Graphics under a Flash colour transform, and a settled group's, stay
batched copies with the colour batcher: drawn by the table, `--branches
64`'s few batches became 12,000 draws, which saved the main thread a
millisecond and cost GL two on a GPU, fifteen under software GL. A large
one, of 200 vertices or more as Pixi draws alone uncoloured, in a group
that has not settled, is drawn alone instead (`render/color.ts`,
`showFor`): a batched copy's vertices were packed and uploaded again with
each rebuild and each change of the transform, and a busy monster SWF
whose creatures, rebuilt on most frames, fade out under a tween packed
some 55 MB a frame of them. A flat one takes its transform in its row,
which grows to five texels with the multipliers, the offsets and a flag;
a Graphics Pixi's pipe draws, of a gradient or a bitmap, one that rounds
to pixels, or any with the table switched off, takes Pixi's graphics
shader with the colour batcher's colour, the transform in uniforms. Both apply it as the colour
batcher does, to the straight colour, the fill's times the Graphics' own
tint rounded to a byte, clamped and premultiplied after, and leave out
Pixi's group colour; where a renderer is not WebGL, every one is a
batched copy, those already drawn alone too as one is made
(`ColorAloneSystem`). A context is weighed before it is built, from its
paths' points (a line's by its joins, round ones some ten vertices a
point), as a part may keep the transform it first shows under. The
`color-alone` case draws large discs, gradients and bitmaps under changing
transforms each way, and `color-alone-runs` a run of 48 that the table
draws from its texture. `bench.ts --no-table` draws without the table, and
the `table-runs` case, with `draw-objects`, is played with the table
drawing even its shortest runs and without it, and must draw the same
pixels (`run.ts --table-ab` asks it of every case).

Flash anti-aliases by supersampling on a grid: none at low quality, 2×2 at
medium, 4×4 at high and best. The test page draws the same way, at that
many times the resolution without multisampling, averaged down, and its
frames then match Flash's to the pixel for straight edges, and within a
quarter pixel's anti-aliasing for curved lines and lines under a skew.
A case may give a zoom, as a host showing the stage larger does: the
page's resolution is then the zoom times the grid, and the stage is drawn
at the zoom's inverse, so the samples are the same and only Pixi's
arithmetic at that resolution, no whole number, differs.
Or it may have the stage shown at the zoom, as a game's page does, its
frames the zoom's size; Flash, which cannot, then draws a SWF the case
builds at that size.

### Drawing with Graphics

A `Shape` or `Sprite` draws with its `Graphics`, which records into a
drawing the display object keeps: the same layers of fills and strokes,
with their paths in pixels, that `display/shapes.ts` makes of a SWF shape, so
the renderer draws both alike. A fill begins at `beginFill` (or a
gradient or bitmap fill) and ends at `endFill` or at the next begin, not
at a change of `lineStyle`; what is drawn between is the fill's contours, each
`moveTo` starting one and each closed back to its start, filled even-odd
across them, as Flash fills. A contour left open is closed with a line
in the line style of the time, wherever it ends (`endFill`, the next
fill, a `moveTo`, or no end at all), and with none if there is no line
style then. The pen stays where it was, and a line or curve drawn on from
it after `endFill` takes the closing line away again, where a move, a line
style or a fill keeps it. A contour along one straight line has none, as
it would only retrace it, nor does a contour `drawPath` drew, which also
begins a contour of its own at the pen. The closing line is kept beside
the stroke's paths, drawn joined to the path it ends, and left out of the
bounds and hit tests, as in adl (the `line-close` and `line-close-probes`
cases). Where a half-transparent path meets itself, at a closed path's
start or a line back over itself, the page draws it darker and adl does
not; and adl fills a `drawPath` contour left open without closing it, in
bands to the shape's edge, where the page closes it: limits noted. A stroke begins at `lineStyle` with a
thickness and ends at one without, keeping the line's width, color,
caps, joints, miter and scale mode. `drawRect`, `drawRoundRect` and
`drawRoundRectComplex` are moves and lines with quadratic quarter
circles, as Flash's; `drawCircle` and `drawEllipse` are playerglobal's
own, over `curveTo`. `cubicCurveTo` adds a cubic command to the path
model; `drawPath` takes commands and data with a winding, which is that
path's: even-odd fills by the parity of the contours around a point,
non-zero by the sum of their orientations, so a square drawn inside
another the same way round is filled under non-zero and a hole under
even-odd, and one fill drawn with both rules in turn keeps each path's,
as Flash does (the `draws` case). Crossing contours and self-intersections
use the same rules through the renderer's disjoint spans, so even-odd
leaves an overlap empty while non-zero can fill it (`crossing-fills`).
`clear` takes everything and the styles away; `copyFrom` clears first
and then copies, so a drawing copied from itself ends empty, as Flash's
does (the `draws` case). The drawn order is the calls' order but for
lines, which draw over the fill they are drawn with: each fill begins a
layer, as a SWF shape's new styles do, and the lines drawn from then
until the next fill begins go in it, over the fill and under the next,
whenever their `lineStyle` was set; a line open as a fill begins goes on
in the new layer, and lines drawn before any fill are a layer of their
own (the `line-order` case). A sprite's drawing is under its children.

The renderer keeps a drawing's fills and strokes as it keeps a shape's,
per display object rather than per character, since a drawing changes,
rebuilt when the object's content changes; strokes go through the same
re-stroking as a shape's for their width under a transform. The drawing's
points, and its lines' half widths, give the object its bounds, for
`width`, `height`, `getBounds` and the hit tests to come. Gradient and
bitmap fills are recorded as a shape's are, and drawn as far as a shape's
are (the first stop); shader fills wait. An adl case draws in a `Shape` and in a
`Sprite` with a child, compared by pixels; the corpus's `graphics_*`
tests, which trace nothing, check that nothing throws.

`drawTriangles` draws as adl does (`display/drawing.ts`, the
`draw-triangles` case). Its triangles, three vertices each by the indices
or in order up to the first index past the vertices, go in a layer of
their own: each a fill of its own, so overlapping triangles never cancel
whichever way round they are, and the line, if one is set, around each,
its outline closed and joined, over them all. They end the open fill's
contour, whose closing line stays, and the line's path; both go on from
the pen, which stays where it was, in a layer after them, the contour
still closing to where it began. `culling` drops the triangles that turn
one way, `positive` those clockwise on the y-down screen: as they turn on
the screen, or in a BitmapData's draw, for what is drawn and the hit
tests, so a mirror drops the others (the layer's `mirrored` parts, which
`facing` puts in its place where the object's transform turns it over);
as they turn in the drawing's own space for `readGraphicsData`; and in a
3D object's own space within it, as its content is drawn into its bitmap
(the `draw-triangles-culling` case). A bitmap fill without `uvtData` fills through its matrix, as any
fill does. With `uvtData`, two or three numbers a vertex, only a bitmap
fill draws, the triangles textured and its matrix ignored; any other fill
draws nothing, nor its lines, though without a fill the lines draw. The
textured triangles are a layer's `meshes`, drawn after its fills by a
Pixi mesh of their own (`render/triangles.ts`, WebGL alone): u·t, v·t and
t a vertex, which the GPU interpolates straight and each pixel divides,
so t is a perspective. A 3D engine clears its Graphics and draws them
again every frame, so a redraw keeps the meshes, taken in place where the
layers lay out as before or from those the view keeps, with their
buffers, vertex arrays and shaders: new vertices go into the same
buffers, and every mesh draws from one buffer of indices in order. Kept
ones no content takes go after `IDLE_MS`, and all as the context is lost.
adl maps u and v from 0 to 1 onto the bitmap's first texel's centre to
its last's, wrapped there when the fill repeats
or clamped, a hair nearer 0 as its fixed-point steps come out, and
samples once a pixel at the pixel's top left corner: the nearer texel,
or the four around weighed when smoothed; a bitmap a texel high shows its
first texel throughout. The shader reads the texels itself, so the
texture's sampling counts for nothing, and every sample of a pixel the
page draws finer takes the pixel's value. Flash colour transforms apply
as the colour batcher's do. The bounds count every triangle given, culled
or drawing nothing, with the line's width if a line was set; the hit
tests count the textured triangles; `readGraphicsData` gives each
untextured triangle as a fill, a path and an end, the lines all in one
path, and leaves the textured ones out. Errors are adl's: vertices not in
pairs, or not three a triangle without indices, indices not in threes and
`uvtData` not two or three a vertex are ArgumentError 2004, a culling
not one of the three 2008, after them; null vertices draw nothing; a
`GraphicsTrianglePath` refuses a culling as it is set, 2008. Where an
open contour went on after triangles, adl reads it back from the pen to
where it began, and the player from where it began through the pen; and
a filter's output or a cached bitmap over textured triangles adl keeps
though the texture changes, which the player draws again; adl keeps them
over a path's bitmap fill too, so this is any bitmap fill's limit, not
the triangles'. adl hits a culled drawing's triangles where it last drew
them on the screen, so a hit test asked after a flip, before the next
frame is drawn, finds them where they were; the player's, where they
now are.

`readGraphicsData` reads a drawing back as Flash does, from the shape in
twips rather than the commands (`display/graphicsdata.ts`): each fill as
its fill, one path and an end; each line as the outline Flash strokes it
into, a nonZero fill of its colour, with its caps and joins; cubics as
quadratics; colours through Flash's premultiplied store; and with
`recurse`, its children's through their matrices. The `read-graphics-data`
case holds adl's output. Lines a few pixels wide and the outlines of
curves still stray from adl's by a twip.

### Bounds and hit tests

A display object's bounds are what it draws and what its children draw,
in its own space: for a shape from the SWF the rectangle DefineShape
recorded, with the lines' widths for `getBounds`, `width` and `height`
and without them (`edgeBounds`, where the shape has one) for `getRect`,
as Flash reports the recorded rectangles even where the shape's edges
disagree with them (the corpus's `displayobject_getrect`); for a
drawing, the extent of its paths, curves at their true extremes, with
the lines' half widths and square caps for the bounds with lines; for a
container, the union of its children's bounds, each through the child's
matrix, with its own drawing's. `width` and `height` are the bounds
through the object's own matrix, in its parent's space, or what that
would be for one with no parent, so a turned square is wider than its
side and a scaled shape never added is as wide as its scale makes it
(the `draws` case); setting one scales the
object so that the bounds come to the value, and leaves it when the
bounds have no extent to scale, as Flash. `getBounds(target)` and
`getRect(target)` take the bounds through the matrices up to the stage
and back down into the target's, or stay in the object's own for null.

What is reported is in twips, as Flash keeps positions: a turned square
of side 50 is 61.25 wide, not 61.237 (the `draws` case). Flash's bounds
of a line come out about half a pixel wider than its geometry with its
half width, by a rule not known yet, so the case reports its drawing's
`getRect`, which has the lines' paths without their widths. `scaleX`,
`scaleY` and `rotation` are kept apart from the matrix, as Flash keeps
them: see [Scale and rotation](#scale-and-rotation).

`hitTestPoint(x, y)` takes its point in the space of the main root, as
Flash does (the corpus's `displayobject_hittestpoint_root`: moving the
root moves nothing under the point, moving a loaded SWF's root does):
against the bounds, or, asked for the shape, against what is drawn, a
fill where the point is inside by the fill's winding rule, the parity
of its contours around the point or the sum of their orientations, as
the renderer fills it (the `draws` case hits the inner square of the
non-zero pair and not the even-odd one's), and a line where it is within
half the width of a path, children included. Flash finds nothing on an
object not yet drawn and off the stage, as the oracle's harness has a
document class in its constructor; the player does not model that.
The shape test samples half a pixel to the left of the point, on its
row, which is how Flash's answers on a shape's edges come out: a point
on its right edge hits, one on its left, top or bottom edge does not
(`displayobject_hittestpoint_boundary`, both ways round). The shape test
asks for a SWF's root above the object, the bounds test does not; the
stage counts as one, with the main SWF's `LoaderInfo`, so that what a
script puts on the stage itself has the stage for its `root` and takes
the pointer's hits, as a window over the whole movie does in Flash (the
`stage-hits` case). The stage's own shape test still hits nothing, as
adl's does, though its bounds test hits its children. `hitTestObject`
asks whether two objects' bounds in the stage's space overlap. The
corpus's `displayobject_getrect`, `_hittestpoint`, `_hittestpoint_root`
and `_hittestobject` are the reference, with the `draws` case.

### Scale and rotation

Flash keeps a display object's `scaleX`, `scaleY` and `rotation` apart
from its matrix, and the player does the same: the four are the object's
own, the matrix is made from them, and a matrix set whole, by a
`PlaceObject` or `transform.matrix`, is taken apart into them, the
scales by the lengths of its columns and the rotation by the angle of
the first, a skew by the second's. So `scaleX = -0.5` reads back as
-0.5 and halves the width, where a matrix taken apart would read 0.5 at
a half turn; and `width` sets `scaleX` to the value over the object's
untransformed width, positive, from a scale of 0 as well as from any
other, and a negative width changes nothing, as Flash has it (the
corpus's `displayobject_width` and `_height`, 4852 and 6052 lines of
ramps, in twips: a drawing thinner than one is no width, so `nan_scale`'s
`Number.MIN_VALUE` square is as good as none). A scale set stretches its
column of the matrix in proportion, so the other column stays exactly as
it was, and a scale set to NaN reads back NaN and zeroes its column; a
NaN rotation reads back NaN and leaves the matrix; a NaN position is 0
(`displayobject_invalid_floats`). Rotation is reported in Flash's
range, -180 to 180, both ends as given. The ramps
add to what the getters return, so each step's value rests on the one
before, and they part from the player where Flash's arithmetic does from
IEEE's: Flash Player's `-0.9981818181818182 + 1/550` is not the nearest
double to the sum, which the 32-bit player's x87 extended precision
explains, as it does the avmshell's (see [Testing against
oracles](#testing-against-oracles)); swf2es follows IEEE
doubles there too, so those two tests cannot be matched to the end.

`flash.geom.Matrix3D` keeps its 16 components in a `Float32Array`, in
`rawData`'s column-major order. Its constructor accepts a vector of exactly
16 values; otherwise it starts as the identity. The getter returns a new
`Vector.<Number>` each time, and the setter and copy methods round writes to
float32. `copyRawDataTo` pads a growable vector with zeros out to its index,
as adl does however far, but refuses an index from 2^28 on, a negative one
too, with ArgumentError 2004 before writing anything. Its arithmetic
(`display/matrix3d.ts`) is Flash's float32, to the last bit where adl was asked:
products and sums each rounded, `recompose`'s Euler angles through float32
sines and cosines, `appendRotation` with the axis made a unit one in
float32 and the pivot multiplied on, `invert` by Gauss-Jordan elimination
with partial pivoting in float32, and `decompose` making the columns
orthonormal one after another, so a skew goes and a mirror is the z
scale's sign. `interpolate` lerps the translations and scales and slerps
the rotations, and applies the scale after the rotation, as adl does;
Ruffle's corpus drops the scale. Before SWF 13 Flash had the determinant
of the other sign and turned about an axis as given, not a unit one, and
the player does so for such SWFs (`matrix3d-swf12`, `matrix3d-swf13`).
`pointAt`, a stub in Ruffle and Shumway, is adl's to a float32 rounding
or two (`point-at`): `at` turns to face the point from the matrix's
position and `up` to the world's (0, -1, 0), each made square to the
other; left out they are (0, 1, 0) and (0, 0, 1), not the documented
(0, 0, -1) and (0, -1, 0). The scales `decompose` finds go with the
facing frame's axes, x across, y up, z along `at`, and the skew it drops
stays, so a skewed matrix stays skewed; a direction of no length in
float32 leaves the matrix as it was, and a NaN makes it all NaN.
`Utils3D.pointTowards` interpolates a copy toward the matrix's
translation alone turned so, the percent held to 0 to 1, so its scale
goes to 1. `Utils3D.projectVector` and `projectVectors` divide as adl
does, which the Flash Player of Ruffle's corpus rounds further. A field of view a
focal length gives goes through `atan`, whose last bit Flash's C library
decides, so `perspective_projection`'s ramp matches only in part.

A display object goes into 3D once a script sets `z`, `rotationX`,
`rotationY`, `rotationZ` or `scaleZ`, even to what it was, sets
`transform.matrix3D`, or sets `transform.matrix` to null; setting
`matrix3D` to null takes it back to 2D at the identity, and setting a
matrix takes it back with that matrix (the `three-d` case, the corpus's
`displayobject_z` and `geom_transform`). In 3D `transform.matrix` is null,
and the properties are kept as set: a rotation is not brought within
±180, a NaN position or rotation is 0. `matrix3D` is the object's own
Matrix3D, live as adl's (`three-d-matrix`): the getter gives the same one
each time, which shares the object's matrix, so that what a script does
to it moves the object, its properties taken apart from it again (the
Matrix3D's natives tell its owner), and what the properties do shows in
it. Its copyToMatrix3D, copyRowFrom and copyColumnFrom change the
Matrix3D alone, as adl's do: the object is drawn and reports its
properties as before, from a copy of its matrix the view goes by, until a
property set writes that copy back into the Matrix3D (`three-d-matrix-shared`,
`three-d-matrix-silent`). A matrix3D set whole becomes the object's own, a clone of the same
values too, and is taken apart as `decompose` takes it; one that is
another object's is ArgumentError 2189, until that object lets it go
(set to null or another). A position set moves it alone, and a scale or
rotation set makes it again from all the properties, translation ×
rotation about x, then y, then z × scale, the angles' sines and cosines
taken of float32 radians, as adl's are to the last bit, and the
translation put in its column, so an infinite scale's column is infinite
where the rotation's is 1 and NaN elsewhere; an object with a NaN in its
matrix is not drawn. Each of these setters is a touch. A `PerspectiveProjection` of its own measures 500 pixels wide;
one a transform gives reads and writes its object's, as Flash's does,
which keeps the field of view in radians, the stage's 500 wide and the
others' as wide as the stage; the stage and each SWF's root always have
one, back to their defaults when set to null. `transform.pixelBounds` is
the bounds on the stage out to whole pixels.

### 3D display objects

A 3D object is drawn, bounded and hit in perspective, as Flash Player 32
(PepperFlash) and adl draw it (`display/perspective.ts`). Its projection is
that of the nearest container above it with one set on its transform, or
else its SWF's root's, or the stage's for one on the stage: the centre in
that container's own space, the root's at the stage's centre, and the
focal length the field of view's over the stage's width. Its matrix3D,
those of the 3D objects above it and the 2D matrices between go into one
3D transform to the container's space, which the projection divides, a
point at depth z drawn at f / (f + z) of its distance from the centre: a
3D object in another is in one 3D space with it, not flattened into the
other's plane (the `three-d-scene` case's green card in the blue). Each
object's plane is then a projective map of its space to that container's,
and a 3D object's `placed` matrix is its plane in its parent's, the
parent's inverse after its own: a `Projective` matrix, whose third row
`geometry.ts`'s functions divide by, so bounds, hit tests, the pointer's
pick, `mouseX`, `localToGlobal` and `globalToLocal` follow it as they
follow any matrix, and 2D objects pay one test. It is kept on the object
until anything is invalidated, as an ancestor's move changes it.
`local3DToGlobal` projects a point of the object's 3D space so, which
Flash reports to a quarter pixel; `globalToLocal3D` is the point of the
object's plane under the stage's, at z 0.

Bounds through a plane are out to whole pixels, as Flash reports them:
a turned card's `width` is its drawn width (`three-d-flip`). An edge that
passes a whole pixel by less than an eighth of one is not counted to the
next, as adl reports fourteen edges of `three-d-bounds`. A 3D object's box
in another space is that box on the stage (its projector's space), taken
there as a box: so under a turned 2D parent, its box in the parent is the
box of a box, larger than what is drawn; in a 3D parent, it is through
its flat matrix, without perspective, as its `width` is. A 2D object's
box in a space it shares a plane with is measured only up to where the two
meet. adl reports a 3D object's `concatenatedMatrix` as null, and that of
a 2D object in one in the space of the bitmap the 3D object is drawn into:
up to the 3D object, then two pixels out from its bounds' top left out to
whole pixels. `localToGlobal` through a plane is to a whole pixel and
`globalToLocal` to a twip. Before a 3D object is first drawn, adl's bounds,
concatenated matrices and points of anything on its list are not yet
made, its concatenated matrices five times their size, and the cases read
them a frame later. An object with a
corner of its bounds at or behind the eye (f + z at most 0) Flash draws
none of, takes no hit on and counts in no bounds; its own bounds are an
empty rectangle at the origin. `hitTestPoint` without the shape flag
tests the box around what is drawn on the stage, and the pointer picks
where the plane is drawn (`pointer.test.ts`, against Flash Player 32's
traces). Siblings are drawn in the list's order, whatever their depths.
A 3D mask masks nothing, and is not drawn; set on a 3D object, it leaves
none of the object drawn.

Flash draws a 3D object from a bitmap of what it and its children draw in
its own space, a texel a pixel of that space whatever its scale, its
parent's or the stage's zoom, then draws the bitmap smoothed through its
plane; so a 3D object scaled up is blurred, a texel magnified, where a 2D
child scaled up inside it is sharp, and its filters are in its space and
turn with it. The colour and alpha of all above it go into each of its
fills in the bitmap, so a card under a half-transparent parent shows its
own white square paler than its edge, not as a layer faded whole; its
blend mode composites the drawn bitmap, its filters' result included,
with what is behind it (`three-d-filter-blend`); and its
scrollRect counts for nothing, Flash drawing, bounding and hitting all of
it (`three-d-mixed`, the same in adl and Flash Player). The view does the
same (`render/three.ts`): the object's container is in a holder of its
own, coloured from the stage down, drawn before the stage into a texture
of the object's bounds (filters' reach included) out to whole pixels, at
4 samples a side averaged down to a texel a pixel in one pass, as the
stage's edges are anti-aliased, with a texel of nothing around; in its
place in its parent is a quad of the texture's four corners, each with
the w its plane gives it, so that the GPU interpolates in perspective,
which takes none of Pixi's colour and carries the blend mode. Where the
samples would pass the GPU's largest texture or 4M texels, fewer are
taken; past 2048 texels a side, the bitmap holds less than a texel a
pixel, and its lines and filters are made for the units it is drawn at.
Textures are kept in sizes of 32-texel steps, so an object whose
children move each frame keeps its bitmap and the pool's intermediates.
A 3D object in another draws its quad into the other's bitmap, by its
plane in the other's space, so the two are drawn deepest first. Its
hairlines are a texel. The bitmap is drawn again only when what is in it
changes, not as the object moves or turns: 100 turning 3D rigs of 12
parts each, all animated, take some 1.9 ms of sync a frame, and turning
alone 0.1 ms. As adl and Flash Player measure it, the bitmap is drawn a
texel wider and taller than it is, about its centre and half a stage
pixel right and down, which at a texel a pixel keeps its left and top
edges in place; and sampled once a pixel of the stage, at the pixel's
centre, which the shader does for each of the target's samples of the
pixel where the host says how many there are (`screenScale`), as the test
page does; the evidence for that last is mixed, edges matching better
with it and magnified bitmaps no worse. A BitmapData's draw of an object
on no stage projects what is in 3D in it as on a stage the bitmap's
size, centred on it, as Flash does.

A 2D mask set on a 3D object clips the bitmap, in the object's space, as
adl shows (`three-d-mask`). One in the object clips it there as it would a
2D object. One outside it is placed by its matrices up to the nearest 3D
object above it, or the stage, and then moved as if the bitmap's corner,
the top left of the object's bounds in its own space, were where the top
left of its bounds is on the stage, rounded to a pixel: so a band over a
turned card leaves a strip of the card that is not under it, and a card
nearer the eye has its part under the mask magnified. The view draws a
copy of the mask's Graphics and sprites in the plane's holder, which
clips the object's container there, and keeps the mask itself out of the
stage's build. The copy, and the object's bitmap, are made again only
when the mask's place in it, which follows the object's bounds, or what the
mask draws has changed (`three-d-mask-moving`): a still card under a still
mask keeps its bitmap, as one with no mask does. Flash's mask cuts at whole
texels, the view's at a quarter of one, so the edges fall up to a texel
apart. Under WebGPU, which the quad's shader has no program for, a 3D object
draws as its matrix3D's x and y rows.

adl draws through a focal length for a stage 500 wide whatever the SWF's,
and a projection set on the root as if it were not, where Flash Player
draws as its bounds and `local3DToGlobal` say, in both: the player follows
Flash Player, and the `three-d-*` cases, whose references adl draws, have
stages 500 wide and leave the root's projection alone. Flash's
anti-aliasing of the bitmap's edges and its hairlines' place in it (a
pixel's row, where the view straddles two) differ by a level or a pixel
at edges, within the cases' tolerance. For an object hidden behind the
eye adl still projects its 2D children's bounds through the negative w,
and `hitTestPoint(0, 0, false)` on it is true; the player gives such an
object no bounds and no hits.

Left as they are: adl composes a 2D matrix a scale or rotation setter
makes in 16.16 fixed point (scale cut, sines and cosines rounded, so
`rotation = 30` reads `a` 0.86602783203125 and `scaleX = 0.1` reads
0.0999908447265625, a scale below 2^-16 nothing), in 2D as well, and it
goes into the matrix3D as the object enters 3D; a scale set after a whole
matrix makes all four of its numbers again. The player keeps doubles, and
stretches a column in proportion as the corpus's `displayobject_invalid_floats`
has Flash Player do: matching it is a change to every 2D matrix, for
differences below 2^-16 of a scale, and shows in bounds in a turned
parent to a twip. A hairline in a 3D object's bitmap straddles two texel
rows where Flash's covers one, as on the stage.

### Nine-slice scaling

A sprite, movie clip, button or `Shape` with a grid, its symbol's
`DefineScalingGrid` (a character id and a rectangle in twips, which
`format` reads and the timeline keeps on the sprite or button character
for its instances) or the `scale9Grid` a script sets, draws its shapes
sliced (`display/scale9.ts`): its own drawing or shape, and its `Shape`
children's, each vertex, taken through the child's matrix, moved by a map
of each axis through the edges of the bounds the grid divides and the
grid's, so that in its parent's space the corners keep their size, the
edges stretch one way and the centre both. Scaled smaller than its
corners, they share the size in proportion and the centre has none. Its
sprites, texts and bitmaps, and the shapes in them, scale as ever, and so
do its bounds, `width` and `height`. What adl showed, on panels of
coloured bars measured to the pixel:

- The bounds a grid divides are what the object draws, without lines,
  and what each child draws itself, in the child's own space, its matrix
  ignored, and nothing of a grandchild's, a text field's or a static
  text's: a child's bars
  moved 30 to the right leave the edges where the panel's are (its bars
  then pass the corner at the corner's rate), a child sprite's drawing at
  110 to 120 moves the right edge to 120 wherever the child is placed or
  however it is scaled, a grandchild's moves nothing, a bitmap's or a
  video's counts. A SWF shape's are its recorded bounds, its lines with
  them; a MorphShape's are its blend's at the ratio it is drawn at, from
  the frame that sets the ratio: the panel slices by the new blend as it
  draws it, though the morph takes the blend only in its own draw.
- The map goes by the object's own matrix, not its place on the stage: a
  grid under a parent scaled 3 and itself unscaled changes nothing, and
  one scaled under a turned or mirrored parent is sliced, its corners
  their size in that parent's units.
- It slices only under a scale alone: `a` and `d` positive, `b` and `c`
  under a 4096th (adl slices b = 0.000244 and not 0.0002442, a 16.16
  fraction under 16). Turned, skewed or mirrored, it scales as ever.
- Only vertices move, curves' control points too: a triangle's long side
  across the regions stays straight, a quadratic from 0 to 40 under a grid
  at 20 bends to its moved end, and a fill's gradient or bitmap stretches
  as ever. A line is as wide as the owner's parent's transform makes it,
  for every scale mode, times a `Shape` child's own scale: a 2 pixel line
  in a child scaled 2 is 4 wide whatever the owner's scale.
- A grid not strictly inside those bounds both ways, as they are when it
  draws, is ignored, so one on a fill's edge does nothing, but one on a
  SWF shape's fill edge inside its lines' recorded bounds slices.
- A scrolled object slices in its drawing's space and then scrolls: a
  `scrollRect` from -20 moves the sliced bars 20 of its units over.
- A mask is not sliced, in drawing or in hit tests: neither an owner that
  is a mask nor a `Shape` child that masks a sibling, by a script's `mask`
  or a timeline's clip layer, common in a 9-slice symbol, nor an owner
  inside a mask, which a shape test hits nothing of, as of any mask and
  what is in it: what the mask clips is hit where its unsliced drawing
  is. Neither is what `BitmapData.draw` draws through its matrix,
  whatever the source's own scale; a sliced object inside what is drawn
  is.
- A `Shape` moved from a sliced sprite to a plain one draws unsliced, and
  one moved the other way, or between two grids, takes its new parent's.
- A button slices the state that is one shape; a state of several
  characters is a sprite of them, and scales as ever.
- Hit tests find what the slice draws (`display/bounds.ts`), the point
  against the sliced layers, kept by the slice's key, but only within the
  bounds the shape has unsliced, its own, lines included, in its own
  space: in a panel 100 wide scaled 2, a bitmap child 130 wide stretches
  the panel's fill to 230 and it is hit to 200; a bar of its own at 88
  drawn at 218 is not hit; a Shape child's fill from 10, drawn from 10,
  is hit from 20; a line to 110 hits the fill to 220. Between a change
  and the next draw, adl's hit tests still find the slice last drawn, or
  an owner's redrawn shape unsliced; the player's find the new slice.
- `scale9Grid` reads x, y, width and height each cut toward 0, a tag's
  grid of 20.5 to 80 as (20, 59 wide). The setter keeps them so cut, and
  then, for a grid not strictly inside the bounds it divides as given, or
  for an object with none, throws ArgumentError #2004, keeping it; null
  takes it away.

The renderer reshapes the layers when a slice applies, keyed by its
edges and, for a `Shape` child, its matrix, and a drawing's version, which
Graphics counts as it changes the drawing in place, and draws them as a
drawing's are, fills and lines its own, not the shape's shared ones: a
panel rebuilds as it is resized, not on every frame it is drawn. The slice
is computed again only on a sync where the owner's scale, grid, drawing,
children or a direct child's drawing changed, a `Shape` child's matrix or
parent, or a mask role, not as anything moves: a sliced panel dragged
across the stage for 40 frames, under a moving parent and with an
animated grandchild, made its slice and its sliced layers once, on the
first frame, and slicing allocated nothing after. A drawing keeps its
bounds per version, and an object its last slice, which a hit test finds
again rather than making on each pointer move; a set of layers keeps its
four latest slices, for instances of one symbol at a few sizes. The line
of a sliced shape is stroked through its stage transform as ever and as
wide as above. The `scale9` case draws panels with `DefineScalingGrid`,
stretched, shrunk past their corners, turned, flipped, in a button, on a
fill's edge, with a half-pixel grid, with a sprite in them, and a script's
grids, refused ones too, and rescales some on its second frame;
`scale9-changes` changes what the grid divides, moves, redraws, adds and
removes children, turns a parent, gives a Shape a grid of its own, draws
through `BitmapData.draw`, masks, scrolls and hit-tests a curve across
the grid; `scale9-hits` hit-tests panels whose children widen what the
grid divides, from the start and as they change, and a panel inside a
mask, and draws one whose MorphShape child changes ratio. Flash snaps
straight runs of lines to whole pixels, which the player does not, so a
grid's lines at half pixels part from it there as unsliced ones do.
Flash's hit tests on a curve land about half a pixel lower than the
player's, sliced or not.

### Bitmaps

`BitmapData` is a pixel store: a `Uint32Array` of ARGB pixels,
premultiplied by alpha as Flash keeps them, so `setPixel32` premultiplies
and `getPixel32` divides back, with the rounding Flash's does (Ruffle's
`bitmapdata_accuracy` tabulates every alpha and value; adl is the judge of
the rule); a bitmap made opaque keeps every alpha at 255, and `getPixel`
answers without the alpha. The constructor refuses a side under 1 or
past 2^31 / 20 (107,374,182 passes), and more than 536,625,144 pixels
whatever the shape (32752 by 16384 and 65513 by 8191 pass in adl, 32753
by 16384 and 65514 by 8191 not), with ArgumentError 2015, as it does an
allocation the browser refuses: Flash's old limits, 8191 a side and
16,777,215 pixels, are gone; `dispose`
empties the store, after which every read, the size included, throws
2015, and a second `dispose` is nothing. `copyPixels`
into an opaque bitmap composites source over destination whether or not
`mergeAlpha` asks, as Flash does. `fillRect`, `copyPixels`, `getPixels`
and `setPixels` (ByteArrays of ARGB words), `getVector` and
`setVector`, `clone` and `rect` work on that store, clipped to it, a
Rectangle's edges rounded to the nearest pixel and a half to the even one,
as Flash rounds them (`bitmapdata_rectangle_rounding`), each edge, x and
x + width, clamped to 2^30 - 1 either way and NaN made int's least
(`pixelEdge`): under adl an x of NaN or Infinity covers nothing, a width
of Infinity reaches the bitmap's edge, and a copy's point moves by the
clamped edge. `colorTransform` alone takes a height of NaN to the bitmap's
foot from a top past 0, the height wrapping in int arithmetic; `merge`,
`copyChannel`, `paletteMap`, `threshold` and `pixelDissolve` take a
negative size as the rect it spans back over (`spanRect`), the others as
none; `applyFilter` refuses with 2015 what adl cannot make the buffers for
(`filterRefusal`). A Point's coordinates are truncated toward 0 (the
destination, alpha and hit-test points of every operation alike, under
adl: 3.7 is 3, -1.5 is -1; NaN, or past int's range, off the bitmap). A
source rect past the source's edge is clipped and the point moved with it;
`copyPixels` in place that moves right and down by no more than its rect's
size writes the rect whole instead, and what lay left of or above the
bitmap comes out empty (`copyGaps`; adl reads an opaque bitmap's as 0,
alpha and all, and draws it black, which the store keeps as opaque black;
a transparent one's are whatever its memory held, kept transparent; the
`bitmap-rects` case).
`copyPixels`
copies in place in Flash's order, which within one store reads what it
already wrote in one direction (rows bottom-up only when the copy moves
down without moving left, columns right to left when it moves right;
`bitmapdata_copypixels_self`); `merge`, `paletteMap`, `threshold` and
`copyChannel` in place go rows down and pixels along, each pixel read as
the ones before it left it, and a colour matrix's `applyFilter` by fours
from each row's start; `pixelDissolve` in place dissolves the source
rect, wherever the point is; an alpha bitmap scales each premultiplied
channel by its alpha, 256 for 255, shifted down 8, and leaves the
destination as it was where it does not reach; compositing is
s + ((d * (256 - sa)) >> 8) a channel (`bitmapdata_copypixels_alpha_*`).
A Bitmap watches its store, held weakly by it, so a pixel set marks it for the renderer
without keeping a Bitmap taken off the display list alive,
which uploads the same texture again; `lock` and `unlock`
do nothing, as a store drawn from each frame needs no batching. A
`Bitmap` is a display object of its own kind (`BitmapObject`): its bounds
are its data's size, and the renderer draws it as a sprite whose texture
is uploaded from the pixels and again when they change, which the store
counts in a version the node compares.

The pixel operations that read and write the store alone are in
`bitmap/ops.ts`, beside the store and its premultiplied arithmetic in
`bitmap/bitmap.ts`: `noise` and
`pixelDissolve`, whose pseudo-random sequences are Flash's own and fitted
to the values Ruffle's corpus recorded of it; `copyChannel`,
`colorTransform`, `merge`, `scroll`; `threshold`, `hitTest`,
`getColorBoundsRect`, `floodFill` and `histogram`. Each works on the
pixels as Flash does, premultiplied or not as its results show, and each
is checked by the corpus's traces and a case's trace under adl (the
`bitmap-ops` case). The rules fitted: `noise` is Park-Miller's minimal
standard generator (x · 16807 mod 2^31 − 1, a seed of 0 taken as 1 and
one below as −seed + 1), one draw per channel, R, G, B and then alpha on
a transparent bitmap alone, a value `low + r % (high − low + 1)`;
`colorTransform` reads a channel back as p · 255 / a floored, applies
(c · ⌊m · 256⌋ >> 8) + ⌊offset⌋, alpha alike, and writes it premultiplied
as c · (a + 1) >> 8, leaving a pixel of alpha 0 alone; `merge` is
((s · m + d · (256 − m)) >> 8) & 0xFF with the multiplier a uint and
nothing clamped; `copyChannel` from more than one channel copies 0;
`getColorBoundsRect` gives an empty rect where the one pixel found is the
origin; a point or rect `hitTest` never hits alpha 0, and it refuses
with ArgumentError 1508 a first point, or a second bitmap's, the bitmap
would reach past int's range from; `draw` moves its matrix in twips in
an int, so NaN draws at 0, and so does a move past the int's range,
Infinity too, for a matrix that only moves (one that scales draws it
nowhere), while one within 2^30 twips of the ends wraps round to near 0;
`pixelDissolve`
visits the rect, clipped to both bitmaps, in Flash's own order, a Galois
LFSR over ⌈log2 w⌉ + ⌈log2 h⌉ bits whose taps for every width from 2 to
26 bits were read off adl, a state standing for (s & (2^bw − 1), s >> bw)
and skipped outside the rect; each call writes numPixels and returns the
next state; every call writes the origin too, 0 starts at the tap, a
seed past the states steps down to them as any state does, its bits
shifted out, or to 0, which writes the origin from then on, a count of 0
or a rect a pixel wide or high gives the seed back, and a count past the
w · h − 1 states a round visits is one round and the remainder, which
gives Flash's seed without its loop (Flash itself takes seconds over
2^31 − 1). `paletteMap` makes each copied pixel the sum, wrapping at 32
bits, of its unpremultiplied channels' entries in the four tables, a
missing table its channel itself; `compare` is 0 for the same pixels,
-3 and -4 for another width and height, or a new transparent BitmapData
of each differing pixel's colour difference, opaque, or where only alpha
differs of the alpha difference in every premultiplied channel (the
`palette-compare` case). `perlinNoise` is the reference implementation of
SVG's feTurbulence, which Flash's matches to the byte (`bitmap/turbulence.ts`,
after Ruffle's port): Park-Miller seeds four channels' gradients, each
octave moved by its offset, a channel's noise drawn from the next of
the four only for the channels asked for, a byte made of it as Flash
makes it, and the pixel written as it comes, not premultiplied (the
`perlin-noise` case). A double past an int converts as on x86, to -2^31,
so that octaves enough to take the lattice that far give Flash's wild
noise and bytes of 0; more than 1024 octaves give what 1024 do, as
Flash's sum settles long before, a negative count among them. A
negative base is taken as its size, and stitching fits each frequency to
its own side, without the reference's slip of the y frequency's floor
from the x one (adl).

#### Drawing into a bitmap

`draw` and `drawWithQuality` take one of two paths. A
BitmapData or a Bitmap drawn is composited on the CPU, by `drawBitmap`
in `bitmap/ops.ts`: through the matrix by the inverse of each destination
pixel's centre, nearest or bilinear as `smoothing` asks, the colour
transform as `colorTransform` applies it, then the blend mode (normal,
`alpha`, `erase`, `multiply`, `screen`, `lighten`, `darken`,
`difference`, `add`, `subtract`, `invert`), all clipped to `clipRect` and
the bitmap. Any other display object is drawn by the renderer: the
Scripting has a `drawer` the host sets once its renderer exists, before
the document class is constructed, which renders the object's subtree
through the matrix into a texture of the bitmap's size and reads it back
synchronously, as WebGL's readPixels allows, to composite as a bitmap
source is; without a renderer, as in node, drawing a display object is
not supported. The snapshot renders only the object's bounds through
the matrix, a pixel wider, within the clip and the bitmap, so its cost is
the object's size, not the bitmap's; at 4 × 4 samples a pixel averaged
down, as Flash covers edges at its high quality (`drawWithQuality` takes
1, 2 or 4 for low, medium and high), in a fresh view
that leaves the objects' dirty flags to the stage's. The view borrows
from the stage's what is still current: an object's fills while its
content is unchanged, its lines while its transform on the stage is the
draw's too, and a Bitmap's texture while its pixels are, so a draw of
the stage builds no geometry; it builds lines at the draw's own scale and
renders the whole n times larger, so curves are no finer than on the
stage. The samples are averaged on the GPU, halved by linear filtering
at the corner four texels share, and only the final pixels are read
back; a snapshot is composited unscaled at a whole pixel, which copies
each pixel straight. A 1920 × 1080 stage of 1,500 outlined shapes draws
in about 110 ms on a desktop GPU against Flash's 44 (from 810 before),
most of it the wait for the GPU before the read.

Each rule of a draw is Flash's
as the `draw-bitmaps` and `draw-objects` cases trace and draw it under
adl: a destination pixel takes the source pixel under its centre,
clamped to the source's edges; the translation is snapped down to
quarter pixels before rasterising, which the 4 × 4 coverage reads exactly
(a move of 0.49 covers three quarters of the left edge pixels); `normal`
is the store's source-over; a Bitmap draws as its data, its own transform
ignored, as any source's is, and its own colour transform too, though
not its filters (`filtered-colors`); a BitmapData drawn into itself goes a row
at a time, top down, every pixel of the row read before one is written,
so a move right keeps the pixels and a move down smears rows, while
through a Bitmap of itself it goes in plain scan order and smears both
ways; `alpha` and `erase` do nothing to a bitmap
drawn, which has no layer; `invert` ignores the source's colour; a fill's
alpha is a byte floored, 0.5 being 127, on the stage as in a draw. The
other blend modes follow the W3C's compositing and are judged by the
frame, within 2 a channel.

#### Bitmaps on the GPU

A bitmap's pixels are kept where they were last written, as
Ruffle does (its `DirtyState`). With a renderer, a store has a GPU
texture in it, one a renderer, made when a Bitmap first shows it or a
draw first renders into it, holding the store's premultiplied ARGB exactly, uploaded and read
back as they are, never premultiplied or divided on the way; every
Bitmap showing the store samples that one texture, nearest, and a
smoothed one a second, linearly sampled copy made on the GPU as the
first changes, since a texture's sampling is its source's in Pixi. A store is newer on
the CPU or on the GPU: a CPU operation that changes it uploads the whole
store before the next render that needs it, as now, while `draw` of a
display object in the `normal` blend mode with no colour transform
renders straight into the texture, the samples averaged as above and
the last halving composited source over at the reach, and leaves the
store newer on the GPU. Reading `pixels`, which every CPU operation does,
first reads the texture back if the GPU's copy is newer, once, so a
script that draws the stage into a bitmap and shows it never waits on
the GPU, and one that then calls `getPixel` waits as before. Any other
draw (another blend mode, a colour transform, a bitmap source) stays
the CPU's, after that read. A store a draw left newer on one renderer's
GPU is read back through that renderer before another uploads it.
Without a renderer, as in node, a store is the CPU's alone. GPU compositing rounds source over in floating point
where the CPU's is Flash's 8-bit arithmetic, which parts by at most 1 a
channel. A texture lives as long as its store: `dispose` frees it, and a
store collected frees it through a FinalizationRegistry; Pixi's texture
collector never unloads it, as a texture newer than its store cannot be
uploaded again. A store larger than the GPU's texture limit stays the
CPU's. A texture starts with no bytes, and a store whose pixels are all
one colour, as a new bitmap's are, is cleared to it on the GPU rather
than uploaded; the scan that tells stops at the first pixel that
differs. The stage of 1,500 outlined shapes above draws into a new
1920 × 1080 bitmap in about 38 ms against Flash's 44, and with a
`getPixel` after it in about 65.

#### A SWF's bitmaps

A SWF's bitmap characters are `DefineBits` with
`JPEGTables`, `DefineBitsJPEG2`, 3 and 4, and `DefineBitsLossless` and 2.
`format` reads a tag into either pixels or an image to decode. The
lossless formats are pixels, inflated with the zlib `format` already has:
format 3 a palette of RGB, or RGBA with the 2 tag, and rows of indices
padded to 4 bytes; format 4 15-bit RGB, each 5-bit channel v widened
to v · 8 + 7 and 0 kept at 0; format 5 xRGB, or with the 2 tag ARGB
already premultiplied, which the store takes as it is. The JPEG tags are
an image: the JPEG, PNG or GIF bytes, with a JPEG's stray `FF D9 FF D8`
before its start dropped and a `DefineBits` tag's tables spliced in from
`JPEGTables`. `DefineBitsJPEG3` adds zlib'd alpha, one byte a pixel,
which goes beside the JPEG's colours as though they were premultiplied
already, so a colour above its alpha reads back as 255 (swf2es clamps it
to the alpha, which reads the same and keeps the store valid); a PNG or
GIF in it keeps its own alpha and the tag's is ignored, as Flash ignores
`DefineBitsJPEG4`'s and shows it opaque, though reported transparent. A
PNG's or GIF's alpha is premultiplied with the product floored, and the
bitmap is transparent. The player decodes the images when the SWF is
linked, beside its code, before its scripts run, through a decoder its
host may give and otherwise the browser's: WebCodecs' `ImageDecoder` for
a PNG or GIF, whose frame is copied as it is, straight alpha (its RGBA
conversion goes through premultiplied values and loses low alphas'
colours), and `createImageBitmap` through a canvas for a JPEG, which is
opaque; no JPEG library comes along. Flash's JPEG decoding matches
Chrome's to within 2 a channel at 4:4:4, but at 4:2:0 Flash's chroma is
neither repeated nor interpolated as libjpeg-turbo's is: it is smoother
than both, as IJG libjpeg 7's scaled inverse DCT upsamples it, which a
decoder that gives only pixels or planes cannot reproduce; such a JPEG
differs by some 6 a channel on average and up to 40 at sharp colour
edges, and `DefineBitsJPEG4`'s deblocking is not applied. A decoder of
swf2es's own would close both.
What Flash cannot decode is a bitmap of
0 × 0, not transparent, whose size and `rect` read and which `dispose`
takes, while every other method throws ArgumentError 2015: a corrupt
image, a `DefineBits` without `JPEGTables`, and a lossless tag written
with the short tag header, which Flash refuses whatever its data (the
long header, as Flash Pro writes, takes the same bytes). A class
SymbolClass binds to a bitmap and that extends `BitmapData` is
constructed with a copy of the pixels, the size its constructor passes
ignored (0 by 0 and −5 by 100000 alike); one that extends `Bitmap` gets
a new plain `BitmapData` of them each time. Placed on a timeline with
PlaceObject3's `HasImage`, as Flash Pro places one, a bitmap is a
`Bitmap` of its own copy, smoothing off and pixel snapping `auto`, its
data an instance of the bound class constructed with (1, 1), else a plain
`BitmapData`; without `HasImage` Flash takes the bound class for a
display object's and throws TypeError 2022, which swf2es does too.
A class SymbolClass binds to a `DefineBinaryData` and that extends
`ByteArray` starts with its bytes, at position 0; its instances share
them, each seeing what another writes until one is resized, as under adl
(the `crossbridge-runtime` case). Crossbridge keeps a C program's data
so. That case also has what Crossbridge's start asks of the player: the
domain memory on `ApplicationDomain`, the runtime's one, as avmshell's
`Domain` has it; `Worker.current`, the primordial (`isSupported` is
false, where AIR's is true, as no other worker can start); `Telemetry`,
never connected; and `System.disposeXML`, left to the collector.

#### Bitmap and gradient fills

A bitmap fill is a shape's fill of type 0x40 to 0x43 or
`Graphics.beginBitmapFill`'s. Each maps the bitmap's pixels into the shape
by its matrix (a SWF's in twips, so divided by 20; `beginBitmapFill`'s in
pixels, the identity by default, repeating and not smoothed), and
`bitmap-fills` shows what Flash draws: a repeating fill tiles the bitmap,
a clipped one carries its edge pixels on beyond it, smoothed is bilinear
and not smoothed nearest, and a fill whose bitmap the SWF does not
define is solid red. A SWF's bitmap fill is resolved to its bitmap
character as the shape is read, the bitmaps being defined first, and is
drawn from one store made of the character's pixels; `beginBitmapFill`
keeps the BitmapData's store itself, so the fill shows its later changes,
the shape a view of the store as a Bitmap is. The renderer draws a fill
as a Pixi texture fill in global texture space, the matrix as it is,
sampling a copy of the store's texture kept for the fill's repeat and
smoothing: a texture's sampling is its source's in Pixi, which also
switches any fill's texture from clamping to repeating by its
`addressMode`, so a clipped fill's copy reads as clamping there while
WebGL, which reads each axis's mode, clamps it. Without scripts, a SWF's
images are decoded at `start` too, for its bitmap fills. A bitmap line
(`lineBitmapStyle`, a LINESTYLE2 bitmap fill) still draws its first
colour.

Gradient fills, a shape's linear, radial and focal ones and
`beginGradientFill`'s, are drawn from Flash's own ramp, which adl gives
pixel for pixel (the `gradients` case and `display/gradients.ts`'s tests): 256
colours, each channel interpolated straight between the stops and
truncated, alpha too, then premultiplied as c · (a + 1) >> 8; in linear
RGB, interpolated in sRGB's linear light, the ends through it too, which
takes 255 to 254. The stops fill the ramp in order, a span that goes
back skipped and the last colour on to the end; no stops are black. A
pixel takes entry floor(256 · t), t read at its top left corner, not its
centre; pad clamps, repeat wraps and reflect mirrors t, as a texture's
clamp, repeat and mirrored repeat do with a ramp of 256 texels. So a
linear gradient is its ramp as a texture of 256 by 1, sampled nearest,
through the gradient's matrix (a SWF's square is in twips as its shape
is, so only the translation goes to pixels) moved half a pixel for the
corner. A radial one is not affine: its texture is computed over the
bounds of what it fills, a texel a pixel up to 512 a side, each texel
the ramp's entry at its corner, so an unscaled shape's pixels are
Flash's and any spread reaches past the gradient's circle; at a focal
point off the centre Flash draws the last stop, at a centred one's
centre the first. `beginGradientFill` refuses a type but `linear` and
`radial` (ArgumentError 2008) and null colours (TypeError 2007), takes
null alphas as opaque and null ratios as even, floor(255 · k / (n − 1));
arrays of different lengths or a ratio outside 0 to 255 draw nothing,
and stops past 16 are left out. The stage's supersampling softens a hard jump
inside a fill, such as a repeating gradient's seam, which Flash leaves
hard. Gradient lines still draw their first colour.

#### PNG

`encode` writes a PNG as Flash does: IHDR, one IDAT and IEND, RGBA for a
transparent bitmap and RGB for an opaque one, each colour divided out of
alpha as floor(c · 256 / a) up to 255, Flash's encoder's own rule, which
adl showed for every alpha and value and which is not `getPixel32`'s.
Only what the file decodes to is Flash's: `fastCompression` filters no
row and deflates at level 1, as Flash does; otherwise each row takes the
filter whose output sums smallest, libpng's heuristic, deflated at level
6 where Flash uses 9. A 1080p frame encodes in about 135 ms fast (Flash
about 120) and 520 ms otherwise (Flash 2.7 s), at 1% more bytes than
level 9. The rect is rounded and clipped as other methods' are, and an
empty one is ArgumentError 2006; a null rect or compressor is TypeError
2007, a compressor not an encoder's options ArgumentError 2004; the file
goes into the ByteArray given, from its position, or a new one. JPEG and
JPEG XR, which Flash also writes, are not supported yet. The
`bitmap-encode` case traces the file and each refusal under adl; fast
compression's file is Flash's byte for byte, as it is deflated
by zlib itself. `getPixels` and
`copyPixelsToByteArray` write their bytes in one pass. `setPixels` and
`copyPixelsToByteArray` honor the supplied ByteArray's `endian`;
`getPixels` creates a big-endian one with its position after the pixels.
Reads use the ByteArray's DataView without allocating per pixel, keeping
complete pixels and the read position when a later word fails with
EOFError 2030 (`bitmap-pixel-endian`).

### Text

A `TextField` is a display object of its own kind (`TextObject`), placed
by a timeline's DefineEditText or made by a script, 100 by 100 pixels and
empty, as adl makes one. Its text is a `TextModel` (`text/text.ts`): the
characters, `\r` between lines as Flash keeps them (`\n` is made one),
each with its own format, and a default format, Flash's Times New Roman
12 for a new field and the tag's for a timeline's (its font's name from
the DefineFont2 or 3 it names, its height, colour, alignment, margins,
indent and leading; the indent is signed, as Flash reads it, though the
specification has it unsigned). `text` and `htmlText` set the text in
the default format; `appendText` and `replaceText` put theirs in the
format of the character before; `getTextFormat` of a range gives null
for what its characters differ in, and `setTextFormat` sets what a
TextFormat sets.
`htmlText` is written as adl writes it: a `P` for each paragraph (an
`LI` alone for a bullet's), in a `TEXTFORMAT` for its margins, indent,
leading or tab stops, with a `FONT` of all five font attributes and,
for each later run, a `FONT` inside it of what changed; `A`, `B`, `I`
and `U` about a run's text, in that order out to in. It is read as adl
reads it, a paragraph's end and a `BR` a line only in a multiline field.
A TextFormat keeps each value as Flash converts it, null for one it does
not set: whole numbers rounded, a half away from zero, NaN and the
infinities -2147483648 as x86 converts them, `align` one of Flash's or
ArgumentError 2008, an unknown `display` null. The `text-fields` case
traces all of this, defaults, HTML and refusals, against adl.
An `IMG` is dropped, as adl drops it, by class name or URL, and
`getImageReference` gives null for every id (`text-field-queries`).
`TextField.isFontCompatible` asks the fonts `enumerateFonts` lists, the
SWF's own before any is registered: the name in any case, no CFF font,
and the style "bold", "italic" or "boldItalic" as written, any other
regular.
`getTextRuns` cuts a range where the format changes; a paragraph's line
end takes the paragraph's format; `getFirstCharInParagraph` and
`getParagraphLength` count the text's length as in the last paragraph,
one past its end.

A StyleSheet is playerglobal's own code over a few natives: its CSS is
read as Flash reads it (`text/css.ts`, Ruffle's CssStream: selectors
lower-cased, property names camel-cased, and on any of the few errors
Flash finds the whole sheet ignored), a colour is `#` and at most six hex
digits or 0, and the generic font families are Flash's device fonts. A
field with a sheet reads `text` as HTML too, refuses `replaceText` and
`replaceSelectedText` with #2009, gives `htmlText` back as it
was set, and does not read the same HTML again; each tag takes its tag's
style, a link `a:link`'s, then its class's. A tag of the sheet's own is a
block, ending its line when closed by its name, unless its style makes it
inline, and one displayed as none hides what it holds; the display is no
character's format. A change to the sheet styles the HTML again only in
a field that had HTML when the sheet was set on it, as adl does
(`text-natives`, the corpus's `stylesheet` and `edittext_stylesheet`).

Setting a TextField's `width` or `height` resizes its field, as Flash
does, not its scale. The renderer draws the background, the border over
the pixels at both edges, then the text as its layout (below) places it,
from the line scrolled to and no line that fits only part of the way,
clipped inside the gutter: a character of an embedded font as its glyph's
fill, a shape made once for the glyph and shared by every character
drawn in it, scaled to its size, tinted its colour, and moved by its
pair's kerning (its boundaries stay); a run of a device font in one
format as one Pixi Text on the line's baseline. A device font
(`_sans`, `_serif`, `_typewriter`) is the browser's of that kind, any
other by its name. Bullets, underlines, input and selection are still
to come.

A field whose `antiAliasType` is advanced has its embedded glyphs drawn
as Flash's Saffron draws them (`render/saffron.ts`), all of a field's in
one mesh under a shader of its own, measured in adl with fonts of bars
(`text-advanced`, `text-advanced-draw`). Each of Flash's pixels is
covered by a ramp over its signed distance to the glyph's outline, from
0 at an outside cutoff to 1 at an inside one: the shader finds the
distance exactly, from the outline cut into fine chords in a texture
every glyph shares, kept as a glyph is first drawn. The cutoffs come from
a table by size in pixels on the screen (`text/csm.ts`, measured in adl),
one for each of the font's CSM hints (its DefineFontAlignZones; none is
thin) and for light and dark text, light being a luma of 30:59:11 over
200 of the colour as drawn, under the object's colour transform: thin
light text at 20 pixels gains 0.6 of a pixel of ink across a stem, dark
0.1. `thickness` moves both cutoffs and `sharpness` each the other way, a
fiftieth of a pixel per pixel of size at the end of their ranges;
`TextRenderer.setAdvancedAntiAliasingTable` gives a font a table of its
own, for light and dark text alike, as adl uses it. A glyph lies where
adl puts it: the field's origin on the screen at a whole pixel, the pen
(in fractions of a twip) at a quarter of a pixel across and down under
`gridFitType` none, an eighth across and a whole pixel down under pixel,
a quarter across and a whole pixel down under subpixel, ties to even, and
sampled half a pixel left of the pixel's centre; turned or skewed, where
it falls. The grid is the stage's, inside a filter's input too (the Pixi
fork's `uWorldOffset`), and a BitmapData's in a draw. What the shader
goes through is bounded: a glyph of more than 2048 segments, or a field
whose glyphs' segments times their quads' pixels pass 2^25, is drawn as
normal text, all of the field alike, as advanced text is under a
renderer other than WebGL 2 and in a 3D object's bitmap. The store of
segments, 16 MB at most, starts again when full, drawing again the texts
drawn from it, uploads only the rows added since, and goes with the last
view that draws on a stage. Fitting stems to
pixels by a font's alignment zones is still to come. Static text whose
CSMTextSettings ask for advanced anti-aliasing is drawn so too, though
adl drew none of the test SWF's static text with the tag after its
DefineText at all.

A field's text is laid out by swf2es, as Flash lays it out, never by the
browser: lines, and each character's place on them, are what
`textWidth`, `textHeight`, the line and character queries and
`autoSize` report, and what the renderer draws. A font embedded with
`embedFonts` is a DefineFont2 or DefineFont3, found by name, its own
size and its advances, kerning, ascent and descent from the tag, so its
layout is Flash's to the twip. adl, with fonts of rectangles built by
the tests' SWF writer, sets the rules. A character's advance is its
glyph's at the format's size, which is a whole number, truncated to
twips, plus `letterSpacing`. A kerning pair, with `kerning` on, shortens
the second character's advance. A character the font lacks takes no
room and has no boundaries; a font's characters are found by a binary
search of its code table. A line is as tall as its tallest run's ascent
and descent, each truncated to twips, plus the format's `leading` (not
the font's); its width counts its trailing spaces. Lines break at a
newline, and with `wordWrap` before a word that does not fit without
its trailing space (one ending at the room's edge fits), or between
characters for a word longer than the line. A line starts 2 pixels in,
the gutter, then the margin, block indent and, on a paragraph's first
line, its indent, and a bullet's 36 pixels; a negative indent, a hanging
one, takes the first line left as far as the gutter but gives it no
more room (`text-indent`); centred, it is placed in the room left,
right-aligned one twip further left, and justified, a wrapped line but
the paragraph's last has its inner spaces share the room. `textHeight`
is the lines' heights, leading and all, less the last one's leading
where there are two lines or more; a last line left empty by a newline
counts only while the field's type is input, whether a timeline placed
it or a script made it, and a change of type lays it out again
(`text-final-newline`). adl's `numLines` can lag a relayout until the
next one, which swf2es's does not; tab stops, the boundaries adl leaves out for lines beyond the
field's height, and those of a timeline's field, which adl gives 2
pixels further right and down than its lines, are still to come.
`autoSize` makes the field the text's size and 4 pixels, keeping its
left, centre or right edge. A device font's metrics are the browser's
font's, measured by the host, which Flash's own system fonts differ
from.

Static text (DefineText, DefineText2) is a `StaticText`: its records'
glyphs where the authoring tool put them, each record keeping the font,
height, colour and pen of the one before (`text/static.ts`), drawn with
the glyph fills a field's embedded text shares, under the tag's matrix.
A text that sets no colour draws nothing, as adl draws it. A font is
found as the text is shown, as Flash finds it, so one the SWF defines
after the text still draws it (`static-text`); a glyph of a font the SWF
lacks, or past its font's glyphs, draws nothing and moves no pen.
DefineFont's older 1024-unit outlines draw through the same glyph path as
DefineFont2 and DefineFont3. Its separate DefineFontInfo or DefineFontInfo2
supplies the name, style and character codes; the outlines draw without
that metadata too (`legacy-static-text`). A device font's text, whose
glyphs have no outlines, draws nothing where Flash draws it in a system font.
`text` is the glyphs' characters, a line feed before a record's first
where its line is not the last glyph's, and null where any glyph has no
font or character mapping, or there are none (`static-text-probe`,
`legacy-static-text-probe`, the corpus's `statictext_text`; adl reads a glyph past its font as another
character). Only a timeline makes one: a script's `new` is
refused, #2012. It is hit by its glyphs' outlines, a transparent one not at all,
and without the shape flag over its tag's rectangle; it is no
InteractiveObject, so the mouse finds its parent there. adl clips a
filtered one to its bounds, as it caches it as a bitmap of them; the
player does not, which only shows for a glyph past them.

### Colour transforms

A colour transform acts on what each shape, bitmap and text field draws
under it, not on a sprite's children composited first, as adl draws it:
each fill's colour, straight rather than premultiplied, is multiplied and
offset channel by channel, alpha too, and clamped to 0–255. An alpha
offset so shows a fill of alpha 0, while a bitmap's fully transparent
pixels stay transparent. A gradient's stops are transformed and its ramp
made from them. Nested transforms apply the child's first, then the
parent's: (c · m₁ + a₁) · m₂ + a₂. The renderer keeps Pixi's tint and
alpha for a transform that only multiplies, by 0 to 1, as most do. Any
other, with an offset or a multiplier beyond 0–1, sends what is drawn
under it to a batcher of swf2es's own, whose shader takes each vertex's
whole transform, concatenated from the stage down, and applies it to the
straight colour; such objects still batch together. A shape's fills, a
glyph's and a layer's lines are drawn from unbatched contexts that are
shared, by a character's instances, a font's text and instances in step,
so one drawn under such a transform draws a batched copy instead, made
once, and the context itself never changes: switched to batched, the
other instances' Graphics, set up unbatched, drew nothing
(`shared-colors`). A shape's lines keep standing for the shared context,
which their cache counts. A glyph's colour, its Graphics' tint, goes into the
vertex colour there too. A gradient there is
transformed pixel by pixel, which clamps after the ramp where Flash clamps
its stops, so the two part only where a transformed stop is clamped.

A filtered object is the exception: adl colours the bitmap its filters
make, the glow and the shadow too, not what they are run on. Its
colour transform from the stage down, or from the filtered object it is
in, is applied by its chain's last pass to the straight colour of each
pixel the filters made, a clear one staying clear, and what is in it is
drawn as though nothing above it, itself included, were coloured: the
fork's `Container.colorRoot` keeps Pixi's tint and alpha, the render
group's included, from reaching it. A glowing object faded to an alpha of
0.6 had its glow drawn from its faded shape, 65 off, and offsets left the
glow as it was, 139 off (`blend-filtered-alpha`). A filtered 3D object
is coloured so in its bitmap: one at an alpha of 0.6 drew its glow from
its faded shape, 77 off. Children's own colours, masks, text, bitmaps,
filtered objects in filtered objects, render groups in and around them,
filters taken off and put on, and the colours that leave one clear, are
the `filtered-colors` case. A colour that changes
draws the output it kept again in the new colour, with no filter run;
one that leaves every pixel clear draws nothing and runs none, as Pixi
skipped an object at an alpha of 0 before its colour went to the chain
(a rig's faded glowing parts took 12 ms a frame for nothing, 2 skipped).

Stencil masks ignore their own and their ancestors' visibility and colour,
while retaining ancestor transforms. The view uses the fork's
`Container.visibilityRoot` and `colorRoot` on mask nodes; removing a mask role
restores ordinary inheritance. `mask-ancestors` checks hidden, transparent and
tinted ancestors, moving them, and removing and restoring the masks against
Flash.

### Blend modes

adl composites an object with a blend mode as a layer, its children
together in the normal way, and blends that with what is below, the
stage's colour included, where Pixi would blend each child on its own.
An explicit `layer` with children also applies its colour transform to
their combined pixels, including any graphics on the clip itself. Without
children, it colours its fills individually. The view resets colour
inheritance at the former and colours the empty filter chain's output;
that pass replaces the plain layer copy, without keeping another bitmap.
`blend-layer-fade` checks an AVM1 timeline's fading layer, and
`blend-layer-colors` checks colour and alpha offsets, adding and removing
children, mode changes and ancestor colours against AIR.
Where Pixi draws such a layer at once, as a single fill with no masks or
as a filtered object's result, and the GPU's own blending computes
Flash's blend, the GPU blends it, with no copy of what is below:
`screen` and `add` over any ground, `subtract` and `multiply` while the
stage's pixels are opaque, add and subtract under WebGL alone (WebGPU's
add leaves an opaque target less than opaque, and it has no subtract),
and none below a blended, filtered or clipped ancestor, which may draw it
into a layer whose ground is clear. Over a clear pixel the GPU's multiply
drops the object's own colour, which Flash keeps (off by up to 128), and
its subtract the alpha. The stage's pixels may be clear while its
background is (a host's transparent window mode, set at any time) or
while an `erase` or `alpha` blend outside any layer is on the list, which
clears what it covers of the stage as adl does; the view checks both
before and after it brings the list up to date, and where that changes,
each multiply and subtract blend outside a layer chooses again, so that
it switches on the frame the change is drawn on (`blend-direct-clear`).
Pixi drew its back buffer onto the canvas blended, over what the canvas
held: with a drawing buffer kept, as the test page keeps it, the frame
before showed through such cleared pixels, and an erase added after the
first frame seemed to clear nothing. The fork copies it instead
(`stage-erase`). A filtered object's chain draws
its result with that blend (`FilterChain.blendOver`); the Pixi fork maps
`subtract` to WebGL's reverse subtraction. adl's lighten, darken and
difference blend the straight colours, which the GPU's min and max of
premultiplied ones match only where the object is opaque, and overlay
and hard light depend on what is below, so those keep the filter. The
`blend-formulas` case puts each mode's formula against adl, at five
alphas over five grounds, unfiltered and through a filter, and
`blend-direct-filtered` draws filtered blends over the stage, in layers
and as they change; the GPU's blends draw what the filter drew, byte for
byte. On the bench (`--rig 300 --filtered 3 --added --glide
--back-buffer --gpu`, an RX 7900 XTX) a frame fell from some 43 ms to
37 ms, and on a busy page of 66 added fills the frame's framebuffer
binds fell by an eighth. Other blends use a filter (`render/blend.ts`): `layer`
one that only makes it a layer, any other one that reads the back buffer
and computes the mode in premultiplied colour, its result replacing what
is there. Multiply, screen, lighten, darken, difference, overlay and
hardlight are the separable blends of the straight colours, composited
source over; `add` adds and `subtract` takes the object from what is
below, each clamped, subtract's alpha the object's over what is below
(over a layer's clear ground adl leaves the object's alpha in black); `invert` inverts what is below as far as the
object covers it; `alpha` and `erase` scale the layer below by the
object's alpha, or by what it leaves, only where the object has any.
The `blend-modes` case draws each over two grounds against adl. Pixi
reads the back buffer only from a renderer made with `useBackBuffer:
true`, which a host passes (`@swf2es/web`'s `playback.ts` does);
without it filter-backed modes draw as normal, and the view warns once.
Direct blends still draw as blends. The back buffer is a full-screen
copy a frame: on the bench (`--back-buffer`, an
RTX 4060) it adds some 0.05 ms to the draw. What is behind an object is
copied from the pixels its bounds cover, which Pixi puts on whole pixels
of the target but keeps in stage units, as k · (1/r): at a resolution
that is no whole number, as a host fitting the stage to its page gives,
k · (1/r) · r can fall a hair short of k, and Pixi's floor took the pixel
before. The blend read what was behind it a pixel off at those positions
alone, so a moving blend shook what showed through it, which Flash leaves
still. The copy's corner and size are rounded instead. Pixi also pads a
filter's region by whole pixels after putting it on the texels, which at
such a resolution left it between them: a blend nested in a layer, its
region starting left of or above the layer's, read along its top and
left edge texels of the pooled back texture the copy never reached, and
drew lines of what it last held, which Flash does not draw. The region
is put on the texels again after the padding. The `blend-drift` case
moves a blend a quarter pixel a frame, at a zoom of 1.5 that gives the
test page a resolution of 6; unit tests hold the region's snap.

What is behind a blended object is copied into a texture the filter
reads, and Pixi's copy is held to both that texture and what it copies
from: an object past the edge of what it is drawn over, the stage's or a
layer's cut by a scrollRect, which bounds an object's filter but not its
children's, asked for a width or height below zero, which GL refuses
(GL_INVALID_VALUE) and WebGPU fails the frame for. The part the copy does
not reach is left as the pooled texture had it: it maps past what the
target has, where the filter's output is cut off. The `blend-edges` case draws such
objects against adl, and the player's test page fails a case whose
drawing GL refused.

A renderer made with `antialias: true` draws into multisampled targets,
which must be resolved before they are read, and Pixi resolves the whole
target at each step: before a blend copies its backdrop, again in the
copy, and after each filter pass drawn on the back buffer, a full-screen
resolve for each small blend. The Pixi fork resolves only the copy's
clipped source rectangle when a backdrop is copied, skips the resolve
before the copy, and leaves the back buffer unresolved after filter
passes until it is presented; a filter's intermediate textures still
resolve before they are sampled. On a scene of 100 nested blends and
glows (RX 7900 XTX) the GPU's frame fell from some 4.1 ms to 3.3 ms, the
frames unchanged. It is in the fork's `FilterSystem` and WebGL render
target adaptor (`finishRenderPass`), and relies on the order the filter
system calls them in. The `blend-antialias` case
draws nested blends, a blurred child of a blend and blends past the
stage's edges multisampled against adl, the only case that runs these
paths; a resolve skipped or of the wrong rectangle fails it, and
`bench.ts --back-buffer --antialias` times them.

A layer, a blend's or a filter's, holds what its filtered children draw
past their shapes, as adl's layer holds a child's glow whole: Pixi
measures a filtered object by its descendants' shapes alone, which cut a
blurred child of a blend off at its shapes' edges, so each filter below
grows the region by its padding (`blend-nested` draws such children
against adl).

### Filters

A filter object keeps its values as adl converts them, in a record of its
kind's (`display/filters.ts`): blurs clamped to 0–255, NaN kept; quality and a
convolution's size whole and clamped, to 15; alphas in 255ths; colours 24
bits; strength in 256ths, to 255; an angle within a turn either way,
through radians and back; a convolution's divisor, bias and matrix, a
colour matrix and a displacement's scale as floats, the colour matrix 20
values and a hole in it 0; a gradient's stops at most 16, its colours
setting their count, its alphas filling to it with 1, its ratios making it
fewer; a number past an int's range, as x87 converts it, 0. A display
object holds records too, from its `filters` or a PlaceObject3's list (a
bevel's highlight before its shadow, as adl reads it), and gives copies
back, so `filters === filters` is false and a filter changed after it was
set changes nothing. BitmapFilter is abstract, and restricted: a script's
class extending it is refused, while one extending a filter of
playerglobal's is made.

BitmapData's `applyFilter` filters on the CPU, as adl computes
(`bitmap/filters.ts`): the source's premultiplied channels, past the
source rect too as far as the bitmap goes, filtered, and the filter's
rect of them written whole into the destination, moved to its point and
clipped; an opaque destination keeps its alpha, and refuses a glow, a
shadow, a bevel and the gradient filters with
IllegalOperationError #2077. `generateFilterRect` grows a rect each way by the passes' spread
times the blur, a blur below 1 counting as 1: Ruffle's per-quality
spreads (1.0, 2.1, 2.7, 3.1 … 7.0) as floats, halved, rounded up from a
quarter for a blur and half to even from a half for the others, as x87
rounds, which the `rect` lines of `apply-filter` pin; a shadow's, inner
too, by its offset in whole pixels (to the nearest 256th, then down) on
the side it moves to, less it on the other, never inward; a bevel's by
the offset's size both ways. At high qualities the rect is less than the
passes' reach, and cuts what they spread. A blur is a box of fractional width, its end pixels weighted by their
part, run along x and then y `quality` times, each value truncated to
8 bits. A glow's alpha is that blur of the source's alpha (of 255 less
it, for an inner one), truncated, times strength to 255 and alpha, over
or under the source as the display's are; inner, the source keeps its
alpha and the glow lies on its straight colour, the glow's colour times
that alpha in 255ths and the source's times what is left in 256ths,
truncated, premultiplied again rounding, and knocked out the glow's
alpha is times the source's, rounded; a shadow samples it from its
offset between pixels, linearly with weights in 256ths. A colour matrix
maps straight colour, rounded, the pixels about what the source has
premultiplied truncated and the rest of the rect the map of a
transparent pixel. A bevel is the source's alpha so blurred, read from
its offset on and back between pixels, as a shadow reads; their
difference times strength, to 255, times the colour's alpha, rounded, in
the highlight colour where on is more and the shadow colour where it is
less. Inner, it lies atop the source, which keeps its alpha, on its
straight colour as an inner glow does; outer,
behind it; full, over it; knocked out, alone, masked to where the source
is (inner) or is not (outer); each over another as the store draws it,
s + d × (256 − sa) / 256 truncated. Off the axes adl reads the offset
about a 256th further out, which swf2es does not find a rule for: there
a channel may be 2 off, so the `bevel` case, to the bit, keeps to the
axes, and `bevel-draw` has the angles between. A gradient glow is a
glow's alpha (from its offset back, as a shadow's) times strength, to
255, picking its colour and alpha from a 256-entry table of its stops,
built as a gradient fill's ramp; a gradient bevel's difference, times
strength, picks entry (d + 256) / 2, so where on and back agree, outside
the source too, it takes the middle. With no stops either draws nothing
but the source. Both place their layer as the bevel does, masked by
rounding, (c × m + 127) / 255; a gradient glow's rect is a shadow's, a
gradient bevel's a bevel's, and as the table may have colour at 0 they
fill it. A displacement map moves each pixel of the source rect by the
map's channels there, read unmultiplied, the map placed at the rect's
corner and its point, the one named channel less 128 times scale, in
256ths toward 0 (none named, or several, moves nothing); it reads the
source between pixels, the four corners' weights in 256ths each
truncated; past the rect as the mode says: wrapped, clamped, its own
place where the whole pixel it lands on is past it (ignore), or the
filter's colour; where the map is not, or there is none, it keeps its
own. Its rect grows by a quarter of each scale, whole, and none with no
map; `generateFilterRect` takes any filter's rect within the bitmap first,
and a displacement's result, and an inner glow's, shadow's, bevel's or
gradient filter's, within it too. adl keeps each part of a shadow's or a
bevel's offset in 256ths in an int: 2^23 − 1 or more wraps round to
−2^23 − 256 and less stops there (`shadowOffset`), so the rect reaches
−8388866, as Infinity's does; and its angle is 6.79e-9 radians off, so the
offset grows across the axes as the distance does, 4e9 at 0° reaching 30
up (fitted from 5e5 to 1e11, taken from where it comes to a 512th). An
outer shadow or gradient glow cast past the wrap writes its rect empty,
the source too; a filter rect past the buffers adl makes is refused, 2015
for an outer shadow or gradient glow (1e5 at 45°, or 8e9 at 0° as the
part across grows), 2077 for an inner bevel and 2015 for an outer or
full one, which is refused with 2077 from 2^31 / 10 pixels already; and a
distance or angle of NaN
refuses an outer shadow and is none for the rest (`filterRefusal`). Cast some 2^15 pixels left or up, adl draws
an outer shadow in pieces as its 16-bit sums wrap, which swf2es leaves.
However far the offset, the work is what the destination shows: the
alpha read from the offset is blurred where it is read, not over all the
offset spans (the `filter-distances` case). An inner filter writes its
rect as generateFilterRect gives it, the rect within the bitmap grown
and kept within it, and adl moves it by that rect's corner from the
source rect's twice: the source rect (8, 8) at (10, 10) of an inner glow
reaching 2, whose rect is (6, 6), writes at (6, 6), not (8, 8)
(`apply-filter-inner`, every inner filter from a rect inside the
source's content, past its edge and past the bitmap's, to the bit; it
wrote the grown rect where an outer filter's goes). A displacement map
writes the rect alone: adl, displacing a rect moved elsewhere, fills its grown rect from
the rect's corner, shifted, and into an opaque destination leaves alpha,
quirks swf2es does not take on. The map is read as it is when applied.
The `apply-filter` case matches adl's numbers to the bit.

A convolution grows the rect by half its matrix, rounded down, each way.
Its taps read the source's straight colour, unmultiplied as getPixel32
does, past the source rect too: only past the bitmap's edge does a tap
take the nearest edge pixel, or with `clamp` false the filter's colour.
The kernel is not flipped: tap (i, j) of a matrix x by y reads the pixel
(i − ⌊x/2⌋, j − ⌊y/2⌋) from the one it makes. The sum is divided (a
divisor of 0 counts as 1), the bias added, each channel clamped and
truncated; `preserveAlpha` keeps the source pixel's alpha, else alpha is
summed as the colours are; the colour is then premultiplied by that
alpha as setPixel32 does, or kept straight in an opaque destination.
adl takes another way for a 3 × 3 kernel of whole weights whose positive
and negative sums each stay within 127, with a divisor from 1.1 (all
weights positive) or past 2.0001 (any negative), at pixels whose taps
all lie in the bitmap: in fixed point, the integer sum times 65536 ÷
divisor, truncated, plus one, wrapped to a short, shifted down 16 bits,
the colour premultiplied truncating. The wrap makes a divisor of 1.1 to
2 turn and shrink the weights (by 2 they negate), and that way's last
tap reads the centre pixel, not the one right and down of it. Both ways
are in `bitmap/filters.ts`, and the `convolution` case matches adl's
numbers for each, to the bit. A matrix with no taps (0 by anything, the
default filter's) copies instead: as much of the source as the grown rect
is big, from the source rect's corner, to the grown rect's corner, over
an opaque destination's pixels; what lies past the source stays as it
was.

The renderer draws a display object's blur, glow, drop shadow, colour
matrix, bevel and convolution as adl does (`render/filters.ts`), before its blend mode: a blur is
a box blurX by blurY pixels wide, the pixels at its ends weighted by how
much of them it covers, run `quality` times each way and truncated to 8
bits each time, so that blur 2.5 weighs 0.3, 0.4 and 0.3, and the filter
reaches quality × blur / 2 pixels out. A glow is the object's alpha so
blurred, times strength (clamped to 1) and alpha, in its colour, drawn
behind the object, or, inner, one less that inside it over the object;
knocked out, the object is left out. A drop shadow is a glow from
distance × (cos, sin) of its angle back, and with `hideObject` drawn
alone. A bevel is the object's alpha so blurred, read at its offset on
and back, as applyFilter has it, each pixel evaluated once at its centre;
a gradient glow and a gradient bevel pick from their table, a texture
256 wide, and draw only within the filter's rect of adl's bitmap of the
object, its pixels and one more right and down. A displacement map
reads the object's pixels as applyFilter reads the source, with the map
as it was when the object's filters were set, as Flash copies it then
(reading them back gives the live map, and setting them again takes it
anew); one with no map makes no pass. In colour mode it fills half the
scale round the object with the colour, as adl draws it.
A colour matrix maps each pixel's straight colour, offsets in
255ths, transparent pixels within the object's bounds too. A convolution
filters, as applyFilter does, a bitmap of the object's pixels and one
more right and down, its edge pixels clamped or coloured past that, and
draws the rect so grown; each pixel's texels read its centre alike. One
with no taps moves the object up and left by half the other size, a
single tap there. (adl's copy then reads a row past its bitmap and draws
what memory lies there; swf2es leaves that row transparent.) Blurs and
distances are in pixels of the stage: a glow on an object scaled twice
reaches no further than on one at its size, as adl draws it, but on a
stage a host shows at three times its size it reaches three times as
many screen pixels, as Flash Player draws a stage zoomed in its window,
measured for a blur, a glow and a drop shadow at zooms of 2, 2.8 and 3
(under exactFit each axis by its own zoom, where swf2es takes the
stage's x scale). adl cannot show a stage zoomed, so the
`zoomed-filters` case is drawn at the zoom and compared with adl's frame
of the SWF built that many times larger, filters and all, which matched
Flash Player's zoomed frame. Each chain keeps the units to a stage pixel
it was made for and is scaled again when they change, though its object
was off the list then; its padding is the reach in those units. A blur's
box steps a texel of its input, blur × texels to a stage pixel wide:
stepping a stage pixel's texels instead, on a stage shown at three times
its size, it strode over texels past its padding and cut a soft shadow
off square (the `blurred-shadow` case). A
BitmapData's pixel is a screen pixel to a draw into it, rendered at its
samples a side. The passes are Pixi filters at the target's resolution,
for WebGL: under WebGPU, where Pixi would skip an object's whole chain
for one it cannot run, they are left out and a blend mode is kept. A
view made for one draw destroys the filters it made with it. The object
goes into its chain, or a blend mode's filter, multisampled as the
target is (Pixi's filters default to "off"): a filtered caption's edges
were stepped beside its unfiltered neighbours' smooth ones, for some
0.1 ms of GPU time a frame on a screen of filters and blends.

As Flash caches a filtered object as a bitmap, an object's filters run
as one chain (`FilterChain`) whose output is kept and drawn again until
what it was run on changes: the object or anything below it, its
transform other than a move, or how much of it the screen shows (its
colour colours the output as it is drawn). Filters set again with the values they had,
as a tween writes them on each frame or a script sets them from their
own, keep the chain and its output; a displacement's map is the same only
as the same object, which setting it again takes anew. A wide blur's
passes read blur × texels to a screen pixel a pixel, over an area grown
by its reach, so their cost rises with the cube of the texels to a stage
pixel; kept, a still object costs one copy a frame. Where there are more
texels than one to a stage pixel, a blur's and a glow's or shadow's runs
go coarser (`blurShrink`), each way on its own, so that a streak 68
across and 5 down goes coarser across alone: whole times, to a texel a
stage pixel at most, the input averaged down first and the result drawn
back between texels. What bends sharply is then off by a part of a coarse texel, which a
glow's strength multiplies: a single box bends at its ends, so it
shrinks only when wide for its strength, while two boxes or more bend
smoothly, so a glow 27 wide at quality 2 runs at a texel a stage pixel
on a screen of three. Against the full runs, on a stage shown 1.5 to 3
times its size, no channel moved more than 5, and the `wide-filters`
case holds it to adl at three times; at a texel a stage pixel nothing
changes. Bevels and the gradient filters, whose difference of two reads
strength multiplies, keep every texel. The object a blur blurs whole, and
a lone glow or shadow behind its object (whose object is then drawn again
over it, sharp, through the Pixi fork's `Filter.objectApart`), may be drawn
into a layer coarser than the target too (`layerFor`), and without
multisampling where the blur hides the edges as well: by the stage's
quality. At medium and low, for any object. At best, never. At high, only
for thick content (render/detail.ts): each fill's thickness, twice its area
over its outline, and each line's width, on the stage, must be eight coarse
texels or more, but for thin parts whose outlines, each moved half a texel
(drawn without samples) or a sample's share of one (with them), move no
more than two levels of a blur box's coverage. A shape's fill is measured
by the signed areas of its contours, which run with the fill on one side;
a drawing's by the even-odd rule. Masks count by their shapes, and objects
filtered or blended within by their content; text, bitmaps, bitmap fills,
drawTriangles, video, scroll rects and 3D count as thin past any budget. Thin geometry repeated under a wide blur (stripes, hatching, a
glyph's strokes) adds up its edges' errors into whole regions brighter or
darker, which `tests/player/filter-coverage.ts` checks, with thick shapes
drawn coarse at high within 6 levels of best's exact layer. A blur of no
passes, or of a texel or less, never coarsens its layer nor drops its
samples. A blur of none, which an
animation's placements carry by the hundred, takes no pass in its chain,
though it pads as before. A kept output moved is drawn at the new place to the
whole texel, its content where it fell within a texel when it was
filtered. adl moves its bitmap by whole pixels where swf2es moves by
whole texels, which differ only where a pixel is drawn as several samples,
as the test page draws Flash's grid: the `filter-retween` case moves by
whole pixels. One that changes frame after frame is filtered straight to
the target, with no copy kept, and a view drawn once keeps none. adl leaves
some changes undrawn: a child moved within its parent's bounds shows in
its capture where it was as well as where it is, and a mask from outside
the object that moves leaves it clipped as it was. swf2es draws the
child once, where it is now, and also keeps the output for such a mask,
unless the object's bounds change with it. Each pass lets go of the
pool's textures it drew with, which the pool destroys as the screen's
size changes. Pixi measures a filtered object's bounds each time it runs
its chain, unless given a `filterArea`; that measuring is some 1% of the
main thread on a page of 32 animated creatures running 450 chains a
frame, and 0.13 ms of a 3.3 ms draw on `bench.ts --rig 32 --blurred`
(the `filterAreaMs` meter), less than the runs vary, so no area is set.
In a busy town of an application, though, with hundreds of filtered
characters and scenery, it was 1 ms of a 14 ms frame, so a chain keeps
the area it was measured at with the object's transform on the stage,
and gives it again, moved as the object moved, until the object changes
as its kept output goes stale or its transform's linear part changes;
one with a mask from outside it in it is measured each time, as that
mask may move with nothing in it changing (`FilterChain.keptArea`).
Each filter pass clears the texture it draws into: Pixi clears a chain's
input as it binds it, and the box blur's runs and a chain's steps clear
their pool textures, some 1,230 clears a frame on that page and 769 on
the rig. None is skipped. Their textures carry no stencil, so the
stencil bit of Pixi's `CLEAR.ALL` costs nothing, and dropping every
clear but the screen's, which draws wrongly, moves neither a frame there
nor `bench.ts --rig 32 --blurred --gpu` by more than the runs vary, on
the discrete GPU or the integrated one: the textures are small, some
0.4 megapixels of inputs a frame.

#### Native CPU convolution

New web playbacks convolve BitmapData on the CPU through
`@swf2es/native/bitmap` by default, loaded alongside the fill tessellator;
`configure({ nativeBitmaps: false })` keeps them on JS and loads no native
bitmap module. Both paths give the same pixels. Each playback supplies one
`Convolver.convolve` to its Scripting or Avm1 `bitmapConvolver` hook before
the movie starts and clears the hook and disposes scratch at teardown.
Direct player hosts can supply the same hook and own its lifetime. Workers
without a hook keep using JS. GPU filters and other BitmapData operations
are unchanged.

The native package depends on no other package and loads no DOM or node
types. The kernel receives numeric records and premultiplied ARGB pixels.
Only the required rectangle and convolution halo cross into Wasm; the
result is copied into an owned Uint32Array before existing clipping and
destination writing. This preserves self-filtering and notifications, and
allows later calls, memory growth or disposal without invalidating results.
Strict double arithmetic preserves coefficient order and Flash's fixed-point
3×3 convolution quirks. The module uses wasm SIMD and has no scalar
build: every current browser ships SIMD, and an engine without it refuses
the module as one without Wasm does, so it keeps the JS path. The module
imports nothing. Compilation refusal, missing optional modules, allocation rejection and traps fall back
to JS before destination pixels are written. Trapped instances are dropped;
ordinary rejection can reuse scratch. Scratch has a 128 MiB absolute limit;
instances above the default 8 MiB retention threshold are dropped after a
call. The package's other sub-paths keep independent modules and lifetimes.

### Masks and scroll rectangles

A mask clips what it masks to where its fills are, as adl draws it: the
fills alone, whole, whatever their alpha, the object's alpha and colour,
or `visible`; lines draw nothing, and a Bitmap clips to its rectangle,
transparent pixels and all. Masks nest, each clipping inside the other.
A timeline's mask is a child placed with a clip depth: it is not drawn,
and it clips the children after it in render order until one placed at a
depth beyond its clip depth. A child a script puts among them, or after
them where nothing deeper ends the range, is clipped with them. Removing
the mask ends the range. `mask` set on an object makes the
other object its mask: not drawn, wherever it is. On the display list it
clips through its own place there. Off the list it clips through its own
matrix, taken in the stage's space. One mask clips one object, so
setting it on a second takes it off the first, whose `mask` is then
null. Neither kind changes bounds or `width`, and a shape hit test
follows `mask` but not a timeline's masks; a mask, a script's or a
timeline's, is never hit by a shape test, nor is what is in it (the
`scale9-hits` case), and a Bitmap, masking or not, is hit over its whole
rectangle. The renderer gives each
mask to Pixi as a stencil: a timeline's range goes in a container whose
mask is the clip-depth child, and a mask's lines are hidden while it
masks. When both objects are cached as bitmaps Flash clips by the
mask's alpha; that, and a text field as a mask, are still to come.
Pixi 8.21 draws every mask through the stencil: its `ScissorMask` has no
pipe and is never chosen. A scissor for a rectangle upright on the screen
was weighed and left out: `bench.ts --masks 40 --gpu`, 40 scrolling lists
each clipped by a timeline's rectangle, takes some 0.7 ms a frame more
than the same art unclipped (`--unmasked`), about 10 µs of CPU a mask,
which bounds what a scissor could gain, while a multisampled target, as
the hosts draw, gives a stencil's edges the coverage a scissor's
whole-pixel box would lose.

`scrollRect` is kept as set, its edges rounded to whole pixels half to
even, so its width and height are the rounded right and bottom less the
rounded left and top. It takes effect at the next render, as Flash's
does. From then on the object is drawn shifted by the rectangle's left
and top and clipped to it, and its bounds in its own space are the
rectangle's size at (0, 0). Its points go through the shift, in its own
`localToGlobal` and below, but its `concatenatedMatrix` leaves its own
shift out, as Flash's does, while its children's take it in. A hit
test misses outside it.

### Sound state

`SoundTransform` keeps its volume and four channel coefficients on each
AVM2 object. The `pan` getter and setter remain playerglobal's AS3 code,
which derives them from those coefficients. A `SoundChannel` copies the
transform it receives, with the channel coefficients truncated to hundredths
as Flash's sound-transform corpus trace shows, and the four gains reach the
browser's left and right outputs through Web Audio. `Sound` classes bound by
SymbolClass to a DefineSound tag find its encoded samples in the library.
The player decodes MP3, uncompressed 8/16-bit or ADPCM sound on first play
(ADPCM as Ruffle's decoder does, to 16-bit samples the browser host in
`media/audio.ts` plays as uncompressed ones), sharing
a decode when separate loads contain the same sound (`scripting/symbols.ts`). The shared cache holds
decoded audio while a sound uses it; entries leave when no SWF holds their
sound definition, so unused audio can be collected. The parser leaves the
MP3 seek word out of the encoded bytes; the tag's sample count and rate,
not the decoder's duration, give the embedded sound's `length`.

`Sound.extract` gives a sound's samples at 44.1 kHz in stereo as adl
does (`media/extract.ts`, the `sound-extract` case): each sample held for
as many as its rate falls short, and positions counting the sound's own
samples. An uncompressed or ADPCM sound is decoded for it at once, whole
samples only; ADPCM as adl has it, each packet's header its first sample,
in blocks of 2048 samples the last of which runs on past the data, and
with adl's seeks, whose packets' offsets wrap in 32 bits. An MP3 is
decoded for it apart from the decode it plays, the first time a script
extracts it, and kept: at the MP3's own rate, of
whole frames, with a Xing or Info header frame as a frame of silence, as
Flash decodes it rather than trimmed by it as a browser would, and a
DefineSound's seekSamples skipped. Playback keeps the browser's decode of
the whole file at the device's rate, gapless trimming and all, which
resamples better than a buffer played at another rate. Flash's decode is
at once, so extraction uses `@swf2es/native/mp3`, separately from Web Audio.
Its upstream source is the pinned `vendor/minimp3` submodule (swf2es/minimp3,
a fork of lieff/minimp3); the Zig adapter (`src/mp3/root.zig`) and TypeScript
wrapper are in `packages/native`, built with its other binaries.
The module compiles once before ActionScript libraries run, and an extraction
instantiates a decoder only on first use. Its fixed 128 KiB workspace holds
one frame's encoded bytes and interleaved PCM, copied into the sound's cached
channel buffers. No host functions are imported. The generated 29 KB
binary is embedded in the package; ordinary builds verify its input
digest, and CI rebuilds it with the pinned Zig 0.17.0, whose clang
compiles minimp3 unchanged. An engine that cannot compile it loads SWFs
as usual, and extract writes no samples for an MP3. Otherwise a first
extract supplies samples synchronously, including inside
`SampleDataEvent` callbacks, even without an audio device. Extracted samples are weakly cached
by the sound character or loaded sound; appending compressed bytes invalidates
the latter's cache. Unused sounds are never decoded.
`media/mp3.ts` finds an MP3's frames: a run of three headers where they
say the next frames are starts it, and it runs on past ID3v2 tags and
other bytes between frames.

`loadPCMFromByteArray` reads 32-bit floats or 16-bit integers in the
ByteArray's byte order and brings them to 44.1 kHz at once; adl's reads
back samples that have nothing to do with those it was given, so the
case checks only its counts, lengths and errors.
`loadCompressedDataFromByteArray` adds MP3 bytes to those the sound has
(a SWF's sound keeps its own): its length counts their frames by their
headers at once, a frame cut short too, as Flash's, reading on from
where the bytes before stopped; the sound is decoded only when it plays
or a script extracts it.

An external `Sound.load` uses the same host fetch as `URLStream`; its
open, progress and complete or error reach ActionScript on a frame, after
the host has decoded it. `Sound.play` gets a channel immediately, with
start time, repeats, stop and sound transform. Sound-complete is delivered
on a frame. A stopped channel's `position` stays where it stopped. A page
may provide an `AudioHost` to `Scripting`; without one, the player keeps
the script-visible sound state but emits no audio.

An empty `Sound` with a `sampleData` listener streams stereo float PCM at
44.1 kHz. `media/dynamic-sound.ts` requests samples synchronously on first
play, then refills against the audio device's consumed samples. Each channel
keeps its own ByteArray, resetting its position before each callback while
preserving its contents and endian, as AIR does. The write position counts
the supplied frames: fewer than 2048 ends the stream after those samples,
and more than 8192 reports RangeError 2004. A write cursor beyond the
logical data length reports EOFError 2030 and ends the stream. Sample buffers are copied before
scripts can reuse them. The sound's `length` stays zero; its channel's position
tracks consumed samples and freezes on stop.

`AudioHost.stream`, when supplied, accepts the PCM blocks without a decode
or a conversion to 16-bit samples. The browser schedules consecutive Web Audio
buffers on one device clock and mixer, with bounded buffering and a refill
timer independent of the SWF's frame rate. Completion waits for queued audio
to drain and is dispatched on a player frame. Stop, stopAll and destruction
cancel refills and queued sources. Failed startup or refill releases the channel
and its device resources, even if stopping a failed device also throws.
A host without streaming keeps script-visible
state and sample requests on the player clock, without emitting this audio.

`SoundMixer.soundTransform` is one transform per player, stored in
hundredths as a channel's is, and its getter returns a copy. What a channel
sends to the device is its own transform and the mixer's, combined as
Ruffle's `SoundTransform::concat` computes them (only two transforms that
both cross channels depend on the order, which no trace shows), so setting the mixer's updates
every playing channel through `PlayingSound.setMix` and applies to every
later one. `SimpleButton.soundTransform` reads and writes the mixer's, as
in Flash (the `sound-mixer` case and the corpus's
`simplebutton_soundtransform`). `stopAll` stops every channel without a
sound-complete, and every timeline sound. `bufferTime` is kept, 5 seconds at first, and rejects a
negative one with RangeError #2027; `areSoundsInaccessible` is false.
`computeSpectrum` writes 512 zero floats and rewinds the ByteArray, which
is what Ruffle writes with no sample history and what Flash writes while
nothing plays: the player reads no output back from the device. AIR's
`audioPlaybackMode` and `useSpeakerphoneForVoice` are kept and checked as
AIR checks them; their API version hides them from a SWF.
DefineSound's Nellymoser and Speex formats, ByteArray sound loading and ID3
are later slices. MP3 seek samples are parsed but not yet applied to decoded
browser audio.

### Timeline sounds

A timeline plays sounds of its own, which no script sees: StartSound and
StartSound2 on its frames, its stream (SoundStreamHead or SoundStreamHead2,
and a SoundStreamBlock a frame), and a button's DefineButtonSound. The
library's `sounds` hook (`TimelineSounds`, made by `media/sounds.ts`
for every AS3 library a `Scripting` loads) plays them through
the page's `AudioHost`; a player without one plays none, and a SWF without
them pays nothing. AVM1 libraries use the same hooks through their own
SoundHost, including AVM1 movies loaded by an AS3 Loader.

A frame's StartSound tags play as the playhead enters it, played on to,
looped to, or landed on by a goto, but a goto to the frame the clip is on,
as Ruffle's `run_goto` has it; the frames a goto passes over play none.
StartSound2 names its sound by the class SymbolClass bound to it. A
SOUNDINFO's in and out points (samples at 44.1 kHz) bound each loop, its
loop count repeats it, and its envelope scales its left and right channels
from the start, linear between points, the first point's level held before
it, as Ruffle's `EnvelopeSignal` does, through gain automation on the
browser host (`PlayShape`). SyncNoMultiple starts none while the timeline
plays the sound anywhere, and SyncStop stops every instance the timeline
started, as Ruffle's `perform_sound_event` does for the timeline's. Both
leave a script's channels of the sound out: a channel plays on through a
SyncStop, as adl shows (the `timeline-sounds` case's channel completes),
where Ruffle stops it; and SyncNoMultiple does not see one, where Ruffle
does, which adl cannot show.

A clip's stream is its blocks back to back (`streamSound` in `media/audio.ts`:
MP3 blocks give their sample counts, PCM's are whole frames of their
bytes, and each ADPCM block decodes on its own, headers and all), made one
sound when it first plays and shared by every clip of the timeline; the
joined sound, and its decode while a clip plays it, live as long as the
library does. The block of a frame a playing clip enters, with no stream
of its playing, starts it there, as Ruffle's `sound_stream_block` does,
and it runs to the end of that run of frames with blocks, or, for MP3,
which plays over gaps, to its last block. It stops as the clip stops (the
`playing` setter of `MovieClip`), at a goto to another frame, before the
frame it lands on starts it again if the clip plays (a goto to the frame
it is on leaves it be, as Ruffle's `goto_frame_now` does), and on the
single frame of a clip of one. When the timeline takes the clip off it
stops too, and the clip plays its removal frame but starts no stream
there: the player's choice, as the clip plays no more; Ruffle's AS3 clip
keeps its stream, and adl cannot show Flash's. A clip a script takes off
plays on as an orphan and keeps its stream, as in Ruffle. `unloadAndStop`
stops the timeline sounds of all under the content, event sounds too, and
`stopAll` every one, a stream starting again at the next block its clip
plays on to. A stream counts the time its clip advances, using the stage
frame rate of each frame. `PlayingSound.positionMs`, when supplied by the
host, is elapsed playback from the requested start, including `atMs` and
any wait for the device to start; it is NaN before playback begins, follows
the audio device clock, and freezes when stopped or ended. Whole frames of
audio lead request the bounded catch-up described above. Hosts without a
cursor retain ordinary pacing. MP3 gaps retain their timeline duration:
cumulative sample offsets are not treated as jumps to later block frames.

A button's change of state plays DefineButtonSound's sound for it, as
Ruffle's button events pick them: up to over, over to down, down to over,
and over to up, and a release outside plays over to up's (the pointer's
up, with a button pressed and something else under it). A pressed
button dragged off shows its over state until the release, and its down
state again when the pointer comes back, as Flash Player 32 shows them
(`tests/unit/player/input/pointer.test.ts`); those two changes play
none, as Ruffle's DragOut and DragOver do. A button pressed elsewhere and
dragged onto stays up until the release over it, which shows over.

A timeline sound's mix is the transforms of its clip or button and each
ancestor, a sprite's `soundTransform`, concatenated from it up, then the
mixer's, as Ruffle's `transform_for_sound` does; setting a sprite's or the
mixer's updates every timeline sound playing. A stream starts on the
device once its decode is done, as far into it as the player's clock has
run since it was due, so that one whose first decode took frames keeps
with its timeline; on a device the page has not yet let run (a suspended
`AudioContext`, whose time stands still before the first gesture or
through a slow resume), the browser host starts it when it runs, as far
in again as it waited. An event sound plays whole, late if its decode or
the device kept it waiting: a click's start is not lost. A sound is over,
for SyncNoMultiple, once the clock has run its length, in and out points
and loops counted; the device may still play it, and a stop still reaches
it until the device is done with it
(`PlayingSound.ended`), or, for a host that cannot tell, until 100 ms
later, when it is stopped for good. A stream stays attached until its
clip passes its final block, stops, seeks, loops or is removed. The device
ending first must not restart audio from a lagging timeline block. At
most 32 sounds play at once, Flash's 32 channels and Ruffle's `AudioManager::MAX_SOUNDS`: a script's channels
whose sound is there to play, and the timeline's sounds the device has,
or will have once decoded, together. Past them a timeline sound does not
start, nor queue on a device that is not running, and `Sound.play` gives
null, as Flash's and Ruffle's do; a channel of a sound still loading
holds no channel until it can start. adl cannot
show what a timeline plays (its `computeSpectrum` reads nothing of an
event sound or a stream), so the node tests (`media/timeline-sounds.test.ts`)
check, through a device that logs, what starts and stops, when, how far
in, and with which mix; the `timeline-sounds` case checks that the frames
go on as in Flash.

## The web embedding

`@swf2es/web` (`packages/web`) plays SWFs on any page, as Flash's plug-in
did and a browser extension will: a custom element, `<swf2es-player>`,
defined as the module loads, a function that swaps a page's Flash tags
for it, and a configuration the page sets once. It depends on the player
and on player-hosts, whose WebSocket relay carries flash.net.Socket.

The element (`element.ts`) takes an `<embed>`'s attributes: `src`,
`width` and `height` (a number is pixels, as an `<embed>`'s, anything
else a CSS length), `flashvars`, `scale`, `salign`, `wmode`, `bgcolor`,
`base`, `allowscriptaccess`, `allownetworking` and `quality`, and
`workers` of its own ([Workers in the page](#workers-in-the-page)). Its
JavaScript side is `load(url | ArrayBuffer | Uint8Array)`, which plays a SWF in place of the
one playing; `ready`, which resolves once the SWF loading plays and
rejects with what kept it from playing; `destroy()`; and the events
`load`, `error` (the error in `detail`) and `fscommand`, which also goes
to the page's `<id>_DoFSCommand` as the plug-in's did. Its size is its
attributes', or its SWF's stage, in `:host` rules the page's own styles
override. A SWF with no ActionScript 3 plays with no Scripting.

### Showing a player

`playback.ts` shows a player in the element: a Pixi renderer whose
screen is the element's box taken into stage coordinates, and whose
resolution is the device's pixels to a stage pixel, so the canvas covers
the box and the view's pointer mapping, which reads the canvas's box, holds
for every placement. As in Flash, what lies past the stage's edges shows
in showAll's and noScale's margins, and a press there reaches the stage at
coordinates past its edges (negative to the left and above); the stage
keeps the SWF's size. exactFit, which leaves no margin, keeps a canvas of
the stage's size stretched by CSS. `layout.ts` places it as Flash's plug-in did:
showAll fits the stage whole, noBorder fills the element and crops,
exactFit stretches it, noScale leaves it its size, and `salign`'s T, B,
L and R hold the edges they name, the stage centred along an axis that
names neither. A stretched stage is drawn as fine as its finer axis
needs; no side passes 4096 device pixels. A ResizeObserver places it
again as the element changes, and each animation frame checks
`devicePixelRatio`, which a move to another display or a zoom changes.
`wmode="transparent"` draws no background, so the page shows through;
otherwise the stage's colour, `bgcolor`'s if given, fills the element
around the stage too. Each animation frame advances the player by the
time passed and draws when `changes` moved or the element did. The keys
go to the element, focusable and focused as it is pressed, as a plug-in
had them only while focused.

It draws by the stage's quality (`Player.quality`): the element's
`quality` attribute at the start and as the page changes it, then what a
script sets, `Stage.quality` or AVM1's `_quality`, from the next frame.
Flash draws edges aliased and smooths no bitmap at low, a Bitmap's or a
bitmap fill's that asks for it among them, and supersamples on a grid
of 2×2 at medium and 4×4 at high and best (the `stage-quality-*` cases).
The canvas is not multisampled; the back buffer the stage is drawn into
is, but at low (the Pixi fork's `GlBackBufferSystem.antialias`, which
makes it anew), and `PixiView.quality` at low samples the smoothed copies
of the stores' textures, and drawTriangles' fills, nearest. Medium and
high are the GPU's multisampling, which costs the GPU memory and
bandwidth but no shading: supersampling, 4 or 16 times the pixels, would
cost more than the edges show. The back buffer and the filter and blend
layers take 4 samples at medium, 8 at high and 16 at best, as many as the
GPU allows (the fork's `backBufferSamples` and `msaaSamples`), remade at
the next frame. Flash covers an edge with 16 at high; 8 look alike but on
the longest, shallowest edges, at half the memory, and best takes 16.
Every sample costs its pixels 8 bytes, colour and depth-stencil, so a
canvas larger than about 1080p takes fewer (`fittingSamples`: what fits
256 MB, 4 at least): 8 at 1440p, 4 at 4K. A BitmapData's draw at low
quality smooths no bitmap either.

### The page's configuration

The web host uses native fill tessellation by default. Each playback owns a
`Tessellator` from `@swf2es/native/tessellate`, loaded when playback is created, and
disposes its Wasm scratch when playback is destroyed. `configure({ nativeFills:
false })` keeps new playbacks on JS and skips loading the native package.
A missing module or unavailable Wasm keeps JS usable; failed Wasm compilation
is tried only once per tessellator. A shape layer's fills are tessellated in
one call into one position and one index buffer, which Pixi draws from as they
are (`packages/native/README.md`). A rejected fill resolves its JS fallback
at construction, and the successful result is cached. Cached geometry owns
its CPU buffers independently of Wasm scratch, including for context restoration.
`@swf2es/player` retains its generic `PixiView` fill hook without importing the
native package. Different triangle layouts can change subpixel edge coverage
and paint interpolation, so native and JS need not draw identical pixels.

`configure` (`config.ts`) sets what every player on the page shares:
`libraries`, the URLs of builtin.abc and playerglobal.abc, which the page
gives, as playerglobal is Adobe's and cannot ship with swf2es; `codegen`, codegen.wasm's URL, by
default what the import map gives `@swf2es/codegen/codegen.wasm`;
`socketProxy`, a function from a socket's host and port to a WebSocket
relay's URL or a list of them as Ruffle's, a socket without one refused
with #2031; `sockets`, a SocketHost of the embedder's own that takes the
relays' place, as the desktop app's, which reaches TCP itself; `fetch`,
an embedder's fetch in place of the browser's for what the SWFs load and
for the SWF the element plays (purpose `movie`), with `loadPolicyFile`
and `sandboxType` for the player, as the desktop app judges requests by
Flash's sandboxes and policy files rather than CORS; and
`cache`. The page fetches and compiles codegen.wasm once and the
libraries once, and each player instantiates the compiled module
and reads the same bytes. A player has a Codegen of its own: Scripting
resets the compiler it is given, and its domains' numbers are its own,
so two players on one instance would take each other's over. `cache:
true` gives every player one IndexedDB module cache
(`player-hosts/indexeddb`, see [Caching modules](#caching-modules)); it
is off by default, as the player's is, a first visit being slower for
the writes.

### Workers in the page

`workers`, on by default as Flash had them, gives each player a
`webWorkerHost` (`player-hosts/workers`, see [Workers](#workers)); the
element's `workers` attribute, `"true"` or `"false"`, decides for its own
SWFs over the configuration, and off, `Worker.isSupported` is false. A
player's host starts Web Workers ahead only for a SWF whose ABCs name
`WorkerDomain`, and the element awaits them before the SWF's first
frame, as Crossbridge's start a worker and wait for it in one script, for
ten seconds at most, so that a script that never says it loaded keeps
no SWF from playing; a
SWF that names no worker starts none, and one that a loaded SWF starts
later starts as it is asked for. The workers started ahead are the
page's, shared by its players, and go ten seconds after the last player
that used them does, the element's destroy among them. A host's
`ready` waits for each worker it started ahead though another player's
host took it before it loaded. The element imports
`player-hosts/workers` only when a SWF has workers, so a page whose
import map does not name it plays its SWFs without them.

A Web Worker sees no import map, so the worker script is
`player-hosts`' `dist/thread/`: `build-thread.ts`, after tsc, copies
`web-worker.js` and every module it imports, from player-hosts and the
packages under it, with each bare specifier made a relative path inside
the tree. The tree resolves wherever the package is served, under a
page's import map, from a CDN or from the demo site and the desktop app
as they serve the packages, at the cost of its 3.9 MB loaded again by
the workers; `webWorkerHost` finds it beside its own module.
`workerUrl` names another script, a bundler's. A browser starts a
worker only on a script of the page's origin, and throws SecurityError
for another's, so a script from another origin starts through a `blob:`
module of the page's whose one line imports it: the script needs CORS,
as a CDN serves it, and a Content-Security-Policy that names
`worker-src` (or `script-src`) must allow `blob:`; where it does not,
the worker never runs, and the player reports its thread's failure
(where the browser refuses at once, `Worker.start` throws 3807). Shared memory
needs a cross-origin isolated page, which the demo site and the desktop
app are (see [docs/workers.md](workers.md)); elsewhere workers pass
messages, and sharing memory with one throws the error that says so.

### ExternalInterface in the page

ExternalInterface (`external.ts`) speaks Flash's protocol, but takes
every call from a SWF as data. playerglobal's `call` first offers the
JavaScript it writes, `name(args)` inside `__flash__toXML`, which writes
an object's keys unquoted, as Flash's did, so a SWF's key such as
`a:(code),b` would run in the page: the host declines every one, and
playerglobal sends the call as an XML invocation instead. Its name is
read as written, unescaped, up to the first
`" returntype="xml"><arguments>`,
which the arguments after it cannot move, and its arguments parsed as
data. A name that is a path, `a.b.c` give or take spaces, is the
function that path finds, called on what holds it. Any other name, an
inline function's source as pages wrote them (`function(){return
window.location.href;}`), is evaluated alone, `(name)`, as the code the
SWF gave it to be, and what it gives applied to the arguments, without
an object for `this`; the arguments never reach eval.

A callback the SWF adds becomes a method of the element, called with an XML invocation
and answered in XML, so the page gets plain arrays and objects back,
synchronously, as from Flash; one that throws is reported and throws
"Error calling method on NPObject" into the page, an `<exception>`,
which marshallExceptions sends, throws its message, and one the page
kept after the SWF stopped does nothing. A callback whose name the
element already has, its own methods' or the DOM's (`destroy`,
`getAttribute`, `dispatchEvent`), or one of the protocols other code
looks for on any object (`then`, which would make the element a
thenable, `toJSON`, `handleEvent`), is refused with a warning, and the
element calls its own internals as `#private` methods and the DOM's
through functions taken as the module loads, never looked up on itself.
A value met again inside itself crosses as null, where Flash recursed
until its stack ran out.

`allowscriptaccess` is `always`, `never`, or by
default `sameDomain`, the calling SWF's origin the page's, an opaque
origin no one's; a SWF it denies finds ExternalInterface unavailable and
its fscommand dropped, `available` false and a call throwing #2067, as
Ruffle has it, where Flash's plug-in threw a SecurityError.
`allownetworking` is `all`, `internal`, which takes ExternalInterface,
fscommand, navigateToURL and sendToURL away (Scripting's `sendToUrl`), or
`none`, which takes every fetch, socket and WebSocket too; Flash threw SecurityErrors for them, where
here they fail as networks do. `objectID` is the element's id, else its
name, as the plug-in's was the `<object>`'s id or the `<embed>`'s name.

### Replacing Flash tags

`replaceFlash(root)` (`replace.ts`) finds the Flash tags under `root`:
an `<object>` or `<embed>` of Flash's type, an `<object>` of its ActiveX
class, or one whose movie is a .swf. Each outermost one is replaced by
an element carrying what it and the Flash tags nested in it as
fallbacks say, the outer first: an IE `<object>`'s `<param>`s, then an
inner `<embed>`'s attributes for what those left out; and its id, name,
class, style, width and height, so the page's scripts and styles find
it. `watchFlash(root)` does it again for each tag the page adds later,
or makes Flash later by setting its src, type, data, classid or a
`<param>`'s value, until it is stopped. Where there is no
`customElements` registry, as in an extension's isolated world, where
it is null, the element is not defined and replaceFlash replaces
nothing.

### Letting go

`destroy()` (or the element's removal from the page, a microtask later,
so that a move is not one) releases everything a load holds: the
animation frame, the ResizeObserver, the pointer and keyboard bindings,
the renderer, which loses its GL context as it goes, the callbacks on
the element, the fetch of the SWF itself, and the player through
`Player.destroy` (see [Shutting down](#shutting-down)): its
SharedObjects written, its sounds and AudioContext, its sockets and
fetches. A load that is still under way when the next load
or a destroy comes stops at its next step, and what it made is let go.

### Tests and what is missing

`tests/web/run.ts` plays a page in headless Chrome with two elements,
for two of the player tests' SWFs, and two Flash tags for
replaceFlash, a nested `<object>` and `<embed>` and an ActiveX
`<object>` with `allowScriptAccess` never, at two device pixels a CSS
pixel. It checks that each boots and draws (from a screenshot), the
tags' parameters, ExternalInterface both ways and none where it is
denied, a SWF's callbacks named `destroy`, `getAttribute` and
`dispatchEvent` refused, an object key written as code not run, one
fetch and compile of codegen.wasm and one fetch of each library, the canvas's size as the element widens, and that destroy and
removal let go: 20 elements made and destroyed leave no player and no
codegen instance after a collection, no WebSocket or AudioContext
open, and the heap within 256 KB of each.

Not done yet: the SWF's scripts see Flash Player's showAll, the stage
the SWF's size, whatever the element's `scale`, and noScale does not
resize the stage or dispatch Event.RESIZE (but under the Stage3D
opt-in's live Stage layout); AVM1 custom context menus are not implemented; a
`javascript:` URL from navigateToURL never runs, allowed or not; and
`document[name]`, which found an `<embed>` by its name, does not find
the element. Nor can a page give the element modules compiled ahead of
time yet: its only cache is `cache`'s IndexedDB.

### A browser extension, later

A content script's isolated world has no registry (above), so the element
must be defined in the page's main world, where the page's
Content-Security-Policy applies to it. The player evaluates the modules it
compiles with `new Function` (on JavaScriptCore, as Blob URLs' scripts
where `blob:` is allowed, else by `Function` too),
and codegen is WebAssembly, so a page needs `'unsafe-eval'` and
`'wasm-unsafe-eval'` in its script-src, which an extension cannot lift for
the page, unless every module is compiled ahead of time and imported (see
[Pages without 'unsafe-eval'](#pages-without-unsafe-eval)). A page
with `object-src 'none'` had no Flash tags that worked, but replaceFlash
swaps them all the same. And under a CSP without eval, inline-function
calls come to nothing, but a call by a path still reaches any function
a global path names, `eval` itself among them: script access is the
page's whole, as it was in Flash.

## The desktop app

`apps/desktop` plays local SWFs, and SWFs by their http or https URL, in
an Electron window. It is the web embedding with a shell around it: the
page is one `<swf2es-player>` filling the window, configured with the
IndexedDB module cache and the libraries the user pointed the app at,
and the main process opens the files, keeps the settings and carries the
sockets and the SWF's network requests. The page knows the shell only
through `window.swf2esDesktop`, whose types are `src/shared/api.ts`:
`start`, which hands the page the libraries' state and the SWF to play;
`onOpen` and `onClose`; `openDialog`, `openUrlDialog`, `openDropped` and
`chooseLibrary`, requests the main process answers with dialogs and
`onOpen`; `sockets`; and `network`. The page (`src/renderer`, `static/`)
imports nothing of Electron's, so a Tauri shell can serve it as it is.

### Serving the page

Nothing is loaded from `file:`. One privileged scheme, `swf2es:`,
standard and secure, so fetch, CORS, IndexedDB and localStorage treat it
as https, has two hosts. `swf2es://app/` is the page,
`static/index.html` and its stylesheet, the renderer's build,
`/modules/<package>/` for the packages' builds and their libraries
(pixi.js), which the page's import map names as
`tests/player/serve.ts`'s does, and `/libraries/builtin.abc` and
`/libraries/playerglobal.abc`, read from where the settings say.
`swf2es://file/` is the local files the SWF playing may read, by its
sandbox (below); its answers carry `Access-Control-Allow-Origin:
swf2es://app`. The two hosts are two origins: a SWF's files are never
the page's. Anything but GET and HEAD is refused, and a path with
malformed %-escapes is a 400.

### The sandbox

A local SWF plays in the sandbox Flash Player gave it, chosen by its
FileAttributes' UseNetwork bit (`fileAttributes` in `format`), and
`src/main/sandbox.ts` holds it:

- **local-with-filesystem**, without the bit: the SWF reads the files in
  its own directory and below, its real directory, links followed, and
  reaches no network. The main process refuses its http and https
  requests (with a word on stderr), no socket is made, and navigateToURL
  opens no page, as Flash refused it, since a URL can carry what the SWF
  read.
- **local-with-networking**, with it: the SWF reads no local file but
  itself, reaches the network through the main process by Flash's rules
  (see [The network](#the-network)), content from anywhere and data only
  where a policy file grants every domain, and sockets as the user
  allows (below).

A SWF opened by its URL plays in Flash's **remote** sandbox: its
security domain is its origin, the one its URL came to after redirects,
which is also its `loaderInfo.url`; it reads no local file at all (the
file host has no grant for it, and the page fetches nothing else), and
reaches the network as [The network](#the-network) has it, sockets with
a socket policy and the user's word. Its grant takes effect as the page
asks the main process for that very URL as the movie, after the last
player has gone, as a local SWF's does as the page fetches its file.

So no SWF can both read the disk and send what it read away. A directory
others share is never granted whole: the user's home, the one that holds
every user's (`/home`, `/Users`, `C:\Users`), the temporary ones (the
OS's, `/tmp`, `/var/tmp`) and a file system's root; a SWF there reads
only itself. Only those directories themselves: a SWF one level below,
in `C:\Users\Public` or a directory of `/tmp`, reads all that directory
holds, which may be other programs' or users' files, so a SWF from
elsewhere is best kept in a directory of its own.

The main process chooses the sandbox from the SWF's first 64 KB, with
`fileAttributes` (`format`), which decompresses only as far as the first
tag: a SWF's header may name a length of 4 GB, which it never trusts.
The page decompresses the SWF whole, with what `@swf2es/native/compress`'s LZMA decoder
bounds (see [Packages](#packages)).

Only the SWF playing has a grant: opening another or closing it revokes
it, so nothing accumulates over a run, and the next SWF's grant takes
effect only as the page fetches it, which it does once the element has
let the last player go, so that player never runs in the next one's
sandbox. What the SWF loads, a child SWF among it, plays in its sandbox,
which is the page's. The URL the page plays a SWF from, which is also
its `loaderInfo.url`, names its directory by a token, a hash of the
path, and the file by its name, so the SWF learns nothing of where it is
or whose disk it is on, and the token, the same from run to run, keeps
its SharedObjects.

The page's Content-Security-Policy, a header the main process writes, is
`default-src 'none'` and what the player needs: `script-src 'self'
'unsafe-eval' 'wasm-unsafe-eval'` and the import map's hash, as the
player evaluates the modules it compiles with `new Function` and codegen
is WebAssembly; inline styles, for the element's shadow root; images,
media and fonts from the page, the SWF's files, `data:` and `blob:`; and
`connect-src` for the page and the SWF's files alone. The page never
reaches the network itself: a SWF's http and https loads go through the
main process (below), and every http, https, ws and wss request the page
makes is cancelled in the session's `webRequest`, with a word on stderr,
whatever the policy would allow. So `air.net.WebSocket`, AIR's and not
Flash Player's, has no server here. Nothing may frame the page, and it
frames nothing.

### The network

A SWF's http and https requests are the main process's to send
(`src/main/network.ts`), not the page's: the element is configured with
a fetch (`configure({ fetch })`, `src/renderer/network.ts`) that hands
each one, with its purpose, over IPC, and the main process judges it as
Flash Player judged it, by the SWF's sandbox and the policy files of the
sites it reaches, not by CORS. So a SWF reaches `http:` and servers that
never heard of CORS, as it did in Flash. A swf2es://file URL, a local
SWF's own files, the page fetches as before, and any other scheme is
refused.

Flash's rules, from Adobe's security documentation (the ActionScript 3.0
Developer's Guide's "Security sandboxes", "Loading data" and "Permission
controls") and its Cross Domain Policy File Specification (2.0):

- A **remote** SWF may load anything from its own origin (scheme, host
  and port), and content, a Loader's or a Sound's, from anywhere; it
  reads another origin's data, a URLLoader's or URLStream's, only as
  that origin's policy files grant its domain; sendToURL sends anywhere.
- A **local-with-networking** SWF has no domain: it loads content from
  anywhere, sends anywhere, and reads data only where a policy file
  grants every domain (`domain="*"`), as the Developer's Guide says.
- **Policy files** (`src/main/policy.ts`) are read as the specification
  defines them. The master policy file is `/crossdomain.xml`; others,
  named with `Security.loadPolicyFile`, count only as the master's
  meta-policy permits (site-control, or the
  `X-Permitted-Cross-Domain-Policies` header, the stricter of the two
  winning), and Flash Player 10's default is master-only: a site without
  a master policy file has no other either. A policy covers its own
  origin, and a non-master one only its directory and below. A policy
  file must come as `text/*`, `application/xml` or
  `application/xhtml+xml`, with a 200, without a redirect (the
  specification ignores one to another domain; one within the site would
  move the file's scope), and with a root of `<cross-domain-policy>`; a
  DOCTYPE is skipped, so no entity of its own is expanded. Domains match
  by the specification's table: `*.example.com` is example.com and every
  name under it, an address is never its host's name, and only `*` names
  a local SWF. An HTTPS policy's rule grants an HTTP SWF, or a local
  one, only with `secure="false"`. Headers other than Content-Type go to
  another origin only as its `allow-http-request-headers-from` lists
  them. Each policy file is fetched once a movie and address, and
  forgotten as the movie closes.
- Flash Player outside AIR sent GET and POST only, and refused a SWF the
  headers `URLRequestHeader` lists (Cookie, Host, Referer, User-Agent
  and the rest); the main process refuses those too, and Proxy- and Sec-
  headers, and any header value with a control character or beyond
  Latin-1, which Node would throw for, saying so on stderr.

What Flash never guarded, the machine's place on the network, is guarded
here, since a request from the main process is one from this machine. No
request carries the user's credentials: no cookies (a response's are
dropped), no HTTP authentication, no client certificate, no proxy. The
Referer is what a browser's default policy,
strict-origin-when-cross-origin, sends: the SWF's URL to its own origin,
its origin alone to another, and none from an https SWF to what is not
potentially trustworthy (http, but for this machine's loopback addresses
and localhost names), a URL past 4096 characters going as its origin; a
local SWF sends none. `x-flash-version` goes as Flash Player 32 sent it.
Every address is placed (`src/main/addresses.ts`): on this machine
(127/8, ::1), on a private network (10/8, 172.16/12, 192.168/16,
100.64/10, link-local 169.254/16, where clouds keep their metadata
service, unique and link-local IPv6, the documentation blocks), or
public; an IPv4 address inside an IPv6 one, mapped, translated
(`::ffff:0:a.b.c.d`), compatible, by NAT64 or by 6to4, is that address.
A request to a place more private than the SWF's own needs a policy file
from that very address that grants the SWF, whatever its purpose and
even within its origin, as Chromium's Private Network Access asks a
server there before a public page may. A remote SWF's place is that of
the address it came from; a local one stands for the internet, so it
reaches this machine and the LAN only where a policy there grants every
domain. Addresses no server has (0.0.0.0/8, ::, multicast, 240/4) are
never reached, nor the ports the Fetch standard blocks (SMTP's, SSH's
and the rest), as Flash in a browser never reached them either.

Addresses are placed by their ranges alone, as a browser's Private
Network Access places them: the app does not know which public addresses
are this machine's own or its network's. So this machine's own public
IPv4 address or global IPv6 one, and a LAN device reached by its global
IPv6 address (as most on an IPv6 network are), count as the internet: a
SWF from the internet reaches a service listening there as any web page
in a browser could, though still without the user's credentials. A
service that is to stay private should listen on loopback or a private
address, or ask for authentication.

Each request resolves its host once and connects to that address, its
policy file fetched from the same one (Node's `lookup` pinned, the name
kept for TLS's server name and the Host header), so DNS that changes its
answer between the policy and the request, rebinding, gains nothing:
same-origin by name, a request now at 127.0.0.1 is judged as one to this
machine. Every redirect is judged as a request of its own, a POST
redirected by a 301, 302 or 303 going on as a GET without its body, to
http or https only and ten at most. HTTPS is verified against Node's
roots and the system's. A response is read up to 128 MB, and a movie's
responses under way hold 256 MB at most all told (no compression is
asked for, and a body a server compresses anyway, gzip, deflate or br,
is decompressed as it comes, the limits counting what comes out, so a
small bomb stops at them; gzip's header is read by the main process and
its stream inflated raw, so what follows the stream is ignored, as
Chromium ignores it, deflate is zlib's or raw as its first two bytes
tell, and a body coded twice is refused), past which the next is refused
(each is copied once, into memory of its own, and counts until the main
process has sent it to the page in a message of its own, which copies it
there); a body is sent up to 32 MB, a URL up to 64 KB, 32 headers in 8
KB; a request that hears nothing for 30 seconds fails, and one that
takes five minutes all told, from its turn, however its bytes trickle
in, its redirects and the policy files it waits on included, as does a
socket's search for its policy (a policy file's whole fetch takes ten
seconds at most, port 843's socket policy three); 16 requests run at
once, a thousand more wait, and the rest are refused. A sendToURL's
response is not read. Requests the page aborts are aborted, and a
movie's all are as the next opens, closes, or the page reloads. A
refused request is a failed load to the SWF (IOErrorEvent, or the
player's error for the SWF itself) and a line on stderr saying why.

The page says what a request is for, and the main process cannot check
it; nor does the player keep Flash's other half of the content rule,
which let a SWF show another domain's image but not read its pixels or
bytes without a policy. So a content load's bytes are the SWF's to read,
and the line that holds against a SWF, or a page that misbehaves, is the
one above: nothing with the user's credentials, and nothing more private
than the SWF without that place's own policy. What a SWF reads from the
internet that way is what its author's own server could fetch. The page
also tells the player the sandbox, which `Security.sandboxType` reports.

### What the page may do

The window's renderer is sandboxed (`app.enableSandbox()`), with context
isolation, no node integration and web security on. The preload, a
CommonJS script as a sandboxed one must be, puts the API on the page
through `contextBridge` and passes the path of a dropped file
(`webUtils.getPathForFile`) to the main process without showing it to
the page. The main process answers a message only from the window's own
top frame on `swf2es://app/`, and checks each argument: a path must be
absolute and its file start with a SWF's signature, a library must be an
ABC (major version 46), a socket's host a string and its port in range.
The page never navigates: `will-navigate` is refused, and a new window,
as a SWF's navigateToURL asks for, is refused too, its URL opened in the
system's browser with `shell.openExternal` if it is http or https, the
SWF has the network (local-with-networking or remote), and a click, key
or tap in the window asked for it: one page a gesture, within five
seconds of it and a second after the last, as a browser's popup blocker
allows, so a SWF cannot launch the browser in a loop. `<webview>`s are
refused, and the only permission granted is full screen.
ExternalInterface is off (`allowscriptaccess="never"`): a SWF's calls
into the page would run beside the API.

### Files, settings and libraries

The main process opens a SWF from File › Open, a drop on the window, the
command line (the last argument that is an http or https URL or names a
.swf file there is, as a switch may take a value), macOS's `open-file`,
a second start of the app, which hands its SWF to the first and quits,
File › Open URL (Ctrl+L), and the recent list, and sends the page its
swf2es://file URL, or the http or https one, which it plays with `load`
in place of what played, the element letting the last player go. The URL
dialog is a window of its own (`static/open-url.html`,
`src/renderer/open-url.ts`), modal over the player's, with a preload of
its own (`src/preload/prompt.cts`) whose only messages are what to show
first and the user's answer, which the main process takes only from that
window's own page; the player's page may only ask for the dialog
(`openUrlDialog`). So nothing a SWF runs opens a URL: a SWF's movie
fetch reaches any address, as the user chose it, and the dialog keeps
that choice the user's. Only http and https URLs open, with a host and
without credentials, their fragment dropped. It keeps `settings.json` in
Electron's user data directory (`SWF2ES_DESKTOP_USER_DATA` names
another, for the tests): the libraries' paths, the last ten SWFs, by
path or URL, and the servers each SWF, by path or URL, may always reach.
A settings file that cannot be written keeps them for the run, with a
word. playerglobal.abc is the user's to give; builtin.abc is taken from
beside it, else from the checkout's avmplus submodule, else given too.
Without them, the page shows what is missing and why the app cannot
include playerglobal, and an ActionScript 3 SWF that fails for want of
them says so rather than showing the 404; choosing one reloads the page,
which fetches the libraries once.

### Sockets

The element takes the shell's SocketHost through `configure({ sockets
})`. Each `flash.net.Socket` is an id the preload numbers, and the main
process connects it with `node:net`, as `player-hosts/node` does,
relaying its bytes and events over IPC. Only a SWF with the network has
sockets, and only as the user allows: the first connection to each host
and port asks, Allow Once (until the SWF closes), Always Allow for This
SWF (kept in the settings by the SWF's real path) or Deny (until it
closes); connections there while the question is open wait on its
answer, and where no one can be asked it is a refusal. A remote SWF then
needs the server's socket policy too, as Flash Player 9.0.124 and later
asked of every socket, its own server's included: the main process
connects to port 843, sends `<policy-file-request/>` and its NUL and
reads the policy up to its NUL (three seconds at most), and, as its
meta-policy allows ("all" by default for sockets), tries the ports
`Security.loadPolicyFile("xmlsocket://host:port")` named and the port
itself; a policy grants the SWF's domain the ports its `to-ports` lists,
one from a port of 1024 or above only ports of 1024 and above. The
policy is asked only after the user allows the server, so no SWF makes
the app speak to a server the user did not allow, and the socket then
connects to the address the policy came from. A local SWF with
networking needs no socket policy, as before. A refused socket fails
with #2031, as one no server took. A page holds at most 64 at once, and
one with more than 4 MB its peer has not read fails, so a peer that
stops reading cannot fill the main process's memory. A page's sockets
close, silently, as it navigates or reloads, and with it. TLS
(`SecureSocket`) waits for the player to have it.

### Running and testing

`pnpm install` leaves Electron's binary undownloaded (pnpm's
`ignoredBuiltDependencies`), so nothing else pays for it; `pnpm --filter
@swf2es/desktop fetch-electron` fetches it, and `start` runs the app,
`--trace` printing the page's console, a SWF's traces to stdout.
`tests/desktop/smoke.ts`, part of `pnpm test`, skips with a word where
there is no binary; with one, it runs the app in Chromium's headless
mode with SwiftShader, so it needs no display, and checks that a SWF
named on the command line, through a link, draws and traces; that in
local-with-filesystem it reads the file beside it, nothing outside its
directory, no network and no socket, and its URL tells nothing of its
path; that playing it again leaves one canvas, that one dropped on the
window opens, and that a second start hands the first its SWF, which, in
local-with-networking, reads no file, the last SWF's grant gone, and
talks to a TCP server it is allowed through the bridge; that no page
opens without a gesture, and that the policy refuses nothing; that
without playerglobal the page says what is missing; and that a SWF
opened by its http URL, from the command line and then from the URL
dialog, which starts with the URL playing, plays in the remote sandbox:
it reads its own origin and one whose crossdomain.xml grants it, not one
without, no local file by swf2es:// or file://, connects the socket
whose server answers with a socket policy and not the one without, and
both URLs join the recent list. `connections.test.ts` and
`sandbox.test.ts` test the sockets' limits and the sandbox's grants in
node, `addresses.test.ts` where each address is, in every form an IPv4
address takes inside an IPv6 one, `policy.test.ts` the policy parser and
what policies grant, by the specification's examples, and
`network.test.ts` the network against servers of its own, each on
127.0.0.2, which it takes for the internet, and on 127.0.0.1 at the same
port: same-origin and cross-origin loads with and without policies,
meta-policies and named policy files, redirects, this machine reached by
address, by name, by redirect and by a name whose DNS turns to it, HTTPS
with a certificate it makes with openssl (skipped without), socket
policies on a stand-in for port 843 and on the port itself, and the
limits. `tests/desktop/stage3d.ts` drives the native View menu through the main
process's test-only inspector: disabled fallback without fetching the backend,
remembered opt-in, two composed slots, live layout/DPR changes, browser context
loss/restoration, repeated movie reloads and close. It shares the isolated
display and process harness in `tests/desktop/app.ts` with the ordinary smoke
test. `settings.test.ts` covers explicit opt-in and persistence. CI's `desktop`
workflow fetches Electron and runs them.

Not done yet: packaging and installers, `SecureSocket`, Flash's Settings
Manager for trusting a SWF or directory (localTrusted), each loaded SWF
in a sandbox of its own rather than its loader's, a POST from
navigateToURL (the system's browser gets its URL alone), reading
playerglobal from a `.swc`, Flash's SecurityErrorEvent for a load a
policy refused (the SWF sees an IOErrorEvent), cookies for a SWF's own
origin, the system's proxy, and Flash's checks within the player:
`checkPolicyFile`, pixels and bytes of another domain's content, and
`Security.allowDomain`.

## The demo site

`apps/site` is a static page, published by `.github/workflows/pages.yml`
from `main` to https://swf2es.github.io/swf2es/, that plays the SWFs
people open: one `<swf2es-player>`, the panels a person trying a SWF wants
around it, and three demos. It is the web embedding with nothing in
between, so a static host is all it needs: `build.ts` copies the packages
as `tsc` wrote them, the Pixi fork's bundle, `codegen.wasm` and
`builtin.abc` into `apps/site/dist/site/`, under an import map of relative
URLs, so it plays under Pages' `/swf2es/` as at a server's root.

- **A SWF** comes from a file the browser reads, never uploaded; from a
  URL the page fetches, which works only where the server allows another
  origin (CORS); from `?swf=`; or from a demo. The page reads its bytes
  itself, for the header it shows, and gives them to the element with
  `base` set to the URL they came from, so the SWF's own loads resolve as
  if the element had fetched it. Its `allowscriptaccess` is `never`: a
  stranger's SWF does not script the page.
- **The console** shows what the element sends to the browser's console,
  trace on `console.log` and uncaught errors on `console.error`, which
  the page wraps. **The stats** count the frames the player's `advance`
  plays, wrapped on the instance, the main thread's time per animation
  frame, and Chromium's JS heap.
- **Report a problem** opens a new issue filled in with the build, the
  browser, the renderer, the SWF's header and the last errors: never the
  SWF, nor a local file's name.
- **No sockets**: a static site has no WebSocket relay. Compiled modules
  are kept in IndexedDB (`cache: true`).
- **The demos** are built from the repository's sources as the site is:
  `demos/Bounce.as` compiled by ASC in the oracle's image, an AVM1 SWF
  whose actions `tests/avm1-script.ts` writes, and the player benchmark's
  crowd. The workflow pulls the oracle's image for the first.
- **Licences**: `notices.html` gives builtin.abc's MPL-2.0 and lists the
  files translated from avmplus and taken from Ruffle, found by their
  headers as the site builds, with the licences of PixiJS, zlib and the LZMA SDK.

`tests/site/run.ts`, part of `pnpm test`, builds the site and checks it in
Chrome under `/swf2es/`; `--serve` serves it to look at.

## Testing against oracles

- **avmshell** (avmplus/Tamarin shell) for AS3 semantics: the output of the
  compiled test must match avmshell's `trace()` output exactly. The Tamarin
  acceptance suite supplies thousands of cases.
  The oracle's avmshell is a 32-bit x86 build, whose C++ double arithmetic
  may run in the x87's extended precision. Where that shows, swf2es follows
  IEEE doubles and the cases avoid it: `Number.toString(radix)` of a value
  above 2^53 writes digits that are neither exact nor a double's, and in
  its JIT a multiplication past 2^53 comes out exact, as as3pb's wire
  checksum shows (`tests/programs` compares all but that line).
  `tests/programs` also builds C, LZ4's from the com-lz4-as3 submodule
  with a driver of its own (`tests/programs/lz4`), with the image's
  Crossbridge, and runs it as avmshell's projector and its ABC in
  swf2es. That avmshell has Crossbridge's ShellPosix, which swf2es's
  shell has not, so its start, which then goes as in a player, is left
  out of the comparison.
  for-in and for each visit an object's dynamic properties in the order
  they were added; avmplus visits them in its hashtable's, which for names
  that are not indexes follows their interned strings' addresses, so the
  cases do not depend on it.
- **Flash, as AIR's `adl` runs it**, for what the player draws and traces
  (`oracle/flash.ts`, `oracle/flash/Harness.as`). The harness is an AIR
  application that loads each SWF with a `Loader`, in a hidden window of
  the SWF's size, and sends back the frames asked for, drawn with
  `BitmapData.drawWithQuality` at the SWF's stage quality, and its traces.
  Frame 1 is the one its `INIT` follows and frame k the one after k - 1
  `EXIT_FRAME`s, a frame later for AVM1, whose movie in a `Loader` shows
  its frame 2 a frame late; adl prints an AVM1 movie's first frame's
  traces only with its second's, so a corpus test or case of one frame is
  run for two. A frame's load completions (`INIT`,
  `COMPLETE`) follow its `EXIT_FRAME`, so what their listeners change
  shows in the next frame's capture (the `loads-init` case captures frame
  3 for its unload at frame 2's `INIT`). A SWF's clips taken off the
  display list play on in Flash until collected, so a case that leaves
  one is recorded last, or its traces would reach the next case's. A SWF the harness runs is loaded content, and
  Flash constructs that before it is the `Loader`'s child: its document
  class finds `stage` null in its constructor, where a main movie's finds
  the stage, as the player's does. A case whose trace depends on that
  waits for the player's own `Loader`, to run as loaded content too. adl is not in CI (here it runs the Windows AIR
  runtime under Wine), so what the player's tests compare against is drawn
  once and committed (`tests/player/references`, `node tests/player/run.ts
  --update`); CI needs only Chrome.
  [Ruffle's test corpus](https://github.com/ruffle-rs/ruffle/tree/master/tests/tests/swfs)
  supplies thousands of SWFs with Flash Player's traces, and some with its
  frames (`tests/player/corpus/fetch-ruffle.ts` fetches it, uncommitted). Flash
  under adl traces what their `output.txt` holds (`timeline/`: all 15 that
  finish; `visual/`: 104 of 107). The expected frames are not all Flash's,
  some are Ruffle's own, and Flash under adl draws 42 of the 101 in
  `visual/` within their tolerance or a pixel's anti-aliasing of it, so
  the oracle decides, not the corpus's PNGs (`tests/player/corpus/check-references.ts`).
- **Ruffle's corpus, as a baseline for the player** (`pnpm corpus`,
  `tests/player/corpus/run.ts`): the player plays each `avm1/`, `avm2/`
  and `timeline/` test that has Flash's `output.txt` for the frames its
  `test.toml` names, in Chrome as the player's tests run, and its trace is
  compared to Flash's line by line. The page runs the runtime as the
  debugger player, since Ruffle recorded its traces with one and adl is
  one: an uncaught error's line carries its text, "Error #1010: A term is
  undefined and has no properties.", where the release player's and
  avmshell's has the number alone. `baseline.json` records each test's
  standing, as `tests/tamarin/swf2es-baseline.json` records swf2es's on
  Tamarin: the lines matched before the first difference, of how many,
  and what stopped the player, if anything. A change may not lower a
  standing, and one that raises it updates the baseline with
  `--update-baseline`; a test whose standing varies from run to run is
  set to null and not compared. Only the traces are compared: the frames
  Flash drew are the oracle's matter (above), and a test needing audio,
  video or a default font is ignored, as the collector marks it. A test's
  `input.json`, the mouse, keys and text Ruffle's runner plays into it, is
  played as Ruffle plays it (`tests/player/replay.ts`): after each frame,
  the events up to the next `Wait`. A key's press sends its events and
  moves focus with Tab, and only the recorded text and editing keys edit
  a field, as Ruffle's input keeps them apart; a press is a first click
  unless its `index` counts it as a second, as Ruffle's runner has it.
  A test that gives its window (`viewport_dimensions`) recorded its
  positions in it, the stage shown whole and centred: they are scaled
  back to the stage's, and an AVM1 movie told the window's pixels to a
  stage pixel, which `_xmouse` is measured in.
  Flash's harness plays no input, so `check-references.ts` leaves these
  tests out.
  A test that does not finish in its time is a timeout, a standing of its
  own. The corpus is fetched, not committed: CI's `corpus` job, beside
  the build job on every pull request and every push to main or dev,
  fetches it at
  `RUFFLE_COMMIT`, caches it by that commit, and fails on a lowered
  standing, naming the test, its standing before and after, and where its
  trace parts from Flash's. It is what says, in order of what real SWFs
  hit first, what the player lacks.

The AS3 half of a player test is an `.as` file beside its case, compiled
in the oracle's container by ASC against `builtin.abc` and
`playerglobal.abc` (which stays in the image, not the repository), and
placed in the
SWF the test builds as a `DoABC` with a `SymbolClass`. Flash's trace of
the SWF is recorded by `--update` beside its frames, and the player's
must match it line for line, as the conformance cases must match
avmshell's.

### Fuzzing the compiler

The JIT compiles whatever bytes a SWF holds, so codegen must reject any
malformed ABC with a VerifyError, never trap. `tests/fuzz/abc.ts` mutates
seed ABCs (the unit tests' hand-built ones and the conformance cases) a
few bytes at a time, mostly toward the end, where the method bodies are,
and checks that the compiler does not trap, that a module it accepts
imports as an ES module, and that each of its methods compiled alone is its
entry in the module. A seeded generator makes a run repeat; a failing case
is written to `tests/fuzz/out/failures/`. `pnpm test` runs a short round,
`pnpm test:checked` the same in the build that checks every array access,
which catches a read past a table's end the release build lets through.

`tests/fuzz/avm1.ts` does the same for AVM1's decoder and flow
(`codegen/assembly/avm1/`): action blocks generated from the actions'
grammar, nested bodies and branches among them, and shapes at the edges
(bodies that jump back before their own start, long `WaitForFrame` chains,
deep nesting, blocks that read the same bytes from many offsets), mutated
a few bytes at a time or cut short. A block must decode without a trap, no
region may hold an action in two of its blocks, and a block must decode
the same again after others. The flow refuses a block whose regions would
hold more than 2M actions or whose decoding would read more than eight
bytes per byte of it (and a megabyte besides), so a crafted block costs
time in proportion to its size.

`tests/fuzz/domains.ts` gives two instances the same ABCs, child domains
and findings in a seeded random order, and lets one of them also drop,
evict, revive and rebuild domains; every module, entry, method compiled
alone and resolved slot type of a live ABC must come out of both the same.
Besides the conformance cases, it loads classes made to collide, and
again and again has a domain resolve a type its ancestor then defines
anew, the order a rebuild must not change.

## Milestone 1

Met, and kept for the record. The as3pb protobuf benchmark
(`tests/programs`), compiled by swf2es and run in node:

- its trace output matches avmshell byte for byte;
- it is faster than the AwayFL JIT on the same benchmark (headless, its
  first run: ByteArray 525 ms, domain memory 689 ms; PepperFlash 188 ms /
  83 ms). Met since #23, at 207 ms / 251 ms
  ([benchmarks.md](benchmarks.md#generated-code-as3pb));
- the Tamarin `ecma3/` and `as3/Types/` suites run through the conformance
  runner, with their pass rate tracked.

Out of scope for milestone 1: E4X, `Proxy`, `with`, playerglobal, SWF
timelines.
