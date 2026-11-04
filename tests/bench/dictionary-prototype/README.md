# Standalone Dictionary experiment

This plain JavaScript class explores AVM2-style Dictionary storage and mutable
enumeration. It imports no swf2es runtime or compiler code. It is an experiment,
with known semantic gaps, rather than a runtime replacement.

Object/function keys use identity lookup. Other supported primitive keys become
property names. Enumeration uses shared physical slots, tombstones and weak
records; native Map insertion order is not used as the mutation specification.

```js
import { Avm2Dictionary } from "./dictionary.js";

const dictionary = new Avm2Dictionary(true);
const key = {};
dictionary.set(key, { key });
for (const current of dictionary.keys()) {
  dictionary.delete(current);
}
dictionary.trim();
```

## APIs and trimming

- `get`, `set` and `delete` preserve object identity and do not coerce object keys.
  `delete` returns AS3's successful deletion result even for an absent entry.
- `containsKey` checks own storage. `has` models AS3 `in`, including coercion of
  an absent object key for prototype lookup.
- `hasOwnProperty` and enumerability helpers coerce names. Dictionary ignores
  `setPropertyIsEnumerable` visibility changes, as the recorded Adobe runs do.
- `nextNameIndex(0)` starts a numeric-cursor walk; subsequent calls consume the
  returned opaque index. `nextName` and `nextValue` read that slot.
- `keys`, `values`, `entries` and `[Symbol.iterator]` provide JS iterators. The
  default iterator yields entries. These wrappers allocate iterator results;
  numeric cursors are preferable when measuring allocation overhead.
- `size` prunes dead weak records. `weakKeys` reports the storage mode.

`trim()` is an explicit host storage API. Call it at an idle boundary after
finishing/returning iterators: it rebuilds the shared slot table, changes numeric
cursor indices, shrinks capacity and drops dormant weak metadata. It preserves
live entries. It is not an ActionScript Dictionary method or a transparent
operation during an existing walk. There is no automatic cache budget yet.

Weak storage keeps values/records in ephemerons. Enumeration holds WeakRefs to
records, so a value referring back to its key does not create a strong root.
Deletion clears the record's key, value and retired-slot reference immediately.
Reusable metadata survives for externally live keys until trimming or collection.

## Validation

Run from the repository root; these checks need only Node, without a build or
Adobe installation:

```sh
node --expose-gc --test tests/bench/dictionary-prototype/dictionary.test.js
node tests/bench/dictionary-prototype/oracle-test.js
```

The normal unit suite runs both through
`tests/unit/runtime/dictionary-prototype.test.ts`. There are 25 focused unit/GC
tests, including unfinished walks, self-referencing values, live keys retaining
values, deleted values collecting with live keys, trimming, and 20,000 randomized
mixed-key operations.

The shared AS3 scenarios were recorded in three fresh avmshell and three fresh
ADL processes. Both JS APIs match 810 order-independent cases and the final
contents of 198 layout-sensitive cases. Exact visitation still differs in 51
avmshell cases and 49 ADL cases with the saved observations. These differences
are printed and remain open; final-content equality is not full conformance.
The Adobe processes themselves also vary on some visit counts.

`reference.json` stores short expected strings and hashes of long outputs, plus
the observed layout-dependent counts. Its source digest guards the shared AS3
body and adapter. Never change expected results just to make the class pass.
To regenerate references using the existing repository oracle and installed AIR:

```sh
node tests/bench/dictionary-prototype/oracle.ts 3
```

`SWF2ES_FLASH_HARNESS` optionally names another compatible `oracle/flash.ts`, for
example a harness under a home directory visible to a Wine sandbox. Full raw
reference output is written under ignored `out/`.

## Measurements

See [RESULTS.md](RESULTS.md) and [measurements.json](measurements.json) for the
recorded samples, source hashes, medians/ranges and limits.

```sh
node tests/bench/dictionary-prototype/run-bench.js 7
node tests/bench/dictionary-prototype/run-bench.js 7 mutation
node tests/bench/dictionary-prototype/memory.js 5
```

`before-trim.js.txt` preserves the prior standalone source for reproduction; it
is only a measurement fixture. A/B runs stage it as JavaScript under `out/`:

```sh
node tests/bench/dictionary-prototype/compare.js tests/bench/dictionary-prototype/before-trim.js.txt tests/bench/dictionary-prototype/dictionary.js 7 read
node tests/bench/dictionary-prototype/compare.js tests/bench/dictionary-prototype/before-trim.js.txt tests/bench/dictionary-prototype/dictionary.js 7 mutation
```

Fresh Adobe timings use matching AS3 workloads, excluding compilation/startup:

```sh
node tests/bench/dictionary-prototype/timing-oracle.ts 7 read
node tests/bench/dictionary-prototype/timing-oracle.ts 7 mutation
```

`memory.js --runtime` measures a separately built runtime's actual Map/WeakKeys
storage and numeric enumeration helpers, with temporary Multiname allocation
excluded. The baseline is incremental heap above empty dictionaries and common
externally held keys, not whole-player memory. For example, pass a built main
checkout explicitly:

```sh
node tests/bench/dictionary-prototype/memory.js 5 --runtime /path/to/main/packages/runtime/dist
```

Retained heap uses 100 dictionaries with 1,000 common keys, GC across three jobs
at each state, consumed walks and checked counts. Shared key payload/module hash
data is outside the baseline. `trimmed` is only reported for the standalone
prototype, which implements that API. Benchmark timings and memory measurements
should run separately from builds and other heavy jobs.

## Remaining work

Exact Adobe hash layout, reinsertion/growth/compaction traces and GC scheduling
are not reproduced. QName/Namespace, ActionScript subclasses, traits, API
versions, full prototype traversal, accessors/bound calls, Proxy/XML and AMF are
not implemented. Symbols and BigInts are outside the supported key domain.

The class has higher live-entry storage overhead than main. Trimming is
explicit; no general automatic memory policy or browser/integration performance
claim is made. Runtime/codegen integration and production semantics are separate
follow-up work. No MPL implementation code was copied into this experiment.
