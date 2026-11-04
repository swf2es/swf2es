# Dictionary runtime measurements

`DictionaryAccess.as` measures identity hits, misses, writes, membership and
deletion/reinsertion for strong and weak Dictionaries, plus string keys and mixed
receivers. The runner compares every result with avmshell and exits on a mismatch.
It alternates snapshot order between runs and reports medians and ranges.

```sh
pnpm build
node tests/programs/ab.ts --snapshot /tmp/dictionary-before-UNIQUE
# Apply the candidate and rebuild before taking the second snapshot.
pnpm build
node tests/programs/ab.ts --snapshot /tmp/dictionary-after-UNIQUE
node tests/bench/dictionary/run.ts /tmp/dictionary-before-UNIQUE /tmp/dictionary-after-UNIQUE 7
node tests/bench/enumeration/run.ts /tmp/dictionary-before-UNIQUE /tmp/dictionary-after-UNIQUE 7
node tests/bench/untyped/run.ts /tmp/dictionary-before-UNIQUE /tmp/dictionary-after-UNIQUE 7
node tests/bench/dictionary/memory.ts /tmp/dictionary-before-UNIQUE /tmp/dictionary-after-UNIQUE 5
```

Snapshot destinations must be fresh: `--snapshot` replaces its destination.
The existing enumeration runner also reports output differences, but keeps timing
them; a timing with a reported difference is not a valid improvement.

`memory.ts` measures retained JS heap plus ArrayBuffer storage above an empty
baseline for 100 Dictionaries with 1,000 object keys each. It checks enumeration counts and values, forces
collection between phases, and runs shared-key and independent-key workloads in
fresh child processes. Values reference their own keys. Its phases are populated,
walked three times to activate reuse, deleted, restarted empty, and external keys
dropped. A fourth argument changes the number of Dictionaries, for example `5 1`
for a single Dictionary.
The empty baseline already includes each storage object's extra cache field.
Live-phase totals include external key objects and their array; these roots stay
live through the restarted-empty phase and are released for the final phase.

The runtime candidate reuses an existing enumeration record only for an unchanged
Dictionary without dynamic string properties. Strong stores invalidate on every
write, delete or clear. Weak stores invalidate on key insertion or deletion, and
enumeration invalidates a record when it encounters a collected key. Weak slots
continue to hold only WeakName wrappers. Neither object identity lookup nor the
existing mutation/slot policy changes.

The standalone prototype in PR #720 remains separate. Its hash layout has known
reference differences during mutation and is not transplanted here. A bounded
WeakRef-sharing experiment reduced construction counts but did not improve
1,024-key runtime churn and slowed 2,048-key churn; it is not included.

## 2026-11-04: unchanged enumeration records

Baseline: `ea731a59793bfbe85620a6ed313ecda19970ab50` (dev). Candidate: the
runtime implementation in this PR, snapshotted as
`/tmp/dictionary-runtime-candidate6-20261104`; baseline snapshot
`/tmp/dictionary-runtime-before-20261104`. Production changes are confined to
Dictionary storage initialization and enumeration caching. No compiler change.

Linux x86_64, Intel Core i9-13900H, Node v24.22.1. Timing commands above used
`taskset -c 18` for both builds (one efficiency core, avoiding SMT contention).
Each timing comparison used seven fresh processes per build in alternating order.
The machine also had unrelated desktop/browser processes; it was not an isolated
benchmark host. Initial unpinned measurements had wide ranges and are not used
for the retained result.

Strong object-key enumeration took 10–18% less time; weak object-key enumeration
took 39–45% less. Ordinary/mixed controls were within 3%, apart from the empty
sealed-object control, which took about 4–5% more time. Every enumeration result
matched avmshell. These are runtime A/B results, not the standalone prototype's
timings. The oracle column is one reference run without matched CPU affinity;
it is not a cross-engine comparison.

Enumeration command:

```sh
taskset -c 18 node tests/bench/enumeration/run.ts /tmp/dictionary-runtime-before-20261104 /tmp/dictionary-runtime-candidate6-20261104 7
```

