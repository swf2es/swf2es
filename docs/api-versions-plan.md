# Plan: API versions by SWF version

A design plan; no code yet. swf2es runs every user ABC at the latest API
version (`API_VERSION` 50, `AIR_API_VERSION` 51 for AIR,
`packages/format/src/api-versions.ts`). Flash hides what a SWF's version
predates, so an old SWF whose MovieClip subclass declares its own
`get isPlaying()` loads in Flash and is refused here with VerifyError
#1053 (the corpus's `avm2/versioned_isplaying`), and the
`avm2/all_classes` tests of SWF 9 to 13 see classes and members they
should not.

## The finding that shapes the plan

The work was scoped as a version per SWF, or per ABC. Flash does not do
that: **the version is the root SWF's, and everything it loads runs at
it.** Measured in adl (AIR 51.3) with the corpus's SWFs, as the
application's content and loaded by a `Loader` of a root compiled with
`-swf-version`:

| root | content | result |
|---|---|---|
| `versioned_isplaying` (SWF 12) itself | | runs, its own `isPlaying` twice |
| SWF 12 | `versioned_isplaying` (SWF 12) | runs |
| SWF 30, or the oracle's harness | `versioned_isplaying` (SWF 12) | VerifyError #1053 |
| SWF 12 | `all_classes/display` of SWF 9, 12 and 30 | all three the SWF 12 root's output (2,677 lines) |
| SWF 30 | `all_classes/display` of SWF 9, 12 and 30 | all three the SWF 30 root's output (2,848 lines) |

Ruffle found the same for Flash Player (`core/src/avm2.rs`,
`root_api_version`). So the design is one version per player, taken from
its root SWF, which is what the compiler and the runtime already hold;
nothing is stored per ABC and no lookup asks who called it.

## 1. What avmplus does

All paths are under `oracle/avmplus`.

- **The table.** `core/api-versions.h:17-72`: versions 0
  (`VM_ALLVERSIONS`) to 51, alternating AIR's series and Flash Player's,
  then `VM_INTERNAL` 52. A name's mark is U+E294 plus the version, 660 in
  `[API]` (`core/api-versions.as`, `AvmCore.h:485`,
  `AvmCore.cpp:5844-5854`). A core has one series (`AvmCore.cpp:323-333`);
  a version of the other becomes the next later one of its own, which for
  Flash Player makes AIR's names `VM_INTERNAL`
  (`api-versions.cpp:121`, `AvmCore-inlines.h:599-602`).
- **A pool's version** is given when it is parsed
  (`AbcParser.cpp:354-361`, `PoolObject.h:267`). A builtin pool's public
  namespace keeps its mark, or is `VM_INTERNAL` when unmarked in a
  versioned URI; a user pool's public namespaces all get the pool's
  version, marks ignored (`AbcParser.cpp:1497-1518`). A name with several
  marks takes the lowest valid in the series (`AbcParser.cpp:1755-1763`,
  `Traits.cpp:386-401`).
- **Who chooses it** is the host. avmshell takes `-api`
  (`shell/avmshell.cpp:1126`, `ShellCore.cpp:373`), and `Domain.loadBytes`
  parses at its caller's version (`shell/DomainClass.cpp:56-64`); its
  `swfVersion` argument picks only the bug compatibility
  (`DomainClass.cpp:67-85`, `Domain.as:23-26`). Flash's host is closed:
  the table above is its behaviour. The SWF version stays per SWF for
  bug compatibility, as `Runtime.swfVersion` is here.
- **Lookup.** A binding is found when the namespaces are one, or both
  public with one URI and the binding's version no higher than the
  looking namespace's (`MultinameHashtable-inlines.h:15-24`); a table
  keeps a name's lowest version (`MultinameHashtable-impl.h:385-392`).
  A later class or member is therefore **invisible, never an error of its
  own**: finding it by name gives ReferenceError #1065 (`MethodEnv.cpp:591`), a type
  in a signature VerifyError #1014 (`Verifier.cpp:3278`), a read on a
  dynamic object `undefined`.
- **Overrides.** `Traits::getOverride` finds the base's binding with the
  derived trait's own namespace, so at the pool's version
  (`Traits.cpp:2108-2116`): a later base member is not found, the trait
  needs no `override` and gets a binding and a dispatch slot of its own
  (`Traits.cpp:859-862`); a visible one without `override` is #1053
  (`Traits.cpp:2165-2180`). Builtin code bound to the base's slot still
  calls the base's.
