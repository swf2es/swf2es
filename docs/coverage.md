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

2026-09-29, after E4X (#39), in 43 s. Two runs agree, but for the two
tests above.

| | Tests | Match avmshell | Checks passed, of avmshell's |
|---|---|---|---|
| **All** | 2578 | **2338 (90.7%)** | 59,950 of 62,435 (96.0%) |
| ecma3 | 928 | 847 (91%) | 44,253 of 44,561 (99.3%) |
| spidermonkey | 521 | 488 (94%) | 2,639 of 2,701 (97.7%) |
| as3 | 849 | 754 (89%) | 10,344 of 11,522 (89.8%) |
| e4x | 173 | 171 (99%) | 1,916 of 1,919 (99.8%) |
| regress | 61 | 42 (69%) | 556 of 1,344 |
| misc, mmgc, mops, recursion, versioning | 46 | 36 | 242 of 388 |

The two E4X tests left call a native with too few arguments, which
avmshell checks (ArgumentError 1063) and swf2es' natives do not yet.

What stops a test, or makes it differ, most often:

| Tests | Reason |
|---|---|
| 101 | Fewer checks passed than in avmshell |
| 66 | Ended otherwise: 64 with an AS3 exception nothing caught where avmshell ended normally, 2 the other way |
| 14 | The same checks passed, but others failed |
| 31 | avmshell's shell API (`System`, `File`, `Domain`, the sampler, `Mutex`), which a SWF never calls |
| 4 | `describeTypeJSON`, and AMF3 for XML |

### Since the first run (2015, 78.2%)

| Fix | Tests |
|---|---|
| A class's interfaces settled when a type test needs them, as a script may make the class before them | +47 |
| The URI functions, `escape` and `unescape`; a method closure's `length` is its method's | +34 |
| The register below a `swap` given the top's type, so a setter called from a setter is bound by its own type | +14 |
| A private type named by its module's own namespace, as a class outside the package block is | +20 |
| E4X: XML and XMLList, their parser, names and namespaces, the default XML namespace | +208 |

## Natives

381 of the 585 native methods builtin.abc and shell_toplevel.abc declare
are implemented. About 140 of the rest are avmshell's shell API
(`ShellPosix`, `File`, `System`, the sampler, `Trace`, `Worker`, `Mutex`,
`Condition`), which SWF content cannot reach. Of the others:
- `IExternalizable` in AMF: 35 (`ObjectInput`, `ObjectOutput`);
- `describeTypeJSON`, `Proxy`'s `isAttribute`, `DynamicPropertyOutput`,
  `Domain#loadBytes`/`getClass`, the atomics: 8.