```text
dense16-in           A 512 ms (501–524)  B 525 ms (516–534)  B/A 2.5%  avmshell 49 ms
dense16-each         A 495 ms (478–510)  B 508 ms (498–520)  B/A 2.6%  avmshell 46 ms
dense1k-in           A 235 ms (231–244)  B 235 ms (228–247)  B/A 0.0%  avmshell 29 ms
dense1k-each         A 228 ms (225–248)  B 230 ms (227–249)  B/A 0.9%  avmshell 25 ms
dense100k-in         A 229 ms (224–232)  B 228 ms (222–239)  B/A -0.4%  avmshell 30 ms
dense100k-each       A 224 ms (218–233)  B 221 ms (219–238)  B/A -1.3%  avmshell 25 ms
holey-in             A 264 ms (259–271)  B 262 ms (255–271)  B/A -0.8%  avmshell 30 ms
holey-each           A 257 ms (251–283)  B 260 ms (249–285)  B/A 1.2%  avmshell 26 ms
sparse-in            A 539 ms (527–577)  B 535 ms (528–554)  B/A -0.7%  avmshell 37 ms
sparse-each          A 634 ms (624–643)  B 631 ms (612–638)  B/A -0.5%  avmshell 40 ms
named-in             A 291 ms (282–306)  B 296 ms (287–304)  B/A 1.7%  avmshell 30 ms
named-each           A 362 ms (350–389)  B 371 ms (349–385)  B/A 2.5%  avmshell 26 ms
vector-int-in        A 435 ms (432–442)  B 439 ms (432–457)  B/A 0.9%  avmshell 28 ms
vector-int-each      A 404 ms (400–412)  B 410 ms (403–413)  B/A 1.5%  avmshell 33 ms
vector-number-in     A 436 ms (429–441)  B 441 ms (434–460)  B/A 1.1%  avmshell 27 ms
vector-number-each   A 417 ms (413–419)  B 420 ms (414–427)  B/A 0.7%  avmshell 85 ms
vector-object-in     A 476 ms (465–513)  B 470 ms (466–484)  B/A -1.3%  avmshell 29 ms
vector-object-each   A 447 ms (441–458)  B 451 ms (443–463)  B/A 0.9%  avmshell 30 ms
vector-string-in     A 509 ms (496–518)  B 500 ms (498–509)  B/A -1.8%  avmshell 27 ms
vector-string-each   A 525 ms (520–533)  B 520 ms (517–532)  B/A -1.0%  avmshell 28 ms
object16-in          A 809 ms (780–841)  B 812 ms (797–849)  B/A 0.4%  avmshell 58 ms
object16-each        A 964 ms (915–1034)  B 963 ms (914–1030)  B/A -0.1%  avmshell 66 ms
object1k-in          A 420 ms (414–432)  B 417 ms (405–428)  B/A -0.7%  avmshell 49 ms
object1k-each        A 542 ms (518–557)  B 534 ms (506–554)  B/A -1.5%  avmshell 53 ms
dict-objects16-in    A 382 ms (381–392)  B 342 ms (337–357)  B/A -10.5%  avmshell 33 ms
dict-objects16-each  A 388 ms (384–401)  B 343 ms (338–358)  B/A -11.6%  avmshell 37 ms
dict-objects32-in    A 645 ms (636–660)  B 580 ms (556–593)  B/A -10.1%  avmshell 60 ms
dict-objects32-each  A 653 ms (640–665)  B 582 ms (565–598)  B/A -10.9%  avmshell 69 ms
dict-weak-objects32-in A 1562 ms (1458–1585)  B 949 ms (905–976)  B/A -39.2%  avmshell 81 ms
dict-weak-objects32-each A 1620 ms (1506–1655)  B 993 ms (954–1029)  B/A -38.7%  avmshell 82 ms
dict-objects-in      A 355 ms (340–366)  B 296 ms (287–307)  B/A -16.6%  avmshell 34 ms
dict-objects-each    A 365 ms (346–389)  B 298 ms (291–311)  B/A -18.4%  avmshell 44 ms
dict-strings-in      A 426 ms (412–443)  B 423 ms (416–445)  B/A -0.7%  avmshell 35 ms
dict-strings-each    A 815 ms (807–838)  B 821 ms (798–839)  B/A 0.7%  avmshell 44 ms
dict-mixed-in        A 383 ms (372–402)  B 377 ms (374–408)  B/A -1.6%  avmshell 35 ms
dict-mixed-each      A 581 ms (571–596)  B 578 ms (571–610)  B/A -0.5%  avmshell 41 ms
dict-weak-objects-in A 943 ms (931–984)  B 515 ms (504–520)  B/A -45.4%  avmshell 47 ms
dict-weak-objects-each A 1002 ms (964–1015)  B 551 ms (543–571)  B/A -45.0%  avmshell 48 ms
dict-weak-mixed-in   A 744 ms (731–767)  B 765 ms (738–782)  B/A 2.8%  avmshell 47 ms
dict-weak-mixed-each A 971 ms (944–984)  B 983 ms (961–997)  B/A 1.2%  avmshell 49 ms
sealed-in            A 913 ms (903–950)  B 955 ms (904–1011)  B/A 4.6%  avmshell 56 ms
sealed-each          A 918 ms (892–947)  B 954 ms (911–1001)  B/A 3.9%  avmshell 61 ms
nested-in            A 651 ms (643–665)  B 650 ms (646–674)  B/A -0.2%  avmshell 42 ms
nested-each          A 747 ms (740–753)  B 747 ms (737–764)  B/A 0.0%  avmshell 40 ms
queue-in             A 1011 ms (971–1107)  B 991 ms (961–1045)  B/A -2.0%  avmshell 87 ms
queue-each           A 1046 ms (1016–1123)  B 1046 ms (1034–1112)  B/A 0.0%  avmshell 81 ms
```