- **Names built from strings** take the version of the first user frame
  on the stack, else the host's default (`AvmCore.cpp:5311-5339`,
  `findPublicNamespace` at `5809`): class lookup by name
  (`shell/DomainClass.cpp:124-133`), `in` and property names
  (`Toplevel.cpp:455`, `811`), `hasOwnProperty` (`ObjectClass.cpp:97`,
  `111`), `sortOn` (`ArrayClass.cpp:472`, `974`), JSON
  (`JSONClass.cpp:1250`, `1712`), AMF (`AvmSerializer.cpp:1424`, `1542`),
  `new Namespace` and `QName` (`AvmCore.cpp:4615`, `4645`, `4673`).
  describeType leaves out bindings above it (`TypeDescriber.cpp:143-148`).
  With one version for all user pools, that frame's version is the
  root's.

**SWF version to API version** is not in avmplus. Flash Player's, by
the table's names and Ruffle's `core/src/avm2/api_version.rs`, to be
confirmed in the projector: 9 and below 0, 10 `FP_10_1` (7), 11
`FP_10_2` (10), 12 to 31 `SWF_n`, above 31 the latest. AIR's, measured in adl by which marked
members a root sees: 9 has AIR 1.0's names and not AIR 2.5's, 10 has
AIR 2.5's (`Loader.loadFilePromise`; Ruffle's table says AIR 2.0), 11
has AIR 2.6's. Slice 1 measures the rest.

## 2. Codegen

`Domain.apiVersion` (`assembly/avm2/link/domain.ts:105`) stays the one
version of a compiler's domains: `addNamespaces` gives it to user ABCs'
public namespaces (`link/namespaces.ts:77`), `publicVersion` answers
overrides with it (`domain.ts:878`), a rebuild copies it
(`lifetime.ts:297`). What changes:

- `checkApiVersion` refuses 0 (`api-versions.ts:21`); a Flash Player
  root of SWF 9 needs it. `activeVersion` already reads 0 as Flash
  Player's series (`namespaces.ts:95-97`), and no AIR root maps to 0.
  Slice 1 audits 0 where it also means "not public".
- The rule that a builtin ABC's highest mark, from 42 up, is its
  internal one (`namespaces.ts:22-27`, `71-74`) keeps our playerglobal
  from marking anything at 43 to 51 (SWF 28 to 31). The library says its
  internal mark instead: 52 for ours, 42 for Adobe's.
- Nothing else: purity, JIT equal to AOT and a method's independence
  hold as now, since the version is an input of `reset` that `moduleKey`
  already names (`packages/codegen/src/index.ts:65`). `pnpm determinism`
  and `tests/fuzz/abc.ts` gain runs at 0 and 12.

**Cost.** No codegen memory or time. The cost is the cache: every key
names the version, so a site's SWFs of n versions would compile and
store the libraries n times. A library's module should not depend on
the user version within a series (its namespaces come from marks and
the series alone); slice 1 proves it by compiling the libraries at
every version, and then keys a module whose context is all builtin by
series.

**AOT.** `compileAhead` resets at `API_VERSION` (`cli/src/aot.ts:166`).
`compile` takes the version from the SWF's header, which the manifest
already records beside `apiVersion`, as the player will for a main
movie; `--api <version>` names another, for a SWF another root loads. A
module compiled at another version than the player's misses by key and
is compiled in the page, as an AIR module is on the web today.

## 3. The runtime

`Runtime.apiVersion` and `userVersions` (`runtime/src/avm2/runtime.ts:333`)
stay one value, now the root's: describeType, JSON, AMF,
`System.apiVersion` and `definitionNamed` are right as they are, and no
path pays anything, since nothing asks for the calling ABC. Natives and
hosts reach members through `publicName`, at every version
(`runtime.ts:2037`), so the player's own lookups do not change. Slice 5
moves the string-built names that still use every version to
`userVersions`.

## 4. The player

- `apiVersionOf(swfVersion, air)` in `@swf2es/format`, the table of
  section 1.
