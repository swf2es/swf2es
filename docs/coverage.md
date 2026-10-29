# Coverage

How much of AS3 and its builtins swf2es runs as avmshell does, measured
with the Tamarin acceptance suite (`oracle/avmplus/test/acceptance`),
and how much of Flash's behaviour the player matches, measured with
Ruffle's test corpus. The site's
[compatibility page](https://swf2es.github.io/swf2es/compatibility/)
shows both, and how much of the `flash.*` API is implemented, worked out
from the baselines as it builds ([site.md](architecture/site.md)); the
figures below are dated.

## Tamarin

`pnpm tamarin` compiles each test with ASC 2.0, runs it in avmshell and
records avmshell's results in `tests/tamarin/baseline.json`. Then
`pnpm tamarin:swf2es` runs the same ABCs in swf2es:
- one of at most 10 worker processes runs each test, after the builtins
  avmshell loads;
- a worker is replaced when a test runs for more than 30 s;
- every worker reads a clock that starts at the same instant on every
  run (`tests/tamarin/clock.ts`), so that swf2es' own Date results do
  not follow the date;
- each test is scored as avmshell is, by its `PASSED!` and `FAILED!` lines.

A test **matches** when it passes and fails the same checks as in avmshell,
and ends as it did: avmshell's exit code, 0, or 1 for a VerifyError or an
AS3 exception nothing caught (124 for a timeout), with nothing of the
host's stopping it. A test avmshell compiled but whose ABC is missing
fails the run. `tests/tamarin/swf2es-baseline.json` holds swf2es'
results: a test that matched and no longer does, that passes fewer checks,
or that is not in it fails the run, and one that now matches is listed.
Keep a fix with `pnpm tamarin:swf2es --update-baseline`. A test whose
result varies from run to run has `null` there and is not compared
(`--relax`): `spidermonkey/js1_5/Exceptions/regress-121658`, which
recurses until the host's stack runs out, and
`spidermonkey/js1_5/Regress/regress-169559`, which times itself.

Ten of `ecma3/Date`'s tests (`e15_9_5_10` to `e15_9_5_34_1`) count
differently in avmshell with the date or the hour, as they work out the
expected time with daylight saving rules of their own. `baseline.json`
does not compare their counts, so they are left out of the score against
avmshell; swf2es' own counts, under its fixed clock, are still compared
with `swf2es-baseline.json`.

### Results

2026-10-29, from `main`'s baselines (#668), scored as `swf2es.ts` scores
a run: of the 2,578 tests avmshell compiled, the 2,566 whose counts are
compared and whose result does not vary. Checks passed are left out: a
test may pass more checks in swf2es than avmshell runs, so their sum over
a directory overstates.

| | Tests | Match avmshell |
|---|---|---|
| **All** | 2566 | **2530 (98.6%)** |
| ecma3 | 918 | 912 (99%) |
| spidermonkey | 519 | 510 (98%) |
| as3 | 849 | 830 (98%) |
| e4x | 173 | 173 (100%) |
| regress | 61 | 60 (98%) |
| misc, mmgc, mops, recursion, versioning | 46 | 45 |

What stops a test, or makes it differ:

| Tests | Reason |
|---|---|
| 11 | avmshell's sampler (`flash.sampler`, `as3/sampling`), which a SWF in the player does not use |
| 10 | The same checks passed, but others failed |
| 7 | Fewer checks passed than in avmshell |
| 4 | Ended otherwise: 2 ran to their end where avmshell ended with an AS3 exception nothing caught (`Array/insertremove`, `Vector/insertremove`), 2 where avmshell itself died (exit code 128): `regress-303213`, which swf2es runs to its end, and `regress-157652`, where swf2es times out (124) |
| 4 | The host's limits: a string, an array or the stack too large |

### Since the first run (2015, 78.2%)

| Fix | Tests |
|---|---|
| A class's interfaces settled when a type test needs them, as a script may make the class before them | +47 |
| The URI functions, `escape` and `unescape`; a method closure's `length` is its method's | +34 |
| The register below a `swap` given the top's type, so a setter called from a setter is bound by its own type | +14 |
| A private type named by its module's own namespace, as a class outside the package block is | +20 |
| E4X: XML and XMLList, their parser, names and namespaces, the default XML namespace | +208 |
| A native's argument count checked where its call was not bound; the script defining Object run first | +18 |
| Native error classes constructing when called; Date's, RegExp's and Array's prototypes instances of their class; a RegExp callable; Function.prototype a function | +37 |
| PCRE's named groups and inline flags, a pattern that does not compile matching nothing | +11 |
| The builtins' edges: errors of calls and constructions refused, super by the base's traits, constructor not enumerable, and small natives | +55 |

### Natives

As of 2026-10-08: 381 of the 585 native methods builtin.abc and
shell_toplevel.abc declare are implemented. About 140 of the rest are
avmshell's shell API (`ShellPosix`, `File`, `System`, the sampler,
`Trace`, `Worker`, `Mutex`, `Condition`), which SWF content cannot
reach; the shell's workers, Mutex and Condition have been built since
([workers.md](workers.md)). Of the others:
- `IExternalizable` in AMF: 35 (`ObjectInput`, `ObjectOutput`);
- `describeTypeJSON`, `Proxy`'s `isAttribute`, `DynamicPropertyOutput`,
  `Domain#loadBytes`/`getClass`, the atomics: 8.

## Ruffle's corpus

`pnpm corpus` plays Ruffle's test corpus (fetched by
`tests/player/corpus/fetch-ruffle.ts`, not in the repository) in Chrome:
its `avm1/`, `avm2/` and `timeline/` tests that have Flash's
`output.txt`, less those Ruffle skips or that need audio, video or a
default font; the input Ruffle recorded for a test is played into it
(`tests/player/replay.ts`). Each test's trace is compared with Flash's line by line,
and `tests/player/corpus/baseline.json` records how far it got: the lines
matched before the first difference, of the lines Flash traced, how many
the player traced, and what stopped it. A test **passes** when every line
matched, no more were traced, and nothing stopped it. A change may not
lower a test's standing; one that raises it is kept with
`--update-baseline`.

From `baseline.json` on `main` (last raised 2026-10-24):

| | Tests | Pass | Lines matched |
|---|---|---|---|
| **All** | 1984 | **1380 (69.6%)** | 167,322 of 287,667 (58.2%) |
| avm1 | 715 | 590 (82.5%) | 88,414 of 131,812 |
| avm2 | 1252 | 784 (62.6%) | 78,718 of 155,484 |
| timeline | 17 | 6 | 190 of 371 |

The natives most often in the way are Pixel Bender's (`Shader`,
`ShaderData`, `ShaderJob`: 27 tests) and the Flash Text Engine's
(`flash.text.engine`: 21). The rest mostly trace a line differently and
stop comparing there; `pnpm corpus --diff` shows where for each.
