# The compiler in Zig

Status: ported. Stage 7 (`zig/stage-7`) swapped the compilers and deleted
the AssemblyScript one, with no release that kept both; the tag
`zig-last-parity` is the last commit that has both, where the whole parity
harness ran, and comments that name `assembly/...` mean its files there.
The port was done on stacked pull requests from stage 0 (`zig/stage-0`,
on `dev` at 52aac10d, the merge of #1185). The plan was read against
`dev` at fcecef29 and #1185; the earlier spikes are on local branches,
`experiment/zig-abc` and `experiment/zig-avm1`. Where this says
"estimate", nothing was measured; where it says "to check", the code was
not read to confirm it.

Decided:

- **Stacked pull requests, nothing merged to `dev` until the port is
  complete.** Each stage is a pull request on the one before it (stage
  0's on `dev`), reviewed as it comes, and the stack is merged only once
  the whole compiler is at parity. `dev` never carries a half-ported
  compiler, the switch or the parity job; they arrive with the stack.
  When a stage below is merged into its base, the ones above are
  retargeted first, before its branch is deleted.
- **`assembly/` is frozen** from the merge of #1185 (52aac10d) until the
  swap, but for fixes, each of which is made in both. Section 10's first
  question is answered by this.
- **Inside `@swf2es/codegen`**, at `packages/codegen/zig/` (`build.zig`,
  `src/`, each file's tests at its end), beside `assembly/`; not in
  `@swf2es/native`, which shares only the toolchain (`tools/zig.ts`).
- **Zig 0.17.0, pinned for good; ReleaseSafe shipped;** M1's memory
  (section 2): a bump arena per call and one per `Domain`, over a page
  allocator of fixed chunks that never doubles memory.
- **The Zig wasm is built, not checked in.** Only digests are
  (`packages/codegen/zig/digests.json`); `pnpm build` runs the pinned Zig,
  downloaded once by `tools/zig.ts`, and CI builds it again and compares
  (section 7).
- **A panic is recovered from**: the wrapper makes a fresh instance and
  adds the live ABCs again, and the load that panicked fails as a
  VerifyError would (section 7).

## Why

A long session of busy real content that loads about 1,500 SWFs left
codegen's `WebAssembly.Memory` at 256 MB, which the page keeps for good.
#1185 found the cause, compaction rebuilding the domain in place, and
now rebuilds it a part at a time into a second instance. Over 300 real
loads that takes memory from 512 MB and 30 rebuilds (about 105 s of
stalls) to 250 MB and 9 rebuilds (about 31 s). About 94% of each rebuild
is verifying the live ABCs again.

That is as far as AssemblyScript goes. The compiler's long-lived state
is garbage-collected objects in one heap (`Domain`'s dozens of arrays,
`TraitsTable`, each `Abc`), so what a dropped application domain took
cannot be found and freed; it can only be left behind by building
everything else again. Rows are `Array<T>`s that double and keep their
slack, every object has a header, and the runtime grows memory by
doubling.

The spikes showed what Zig gives instead:

- Memory is ours to lay out. The ABC reader and pool took half the
  memory (5.6 MB against 11.9 MB for a 3.78 MB ABC) with a bump arena.
  The whole AVM1 compiler, with one region of lasting blocks and a
  per-call arena, peaked at 190 MiB where AssemblyScript peaked at 356
  on an obfuscated SWF, and 15.0 against 16.0 on the corpus.
- ReleaseSafe checks every index, cast and overflow at about the speed
  of today's unchecked build, and found two latent bugs in the slice.
- Tests sit at the end of each file, every allocation can be shown to
  fail cleanly (`checkAllAllocationFailures`), and the fuzzer and a
  debugger run natively.
- The AVM1 port was byte-identical on 1,683 corpus SWFs, 107 of the
  repository's, an obfuscated SWF of 19,722 units and 680k fuzz outputs,
  in 3,269 lines against 3,791.

It was parked on 2026-10-23 until codegen's memory became a problem. It
has.

## 1. Goals and non-goals

Goals, in order:

1. **The same bytes.** Every module, source map, entry list, unit, key
   header and key log the Zig compiler hands out equals the
   AssemblyScript compiler's, byte for byte, on everything the
   repository can feed both. Every rejection has the same VerifyError
   number.
2. **The rules of AGENTS.md hold as they are.** Codegen is pure; the wasm
   imports only `env.abort`; JIT and AOT output are identical; a method
   compiled alone is its entry in its module; malformed input never
   traps; errors are sticky flags and avmplus' numbers.
3. **Memory that follows what is live.** A dropped application domain's
   memory is free the moment it is dropped. No rebuild, and no stall, to
   get it back.
4. `@swf2es/codegen` stays the one package, with the same public API
   (`createCodegen`, `Codegen`, `moduleKey`, `KeyChains`), so the player,
   the CLI and the web element change little or not at all.

Non-goals of the port:

- No change in generated code, in what is accepted or rejected, or in
  the order anything resolves. A bug found on the way is reported and
  fixed in AssemblyScript first, or after the swap, never during.
- No new optimizations, no new IR, no restructuring of stages. Files
  keep their names and their functions, `.ts` to `.zig`.
- Idiomatic Zig (iterators, tagged unions, comptime tables, error
  unions) only where the output stays identical, and as a pass of its
  own after a stage is at parity, as the AVM1 slice did it.
- No threads, no shared memory, no native CLI. Section 8 says what
  keeps those possible.
- Not in `@swf2es/native`. That package stays leaf kernels that depend
  on nothing; the compiler depends on `format` through its wrapper and
  has its own API, cache key and purity rules. Considered and rejected:
  it would change the boundary table and docs/architecture/overview.md
  for no gain. Only the toolchain is shared (section 7).

## 2. Memory

### What there is to place

Today one `Domain` (`assembly/avm2/link/domain.ts`) holds every
application domain's rows in the same arrays, by ids that are global:

| What | Where today | Owner |
|---|---|---|
| An ABC's bytes and PADDING | `buffers`, `abcBuffer`, `abcBase` | its ABC |
| Its parsed tables | `Abc` and its pool, methods, classes, traits, bodies | its ABC |
| Its id maps | `abcString`, `abcNs`, `abcNsVersion`, `scriptTraits`, `bodyTraits` | its ABC |
| Classes, traits, members, methods | `class*`, `TraitsTable` (`kind` … `scope`, `member*`), `methodAbcIndex` | the ABC that defines them |
| What resolves lazily | `slotType`, `dispatch`, `paramType`, signatures, `Scope`s, verified scopes | the traits' or method's ABC |
| Script bindings, class names | `binding*`, `type*` | the defining ABC |
| On-demand traits | `catchScopes`, `vectorOf` | see below |
| Lookup memo | `bindingMemo`, `memo*` | the asking ABC |
| Findings | `cached*`, `found*` | the application domain that found |
| The log | `logKind`, `logAt`, `logAbc`, `logA`, `logB` | the ABC each entry is of |
| Interned strings, namespaces | `stringPtr`, `stringLength`, `versioned`, `ns*`, `texts` | shared by every ABC that spells them |
| The tree | `domainParent`, `domainDepth`, `domainState`, `domainEvicted` | global |
| Per-ABC index arrays | `abcDomain`, `abcOwner`, `abcWeight`, `methodStart`, `classStart` | global |

Outside the domain: the `ModuleEmitter` kept for its entries and source
map (`written` in `compile.ts`), the `BodyDecoder`'s scratch, the
`Output` buffer, the IR's flat tables, AVM1's held SWFs (`held` in
`avm1/compile.ts`) and the key chains' marks.

### Three lifetimes

Every allocation takes an allocator named for how long it lives. There
is no general-purpose allocator and no `free` of single objects.

- **`call`**: a bump arena reset when the next call starts, as in the
  slice (`experiments/zig-avm1/src/memory.zig`, `Arena`). The decoder's
  scratch, the IR, `Output`, a module's parts, every temporary name.
  What a call hands out (an address and `outputLength()`) stays until
  the next call, as now.
- **`domain(d)`**: an arena per application domain. Everything the
  table above gives an ABC goes to the arena of that ABC's application
  domain. Freed whole when the domain is dropped, or evicted (below).
- **`global`**: the tree, the per-ABC index arrays, the intern tables,
  the kept emitter, AVM1's held SWFs. Small, or freed explicitly.

All three are lists of runs from one **page allocator** over wasm
memory: fixed chunks (16 KB, to be tuned against 64 KB), a bitmap of
free chunks, runs of adjacent chunks for anything larger, and
`memory.grow` by what is needed, never by doubling. Freeing an arena
returns its chunks; adjacent free chunks are one run again, so nothing
is kept apart by who freed it.

Tables are segmented lists (the slice's `Chunked`, with shelves that
double up to one chunk): rows never move, so a growing table leaves no
old copy behind in a bump arena, and a link that fails rolls back by
resetting lengths and the arena's mark, where `attach` now pops and
truncates some 15 arrays.

### Two steps, not one

The memory model changes in two steps, so that the translation is never
also a redesign.

**M1, with the port: one arena per `Domain`.** The global tables are
translated as they are, ids and all, into a single domain arena. Drop,
evict, revive and the rebuild (`lifetime.ts`: `rebuilt`, `Rebuild`,
`saveDomain`, `loadDomain`) are translated too. A rebuild makes the new
`Domain` in a new arena and frees the old one whole. This is the
compiler that is held byte-identical to AssemblyScript's. It already
gains exact-size rows, no object headers, no collector garbage inside a
call and no doubling of memory.

**M2, after the swap: an arena per application domain.** This is the
only part of the plan that is new design, and it is checked against M1
and the domains fuzz, not against AssemblyScript. What it needs:

1. *Rows by owner.* Each table's id space is cut into pages (32 to 256
   ids, by table). A page belongs to one application domain and its
   storage is in that domain's arena; a global directory maps `id >> k`
   to the page. A read is two loads, as an AssemblyScript `Array<T>`
   read is today. An ABC's rows are consecutive in its domain's pages,
   but ids no longer increase with time across domains. To check before
   M2: that nothing written to a module depends on the numeric order of
   ids from different ABCs. A rebuild already renumbers every id and the
   domains fuzz holds the modules equal, but it keeps the ids' relative
   order.
2. *Lookups by owner.* `strings`, `namespaces`, `bindings`, `types`,
   `cached`, `members` and `bindingMemo` are `IdTable`s filtered by
   `Domain.sees`. Bindings, type names, findings and the memo become a
   table per application domain, searched along the ancestor chain
   (`findIn`, `findTypeIn`, `findCached`), giving the same answer: the
   first from the root down, then load order.
3. *Shared names.* A string or namespace may be spelled first by a
   child and later by the root, and both must have one id, so interned
   names stay global. Their bytes are copied into a global string heap
   (size classes with free lists), not pointed at inside an ABC's
   buffer as `stringPtr` does, and each has a count of the ABCs that
   spell it (`abcString`, `abcNs` are exactly those lists). Freeing a
   domain walks its ABCs' lists and frees what reaches zero; freed ids
   are reused.
4. *On-demand traits.* `Vector.<T>`'s traits go to T's domain, a catch
   scope's to its ABC's: whoever can name them outlives nobody who can
   see them.
5. *The log by owner.* Each entry gets a global sequence number and
   lives in its ABC's domain. A reader (`domainContext`,
   `domainKeyLogBytes`, `domainLogSince`) merges the lists of the chain
   it sees by sequence, which is the order `logAt` gives now.

Then:

- **Drop** frees the domain's arena and its descendants', removes their
  pages from the directories and releases their names. Microseconds,
  inside `domainDrop`. No rebuild.
- **Evict** frees the same, and keeps what it keeps now once compacted:
  the domain's log entries and its ABCs' places (`KEPT_Weight`, 36
  bytes an entry). The host keeps the bytes (`evictable` in the
  player's `scripting/code.ts`).
- **Revive** links the evicted chain's ABCs again and does their log
  entries again, and nothing else: no live ABC is touched. Each entry
  must see the ABCs there were when it was first made, which a rebuild
  gets by replaying everything in order. A scoped replay needs lookups
  bounded by an ABC count (`find*` taking `upTo`, the entry's `logAt`).
  That bound is the one new piece of semantics; the domains fuzz
  (drops, evictions, revivals against a reference) is its test.
  Cost: the revived SWFs' own link and verification, milliseconds for
  the small SWFs that are evicted, where a revival after a compaction
  now links every live ABC.
- **Rebuild and compaction go away**: `domainCompact`,
  `domainWantsCompact`, `domainRebuild`, `domainRebuildStep`, the
  weights (`weigh`, `addWeights`, `rows`), and the player's
  `compactSoon`. `Codegen.compact()` stays in the API as a function
  that returns false, until the hosts stop calling it.
- **Left from stage 6 for M2.** The memory test accepts linear growth
  of about 220 bytes a load (domain and ABC indices, `domain.test.ts`,
  at most 512), which per-domain arenas should bound. Tables a call
  replaces in the domain's arena (an `IdTable` grown or rehashed, a
  `Rows` directory outgrown) stay there unweighed until the next
  rebuild, so the weights undercount the dead.

What still grows: the root. A SWF loaded into the main SWF's own
application domain adds its ABC there for good, as Flash keeps its
classes; arenas do not change that, and a session's live data grows
with it. The per-ABC index arrays grow by about 100 bytes an ABC ever
added, and evicted domains keep their log.

### High water and fragmentation

Wasm memory never shrinks, so the number that matters is the highest
sum of: the live domains' arenas, the global tables, one call's arena,
and free chunks nothing could use.

- Chunks are one size, so a freed domain's chunks fit any other. Only
  runs can fragment: an ABC's bytes (the parser reads them by address,
  so they stay contiguous), and the call arena's growing buffers.
- The call arena takes the topmost run, so that its last allocation
  (`Output`, the decoder's scratch) grows in place by growing memory,
  as the slice's does. A domain allocation made during a call (a traits
  resolved lazily, a log entry, a memo row) takes a free chunk below;
  a reserve of free chunks is kept for them. If the reserve runs out,
  the chunk goes above the call arena and the arena continues past it,
  at the cost of one copy when a buffer next grows. Stage 0 has no
  reserve yet: the call's run starts right past the highest chunk in
  use, and the first domain allocation of a call takes the chunk after
  it, so the call's run cannot grow in place again. A probe of a 2 MB
  output written between 4 MB of domain allocations took 13 runs each
  and 687 chunks (11 MB) for about 6 MB live. **Stage 3's exit
  criterion:** a reserve, or the call's run started a gap above the top,
  chosen by measuring the libraries, a large application's ABC and
  `codegen-session.ts`, with the call's runs and the chunks reached
  reported. *Measured at stage 3* (`memory.reserve`, `memoryTopRuns`):
  linking's call arena rarely outgrows its first run, so the reserve buys
  little there. With none, the libraries took 9 runs from the top in 5
  calls, a large application's 29 ABCs after them 41 in 35, and 400
  corpus SWFs each linked into a child domain and dropped 2,129 in
  2,121; with 32 chunks, 6, 36 and 2,123, for 0.5 MiB more memory
  reached (3.6, 3.6 and 10.1 MiB with none; AssemblyScript's memory 4.0,
  8.0 and 16.0, its size after a collection, which grows by powers of
  two, so an upper bound on its live heap rather than the heap itself). `codegen-session.ts` compiles modules, so it waits for
  stage 5, as does the choice: the reserve is none until the emitters'
  growing output, which the probe above found taking 13 runs a call, is
  measured with it.
- A slack of under one chunk per arena: 1,500 live domains would keep
  up to 24 MB at 16 KB, so the first chunk of a small domain is a
  quarter chunk taken from a shared one. To measure.

**Is #1185's second instance still needed?** In M1, yes, as it is: an
in-place rebuild still holds the old and the new tables together. In
M2 there is no rebuild, and nothing dead to leave behind. The one case
left is a peak that was never live data: a method body of megabytes
takes some 73 bytes a code byte of scratch (35 to 204 MB measured on
giant bodies), and memory stays there. Moving to a fresh instance is the
only cure for that. The save and load exports (`domainSaveBytes`,
`domainSavedAbcBytes`, `domainLoad`, `domainLoadAbc`,
`domainLoadRebuild`) are translated for M1 anyway, so the proposal is to
keep them through M2 as that escape, due only when memory is four times
what is live, and to decide on deleting them from measurements.

### Expected numbers (estimates)

| | AssemblyScript, #1185 | M1 | M2 |
|---|---|---|---|
| An ABC's parsed tables | about 3× its bytes | about 1.5× (spike) | the same |
| A row of traits | about 144 B (`rows()`) | 90 to 100 B | a little more (pages) |
| Slack and headers | three eighths over the rows (`full`) | under an eighth | the same |
| Memory against live weight | 1.7× to 4× (`rebuiltSize`, the policy) | 1.3× to 2× of a smaller live | live + one call + slack |
| 300 real loads | 250 MB, 9 rebuilds, about 31 s | 120 to 180 MB, as many rebuilds, shorter | 40 to 100 MB, no rebuilds |
| 100 dropped domains, then compact | 64 → 12 MB | about the same | never reaches 64 |
| Libraries alone | 8 MB | 4 to 6 MB; measured 11.6 MiB (below) | the same |

The M2 line assumes live weight of 60 to 150 MB by today's estimate
(250 MB over the 1.7× to 4× the policy keeps) and half to two thirds of
it in Zig's layout. `tests/bench/codegen-session.ts` (#1185) prints
memory, live and dead weight and rebuilds, and measures each step; the
first M1 measurement replaces this table.

*Measured in M1 (stage 6):* the libraries alone reach 11.6 MiB of wasm
memory in Zig, against AssemblyScript's 8.0, not 4 to 6: builtin and
playerglobal added take 4.0 in both, and compiling playerglobal's module
takes Zig's call arena and module text to 11.6 where AssemblyScript's
collector stays within its 8.0. After 30 loads of builtin into children
that are dropped and compacted, Zig is at 8.8 MiB and AssemblyScript at
16.0. 300 real loads: see stage 6 below.

## 3. Interface

**The TypeScript API does not change.** `packages/codegen/src/index.ts`
keeps `createCodegen(module)` and `Codegen`. What changes is under it.

Today `src/index.ts` imports `instantiate` from `dist/codegen.js`, the
glue asc generates (`bindings: "raw"`): it lowers `Uint8Array`s and
strings into managed objects, lifts strings out, and exposes
`__collect`. Zig has no such glue, and its ABI is bytes:

- Every call starts with `input(size)`, which resets the call arena and
  the last failure and gives room for the call's arrays and strings
  (0 bytes when it has none); the host writes them there and passes
  each as its address and length. No export starts a call itself, so
  none can forget to, and the wrapper calls `input` before every export
  but `outputLength` and `codegenError`, which read the last call.
  Addresses are u32 and reach JavaScript as i32: the wrapper reads them
  `>>> 0`.
- Whatever is handed out is an address, with `outputLength()` bytes,
  valid until the next call. The eight `*Bytes` exports already work so
  (`handed` in `src/index.ts`). The exports that return strings today
  (`domainLinked`, `domainContext`, `domainUsage`, `domainModuleEntries`,
  `domainSourceMap`, `domainRevision`, `domainLogSince`,
  `actionsModuleEntries`, `actionsModuleUnits`) hand out UTF-8 the same
  way.
- `codegenError()` says why the last call failed: 0, or 1 out of
  memory. A call that fails hands out nothing.

A hand-written `packages/codegen/src/zig.ts` (from the slice's
`bindings.ts`, written there for AVM1) wraps the Zig module in an
object with the same members the asc glue has, export for export, with
`__collect` doing nothing. `createCodegen` picks by what the module
exports (`input` is Zig's), so a host chooses a compiler by which wasm
file it loads and nothing else. The export names stay: `domainAdd`,
`domainChild`, `domainDrop`, `domainEvict`, `domainState`,
`domainRestore`, `domainRevive`, `domainFound`, `domainModuleBytes`,
`domainModuleMoreBytes`, `domainModuleDone`, `domainKeyHeaderBytes`,
`domainKeyFork`, `domainKeyLogBytes`, `domainParent`, `domainLogMark`,
`domainReplay`, the `actions*` twelve, `compilerVersion`, `abcVersion`,
`outputLength`.

**The cache key and determinism.** `moduleKey` names the compiler by
`Codegen.identity`, the SHA-256 that `stamp.ts` writes into the
`swf2es.build` section. The Zig wasm is stamped the same way and has
another identity, so no cache ever serves one compiler's module to the
other, though the modules are equal. The key's other parts come from
the compiler (`domainKeyHeaderBytes`, `domainKeyLogBytes`, `KeyChains`
in `src/keys.ts`), and parity holds them to AssemblyScript's bytes too.
`COMPILER_VERSION` does not move for the port.

What Zig adds to the purity rule, since nothing zeroes its memory:

- An arena hands back memory with the last call's bytes in it. Where
  AssemblyScript relied on `new StaticArray` being zero, the port
  allocates zeroed (`memory.allocZeroed`). A test build,
  `testing-zig-poison.wasm`, fills every freed run, every rolled-back
  allocation and memory freshly grown with 0xAA, and must give the same
  modules: the parity
  harness compares it with `codegen-zig.wasm` on every suite, and under
  `SWF2ES_COMPILER=zig` `testing-module.ts` loads it where the checked
  build is asked for, so that `pnpm determinism` runs it in place of the
  checked build.
- No address is ever hashed, compared or written; no `std.HashMap` is
  iterated into output (`IdTable` is ported as it is).
- Indices and sizes are `u32`, not `usize`, wherever they are stored or
  computed with, so a native build computes what wasm32 does.

## 4. Order of the port

`packages/codegen/zig/` beside `assembly/`: `build.zig`, `src/` with the
same tree (`avm1/`, `avm2/abc/`, `avm2/link/`, `avm2/ir/`, `avm2/emit/`,
`compile.zig`, `output.zig`, `memory.zig`, `panic.zig`, `dtoa.zig`,
`root.zig` for the exports, `testing.zig` for the test build's).

The test build's exports are what makes a stage checkable before the
next exists: `assembly/testing/abc.ts` dumps what the reader and the
decoder made (`poolDump`, `abcDump`, `codeDump`, `readAll`),
`testing/domain.ts` what linking and verifying made (`domainSummary`,
`domainTraits`, `domainSlotTypes`, `domainResolve`, `domainFind`,
`domainVerifyAll`, `domainIr`, `domainCheckIr`) and one method's code
(`domainEmit`), and `testing/avm1.ts` AVM1's (`avm1Dump`, `avm1Check`).
Each stage ports its dumps with it, and the parity harness compares the
two compilers' dump text on every ABC it has.

| # | Stage | AssemblyScript (lines) | Checked before the next by |
|---|---|---|---|
| 0 | Scaffold: `build.zig`, `memory.zig` (page allocator, arenas, segmented lists), `panic.zig`, `root.zig`, `src/zig.ts`, the switch, the parity harness with nothing to compare | new | the harness runs both builds; the wasm imports only `env.abort` (the unit test that checks `codegen.wasm`'s imports) |
| 1 | AVM1, from `experiment/zig-avm1` rebased on dev: `output`, `dtoa`, `avm1/**` | 3,791 + 308 | `actions*` bytes on the corpus's and the repository's AVM1 SWFs; `tests/fuzz/avm1.ts`; `determinism-avm1.ts`; `avm1*.test.ts`; the dumps (`avm1Dump`, `avm1Check`, `avm1Action`, `avm1Opcodes`) through the parity harness; `atEveryMemorySize` over every entry |
| 2 | ABC reading: `reader`, `pool` (from `experiment/zig-abc`), `constants`, `opcodes`, `parse`, `methods`, `classes`, `traits`, `bodies`, `abc` | 1,750 | `poolDump`, `abcDump`, `readAll`, `opcodeTable` and the error number on every ABC (libraries, tests, the corpus's DoABC tags) and on 4,000 mutated ones (`tests/fuzz/abc.ts` needs `domainAdd`, stage 3); `reader`, `pool`, `abc`, `opcodes` tests; `atEveryMemorySize` over the parser and dumps |
| 3 | Linking: `table`, `namespaces`, `domain`, `classes`, `typenames`, `traits`, `bindings`, `types`, `signatures`, and `lifetime` without the rebuild | 5,500 | `domainSummary`, `domainTraits`, `domainSlotTypes`, `domainResolve`, `domainFind` and link errors, over libraries, Tamarin and the corpus's ABCs added in the player's order; `domain` tests (`library-versions` compiles the libraries, and waits for stage 6's log exports); the call arena's reserve measured (section 2); a name that is not valid UTF-8 decoded and interned again as AssemblyScript does (section 6); `atEveryMemorySize` over `domainAdd` |
| 4 | Verifying and the IR: `code`, `verify`, `typing`, `properties`, `targets`, `ir` | 3,800 | `codeDump`, `domainIr`, `domainCheckIr`, `domainVerifyAll` and VerifyError numbers; `code`, `verify`, `typed`, `ir` tests; the ABC fuzz |
| 5 | Emitting: `method`, `blocks`, `structure`, `handlers`, `instructions`, `objects`, `values`, `refs`, `copies`, `floats`, `memory`, `stack-names`, `sourcemap`, `module` | 9,200 | `domainEmit` per method, then whole modules, source maps and entries; `pnpm determinism`; `emit`, `copies`, `folds`, `float`, `double`, `ascii` tests |
| 6 | The exports and lifetimes: `compile` (parts, `ModuleEmitter.begin`/`step`, entries, context, keys, log, replay), `lifetime`'s rebuild, save and load | 1,000 + about 700 of #1185 | `tests/fuzz/domains.ts` on both; `keys`, `wasm` tests; everything in section 5 through `createCodegen`; recovery from a panic by the journal (section 7), tested with `testingPanic` and `testingOverflow` mid-load |
| 7 | Swap (section 9) | | |
| 8 | M2 (section 2) | | the domains fuzz against M1; `codegen-session.ts`; `leak.ts` |

AVM1 arrives as the slice left it, after its idiomatic pass (tagged
unions, the comptime table of actions, iterators), since the slice was
held to parity through that pass; its files are split as AssemblyScript's
now are. Stages 2 to 5 are translated file by file, function by function,
so that their dumps map one to one and a difference points at the line
that made it; their idiomatic pass waits until after the swap.

Stages 2 to 5 depend on each other for checking, not for writing: the
files, functions and tables keep their names, so their translation can
go on at once in separate worktrees, and parity is then reached in
order.

**Can the two coexist? Yes, and they should, as two whole compilers.**
Recommended (and done, until stage 7 removed the switch with the
AssemblyScript compiler):

- Two wasm files in `@swf2es/codegen`'s `dist/`: `codegen.wasm`
  (AssemblyScript, the default) and `codegen-zig.wasm`, with the test
  builds beside them. `SWF2ES_COMPILER=zig` (or `as`, the default; any
  other value is refused) picks the second: the CLI reads it, and
  `tests/compiler.ts` does for the tests, making
  `@swf2es/codegen/codegen.wasm` resolve to `codegen-zig.wasm` for every
  loader in the process (a module resolve hook, which tests/unit's
  runner and `testing-module.ts` load), and serving it in its place to
  the Chrome tests' pages. `createCodegen` itself reads no environment;
  it tells the two by their exports. `SWF2ES_CODEGEN` keeps its meaning,
  a directory holding another copy of the release build for the A/B
  benchmarks. Not covered by the switch: the benchmarks; the bundled
  browser build and what serves it (`tests/web/cdn.ts`, the site's
  tests, the desktop app); and node Workers started without the parent's
  `--import` preload (those started with its `execArgv`, as by default,
  are covered). The tests/web and tests/context3d pages are, through
  `tests/player/serve.ts`. The whole-suite runs on Zig before the swap
  (`pnpm test`, `pnpm corpus`, `pnpm tamarin:swf2es`) cover everything
  by copying `codegen-zig.wasm` over `dist/codegen.wasm` after `pnpm
  build`, so that no loader can miss it.
- Until stage 6 the Zig module is not a compiler: the switch is only
  good for the stages it has, and the harness skips the rest.
- Not recommended: one `Codegen` over both, Zig's AVM1 with
  AssemblyScript's AVM2. AVM1 links to nothing, so it would work, but it
  ships two compilers to every page for a slice that is not the
  problem, and makes `identity` two hashes.

## 5. Parity

The AssemblyScript compiler is the oracle until it is deleted, as
avmshell is for semantics.

**The harness**, a test package of its own (`tests/parity/`, with its
own output folder): loads both builds, feeds both the same calls, and
compares bytes. Inputs, each with what is compared:

| Input | Compared |
|---|---|
| The libraries (builtin, playerglobal, AIR, float), each API series | modules, source maps, entries, contexts, key bytes |
| Conformance cases, as `tests/conformance/run.ts` compiles them | the same, and each method alone (`domainEmitEachBytes`) |
| Tamarin's ABCs (`pnpm tamarin:swf2es`'s own compiles) | modules and VerifyError numbers |
| Programs (as3pb, the LZ4 one) and `tests/libraries` | modules |
| Ruffle's corpus, AVM2 and AVM1 (`tests/player/corpus`) | modules, units, entries |
| `tests/fuzz/abc.ts`, `avm1.ts` | the result or the error of every case; neither traps |
| `tests/fuzz/domains.ts` | every module, entry and key after each drop, eviction, revival and rebuild |
| `pnpm determinism`, `determinism-avm1.ts` | run whole on the Zig build, and its reference compared with AssemblyScript's |
| Stage dumps (section 4) | text |

A difference prints the first differing line of the two outputs and the
method it is in. `domainUsage` and `domainWantsCompact` are not
compared: they report memory, which differs by design.

**Zig's own tests**, which need no oracle:

- `test` blocks at the end of each file, run natively by `zig build
  test`: the unit a file exports, on inputs small enough to read.
- `std.testing.checkAllAllocationFailures` over each entry
  (`domainAdd`, a module's parts, `actionsModuleBytes`, revive): every
  allocation made to fail in turn, each ending in `codegenError() == 1`,
  no trap, no leak, and the domain as it was before the call. An arena
  takes few runs and grows most in place, so that alone fails little;
  each entry is also run by `memory.atEveryMemorySize`, over memory of
  every size from one wasm page to 120, so that memory runs out at every
  point, a run neither grown nor taken, and must roll back to no chunk
  in use.
- `zig build test --fuzz` on the reader, the decoder and the whole
  compile entry, natively and coverage-guided, beside the seeded node
  fuzzers.
- The same corpus run natively and compared with the wasm's output by
  digest, which is what "native equals wasm" means in section 8.

**CI.** During the port: a `zig` job runs the inline tests, builds the
Zig wasm again with fresh caches and fails on a difference from
`digests.json`, and runs the harness on the stages the Zig one has. The existing jobs stay on
AssemblyScript. Before the swap: the whole of `pnpm test`, `pnpm
corpus` and `pnpm tamarin:swf2es` once with `SWF2ES_COMPILER=zig`, in CI.
After the swap, done in stage 7 with no release between: the jobs run on
Zig, and the parity job went with `assembly/`. From then on output is held
by determinism, conformance, Tamarin and the corpus, as before, and by
golden digests (`tests/golden/`, question 8 below): what the compiler makes
of the libraries (the player's and the oracle's), the unit tests' ABCs,
the conformance cases (with and without line maps), the programs and
AVM1 blocks, generated from the binary the last parity run held to
AssemblyScript's, and moved only by a change that means to move them.

What is no longer byte-compared on every pull request: Tamarin's ABCs,
Ruffle's corpus (AVM1 and AS3), API versions other than the ones the
golden digests use (the player's latest, AIR's, the shell's),
`compileModuleLogged`'s logs, `replay`, the key bytes (`domainKeyHeaderBytes`,
`domainKeyLogBytes`), the stepped paths of a module written a part at a
time under small budgets, and the fuzzers' differential suites. Their
behaviour is still tested (Tamarin, the corpus job, determinism, the
keys and domains tests), but not their bytes. For a refactor of the
compiler, the tool is the old-against-new harness: `tests/parity/run.ts`
at the tag `zig-last-parity`, its AssemblyScript side changed to load the
Zig test build of the commit before the refactor (both builds bind
through `src/zig.ts`), compares every suite byte for byte.

## 6. AssemblyScript behaviour to copy

From the AVM1 slice, already in `experiment/zig-avm1`:

- **Printing a double.** `Output.double` writes integers below 2^53
  itself and everything else with `f64.toString`, AssemblyScript's
  Grisu2. `dtoa.zig` is that algorithm as the repository's patch to
  AssemblyScript has it (`patches/assemblyscript@0.28.20.patch`, since
  the slice): where `genDigits` read past the ten entries of `POWERS10`
  into whatever static data followed, it multiplies by 0, which leaves
  the last digit unrounded, as every build printed it. The slice's
  copied over-read values (`tools/powers10.ts`) are gone; section 10's
  fourth question is answered by the patch.
- **Parsing an integer.** `i32.parse` and `I32.parseInt`: signs,
  whitespace, digits after garbage, wrapping. AVM2 uses them in
  `compile.ts` on the body list of `domainEmitEach` and on
  `domainReplay`'s log lines.
- **Reads after failure.** The decoders set a sticky error and read on;
  which later check fires first, as "too large" does, follows from what
  those reads return. The ABC reader reads into `PADDING` past the
  buffer; Zig keeps the padding and reads the padded slice, so the
  bytes are the same and in bounds.
- **`Array#sort`** on `i32`s in `avm1/flow/regions.ts`, and the
  insertion order of `Map<string, …>` in `avm1/emit/module.ts`.

For AVM2, from reading `assembly/`:

- **Wrapping arithmetic and casts.** AssemblyScript wraps every
  overflow and truncates every cast; ReleaseSafe panics on both. Each
  site that relies on it is written out: `*%` in `hashBytes` (FNV-1a)
  and `hashPair`, `@truncate` for `<u8>` and `<u32>`, `@bitCast` between
  signs, and a saturating helper for `<i32>` and `<i64>` of an `f64`
  (the wasm is built with nontrapping float-to-int, as asc builds it).
  This is where most translation bugs will be, and a panic in the fuzz
  is how each is found.
- **`IdTable`.** Linear probing at half full, 64 slots to start, and a
  `grow` that re-inserts from the first slot after an empty one, so
  that equal hashes stay in insertion order. Lookups take the first row
  that matches along the probe, so which of two definitions is found
  depends on this. Ported as written.
- **Maps.** `catchScopes`, `vectorOf` and the source map's `sourceIndex`
  are only read by key, never iterated: any map does.
- **Zeroed memory.** `new StaticArray<T>(n)` and a grown `Array` are
  zero (section 3).
- **Strings across the API.** `domainFound`'s URI and name arrive as
  UTF-16 and `internText` encodes them with `String.UTF8.encode`, whose
  default error mode is WTF-8: a lone surrogate is three bytes, where
  `TextEncoder` writes U+FFFD. The wrapper encodes every string so
  (`toUtf8` in `src/zig.ts`). Going out, `String.UTF8.decodeUnsafe` turns an ABC's bytes into
  the string an export returns (`avm1/compile.ts`, `emit/refs.ts`),
  without `TextDecoder`'s replacement of invalid sequences; the wrapper
  decodes as it does (`fromUtf8`: `TextDecoder` where the bytes are valid
  UTF-8, AssemblyScript's reading where not). Each export that changes
  from a string to bytes is compared on names that are not valid UTF-8.
  That equals AssemblyScript's only for a whole buffer decoded once.
  Where AssemblyScript decodes a piece and makes a string of it again,
  the decoding is part of the result, and the port must decode and
  encode again there too: `assembly/avm2/link/domain.ts` (about line
  600) decodes one name and interns `_${text}`, so invalid UTF-8 is
  normalised per piece (a name ending in a lone 0xC3 becomes `_`). Stage
  3, which ports it, has a test of a name that is not valid UTF-8 there
  (`Domain.underscoredName`, through `output.writeDecoded`). The search
  of `assembly/` for every other `decodeUnsafe` whose string goes back
  into bytes found, for stage 5: `emit/stack-names.ts` (about lines 72,
  95 and 101: a method's and a class's name as shown, where `text.length`
  is the decoded string's, so a name of only a cut-short sequence shows as
  `<anonymous>`) and `emit/refs.ts` (about lines 228 and 234,
  `qualified`, whose `uriText.length` is the decoded URI's). Each must
  decode with `writeDecoded`, and test emptiness after decoding, not on
  the bytes. `avm1/emit/module.ts` (about line 301) keys units by their
  decoded text, but that text is the emitter's own ASCII, so bytes
  compare alike. The rest (`compile.ts`, `avm1/compile.ts`, the
  `testing/` dumps) decode a whole buffer to hand it out, which the
  wrapper's `fromUtf8` does.
- **Text in the emitters.** `Output.text` writes the low byte of each
  UTF-16 unit; the emitters' own text is ASCII. Some 370 lines build a
  name or a snippet as a template string first. Writing those straight
  into `Output` gives the same bytes and is the one cleanup done while
  translating, since Zig has no string type to translate them to.
- **`Output.insert` and `remove`** move the buffer's tail; **`reserve`**
  grows in place with `__renew`. The call arena's last allocation grows
  in place the same way.
- **Unaligned little-endian loads** (`load<f64>`, `load<u64>` on ABC
  bytes): `std.mem.readInt` and a bit cast.
- **`Math.fround`, `Math.imul`**: `@floatCast` and `*%`.
- **Recursion.** AssemblyScript recurses on depths the input decides:
  the linker along a base-class chain (`TraitsTable.resolve`), down an
  interface hierarchy (`addInterfaces`) and down nested TypeNames
  (`resolveTypeId`, `resolveType`, `Domain.checkTypeName`); the
  structure emitter, the dominator walk and `Output.uint` too. Frames
  differ in size, so such an input overflows one compiler's stack and not
  the other's, and the engine's stack, not the shadow stack, ran out
  first in Zig's: a chain of 8,000 classes resolved from the last trapped
  there where AssemblyScript's returned. So the rule for the port: **no
  recursion on a depth the input decides.** Such a walk keeps its frames
  on a stack of its own in the call's arena, in the order the recursion
  visits them, the first error ending every frame. Stage 3's linker does
  (the parity suite `link-deep`: chains of 2,000 to 20,000 classes,
  interface chains to 4,000, TypeNames nested to 20,000, where
  AssemblyScript's stack runs out at the 20,000s and Zig's goes on);
  stages 4 and 5 write theirs as work lists from the first. Recursion is
  left only where the depth is the compiler's own (`Output.uint`'s
  digits). Zig 0.17's linker places the shadow stack first in memory
  (`__stack_pointer` starts at the stack's size, the static data after
  it), so an overflow traps and cannot write into the heap; its size, 1
  MiB, is to be set from the deepest the fuzzers and the corpus reach
  (the test build's `stackPaint` and `stackDeepest`). Such a trap is not
  a panic and kills the instance all the same (below). Known and kept,
  since the output depends on them only through their answers:
  AssemblyScript's `allInterfaces` is quadratic in the interfaces
  (`includes` on a list) and walks the whole base chain for each traits
  laid out, quadratic along a chain of classes, and the parser's
  `typeNamesAreAcyclic` is quadratic in nested TypeNames.
- **`rows()`, `weigh`, `memory.size()`** feed only the compaction
  policy, never a module. M1 keeps AssemblyScript's constants for a row
  of each table, so that the weights compare between the two (the
  parity harness compares `domainUsage`'s live and dead weights); only
  the memory size is Zig's own. `rows()` counts getBinding's memo, which
  a rollback empties, so after a call that ran out of memory the next
  ABC's weight can count fewer memo rows than AssemblyScript's, which
  trapped there instead; weights decide only when to compact.

Nothing in `assembly/avm2` sorts, and nothing was found that writes an
address or iterates a hash map into output. The parity harness is the
proof, not this list.

## 7. Build, toolchain and size

**Before the port.** `pnpm build` ran asc (`assemblyscript` 0.28, a
devDependency) on `asconfig.json`: `dist/codegen.wasm` at `-O3`,
unchecked, 259 KB with #1185 (94 KB gzipped), then `stamp.ts`, then the
test build `dist-test/testing.wasm` (271 KB). `pnpm test:checked` builds
a third with every access checked. Nothing is checked in, and
`dist/codegen.js`, the glue, is generated.

**In Zig**, as decided, sharing `packages/native`'s toolchain and no
more:

- The pinned Zig 0.17.0 through `tools/zig.ts` (`findZig`,
  `ZIG_VERSION`), never upgraded.
- `packages/codegen/zig/build.ts`, on `tools/zig.ts`'s `runZig` and
  `inputDigest`: `pnpm build` runs it. It builds `dist/codegen.wasm`
  (during the port `codegen-zig.wasm`, beside asc's), stamped by
  `stamp.ts`, and the test builds `dist-test/testing.wasm` and
  `testing-poison.wasm` (during the port `testing-zig.wasm` and
  `testing-zig-poison.wasm`). Nothing is checked in but
  `packages/codegen/zig/digests.json`: the digest of the inputs (the Zig
  sources, `build.zig`, `build.ts`, `stamp.ts`, `ZIG_VERSION`) and each
  module's SHA-256. A build whose inputs are the digested ones and
  gives other modules warns, as another host's Zig might (CI's
  `--verify` fails on it); one whose modules are already those does
  nothing, and needs no Zig. Zig's caches are kept in
  `~/.cache/swf2es/zig-codegen-cache`: the first build compiles Zig's
  build runner, about 70 s, later ones take under a second. `--update`
  runs `zig build test` and builds, with fresh caches shared by the two,
  and writes the digests.
- Every `pnpm build` thus needs the pinned Zig: from the PATH, or
  downloaded once (`tools/zig.ts` has the Linux, macOS and Windows
  releases). CI caches it and Zig's caches. Only Linux builds are
  checked against the digests, here and in CI; another host's differing
  module shows as `pnpm build`'s warning.
- CI's `codegen` job (`zig` during the port) runs `build.ts --verify`: the inline tests, a build with
  fresh caches, and a failure where the inputs or a module are not
  `digests.json`'s. The builds are deterministic: the same digests from
  fresh and kept caches, here and in CI.
- `build.zig` names the exports (`export_symbol_names`), disables the
  entry, builds `wasm32-freestanding` with bulk memory, nontrapping
  float-to-int, sign extension and mutable globals, single-threaded and
  stripped, plus a build with names for reading a trap's stack.
- `tools/notices.ts` gains Zig's standard library (MIT) for what is
  compiled in. AssemblyScript's notice stays after the deletion, reworded:
  `dtoa.zig` and `parse.zig` are translated from AssemblyScript's standard
  library (Apache-2.0), say so, and are compiled into `codegen.wasm`.

**Release mode: ReleaseSafe**, as agreed. A wrong index in the compiler
would otherwise become wrong JavaScript run with the page's privileges.
It also ends the separate checked build, `dist-test-checked`, since the
shipped build is the checked one. `pnpm test:checked` and `SWF2ES_CHECKED`
stay, for the player's own checks (its shortcuts and the renderer's spans
against full walks), and run the compiler's tests on the 0xAA build.

A panic is `env.abort`, with its message, and a trap. `src/zig.ts`
throws it as a `CodegenPanic` and marks the instance dead: every later
call throws one too. Any other trap (the shadow stack overflowing, the
engine's call stack exhausted) is taken for the same. As decided,
`createCodegen` then recovers, in the stage that ports the save and load
(6): a fresh instance with the live domain again, and the load that
panicked returns a VerifyError as a rejected ABC does.

Recovery reads nothing mutable from the dead instance. A trap stops a
call anywhere: an in-place row write, an `IdTable` rehash, the intern
tables or the allocator itself half done, and `__stack_pointer` not
unwound. Rolling back marks undoes appends, not those, so the domain is
not saved from the dead memory. Instead the wrapper keeps a journal of
the calls that change the domain, in order: reset, each ABC added (the
array the host passed, held), child domains, drops, evictions,
revivals, findings, and for each compile the log entries it fixed
(`domainLogMark` and `domainLogSince`, as `compileModuleLogged` takes
them). A fresh instance replays it, adds then `domainReplay` for the
compiles, and is the same domain by determinism; the load that panicked
is left out. If the replay itself panics or traps, or a compile's log
does not replay, there is no second attempt: the domain is lost, and a
fresh instance goes on for a reset and the calls that read no domain,
the domain's throwing until the next reset. Dropping a domain leaves placeholders for its ABC
indices. Ancestor resolutions survive a child being dropped. A successful
rebuild replaces the earlier journal with a checkpoint. Its retained
bytes and the measured journal size are described in stage 6 below. Running out of memory is not a panic: it is
`error.OutOfMemory` up to the export and a sticky code
(`codegenError()`), thrown by the wrapper as asc's trap was.

**Size.** There is no stated budget for the browser build; `swf2es.js`
is 1.88 MB and `worker.js` 1.79 MB beside the wasm's 0.26 MB. From the
slice (AVM1 alone: AssemblyScript 65 KB; Zig Small 56 to 74 KB, Fast
106 to 134 KB), the whole compiler is an estimated 300 KB in
ReleaseSmall and 450 to 550 KB in ReleaseFast or ReleaseSafe, perhaps
170 to 200 KB gzipped against 94. Speed from the slice: ReleaseSafe
0.73 to 0.85 of AssemblyScript's time before the idiomatic pass, about
equal after it; `std.Io.Writer` cost about 9%.

Stage 0's scaffold (memory, panics, the ABI, two exports), ReleaseSafe:
`codegen-zig.wasm` 3,638 bytes, 1,933 gzipped. Its build with fresh
caches, the inline tests included, takes about 90 s here, most of it
compiling Zig's build runner and the native tests; with `pnpm build`'s
kept caches, under a second.

Stage 1 (AVM1 on the scaffold): `codegen-zig.wasm` ReleaseSafe
114,249 bytes (43,571 gzipped), ReleaseFast 132,109 (42,399), ReleaseSmall
75,544 (29,933); the AVM1 part of AssemblyScript's was some 65 KB raw in
the slice's measurement. Eleven interleaved runs: the corpus's 1,680 AVM1
SWFs' modules 474 ms against AssemblyScript's 444 (1.07), memory 14.4
against 16.0 MiB; the obfuscated SWF's module, every block and its 19,722
units alone, 1,699 ms against 2,213 (0.77), memory 248 against 356 MiB.
The production path's high water on it, step by step in one instance
(what index.ts calls): the module kept, 191 MiB (AssemblyScript 356);
every block from the held SWF in one call, 248; every unit from it, 248.
The test-only emitEach with a fresh emitter a block reaches 220 alone.
One AVM1 unit test (`avm1-emit.test.ts`'s lazy blocks) reads
`Codegen.usage()`, which waits for stage 3's `domainUsage`.

Stage 2 (the ABC reader and parser) adds nothing to `codegen-zig.wasm`
yet, since no release export calls the parser before stage 3's
`domainAdd`; the test build grew from 141,874 to 189,140 bytes with the
parser and its four dumps.

Stage 3 (linking, `avm2/link/`): `codegen-zig.wasm` 207,957 bytes
ReleaseSafe, the parser now reached through `domainAdd`; the test build
325 KB. The libraries link in about the time AssemblyScript's take
(6 to 8 ms for builtin and playerglobal, warm). As built:

- *All or nothing.* A call that changes the domain runs inside a
  `Change`: the domain's struct is copied first (every table's length
  and shelves, every id table's slices, the scalars), the arena's mark
  taken, and each write to a row the call did not add goes through
  `Domain.put`, which keeps the old value in a journal in the call's
  arena. Running out of memory puts the journal back, then the copy,
  takes out of each id table the ids from its table's length on
  (linear probing never moves an earlier id, so emptying later slots
  changes no lookup of those before), empties getBinding's memo, a
  cache, and gives the arena back to its mark. Native tests hold every
  such call to `atEveryMemorySize` and to the failure of each
  allocation in turn, comparing a digest of the whole domain before
  and after. This answers, for running out of memory, what section 7's
  journal of calls answers for a trap.
- *Where M1 keeps what AssemblyScript's collector freed.* An ABC that
  does not parse gives its bytes and tables back with the arena's mark.
  One that parses and then fails to link keeps its bytes, as
  AssemblyScript does, since the strings it interned point into them,
  and keeps its parsed tables in the arena too until the domain is
  reset or, from stage 6, rebuilt. An id table that grows leaves its old
  slices in the arena. getBinding's memo is emptied in place, keeping
  its room, rather than made anew as AssemblyScript does, so that each
  finding the runtime reports leaves nothing behind; a lookup finds the
  same in either.
- *Writes outside `put`.* Where nothing that can fail follows a write in
  the same call, the write is raw: `lifetime.weigh`, `lifetime.restore`
  (on an ABC a rebuild let go of, after its parse), `leave`, `revive` and
  `unrevive`. Stages 5 and 6 allocate after some of these (a compile
  weighs its ABC, a revival rebuilds), and must make them `put` then.
  The test builds assert that a Change is open in `put`, getBinding,
  `resolve` and `sign`, and every build that no Change opens inside
  another. getBinding pushes its memo's rows before the id that names
  them, where AssemblyScript inserts the id first.
- *Unspecified reads.* AssemblyScript reads the first member of an empty
  last namespace set past the table's end (a name's first namespace, in
  five places). Zig's reads namespace 0 there and counts it
  (`domain.unspecified`, the test build's `unspecifiedReads`), and the
  parity harness compares such a case as unspecified. None has occurred
  in the corpus, the oracle's ABCs or the mutated ones.
- *What waits.* `domainCompact`, `domainRebuild` and the rest of the
  rebuild, saving and loading are stage 6; until then no rebuild ever is,
  so `domainRevive` never needs one. `domainWantsCompact` and the memory
  in `domainUsage` are Zig's own, not compared; its live and dead weights
  count rows alike and are.
- *Parity.* On the test builds, every ABC added is compared by its
  error, its traits before and after resolving, the ABCs it sees, its
  classes' slot types, and the domain's counts, builtins, weights and
  lookups: the libraries; the tests' ABCs and the link cases; the
  corpus's 1,000-odd AS3 SWFs and two additional local ones, each into a child
  domain then dropped; 8,000 mutated ABCs; the rich and the link ABCs
  cut and set byte by byte; 150 random lifetimes of application domains;
  and, where a host keeps them, the 9,884 ABCs ASC compiled for the
  oracle. Some 1.57 million cases, all the same, the poison build's
  included. Under `SWF2ES_COMPILER=zig`, `domain.test.ts` passes the 12
  of its 21 tests that need no module or rebuild, and `tests/fuzz/abc.ts`
  checks that linking never traps, stopping each accepted ABC where the
  emitter is not ported yet; `tests/fuzz/domains.ts` compiles modules
  from its first step and waits for stages 5 and 6.

Stage 4 (the verifier and the IR: `avm2/ir/ir.ts`, `abc/code`,
`targets`, `verify`, `typing`, `properties`). As built:

- *The decoder* lives in the call's arena, made by the first verify of a
  call and held by the domain for the call (`Domain.decoder`, dropped as
  each Change begins); AssemblyScript keeps one decoder across calls,
  which garbage collection between calls makes cheap. Its scratch is
  zeroed when made, where AssemblyScript's keeps stale values from the
  bodies before; nothing read them, as the parity suites show.
- *No recursion on input depth* is needed here: `target` and `throwsAt`
  call each other only through a loop header, and a handler's target is
  past its range (checkHandlers rejects one before its end), so after the
  instruction that throws, never a backward edge or a loop header: the
  recursion is at most target, throwsAt, target, and is ported as it is,
  with no allocation. (A first version made it a loop over frames in the
  call's arena, which allocated on every throwing instruction: 151 MB and
  234 ms for a megabyte body of them, now 114 MB and 113 ms, against
  AssemblyScript's 128 MB and 84 ms.) The IR dump's type names
  (`Vector.<...>`) count their levels.
- *Writes the rollback undoes.* Every row the verifier writes in place
  goes through `put`: the ABC marked verified, a function's flag, scope
  chain and list of chains, contested functions' merged chains, classes'
  captured scopes. A function's list of chains is replaced by a longer
  copy rather than grown, so that the old list is untouched for a
  rollback. Scope chains are made in the call's arena and copied into the
  domain's only when kept. The log entry a verification adds is
  truncated when it found nothing new, rows the call itself added.
- *Parity.* `codeDump` on every ABC there is and the link seeds (7,600
  cases), and on 10,000 mutated ones, most with bytes set in their code
  (20,000); each ABC verified after it links (the error of every body,
  its IR checked, and the IR of up to 64 bodies spread over it): the
  libraries (315), the tests' and the link cases' (448), the corpus's AS3
  SWFs and two additional local ones (80,153), 6,000 ABCs with their code mutated
  (29,078), and, where a host keeps them, the oracle's 9,884 (112,914).
  All the same, the poison build's included, with no unspecified read.
  Under `SWF2ES_COMPILER=zig` the `code`, `verify`, `typed` and `ir`
  tests pass 92 of 99; the rest compile modules. The ABC fuzz verifies
  and checks the IR of each ABC it accepts.
- *For stages 5 and 6.* The Verifier keeps its results and queue in the
  call's arena, and truncates its log entry with raw writes: valid while
  its init and its runs share one call and one Change. AssemblyScript
  steps it across calls (`run(budget)` with a finite budget, for the
  rebuild); stage 6, which ports that, must keep them in the domain's
  arena and journal the truncation, and give the stepped path parity
  cases, which have none yet. The decoder the domain holds is dropped as
  each call starts and as each Change begins. A call that runs out of
  memory leaves wasm memory as large as it grew, up to 4 GiB, which never
  shrinks: the host's recovery (section 7) should count that, a fresh
  instance being the only way to give it back. Parity case counts include
  two additional local SWFs.
- *Parity of the IR, whole.* `domainIrAll` (both test builds) writes every
  verified body's IR as numbers, block entry frames, flags and the with
  bit included, which stage 5 reads; each verify suite compares it for
  every ABC. The suites print the VerifyError numbers AssemblyScript gave,
  by number: the review's fuzz of structured bodies (`verify-fuzz`,
  4,000 ABCs) reaches 26 of them; `tests/parity/verify-errors.ts` adds
  1008 (a name bound in two namespaces of its set) and 1035 (getsuper in
  a function). 1109 (callstatic of a method with no receiver type) is
  unreachable: callstatic takes only methods bound to traits, whose
  receiver is their traits.
- *Size.* The verifier is not reached from a release export before stage
  5, so `codegen-zig.wasm` is unchanged (210,080 bytes, 73,864 gzipped);
  the test build grew from 328,159 to 448,069 bytes (112,586 to 152,340
  gzipped), about 40 KB gzipped for 3,800 lines of AssemblyScript
  (built by hand at the other levels: ReleaseSmall 28 KB of 103, Fast 39
  KB of 147). At that
  rate stage 5's 9,200 lines would add some 95 KB, and the whole compiler
  come to about 210 KB gzipped, past section 7's bound of twice
  AssemblyScript's (about 189): the stage 3 review's projection of 134 to
  168 KB does not hold for ReleaseSafe as translated so far,
  and section 7's levers (Output written directly, tables in the
  emitters, Small for cold files) are to be measured on the first emitter
  files of stage 5. The release's true cost is measured from now on with
  `zig build probe`, the release with a probe export reaching
  `verifyMethods` (and, later, what stage 5 adds): 333,974 bytes, 115.5
  KB gzipped in ReleaseSafe, against 210,001 and 73.8 without it (some 47
  KB raw of it stage 3's linker, unreachable before); ReleaseSmall
  233,821 and 83.5; ReleaseFast 347,324 and 109.2; `wasm-opt -Oz` takes
  ReleaseSafe to 298,765 and 111.5, ReleaseSmall to 207,376 and 79.9.

Stage 5 (the emitters), as it goes. `Output` has AssemblyScript's
methods (`text`, `byte`, `int`, `uint`, `double`, `string`, `chars`,
`hex`, `point`, `unit`, `append`, `reserve`, `reset`), so the emitters
translate call for call. Measured on the source map's writer, the first
file, in the probe: written into the buffer at each call site, grown
first, it added 4,490 bytes (1.9 KB gzipped) in ReleaseSafe and 2,712 in
ReleaseSmall; through std.Io.Writer's shared writeByte and writeAll,
2,192 (1.1 KB) and 1,966. `byte` and `text` therefore go through the
writer, keeping the methods' names: the API of AssemblyScript's Output at
std.Io.Writer's size.

For stage 5: `Output.init` reserves 64 KB up front, so each `Output` is
a whole run in the call arena; an emitter made per method or per block
should reuse one, as AssemblyScript's reuse their buffers.
(`ModuleEmitter.renew` does so for `domainEmitEach` without reuse.)

*Stage 5, measured.* Every emitter file is translated call for call;
`domainEmit` (a method alone), the module exports and `domainEmitEach`
come out byte for byte as AssemblyScript's on every corpus: 70,611
bodies of the corpus SWFs alone (61.5 MB of code) and 116,561 of the
oracle's (90.1 MB); 47,747 module cases of the corpus SWFs and 90,069 of
the oracle's, each module a part at a time, its source map, entries and
each entry compiled again alone; the libraries; and methods nested to
MAX_NESTING and past it. What stage 5 changed of the plan:

- A module written a part at a time lasts past the call that started
  it, and so does a kept one, for its source map and entries: both are
  in an arena of their own (`compile.zig`), given back when the next
  module starts or the domain changes under it. The method emitter's
  scratch is the call's arena, handed to it again as each part starts
  (`ModuleEmitter.prepare`), as AssemblyScript's collector frees it
  between calls; the `Verifier` takes the allocator its results and
  queue live in.
- The translation recurses along the dominator tree, as
  AssemblyScript's does, rather than taking a work list: its depth is
  bounded by MAX_NESTING, which `analyze` holds each block to before any
  code is written. 499 nested merges, the deepest structured, take 21 KB
  of Zig's shadow stack; 500 conditional branches each over a return to
  the next, whose targets are written in place a call deeper each, take
  109 KB of it, and, compiled cold, about 411 KB of the engine's stack
  (node's `--stack-size`), where AssemblyScript's takes about 311 KB:
  within node's default of about 984 KB, and within a browser's main
  thread; a worker given a smaller stack would trap there first.
- Any call may grow memory, Zig's call arena taking a run as a call
  starts: a host copies or decodes what a call hands out before the next,
  as the host does.
- All or nothing holds for each call, not for a module written a part at
  a time: a part that runs out of memory leaves the domain as the parts
  before it left it, weighs their rows to the ABC, and abandons the
  module, as a domain change does.
- For stage 6: the kept emitter holds the ABC's bytes and tables, which
  are in the domain's arena; a rebuild, a compaction and a load must let
  it go (`forgetModules`), as AssemblyScript's set `written` to null.

Size of the release, the emitters reached (stage 4's probe in brackets):

| Build | Bytes | Gzipped |
|---|---|---|
| ReleaseSafe | 530,926 (333,974) | 179.9 KB (115.5) |
| ReleaseSmall | 351,531 (233,821) | 124.7 KB (83.5) |
| ReleaseFast | 637,444 (347,324) | 179.3 KB (109.2) |
| ReleaseSafe + `wasm-opt -Oz` | 475,830 | 173.3 KB |
| ReleaseSmall + `wasm-opt -Oz` | 312,746 | 119.8 KB |
| ReleaseSmall, safety on in `abc/` | 359,597 | 128.0 KB |
| ReleaseSmall, safety on in `abc/`, `link/` and `ir/` | 366,406 | 130.3 KB |
| ReleaseSmall, safety on in `emit/` | 365,136 | 130.5 KB |
| AssemblyScript's codegen.wasm | 259,116 | 94.4 KB |

ReleaseSafe is 1.91 times AssemblyScript's gzipped, under section 7's
bound of twice. Safety itself is cheap: `@setRuntimeSafety(true)` in
every function of the code that reads untrusted input (the decoder,
verifier and parser) costs 3.3 KB gzipped over ReleaseSmall, 5.7 with
the linker and the IR; ReleaseSafe's 55 KB more is mostly its
optimization for speed. (Safety set so covers each function's own code:
what is inlined from another file keeps that file's setting.) The
emitters' code, by file, ReleaseSafe and ReleaseSmall: module 44.5 and
29.9 KB, method 39.2 and 20.8, objects 34.2 and 21.8, blocks (with
instructions inlined) 26.5 and 16.2, stack-names 8.5 and 3.1, refs 8.4
and 5.6, structure 6.4 and 3.3, values 6.1 and 3.8; the rest is inlined.

Stage 6 (the exports and lifetimes), as built:

- *Every export.* Keys, the log and its replay, the rebuild (whole and a
  part at a time), compaction, revival with a rebuild, and saving and
  loading. Every export of AssemblyScript's compiler is Zig's too, but
  its runtime's. Each domain is in an arena of its own (`Box`), so a
  rebuild or a load makes the new one beside the old. A rebuild's parts
  each run in a Change of the new domain. One that runs out of memory
  fails the rebuild, leaving the domain as it was and a domain being
  revived evicted. The domain it replaces is given back, with its kept
  module and its verified bodies.
- *Rebuilds parse the live ABCs again* into the new domain's arena, as
  the old one's arena goes with it. AssemblyScript's hands the new domain
  its Abc objects. A stepped rebuild keeps its current verifier's queue and
  results in a separate arena and releases them when that verifier finishes.
  `wantsRebuild` counts that re-parse for an in-place
  rebuild, which is Zig's own decision. The weights `domainUsage` reports
  stay AssemblyScript's, and are compared. An arena per parsed ABC, handed
  to the new domain, was tried (branch `zig/stage-6-abc-arenas`). It takes
  whole 16 KB chunks, so a small ABC costs at least that, which the dead
  weight does not see. It is M2's starting point, with a sub-chunk
  allocator for small ABCs whose dead runs are reused.
- *Recovery from a panic* uses the wrapper's journal (section 7). If a
  compaction spare is ready, it replaces the failed instance. Otherwise
  the wrapper instantiates the already compiled module synchronously when
  the panic occurs. A successful rebuild checkpoints its generation,
  domain state and live ABC bytes. A move parses those bytes once, into
  the destination arena. Recovery loads the checkpoint and replays only
  the later changes. It owns the bytes it needs from callers and records
  each compile's changes against the ABC it affected, including ancestors.
  The journal keeps inputs that reached the linker, including link rejections
  that already interned names. Dropping a child visits its subtree's journal
  entries and keeps placeholders for its ABC indices. ABCs that were live at
  the last checkpoint stay there until the next successful rebuild or reset.
  Each recovery invalidates outstanding cache reads with a new revision token.
  If a compile stops with a partial verifier log, further calls can still use
  the instance. A later panic can recover once a rebuild checkpoints it or a
  reset starts a fresh domain. A panic recovery cannot undo loses the
  domain, not the compiler: a fresh instance takes the dead one's place,
  a reset and what reads no domain (AVM1, `abcVersion`) go on, and the
  domain's calls throw until the next reset, where AssemblyScript's stays
  callable after a trap. A finding of an ABC outside the finder's chain,
  which the player never reports, is not journaled, as its replay can
  part from the compile (the compiler takes it unchecked, as
  AssemblyScript's does). A compile's log entry that does not replay
  fails the recovery, and the domain is lost.
- *Writes outside put.* A stepped verifier truncates its log entry in a
  later call than the one that added it, and a push in the same call may
  write over that row: a rollback writes it back (`Domain.truncated`).
- *Peak memory* on `codegen-session.ts`, 300 loads, seed 1, three
  interleaved runs per compiler. The largest single Wasm instance reached
  23.8 MiB with Zig and 29.8 MiB with AssemblyScript, with five and six
  rebuilds respectively. Median elapsed times were 6.14 s and 5.91 s.
  Other workloads shared the machine, so the timing comparison is
  inconclusive. At 25-load intervals Zig's recovery payload peaked at
  2.4 MiB outside Wasm, counting owned ABC bytes, serialized checkpoint
  state and four 32-bit words per recorded compile entry. Those words
  are packed, a run of one domain's ABCs to a typed array, so that a
  log entry takes its 16 bytes and about 9 more of JavaScript heap (the
  libraries' 8,023 entries: 0.07 MiB of heap), where the review measured
  94 bytes an entry with an object each. The 9 bytes are for one long
  run; many short runs, as compiles that log a few entries each make,
  cost a typed array and an object each. A restore is kept once an ABC,
  the first, however often a revival is retried. Memory shared in time by the old
  and spare instances is separate.

*Compaction pauses, measured* (after the review asked whether Zig's
rebuild, which parses the live ABCs again, stalls longer). A rebuild is
95% verification in Zig as in AssemblyScript (94%); re-parsing and
re-linking are under 4%. The verifier's domain lookups compared each
probed slot's rows before its stored hash, and the rows are read through
`Rows`' shelves: 40% of a rebuild. Comparing the hash first (as
`TraitsTable.own` did) took one rebuild of a long session's domain from
950 to 1,090 ms to 525 to 614 ms, against AssemblyScript's 612. On real
content, 300 loads of 109 SWFs with child domains evicted and dropped,
two interleaved runs each: Zig 9 compactions, median 4.10 s, max 4.48 s,
33.9 s in all; AssemblyScript 8, median 4.38 s, max 4.74 s, 31.3 s. Each
of Zig's comparable rebuilds took 0.91 to 0.95 of AssemblyScript's; the
ninth is its own memory-based decision. Memory: 123 MB against 308.
`codegen-session.ts`, 300 loads: 5 rebuilds (4 moves) against 6 (3),
5.5 s each, peak instance 15.2 MiB against 29.8. The review's synthetic
case (200 loads of three builtin copies, compacting each load): 3.9 s,
1.13 s of it in compact(), against 4.0 s and 1.03 s. M2 removes the
rebuild.

**Release mode, decided.** The user's decision after stage 5: the
release ships in ReleaseSafe. About 180 KB gzipped is fine, so section
7's bound of twice AssemblyScript's size and its 1.15 bound on compile
time are relaxed by that decision. Tuning compile time, such as writing
`Output` directly rather than through `std.Io.Writer`, is work for after
the swap. ReleaseSmall with safety set per function is not pursued.

Compile time, the median of 11 interleaved runs, each module a part at a
time as the host writes it, Zig's against AssemblyScript's: the
libraries 1.30, as3pb 1.18, a large application's 29 ABCs 1.22 in
ReleaseSafe; 1.26, 1.09 and 1.16 in ReleaseSmall; 1.07, 0.97 and 1.05 in
ReleaseFast; ReleaseSmall with safety in `abc/` 1.26, 1.15 and 1.09.
ReleaseSafe is over section 7's 1.15. Memory after compiling: 14.3, 12.7
and 4.9 MiB, against AssemblyScript's 16.0 each. `codegen-session.ts`
exercises the player’s keys and rebuilds. Its stage 6 results are above.

The parser's tables go to the allocator it is given (stage 3: the
domain's arena) and what only the parse needs (a set's members while
they are counted, the TypeName stamps) to a scratch allocator, the call's
arena, so a domain keeps nothing of a parse but its tables. Each ABC and
pool has its own default tables (`Abc.init`, `ConstantPool.init`), never
shared constants. The reader requires PADDING bytes past the ABC, which
domainAdd guarantees by copying the ABC so, as the dumps do.

**Output and `std.Io.Writer` (measured at stage 2).** In the names build,
the standalone writer and `std.fmt` functions are 3,875 of 106,184 code
bytes (3.6%); the rest of `print` is inlined into its callers
(`BlockEmitter.writeRegion`, which inlines every action's writer, is
21,695). That bounds what a switch saves in AVM1 at a few kilobytes, too
little to decide on size alone. The case for writing `Output` directly is
the translation: AssemblyScript's emitters call `out.text`, `out.uint`,
`out.hex`, `out.double` and `out.string`, and an `Output` with those
methods lets stage 5 translate its 9,200 lines call for call, where
`print` format strings would turn some 370 template strings into new
code to review. Recommended: give `output.zig` AssemblyScript's methods
before stage 5 starts, keep `writer()` for AVM1 until its idiomatic pass,
and measure size and time on the first emitter file both ways.

Measure, at the end of stages 1, 2 and 5 and before the swap, for Safe,
Fast and Small: bytes raw and gzipped, compile time (the libraries,
as3pb, a large application's ABC; 11 interleaved runs under the machine
lock, as #1185 measured), peak memory on `codegen-session.ts`. If Safe
is over twice today's gzipped size or over 1.15 of today's compile
time, the levers are, in order: `Output` written directly rather than
through `std.Io.Writer`; tables in place of generic code in the
emitters; Small for the cold files alone.

## 8. Tests, debugging and native builds

- **Inline tests.** Every file ends with its `test` blocks, as the
  slice's do and as `packages/native`'s Zig does. `zig build test` runs
  them natively in seconds, with no wasm, node or oracle. They cover
  what the file exports on small inputs; the corpus and the fuzzers
  stay in node, where the oracle is.
- **The unit tests stay.** `tests/unit/codegen/*.test.ts` (7,800 lines)
  drive the test build through `testing-module.ts` and run unchanged on
  either compiler. They are not moved into Zig during the port; a later
  pass may move the ones that test one file.
- **Debugging.** A native debug build under gdb or lldb, with a
  `replay` runner as the slice has (`src/replay.zig`): the wrapper can
  dump a session's calls to a file, and the runner plays it natively.
  The names build gives a trap in Chrome a readable stack.
- **Native compiler.** Not part of the port. It stays possible because
  of two rules kept from the start: `u32` indices, not `usize`; and the
  native run of the corpus equal to the wasm's by digest in CI. If a
  native `swf2es compile` or an Electron addon is wanted later, that
  check is what allows it; without it, native is for tests only.

## 9. Phases, swap and rollback

Agent time, on one machine where tests and benchmarks take turns
(`~/.cache/swf2es/machine.lock`):

| Phase | Work | Estimate |
|---|---|---|
| A | Stage 0: scaffold, memory, wrapper, switch, harness, CI job | 1 day |
| B | Stage 1: rebase the AVM1 slice onto dev and move it into the package | half a day |
| C | Stages 2 to 5 translated, in parallel worktrees | 1 to 2 days |
| D | Stages 2 to 6 brought to parity, in order | 4 to 7 days |
| E | Size and speed measured and tuned; whole suite on Zig in CI; review | 2 days |
| F | Swap, one release as default, deletion | 1 day of work, one release of waiting |
| G | M2: per-domain arenas | 4 to 6 days |

The mechanical translation, C, is about a weekend: 20,000 lines at the
slice's rate, written against files whose shape is known. It is not
where the time goes. D is: the verifier's fixpoint and the order things
resolve in must match exactly; every wrap and cast that AssemblyScript
did silently is a panic to find; the suites that prove parity take 5 to
10 minutes each and run one at a time; and dev keeps moving (85 commits
touched `assembly/` in the last month), so each is ported twice unless
the compiler is frozen. Two to three weeks to the swap is the honest
figure, and M2 a week after.

**During the port, `assembly/` is frozen** but for fixes, which are made
in both; each stage's pull request is rebased on `dev` as `dev` moves,
and the parity job runs on the stack's top. Nothing reaches `dev` until
the stack is complete and merged.

**Swap, as done.** The user decided against a release that kept both
compilers. Stage 7 swapped and deleted at once: `dist/codegen.wasm` is the
Zig build (the same bytes as `codegen-zig.wasm` at `zig-last-parity`), and
gone are `packages/codegen/assembly/`, `asconfig.json`,
`asconfig.base.json`, `asconfig.testing.json`, the `assemblyscript`
devDependency and its patch, the asc scripts in `package.json`, the
generated glue and `tsconfig.json`'s `rootDirs` for it, `__collect` and
`COLLECT_EVERY` in `src/index.ts` and `testing-module.ts`, the checked
build, the switch (`SWF2ES_COMPILER`, `tests/compiler.ts`), the parity job
and `tests/parity/` (its hand-built ABCs moved to `tests/unit/codegen/`,
its structured bodies to `tests/fuzz/`), the `assembly` entries in
`knip.json` and `biome.json`, and the AssemblyScript section of AGENTS.md,
replaced by Zig's rules. AssemblyScript's notice stays, for the code
ported from its standard library (section 7). Caches refill by
themselves, as a build's identity names its bytes. Then, with M2: the
rebuild, the weights and the compaction policy, and `compactSoon` in the
player.

**Rollback** is a revert of the stack's merge into `dev`: it brings the
AssemblyScript compiler, the switch and the parity job back as they were
at the merge. The modules are the same bytes either way, so nothing a
page has compiled or cached is wrong under the other compiler.

## 10. Risks and open questions

Risks:

- **Parity has a long tail.** The last differences will be in rare
  paths: a rejection's number on malformed input, an obfuscated method
  that takes the dispatcher. The fuzzers and the obfuscated SWFs are
  the guard; the plan does not swap until they are clean.
- **Size.** ReleaseSafe may double the wasm. Measured at stage 1 and 2,
  before most of the work.
- **Uninitialized memory** is a way for output to depend on history
  that AssemblyScript did not have. The 0xAA build is its test.
- **M2's bounded replay** is new logic in the part of the compiler that
  is hardest to reason about. It is deliberately after the swap, tested
  against M1, and can be dropped for "evict keeps the arena until
  memory is short" if it does not hold.
- **The root still grows** over a long session; M2 removes the dead
  weight and the stalls, not the live weight.
- **Every build needs Zig**: some 50 MB downloaded once, and a first
  build of about 70 s, where none was needed before; CI caches both.
- **Two compilers for some weeks**, and a moving target.
- **Zig 0.17 for good** means its bugs for good; the slice and
  `packages/native` have met none that mattered.

For the user to decide:

1. **Freeze or dual-write?** Decided: freeze, after #1185 lands, with
   the port on stacked pull requests merged to `dev` only when complete.
2. **Check in the wasm, or build it?** Decided: build it. Only the
   digests are checked in, and `pnpm build` runs the pinned Zig
   (downloaded once by `tools/zig.ts`); CI rebuilds and compares against
   the digests. This replaces the checked-in binaries described in
   section 7 for the compiler; `packages/native` keeps its own.
3. **After a panic**, is the compiler dead for the page, or recovered?
   Decided: recovered (section 7). The wrapper makes a fresh instance and adds the
   live ABCs again (#1185's save and load, or the player's journal where
   the dead instance can't be read), at a rebuild's cost, and the load
   that panicked fails as a VerifyError would.
4. **`POWERS10`.** Answered: the repository patched AssemblyScript to
   read no further than the table, printing what every build printed;
   `dtoa.zig` does the same.
5. **Size limit.** What may the wasm weigh before ReleaseSafe gives way
   to Small for cold code: twice today's gzipped size, as proposed?
6. **M2 at all, and when?** If M1 alone brings the 300-load session
   under some figure, is the remaining 9 rebuilds' stall acceptable, or
   is M2 the point? Proposed: M2 is the point; M1 is how to get there
   safely.
7. **Keep the second instance in M2** as the escape from a giant
   compile's high water, or delete it with the rebuild?
8. **Golden digests.** Once AssemblyScript is gone, nothing shows that
   a change moved the generated code but behaviour tests. Keep a file
   of module digests for the conformance cases, updated by the change
   that means to move them?
9. **Dedupe in the root.** A SWF loaded again into the same application
   domain adds its ABC again. Sharing one that has the same hash would
   cut the root's growth, but changes ABC indices and the log, so it is
   outside this plan. Worth a design of its own after M2?
10. **The idiomatic pass**: per stage as it reaches parity, or once at
    the end? The slice's pass cost speed (0.67 to 0.84 of
    AssemblyScript's time) and size (106 to 134 KB). Proposed: at the
    end, file by file, each held to parity and to the size and time
    measured before it.
