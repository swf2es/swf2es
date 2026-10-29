# Compiling ahead of time and caching modules

A module need not be compiled in the page: the swf2es command writes it
ahead of time, and a host may keep what the player compiled across page
loads. Both reach the player as a module cache, and both rely on the
player adding and compiling ABCs exactly as the command does.

## Ahead-of-time compilation

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

## Caching modules

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
verifying](compiler.md#parsing-linking-and-verifying)), and the player replays it in
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

## Modules compiled ahead of time in the player

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

## Pages without 'unsafe-eval'

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
command did not compile for, or a module of another compiler's. The
renderer builds no code at run time; `tests/player/precompiled.ts` plays a
SWF under that policy and draws it as without one.