Identity-access command:

```sh
taskset -c 18 node tests/bench/dictionary/run.ts /tmp/dictionary-runtime-before-20261104 /tmp/dictionary-runtime-candidate6-20261104 7
```

Membership first trains both receiver kinds. Before that warmup, the first short
weak-membership section measured A 11 ms (10–19), B 18 ms (13–20), while larger
membership sections matched. After training both kinds, it measured 8 ms (7–9)
in both builds. The table below uses the committed benchmark with that warmup.
No lookup or churn speedup is claimed: most controls overlap, and weak churn is
particularly variable under collection. Weak 1,024-key writes measured 4.1% slower
(49 to 51 ms), with overlapping 48–52 ms ranges.

```text
strong16-get A 50 ms (48–52)  B 48 ms (47–50)  B/A -4.0%  avmshell 7 ms
strong16-miss A 46 ms (44–47)  B 46 ms (44–49)  B/A 0.0%  avmshell 9 ms
strong16-set A 45 ms (42–46)  B 42 ms (41–47)  B/A -6.7%  avmshell 8 ms
strong16-has A 7 ms (6–10)  B 7 ms (6–9)  B/A 0.0%  avmshell 9 ms
strong16-has-miss A 261 ms (253–278)  B 265 ms (252–279)  B/A 1.5%  avmshell 117 ms
strong16-delete-set A 111 ms (109–113)  B 112 ms (108–118)  B/A 0.9%  avmshell 27 ms
strong1024-get A 56 ms (47–61)  B 57 ms (50–60)  B/A 1.8%  avmshell 7 ms
strong1024-miss A 45 ms (44–48)  B 45 ms (44–47)  B/A 0.0%  avmshell 12 ms
strong1024-set A 48 ms (47–49)  B 48 ms (47–50)  B/A 0.0%  avmshell 9 ms
strong1024-has A 10 ms (9–10)  B 10 ms (9–10)  B/A 0.0%  avmshell 10 ms
strong1024-has-miss A 261 ms (253–282)  B 265 ms (254–283)  B/A 1.5%  avmshell 123 ms
strong1024-delete-set A 128 ms (126–130)  B 130 ms (127–135)  B/A 1.6%  avmshell 36 ms
weak16-get A 46 ms (43–49)  B 44 ms (42–49)  B/A -4.3%  avmshell 7 ms
weak16-miss A 43 ms (42–46)  B 44 ms (42–45)  B/A 2.3%  avmshell 10 ms
weak16-set A 51 ms (49–54)  B 50 ms (45–55)  B/A -2.0%  avmshell 9 ms
weak16-has A 8 ms (7–9)  B 8 ms (7–9)  B/A 0.0%  avmshell 9 ms
weak16-has-miss A 260 ms (257–274)  B 263 ms (248–270)  B/A 1.2%  avmshell 127 ms
weak16-delete-set A 411 ms (368–488)  B 410 ms (363–474)  B/A -0.2%  avmshell 30 ms
weak1024-get A 90 ms (89–94)  B 90 ms (88–91)  B/A 0.0%  avmshell 8 ms
weak1024-miss A 43 ms (40–45)  B 44 ms (41–45)  B/A 2.3%  avmshell 17 ms
weak1024-set A 49 ms (48–52)  B 51 ms (48–52)  B/A 4.1%  avmshell 11 ms
weak1024-has A 10 ms (9–11)  B 10 ms (9–10)  B/A 0.0%  avmshell 10 ms
weak1024-has-miss A 261 ms (260–277)  B 266 ms (250–274)  B/A 1.9%  avmshell 130 ms
weak1024-delete-set A 661 ms (631–711)  B 599 ms (565–622)  B/A -9.4%  avmshell 44 ms
weak2048-get A 58 ms (56–61)  B 57 ms (56–61)  B/A -1.7%  avmshell 10 ms
weak2048-miss A 42 ms (40–44)  B 43 ms (42–45)  B/A 2.4%  avmshell 27 ms
weak2048-set A 50 ms (49–52)  B 50 ms (48–51)  B/A 0.0%  avmshell 12 ms
weak2048-has A 10 ms (9–11)  B 10 ms (10–12)  B/A 0.0%  avmshell 11 ms
weak2048-has-miss A 262 ms (261–274)  B 261 ms (249–283)  B/A -0.4%  avmshell 137 ms
weak2048-delete-set A 851 ms (676–918)  B 799 ms (695–965)  B/A -6.1%  avmshell 53 ms
mixed-receivers-keys A 398 ms (395–420)  B 406 ms (397–429)  B/A 2.0%  avmshell 72 ms
string-get A 103 ms (101–111)  B 104 ms (99–108)  B/A 1.0%  avmshell 16 ms
string-set A 107 ms (101–114)  B 107 ms (100–111)  B/A 0.0%  avmshell 17 ms
```

