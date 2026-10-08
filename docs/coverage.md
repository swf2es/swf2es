# Coverage

How much of AS3 and its builtins swf2es runs as avmshell does, measured
with the Tamarin acceptance suite (`oracle/avmplus/test/acceptance`).

`pnpm tamarin` compiles each test with ASC 2.0, runs it in avmshell and
records avmshell's results in `tests/tamarin/baseline.json`. Then
`pnpm tamarin:swf2es` runs the same ABCs in swf2es:
- one of at most 10 worker processes runs each test, after the builtins
  avmshell loads;
- a worker is replaced when a test runs for more than 30 s;
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

## Results

2026-10-08, on dev (#268), in 36 s. The tests that time themselves
(above) can differ between runs; `regress-271716-n` ended its worker in one
run where avmshell timed out, as it has before. Checks passed are left out
of this run's table: a test may pass more checks in swf2es than avmshell
runs, so their sum over a directory overstates; the 2026-09-29 run counted
them per test, at 97.7%.

| | Tests | Match avmshell |
|---|---|---|
| **All** | 2578 | **2523 (97.9%)** |
| ecma3 | 928 | 918 (99%) |
| spidermonkey | 521 | 508 (98%) |
| as3 | 849 | 819 (96%) |
| e4x | 173 | 173 (100%) |
| regress | 61 | 60 (98%) |
| misc, mmgc, mops, recursion, versioning | 46 | 45 |

What stops a test, or makes it differ, most often:

| Tests | Reason |
|---|---|
| 15 | The same checks passed, but others failed |
| 9 | Fewer checks passed than in avmshell |
| 11 | Ended otherwise: 9 with an AS3 exception nothing caught where avmshell ended normally, 2 the other way |
| 11 | avmshell's sampler (`flash.sampler`, `as3/sampling`), which a SWF in the player does not use |
| 5 | The host's limits: a string, array, stack or pattern too large |

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

## Natives

381 of the 585 native methods builtin.abc and shell_toplevel.abc declare
are implemented. About 140 of the rest are avmshell's shell API
(`ShellPosix`, `File`, `System`, the sampler, `Trace`, `Worker`, `Mutex`,
`Condition`), which SWF content cannot reach. Of the others:
- `IExternalizable` in AMF: 35 (`ObjectInput`, `ObjectOutput`);
- `describeTypeJSON`, `Proxy`'s `isAttribute`, `DynamicPropertyOutput`,
  `Domain#loadBytes`/`getClass`, the atomics: 8.
