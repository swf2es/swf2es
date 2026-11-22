# The compiler in Zig

Status: draft, design and migration plan only, for review. Read against
`dev` at fcecef29 (the merge of #1183) and #1185 (open, `perf/codegen-memory`).
The earlier spikes are on local branches, `experiment/zig-abc` and
`experiment/zig-avm1`. Where this says "estimate", nothing was measured
for this draft; where it says "to check", the code was not read to
confirm it.

Decided since the draft:

- **Stacked pull requests, nothing merged to `dev` until the port is
  complete.** Each stage is a pull request on the one before it (stage
  0's on `dev`), reviewed as it comes, and the stack is merged only once
  the whole compiler is at parity. `dev` never carries a half-ported
  compiler, the switch or the parity job; they arrive with the stack.
  When a stage below is merged into its base, the ones above are
  retargeted first, before its branch is deleted.
- **`assembly/` is frozen** from the start of the port (after #1185
  lands) until the swap, but for fixes, each of which is made in both.
  Section 10's first question is answered by this.

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
  at the cost of one copy when a buffer next grows.
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
| Libraries alone | 8 MB | 4 to 6 MB | the same |

The M2 line assumes live weight of 60 to 150 MB by today's estimate
(250 MB over the 1.7× to 4× the policy keeps) and half to two thirds of
it in Zig's layout. `tests/bench/codegen-session.ts` (#1185) prints
memory, live and dead weight and rebuilds, and measures each step; the
first M1 measurement replaces this table.

## 3. Interface

**The TypeScript API does not change.** `packages/codegen/src/index.ts`
keeps `createCodegen(module)` and `Codegen`. What changes is under it.

Today `src/index.ts` imports `instantiate` from `dist/codegen.js`, the
glue asc generates (`bindings: "raw"`): it lowers `Uint8Array`s and
strings into managed objects, lifts strings out, and exposes
`__collect`. Zig has no such glue, and its ABI is bytes:

- `input(size)` gives room in the call arena; the host writes a call's
  arrays there and passes offsets and lengths.
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
  allocates zeroed. A test build fills every freed chunk and every reset
  arena with 0xAA and must give the same modules; `pnpm determinism`
  runs it in place of the checked build.
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
| 1 | AVM1, from `experiment/zig-avm1` rebased on dev: `output`, `dtoa`, `avm1/**` | 3,791 + 308 | `actions*` bytes on the corpus's and the repository's AVM1 SWFs; `tests/fuzz/avm1.ts`; `determinism-avm1.ts`; `avm1*.test.ts` |
| 2 | ABC reading: `reader`, `pool` (from `experiment/zig-abc`), `constants`, `opcodes`, `parse`, `methods`, `classes`, `traits`, `bodies`, `abc` | 1,750 | `poolDump`, `abcDump`, `readAll` and the error number on every ABC and on `tests/fuzz/abc.ts`'s malformed ones; `reader`, `pool`, `abc`, `opcodes` tests |
| 3 | Linking: `table`, `namespaces`, `domain`, `classes`, `typenames`, `traits`, `bindings`, `types`, `signatures`, and `lifetime` without the rebuild | 5,500 | `domainSummary`, `domainTraits`, `domainSlotTypes`, `domainResolve`, `domainFind` and link errors, over libraries, Tamarin and the corpus's ABCs added in the player's order; `domain`, `library-versions` tests |
| 4 | Verifying and the IR: `code`, `verify`, `typing`, `properties`, `targets`, `ir` | 3,800 | `codeDump`, `domainIr`, `domainCheckIr`, `domainVerifyAll` and VerifyError numbers; `code`, `verify`, `typed`, `ir` tests; the ABC fuzz |
| 5 | Emitting: `method`, `blocks`, `structure`, `handlers`, `instructions`, `objects`, `values`, `refs`, `copies`, `floats`, `memory`, `stack-names`, `sourcemap`, `module` | 9,200 | `domainEmit` per method, then whole modules, source maps and entries; `pnpm determinism`; `emit`, `copies`, `folds`, `float`, `double`, `ascii` tests |
| 6 | The exports and lifetimes: `compile` (parts, `ModuleEmitter.begin`/`step`, entries, context, keys, log, replay), `lifetime`'s rebuild, save and load | 1,000 + about 700 of #1185 | `tests/fuzz/domains.ts` on both; `keys`, `wasm` tests; everything in section 5 through `createCodegen` |
| 7 | Swap (section 9) | | |
| 8 | M2 (section 2) | | the domains fuzz against M1; `codegen-session.ts`; `leak.ts` |

Stages 2 to 5 depend on each other for checking, not for writing: the
files, functions and tables keep their names, so their translation can
go on at once in separate worktrees, and parity is then reached in
order.

**Can the two coexist? Yes, and they should, as two whole compilers.**
Recommended:

- Two wasm files in `@swf2es/codegen`'s `dist/`: `codegen.wasm`
  (AssemblyScript, the default) and `codegen-zig.wasm`, with the test
  builds beside them. `SWF2ES_CODEGEN=zig` makes the node loaders (the
  CLI's, `tests/unit/codegen/testing-module.ts`, the test packages') and
  the Chrome tests' pages load the second. `createCodegen` itself reads
  no environment; it tells the two by their exports.
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
  no trap, no leak, and the domain as it was before the call.
- `zig build test --fuzz` on the reader, the decoder and the whole
  compile entry, natively and coverage-guided, beside the seeded node
  fuzzers.
- The same corpus run natively and compared with the wasm's output by
  digest, which is what "native equals wasm" means in section 8.

**CI.** During the port: a `parity` job builds both compilers and runs
the harness on the stages the Zig one has; the `lint` job rebuilds the
Zig wasm with the pinned Zig and fails on a difference from the one
checked in, as it does for `packages/native`. The existing jobs stay on
AssemblyScript. Before the swap: the whole of `pnpm test`, `pnpm
corpus` and `pnpm tamarin:swf2es` once with `SWF2ES_CODEGEN=zig`, in CI.
After the swap: the jobs run on Zig, and the parity job runs with the
roles reversed for one release, then goes with `assembly/`. From then
on output is held by determinism, conformance, Tamarin and the corpus,
as now. An open question below asks whether to also keep digests.

## 6. AssemblyScript behaviour to copy

From the AVM1 slice, already in `experiment/zig-avm1`:

- **Printing a double.** `Output.double` writes integers below 2^53
  itself and everything else with `f64.toString`, AssemblyScript's
  Grisu2. `dtoa.zig` is that algorithm, including its fault: `genDigits`
  reads past the ten entries of `POWERS10` into the static data after
  it in about 45% of non-integer prints. The slice copied the values it
  finds there (`tools/powers10.ts`). They are a property of one
  AssemblyScript binary's layout; the port freezes them as of the
  oracle build, and section 10 asks whether to correct them after.
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
  UTF-16 and `internText` encodes them with `String.UTF8.encode`, which
  keeps a lone surrogate as three bytes where `TextEncoder` writes
  U+FFFD (to check); the wrapper encodes those two as AssemblyScript
  does. Going out, `String.UTF8.decodeUnsafe` turns an ABC's bytes into
  the string an export returns (`avm1/compile.ts`, `emit/refs.ts`),
  without `TextDecoder`'s replacement of invalid sequences. Each export
  that changes from a string to bytes is compared on names that are not
  valid UTF-8.
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
- **Recursion.** The structure emitter, the dominator walk and
  `Output.uint` recurse. Frames differ in size, so a pathological input
  may overflow one compiler's stack and not the other's. Zig's stack is
  placed first in memory so that an overflow traps and cannot write
  into the heap (to check with Zig 0.17's linker options), and
  its size is set from the deepest the fuzzers and the corpus reach.
- **`rows()`, `weigh`, `memory.size()`** feed only the compaction
  policy, never a module. M1 ports them with Zig's own row sizes.

Nothing in `assembly/avm2` sorts, and nothing was found that writes an
address or iterates a hash map into output. The parity harness is the
proof, not this list.

## 7. Build, toolchain and size

**Today.** `pnpm build` runs asc (`assemblyscript` 0.28, a
devDependency) on `asconfig.json`: `dist/codegen.wasm` at `-O3`,
unchecked, 259 KB with #1185 (94 KB gzipped), then `stamp.ts`, then the
test build `dist-test/testing.wasm` (271 KB). `pnpm test:checked` builds
a third with every access checked. Nothing is checked in, and
`dist/codegen.js`, the glue, is generated.

**In Zig**, as decided, sharing `packages/native`'s toolchain and no
more:

- The pinned Zig 0.17.0 through `tools/zig.ts` (`findZig`,
  `ZIG_VERSION`), never upgraded.
- `packages/codegen/build.ts`, on the helper `packages/native/build.ts`
  is made of, moved to `tools/` to be shared: it runs `zig build test`,
  then `zig build`, and writes `packages/codegen/wasm/codegen.wasm` and
  `testing.wasm` with a digest of their inputs (the Zig sources,
  `build.zig`, `ZIG_VERSION`). `--check` verifies the digest without a
  toolchain, and `pnpm build` runs it, copies the wasm to `dist/` and
  stamps it. Ordinary builds and `pnpm install` need no Zig.
- The binaries are checked in as files, not base64: hosts fetch
  `codegen.wasm` by URL (`@swf2es/codegen/codegen.wasm`), and the
  browser build copies it beside the bundle.
- CI's `lint` job rebuilds and runs `git diff --exit-code` on them, as
  it does for native's `binary.ts`. The slice's builds were
  deterministic.
- `build.zig` names the exports (`export_symbol_names`), disables the
  entry, builds `wasm32-freestanding` with bulk memory, nontrapping
  float-to-int, sign extension and mutable globals, single-threaded and
  stripped, plus a build with names for reading a trap's stack.
- `tools/notices.ts` gains Zig's standard library (MIT) for what is
  compiled in, and loses AssemblyScript's notice after the deletion.
  `dtoa.zig` is translated from AssemblyScript's standard library
  (Apache-2.0) and says so.

**Release mode: ReleaseSafe**, as agreed. A wrong index in the compiler
would otherwise become wrong JavaScript run with the page's privileges.
It also ends the separate checked build: `pnpm test:checked`,
`dist-test-checked` and `SWF2ES_CHECKED` go, since the shipped build is
the checked one.

A panic is `env.abort` and a trap. The wrapper turns it into an error
for the load that was compiling and marks the instance unusable; what
happens next is an open question (section 10). Running out of memory is
not a panic: it is `error.OutOfMemory` up to the export and a sticky
code.

**Size.** There is no stated budget for the browser build; `swf2es.js`
is 1.88 MB and `worker.js` 1.79 MB beside the wasm's 0.26 MB. From the
slice (AVM1 alone: AssemblyScript 65 KB; Zig Small 56 to 74 KB, Fast
106 to 134 KB), the whole compiler is an estimated 300 KB in
ReleaseSmall and 450 to 550 KB in ReleaseFast or ReleaseSafe, perhaps
170 to 200 KB gzipped against 94. Speed from the slice: ReleaseSafe
0.73 to 0.85 of AssemblyScript's time before the idiomatic pass, about
equal after it; `std.Io.Writer` cost about 9%.

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

**Swap.** One commit: `SWF2ES_CODEGEN` defaults to `zig`,
`dist/codegen.wasm` is the Zig build, and the AssemblyScript one is
kept as `codegen-as.wasm` for the parity job and for `SWF2ES_CODEGEN=as`.
Caches refill by themselves, since the identity changed.

**Rollback.** Before the deletion, set the default back: one line, and
caches refill again. The modules are the same bytes either way, so
nothing a page has compiled or cached is wrong under the other
compiler. After the deletion, rollback is a revert of the deletion
commit, which is why it waits a release.

**Deleted after one release on Zig:** `packages/codegen/assembly/`,
`asconfig.json`, `asconfig.base.json`, `asconfig.testing.json`, the
`assemblyscript` devDependency, the asc scripts in `package.json`, the
generated glue and `tsconfig.json`'s `rootDirs` for it, `__collect` and
`COLLECT_EVERY` in `src/index.ts` and `testing-module.ts`,
`test:checked` and the checked build, the parity job and `tests/parity/`,
the `assembly` entries in `knip.json` and `biome.json`, AssemblyScript's
notice, and the AssemblyScript section of AGENTS.md, replaced by Zig's
rules. Then, with M2: the rebuild, the weights and the compaction
policy, and `compactSoon` in the player.

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
- **Checked-in binaries** of some 0.5 MB each, two of them, on a
  package that changed 85 times in a month, add tens of megabytes to
  the repository's history a month.
- **Two compilers for some weeks**, and a moving target.
- **Zig 0.17 for good** means its bugs for good; the slice and
  `packages/native` have met none that mattered.

For the user to decide:

1. **Freeze or dual-write?** Decided: freeze, after #1185 lands, with
   the port on stacked pull requests merged to `dev` only when complete.
2. **Check in the wasm, or build it?** The decision recorded here is
   checked-in binaries with digests, as native. Given how often the
   compiler changes, the alternative is to check in only the digest of
   the inputs' expected output and have `pnpm build` run the pinned Zig
   (downloaded once by `tools/zig.ts`). Which?
3. **After a panic**, is the compiler dead for the page (as an
   AssemblyScript abort is now), or does the wrapper make a fresh
   instance and add the live ABCs again from the player's journal? The
   second reuses #1185's save and load, and costs a rebuild's time.
4. **`POWERS10`.** Keep the frozen over-read values for good, so that
   doubles print as they do now, or correct Grisu2 after the swap,
   which changes some modules' bytes (never their values) and moves
   `COMPILER_VERSION`?
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