Untyped controls:

```text
display  A 411 ms (408–431)  B 412 ms (402–426)  B/A 0.2%  avmshell 55 ms
data     A 212 ms (204–223)  B 211 ms (203–214)  B/A -0.5%  avmshell 38 ms
object   A 1130 ms (1123–1170)  B 1138 ms (1118–1169)  B/A 0.7%  avmshell 217 ms
poly     A 223 ms (219–228)  B 224 ms (220–234)  B/A 0.4%  avmshell 105 ms
string   A 250 ms (244–259)  B 251 ms (244–269)  B/A 0.4%  avmshell 53 ms
```

Retained JS heap plus ArrayBuffer storage, KiB per Dictionary above the empty
baseline, five fresh-process samples per build and workload:

```sh
node tests/bench/dictionary/memory.ts /tmp/dictionary-runtime-before-20261104 /tmp/dictionary-runtime-candidate6-20261104 5
```

After three walks, strong/shared was 100.17 to 100.23 KiB; weak/shared was
217.76 to 217.79 KiB. Independent keys gave the same small deltas. Storage is
essentially unchanged; these measurements exclude the cache field already present
at the empty baseline and do not measure peak RSS or allocation rate. WeakRef
construction on insertion is unchanged.

```text
A-strong-shared populated: 59.86 KiB (59.86–59.86)
A-strong-shared walked: 100.17 KiB (100.16–100.17)
A-strong-shared deleted: 41.10 KiB (41.09–41.11)
A-strong-shared refreshed: 13.31 KiB (13.18–13.46)
A-strong-shared droppedKeys: 12.80 KiB (12.79–12.92)
A-strong-unique populated: 98.53 KiB (98.53–98.53)
A-strong-unique walked: 138.84 KiB (138.84–138.85)
A-strong-unique deleted: 79.78 KiB (79.77–79.78)
A-strong-unique refreshed: 51.86 KiB (51.85–51.86)
A-strong-unique droppedKeys: 12.80 KiB (12.79–12.80)
A-weak-shared populated: 178.52 KiB (178.44–178.52)
A-weak-shared walked: 217.76 KiB (217.75–217.76)
A-weak-shared deleted: 103.69 KiB (103.68–103.69)
A-weak-shared refreshed: 12.86 KiB (12.86–12.87)
A-weak-shared droppedKeys: 12.47 KiB (12.47–12.47)
A-weak-unique populated: 217.11 KiB (217.11–217.11)
A-weak-unique walked: 256.43 KiB (256.42–256.43)
A-weak-unique deleted: 142.36 KiB (142.35–142.36)
A-weak-unique refreshed: 51.54 KiB (51.54–51.54)
A-weak-unique droppedKeys: 12.47 KiB (12.47–12.48)
B-strong-shared populated: 59.89 KiB (59.89–59.89)
B-strong-shared walked: 100.23 KiB (100.22–100.23)
B-strong-shared deleted: 41.18 KiB (41.17–41.18)
B-strong-shared refreshed: 13.26 KiB (13.26–13.51)
B-strong-shared droppedKeys: 12.87 KiB (12.87–12.88)
B-strong-unique populated: 98.56 KiB (98.56–98.56)
B-strong-unique walked: 138.90 KiB (138.89–138.91)
B-strong-unique deleted: 79.85 KiB (79.84–79.86)
B-strong-unique refreshed: 51.94 KiB (51.94–52.40)
B-strong-unique droppedKeys: 12.88 KiB (12.86–12.88)
B-weak-shared populated: 178.52 KiB (178.44–178.52)
B-weak-shared walked: 217.79 KiB (217.78–217.79)
B-weak-shared deleted: 103.77 KiB (103.73–103.77)
B-weak-shared refreshed: 12.93 KiB (12.89–12.93)
B-weak-shared droppedKeys: 12.54 KiB (12.50–12.54)
B-weak-unique populated: 217.11 KiB (217.11–217.11)
B-weak-unique walked: 256.46 KiB (256.45–256.46)
B-weak-unique deleted: 142.43 KiB (142.43–142.44)
B-weak-unique refreshed: 51.60 KiB (51.59–51.61)
B-weak-unique droppedKeys: 12.54 KiB (12.53–12.55)
```

