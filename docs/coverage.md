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
and nothing stopped it. `tests/tamarin/swf2es-baseline.json` holds swf2es'
results: a test that matched and no longer does, or that passes fewer
checks, fails the run, and one that now matches is listed. Keep a fix with
`pnpm tamarin:swf2es --update-baseline`.

## Results

2026-09-28, after step 15 (0e4578a), in 38 s:

| | Tests | Match avmshell | Checks passed, of avmshell's |
|---|---|---|---|
| **All** | 2578 | **2011 (78.0%)** | 53,308 of 62,435 (85.4%) |
| ecma3 | 928 | 821 (88%) | 41,899 of 44,561 (94.0%) |
| spidermonkey | 521 | 481 (92%) | 2,616 of 2,701 (96.9%) |
| as3 | 849 | 648 (76%) | 8,222 of 11,522 (71.4%) |
| e4x | 173 | 0 | 0 of 1,919 |
| regress | 61 | 32 (52%) | 344 of 1,344 |
| misc, mmgc, mops, recursion, versioning | 46 | 29 | 227 of 388 |

Without E4X, which swf2es does not have yet, 2011 of 2405 tests match (83.6%).

What stops a test, or makes it differ, most often:

| Tests | Reason |
|---|---|
| 216 | Fewer checks passed than in avmshell |
| 187 | E4X: an XML or XMLList native, `descendants`, or AMF3 for XML |
| 47 | A runtime bug: `Cannot read properties of null (reading '$it')` |
| 20 | The URI functions: `escape`, `unescape`, `encodeURI`, `decodeURI` and their Component forms |
| 17 | The same checks passed, but others failed |
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
