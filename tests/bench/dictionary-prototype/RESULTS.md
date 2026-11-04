# Recorded Dictionary prototype measurements

Measured 2026-11-04 with Node v24.22.1 on an Intel Core i9-13900H. Raw paired
timings, memory samples, source hashes and Adobe timing samples are in
[measurements.json](measurements.json). These are standalone microbenchmarks,
not browser or swf2es integration results.

The prior standalone source is frozen in `before-trim.js.txt`, SHA-256
`d68eefdf3a7dd53a5550d1916f0ead048d20097ada5b36a8ba9c1df29c3522b6`.
The current candidate's source hash is recorded in the JSON. The PR starts from
dev `ea731a59793bfbe85620a6ed313ecda19970ab50`; production runtime/compiler code
is unchanged.

## Retained memory

Five fresh processes per case, 100 dictionaries with 1,000 common object keys
each. Values are `{key}` objects. Measurements are KiB per dictionary above an
empty baseline after full collections across three JS jobs. Shared external
keys and prewarmed module identity hashes are excluded. This is incremental
storage/enumeration cost, not total application RAM.

| State | Strong | Weak |
|---|---:|---:|
| Populated | 153.3 | 275.2 |
| After a complete walk | 153.4 | 275.4 |
| All entries deleted, before refresh | 94.4 | 212.6 |
| After an empty walk refresh | 16.3 | 134.6 |
| After explicit `trim()` | 0.46 | 0.97 |

Weak refreshed storage previously retained about 212.7 KiB. Clearing a deleted
record's retired-slot reference removes about 78 KiB per 1,000 cached keys
after refresh. Explicit trimming then drops dormant records/WeakRefs and shrinks
the table. Keys can remain externally alive throughout this measurement.
Deleted user values collect, including values referencing their keys.

The original main comparison used
`b417c5f52c688181b6a127e58131eaeecac64bd0` and the same payload/count/GC method:

| State | Main strong | Main weak |
|---|---:|---:|
| Populated, no enumeration | 59.0 | 177.6 |
| After a complete walk | 97.8 | 216.4 |
| Deleted, no refresh | 38.7 | 102.3 |
| Deleted, empty walk completed | 10.8 | 11.7 |

The prototype still has higher live-entry overhead: about +57% strong / +27%
weak after enumeration. Trimming is explicit, and without it dormant weak
metadata can remain while external keys stay live. The shared weak identity
hash table and the runtime/module are outside the baseline. No universal memory
improvement is claimed.

Main's object-key storage and actual numeric enumeration helpers were measured
through the runtime unit fixture, with ordinary host-object keys and temporary
Multiname allocation excluded. A preserved clean build was used after verifying
the complete runtime/format/native source trees against main: only
`enumeration.ts` differed, and main's version was taken verbatim from git and
type-erased for the snapshot. The source digest and main samples are preserved.
The portable reproduction is to build that main revision separately and pass
its `packages/runtime/dist` to `memory.js --runtime`.

## Throughput before/after trimming support

Seven alternating A/B pairs, fresh Node processes; version and case order
alternate. All results/checksums are checked. Values are integers here. Table
entries are median (min–max) milliseconds. Read cases use 2,000 complete walks
over 1,000 held keys. Refill/delete cases use 200 cycles, including insertion,
enumeration, deletion, allocation and table maintenance. Timers exclude startup.
`trim()` is an idle operation and is not called inside these steady-state loops.

| Workload | Before | Candidate |
|---|---:|---:|
| Strong cursor value sum | 13.67 (13.23–14.39) | 14.57 (12.36–19.15) |
| Strong JS iterator value sum | 20.93 (19.80–25.67) | 20.96 (20.15–25.24) |
| Weak cursor value sum | 102.12 (98.12–105.47) | 99.95 (97.61–103.83) |
| Weak JS iterator value sum | 64.86 (61.93–69.82) | 63.52 (61.29–69.28) |
| Strong cursor refill/delete | 24.28 (23.49–26.86) | 26.55 (23.45–29.66) |
| Strong JS iterator refill/delete | 32.80 (27.20–38.73) | 31.67 (27.25–37.36) |
| Weak cursor refill/delete | 51.02 (49.15–53.96) | 51.41 (48.88–53.83) |
| Weak JS iterator refill/delete | 51.39 (49.44–58.68) | 50.71 (48.82–55.86) |

No throughput improvement is claimed for adding trimming. Strong cursor
medians were about 7–9% slower in these runs, with overlapping ranges. The
memory reduction motivates the change. Count-only and native Map controls are
also preserved in the raw samples; unused key/value reads can be optimized away,
so consumed-value and checked-mutation cases are the stronger evidence.

## Adobe timing context

Seven fresh runs per engine of the matching AS3 workloads, with output/counts
checked. Millisecond Date timers are used in Adobe, `performance.now()` in Node.
The saved Adobe runs preceded the trimming addition; their sources are included
as `ReadBench.as` and `MutationBench.as` for regeneration.

| Workload, 1,000 keys | Candidate JS iterator | avmshell | ADL |
|---|---:|---:|---:|
| Strong read-only sum | 20.96 | 35 | 75 |
| Weak read-only sum | 63.52 | 42 | 86 |
| Strong refill/delete | 31.67 | 17 | 31 |
| Weak refill/delete | 50.71 | 19 | 41 |

ADL used the installed Windows AIR SDK under Wine/Flatpak. avmshell used the
pinned repository oracle image. Node launchers used CPU 4; Adobe child affinity
through container/Flatpak was not independently verified. Engines ran
sequentially; Adobe cases have a fixed order. Cross-engine results include
different JIT/loop overhead and are not a controlled application speedup.

## Semantics and open work

Both JS APIs match all 810 stable reference outputs and the exact final
contents of 198 insertion/reinsertion/growth cases. The fixture contains three
fresh avmshell and three fresh ADL samples. Reference regeneration also
reproduced all stable/final outputs without changing expected results.

Exact visit counts still differ in 51 avmshell / 49 ADL cases with the saved
observations, and some Adobe observations themselves vary between processes.
These remain documented gaps, not conformance successes. QName/Namespace,
traits, full prototype semantics, API versions and other runtime integration
behaviors are outside this prototype. See the README for the supported API and
idle-boundary requirement of `trim()`.

## Repository validation

`pnpm check`, `pnpm build`, `pnpm typecheck` and the full serialized `pnpm test`
passed on the feature branch. The latter used `ELECTRON_RUN_AS_NODE` unset.
Desktop smoke/Stage3D checks skipped because Electron was not downloaded; two
conditional unit checks also skipped. No production runtime or compiler sources,
dependencies, Tamarin baselines or corpus baselines changed.