Validation in the isolated checkout:

```sh
pnpm check
pnpm build
pnpm typecheck
env -u ELECTRON_RUN_AS_NODE npm_config_workspace_concurrency=1 pnpm test
pnpm tamarin:swf2es
SWF2ES_RUFFLE=/tmp/swf2es-dictionary-20261103/tests/player/corpus/ruffle/tests/tests/swfs env -u ELECTRON_RUN_AS_NODE pnpm corpus
pnpm --filter @swf2es/codegen build:wasm:checked
SWF2ES_CHECKED=1 node tests/conformance/run.ts
pnpm determinism
```

All commands passed. Main unit suite: 1,516 passed, two optional AVM1 corpus
unit tests skipped because the corpus path was not set for that run. The full
corpus job above ran separately. Desktop smoke and Stage3D checks skipped because
Electron was not downloaded. Conformance: 113 ABCs, in both release and checked
builds. Tamarin: all 2,578 tests preserved their recorded standing (2,530 of
2,568 scored tests matched avmshell; ten unscored). Corpus: all 1,984 tests
preserved their recorded standing (1,414 match Flash's trace). No reference
baseline changed. Determinism: 225 chains checked five ways and 4,627 methods
checked two ways, plus nine AVM1 SWFs. Runtime dist matched the measured snapshot,
and the baseline, candidate and rebuilt release test compiler were byte-identical.
