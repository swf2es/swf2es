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

2026-09-28, after step 15 (0e4578a), in 38 s. Two runs agree, but for the
two tests above.

| | Tests | Match avmshell | Checks passed, of avmshell's |
|---|---|---|---|
| **All** | 2578 | **2015 (78.2%)** | 54,084 of 62,435 (86.6%) |
| ecma3 | 928 | 821 (88%) | 41,998 of 44,561 (94.2%) |
| spidermonkey | 521 | 483 (93%) | 2,619 of 2,701 (97.0%) |
| as3 | 849 | 648 (76%) | 8,889 of 11,522 (77.1%) |
| e4x | 173 | 0 | 0 of 1,919 |
| regress | 61 | 32 (52%) | 351 of 1,344 |
| misc, mmgc, mops, recursion, versioning | 46 | 31 | 227 of 388 |

Without E4X, which swf2es does not have yet, 2015 of 2405 tests match (83.8%).

What stops a test, or makes it differ, most often:

| Tests | Reason |
|---|---|
| 187 | E4X: an XML or XMLList native, `descendants`, or AMF3 for XML |
| 128 | Fewer checks passed than in avmshell |
| 90 | Ended otherwise: 88 with an AS3 exception nothing caught where avmshell ended normally, 2 the other way |
| 47 | A runtime bug: `Cannot read properties of null (reading '$it')` |
| 20 | The URI functions: `escape`, `unescape`, `encodeURI`, `decodeURI` and their Component forms |
| 13 | The same checks passed, but others failed |
| 9 | Runtime bugs on strings: `this.substring` or `this.substr` is not a function |
| 6 | Timeouts: script timeouts (`misc/catchableTimeout`, `doubleTimeout`) and huge arrays |
| 5 | Runtime bugs: `Cannot read properties of undefined (reading 'call')` |
| 21 | avmshell's shell API (`System`, `File`, `Domain`, the sampler), which a SWF never calls |
| 1 | `describeTypeJSON` |

Full per-directory results: `pnpm tamarin:swf2es`.

## Natives

285 of the 585 native methods builtin.abc and shell_toplevel.abc declare
are implemented. About 140 of the rest are avmshell's shell API
(`ShellPosix`, `File`, `System`, the sampler, `Trace`, `Worker`, `Mutex`,
`Condition`), which SWF content cannot reach. Of the others:
- E4X: 88 natives (`XML`, `XMLList`, `isXMLName`);
- `IExternalizable` in AMF: 35 (`ObjectInput`, `ObjectOutput`);
- the URI functions: 6;
- `describeTypeJSON`, `Proxy`'s `isAttribute`, `DynamicPropertyOutput`,
  `Domain#loadBytes`/`getClass`, the atomics: 8.