- `Scripting` takes the root's SWF version and gives the runtime and
  `codegen.reset` its API version (`player/src/scripting.ts:603-607`).
  The web element has the SWF before it makes one
  (`web/src/element.ts:719`); the desktop app and the tests' pages
  likewise.
- A host option overrides it, `apiVersion: "root" | "latest" | <SWF
  version>`: for content whose real root was something else, such as an
  AIR application or a wrapper of another version, and as the way back.
- Loaded SWFs, `loadBytes` and child domains need nothing: they run at
  the root's version, as measured.
- Workers: a worker's `Scripting` gets the primordial's version in its
  init, beside `air` (`workers/protocol.ts:52`), as avmshell's does
  (`worker-api-version.as`).
- An AVM1 root has no AVM2 code and is unaffected. Which version an AS3
  SWF gets under an AVM1 root is measured before that pairing is
  supported.

## 5. playerglobal's marks

Our playerglobal has 825 `[API]` marks, held to Adobe's compile-time
`playerglobal.abc` by `tools/playerglobal.ts --check`. Two gaps: the
running players mark AIR-only names the compile-time library leaves
bare (19 classes found so far, `tools/playerglobal-air.ts`; members not
yet looked for), and nothing checks a mark against what a root of a
given version really sees.

Both are closed by measuring, not by reading Adobe's sources: a probe
SWF of our own asks `hasDefinition` and describeType for every
definition our playerglobal declares and traces the names. Its header's
version byte is set to 9 up to 31, and it runs as the root in adl (AIR's
series) and in the Flash Player projector (Flash Player's). The lowest
version at which a name shows, per series, goes into a table of names
and version numbers, `as3/playerglobal/api-versions.json`; `--check`
holds every compiled trait's marks to it. Marks for Flash Player's
versions stay in the sources; AIR-only members are marked as the
AIR-only classes are, by the tool as it compiles (`markAirOnly`,
`tools/playerglobal.ts:105-124`).

## 6. Slices

Each is one pull request that passes the corpus with no test lowered.

1. **Versions the compiler can run at.** `apiVersionOf`, version 0, the
   library's internal mark, libraries keyed by series. Conformance cases
   against avmshell with `-api VM_ALLVERSIONS` and `-api SWF_12`: a
   class's own member named as a later builtin's with and without
   `override`, lookup by name, `in`, `hasOwnProperty`, describeType,
   JSON, `sortOn`. The rest of the AIR mapping measured. No player
   change, so no risk to content.
2. **The oracle's root.** `oracle/flash.ts` runs a job as the
   application's content, traces only, since the harness is otherwise
   every case's root at its own version. The player's test page passes
   the harness's version for ordinary cases, so every reference stands.
3. **The player takes the root's version**, with the host option, the
   workers' init and the CLI (`aot.test.ts` holds the two together).
   Player cases against adl in root mode: `versioned_isplaying`'s shape
   at SWF 12 and 30, a root loading a SWF of another version, a worker.
   Corpus: `versioned_isplaying` passes, `all_classes` rises; the
   baseline is updated. Risk: a SWF that used later API under an old
   root worked here and not in Flash; it stops working, and the option
   brings it back.
4. **Measured marks.** The probe, the table, `--check`, AIR-only member
   marks. Expected: `all_classes` matches at every version. Risk: a mark
   set too high hides what content needs, which the table prevents.
5. **The remaining string-built names** at the user's version
   (`new Namespace`, `QName`, XML names), with conformance cases.

An older SWF that works today keeps working if it works in Flash: after
slice 3 it sees what Flash shows it. Before slice 4 a wrong mark of ours
errs towards showing more, since the marks present are Adobe's own.

## 7. Open questions

1. Is the root's version the default once slice 3 lands, or does the
   player stay at the latest until a host asks? The plan assumes the
   root's.
2. Flash Player's series cannot run in adl. Is the projector's output
   the reference for it, with the corpus's expected outputs beside it?
3. May the measured table (names and version numbers, no source) be
   committed under the playerglobal rules?
4. SWF versions above 31: the table ends at `SWF_31` and `AIR_20_0`.
   The plan treats them as the latest; extending the table would let
   later members be marked.
5. Should an AIR application's descriptor be able to name the version,
   or only its root SWF?
6. AIR's SWF 10 measured as AIR 2.5 where Ruffle has AIR 2.0: follow
   adl?
