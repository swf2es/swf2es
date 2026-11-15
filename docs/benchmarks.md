# Benchmarks

How to time swf2es, the reference numbers to compare a change with, and
a line for each change that moved them. The renderer's design and what
it is judged by are in [renderer.md](renderer.md#measuring); the native
module's kernels are held to the JavaScript they replaced by unit tests,
and their speed-ups are in the pull requests that moved them (#653,
#655, #657, #660).

A change is measured on a benchmark made for the path it touches first,
then on a real scene for the overall picture. Two builds are run in turn,
interleaved (A, B, B, A, ...), each in a process of its own, so that both
see the same load on the machine; a build against a copy of itself
differs by 2 or 3%, so only a gain that repeats is kept. Run one
benchmark at a time, on a machine doing nothing else heavy.

## Running them

### Against other players

`tests/bench/players.ts` compiles a self-timing benchmark into a SWF and
plays it in swf2es and in Ruffle's web build, each in headless Chrome,
and in Flash, as AIR's `adl -nodebug` runs it (the debugger slows its JIT
by about 1.7× on object creation). The players take turns in an order
that changes each run, every section traces its time by the SWF's own
clock, and every other line must be as Flash traces it.

    node tests/bench/players.ts [--runs N] [--ruffle DIR] [--only swf2es,ruffle,flash] [bench...]

- `enumeration`: for-in and for each over Arrays, Vectors, Objects and
  Dictionaries (`tests/bench/enumeration/Enumeration.as`);
- `dictionary`: gets, misses, writes, `in` and deletion on strong and weak
  Dictionaries (`dictionary/DictionaryAccess.as`);
- `vector`: indexed reads, writes, push and pop on Vectors and Arrays of
  int, Number, String, Object and a class (`vector/VectorAccess.as`);
- `pixels`: a BitmapData's pixels set and read whole, by ByteArray and by
  Vector (`pixels/BitmapPixels.as`).

`--ruffle DIR` (or `RUFFLE`) names Ruffle's unpacked self-hosted build;
without it Ruffle is left out. The draft comparison branch (#835) adds
`drawing`, scenes of vectors, bitmaps, filters, text, redrawn graphics
and a Pixel Bender fill at three loads each, and `stage3d`, played at 60
frames a second on the GPU through the browser build's element, with
frame times and memory; as3pb; startup; and Flash Player's projectors
under Wine. The 0.1.23 numbers below were taken with it.

### The player in Chrome

`tests/player/bench.ts` plays a synthetic SWF in headless Chrome and
prints the median and p90 of a frame's tick (the timeline and scripts),
draw (the display list's walk, plan and GL calls) and gl (the wait for GL
to finish), after the first frames warm up. Chrome draws with SwiftShader
by default, CPU time that compares run to run on one machine; `--gpu`
draws on the machine's GPU (on a machine with two,
`VK_DRIVER_FILES=/usr/share/vulkan/icd.d/intel_icd.x86_64.json` or
`nvidia_icd.x86_64.json` picks one).

    node tests/player/bench.ts [scene] [--gpu] [--counts] [--allocs] [--checkout DIR] [--json]

- by default, 2,000 shapes placed from a few characters, some moving,
  turning and replaced each frame (`--shapes N`);
- `--town N`: N hairline-outlined characters of many parts on loops of
  different lengths, some glowing, mirrored or walking, among scenery,
  all clips with frame scripts; nearest a busy room;
- `--text N`: N TextFields of an embedded font, a tenth taking new text
  each frame (`--normal`, `--device` for other kinds);
- `--blends N`: N shapes alone in a blend mode each, over bands;
- `--scripted N`: N rigs whose parts are scripted clips, replaced each
  frame (`--still` keeps them, for the walk of a deep tree whose scripts
  rarely run);
- and others for one path each: `--rig`, `--pulse`, `--branches`,
  `--toggle`, `--masks`, `--scroll`, `--stamps`, `--pen`, `--triangles`,
  `--redraw`, `--vectors` (the script's header says what each plays).

`--counts` adds the GL calls a frame, `--allocs` the KB allocated,
`--checkout DIR` plays another built checkout on the same SWF, and
`--write-swf FILE` writes the SWF for another player.
`tests/player/draw-counts.ts` holds the GL calls a frame to
`draw-counts.json`, which may only go down.

### The player's walks in node

`tests/player/walk-bench.ts` times the walks a frame makes of the display
list, on a tree of some 13,000 objects (`--rigs 400`) without rendering:
the median of a whole tick, and of a lone `runFrameScripts` that finds
nothing to run, in microseconds, over `--reps 5` runs of `--frames 200`.

    node --expose-gc tests/player/walk-bench.ts [--orphans N] [--menu K] [--old N]
      [--playing N] [--churn N] [--list N [--moving K] [--scroll]]

- `--orphans N`: N hidden panels kept off the list, each held by an
  event listener, as content keeps hidden panels;
- `--menu K`: a script builds a menu of K rows whose buttons' states are
  scripted clips, each made running the frame scripts due, as Flash does;
- `--old N`: N rigs of a version 9 SWF on the stage, which every round of
  frame scripts lists;
- `--playing N`: N clips that play on beside the still rigs, so the tick
  times mostly the advance walk;
- `--churn N`: N clips whose timelines place and remove children every
  frame, listening for ADDED and REMOVED;
- `--list N`: a still pointer over a scrolled list of N rows of text
  fields and buttons, what an idle UI list asks each frame end.

### Morphs

`tests/player/morph-bench.ts` animates curved, outlined morphs, shared or
unique (`--unique`), in step or phased (`--phases`), at repeating or
fresh ratios (`--loop 0`); it reports frame times, cache requests and
misses, and retained memory, `--allocs` allocation and `--counts` the
native calls.

    node tests/player/morph-bench.ts [--morphs 32] [--edges 32] [--loop 96] [--phases] [--unique] [--gpu]

### Two builds, pixel for pixel

- `node tests/player/render-bench.ts <checkout A> <checkout B> [--gpu]
  [--runs 3]`: the renderer's fixtures in two checkouts, A/B then B/A,
  with pixel hashes compared ([renderer.md](renderer.md#measuring)).
- `node tests/bench/bitmap-draws.ts <checkout A> <checkout B> [cases,
  6000] [seed, 1] [--big]`: random BitmapData draws and copies in every
  blend mode, each pixel compared, for a change to `drawBitmap` or
  `copyPixels` that must draw what it drew before, faster.

### The compiler and runtime in node

Each of these compiles an AS3 file with swf2es, runs it in node, and
checks its lines other than the times against avmshell's:

| Benchmark | Times |
|---|---|
| `tests/bench/untyped/run.ts` | names read, written and called on values typed `*`, through the runtime's lookup |
| `tests/bench/typed/run.ts` | `new` of known classes, and calls the compiler binds, through interfaces and `super` too |
| `tests/bench/enumeration/run.ts` | for-in and for each over every kind of collection |
| `tests/bench/native-collections/run.ts` | the natives that walk Arrays and Vectors: map, filter, sort, conversion |
| `tests/bench/vector/run.ts` | indexed Vector and Array access |
| `tests/bench/primitives/run.ts` | String's, int's and Number's methods on typed values |
| `tests/bench/dictionary/run.ts` | Dictionary access; `memory.ts` beside it, what one keeps |
| `tests/bench/globals/run.ts` | thousands of script-level variables and functions, as Crossbridge compiles C |

    node tests/bench/<name>/run.ts [runs]                  the builds now
    node tests/bench/<name>/run.ts <dir A> <dir B> [runs]  two snapshots, interleaved

A snapshot is `node tests/programs/ab.ts --snapshot <dir>`: the runtime's
and the compiler's builds as they are, so a change can be timed by
snapshot, change, build, snapshot again. `node tests/programs/ab.ts <dir
A> <dir B>` times as3pb with the two. `pnpm bench [file.abc...]` times
the ABC parser, the bytecode decoder and typed verification in the
release build (abcdump.abc from the last conformance run without files),
and `tests/bench/dxt.ts` the native DXT encoder against TypeScript's.

## AVM1 startup and scene changes

`pnpm bench:avm1 [--runs 5] [--frames 600]` measures what AVM1 content
pays to start, to enter a scene for the first time and to run warmed
ticks, in fresh node processes and without rendering: a generated,
three-scene movie whose stopped scenes each install an `onEnterFrame`
doing arithmetic, property and array access. It reports compiler time,
compiled block counts, the JS heap after collection and wasm memory;
warmed ticks must compile no further blocks, and the script's result is
checked.

`pnpm bench:avm1 --compare /path/to/built-checkout --json /tmp/avm1.json`
compares that checkout (A) with this one (B), alternating A/B and B/A
order. Each timing shown is the median across runs; the JSON keeps every
run. These are script and timeline CPU times, not frame rates.

`--swf /path/to/movie.swf --replay steps.json` replays a local movie:

```json
[
  { "label": "title", "ticks": 120, "expectFrame": 64 },
  { "label": "open", "click": [320, 294], "ticks": 60 },
  { "label": "attack", "click": ["arena", "controls", "attack"], "ticks": 150, "repeat": 3 },
  { "label": "warm", "ticks": 600 }
]
```

A click is in stage coordinates or at the origin of a named clip reached
through its parents; a step may also give `text` for keyboard input,
`next: true` to resume a stopped root, or `expectFrame` to check where
the replay is. Without a replay, the SWF plays for `--frames` ticks.
`tests/bench/avm1-sas2.json` replays a locally supplied AVM1 game through
its first victory and level-up screen; the SWF is not in the repository.

`node tests/bench/avm1-names.ts [<checkout A> <checkout B>] [runs, 5]`
times AVM1's name lookups on clips with many children, two built
checkouts interleaved: the pointer moved over a thousand clips, each
asked whether it takes the pointer as a button (`onPress` and the rest),
and a script reading members a clip does not have, then a child by name.

There is no AVM1 benchmark against Flash yet; one in `players.ts` is
planned next.

## AVM1 against Flash

`node tests/bench/players.ts avm1` times six AVM1 benchmarks in swf2es
(headless Chrome), Flash (adl `-nodebug`) and, given `--ruffle DIR`,
Ruffle's web build. Each is an AS1 source under `tests/bench/avm1/`,
compiled by `tests/avm1-script.ts` as Flash's compiler writes it into a
SWF 8, after `Bench.as`, which times each section by the Date over its
rounds after a tenth of them to warm up. Every section also traces a
checksum of its work, from its first call; `players.ts` prints where a
player's trace parts from Flash's and still times it, so a run is only
sound if it prints none.

- **avm1-loop** (`Loop.as`): int-like and Number arithmetic, Math's
  functions and a string built by `+=`, in functions (registers), and the
  int loop again on the timeline (variables by name), for a quarter of the
  rounds: 10 to the function's 40, so per iteration the timeline's is
  about 3.3 times slower than the function's, not faster.
- **avm1-members** (`Members.as`): an object's members by literal name
  and by a name in a variable, an Array read, written, pushed and popped
  by index, and for..in over 100 members.
- **avm1-calls** (`Calls.as`): a timeline function, methods on prototypes
  as AS2's classes compile (`_global`, Extends, `super`), an inherited
  method, `new`, and Function's `call` and `apply`.
- **avm1-scope** (`Scope.as`): timeline variables from a function, `with`
  on an object and on a clip, `_root` and `_parent` paths, and `eval` and
  `set` of dotted and slash paths.
- **avm1-clips** (`Clips.as`): 300 clips attached, duplicated or created
  empty, then removed; the attached one is a library symbol of one shape.
- **avm1-frames** (`EnterFrame.as`): 2,000 clips, each with an
  `onEnterFrame`; 30 frames that move them in their own variables only
  (script), then 30 that also set `_x`, `_y`, `_rotation` and `_alpha`
  (display). The SWF's frame rate is 255 so that Flash's frames are not
  held to its pace; an empty handler on the same clips runs at that pace,
  so it is only a warm-up and is not timed. swf2es draws each changed
  frame as the web host does, multisampled, because adl draws its hidden
  window: larger shapes made Flash's display phase twenty times slower.
  A phase is timed over 31 ticks for its 30 frames of work, so Flash may
  wait out one idle frame at its pace (4 ms or more), a few percent at
  most. Ruffle's web build plays at the display's rate and is drawn at
  100 × 50 CSS pixels, so its avm1-frames numbers, bracketed, are not its
  work alone and not comparable.

Medians of 5 runs, 2026-11-15, i9-13900H, Chrome 157 (SwiftShader), AIR
51.5.1's adl under Wine, Ruffle 0.7.1, in ms:

| Section | swf2es | Flash | Ruffle | Flash / swf2es |
|---|---|---|---|---|
| int-arith | 109 | 470 | 608 | 4.3× |
| number-arith | 119 | 512 | 471 | 4.3× |
| math-calls | 198 | 813 | 762 | 4.1× |
| string-concat | 38 | 444 | 246 | 11.7× |
| int-arith-timeline | 91 | 721 | 474 | 7.9× |
| object-named | 115 | 689 | 758 | 6.0× |
| object-keyed | 107 | 669 | 687 | 6.3× |
| array-read | 28 | 159 | 241 | 5.7× |
| array-write | 29 | 231 | 339 | 8.0× |
| array-push-pop | 49 | 234 | 296 | 4.8× |
| for-in | 26 | 147 | 131 | 5.7× |
| function-call | 86 | 529 | 335 | 6.2× |
| method-call | 187 | 1003 | 808 | 5.4× |
| inherited-call | 194 | 995 | 739 | 5.1× |
| construct | 201 | 858 | 777 | 4.3× |
| call-apply | 179 | 858 | 600 | 4.8× |
| timeline-vars | 90 | 538 | 474 | 6.0× |
| with-object | 71 | 437 | 326 | 6.2× |
| with-clip | 82 | 365 | 491 | 4.5× |
| root-paths | 94 | 303 | 773 | 3.2× |
| parent-paths | 99 | 279 | 874 | 2.8× |
| eval-set | 119 | 383 | 268 | 3.2× |
| attach-remove | 121 | 154 | 140 | 1.3× |
| duplicate-remove | 104 | 142 | 102 | 1.4× |
| create-remove | 99 | 129 | 111 | 1.3× |
| enterframe-script | 108 | 361 | (1245) | 3.3× |
| enterframe-display | 379 | 687 | (1576) | 1.8× |

swf2es is ahead of Flash's AVM1 interpreter in every section, 4 to 12
times in script that touches no clip. It is closest where clips are
involved: making and removing them (1.3–1.4×), the display's properties
and drawing (1.8×), paths through clips (2.8–3.2×), and onEnterFrame on
2,000 clips (3.3×). Ahead of an interpreter is still slow for
JavaScript: the int loop's iteration takes about 130 ns. A profile in
node points at:

- **The operand stack in memory.** A function's code keeps AVM1's stack
  as an array across actions, `st.push(r1 = st.pop()); st.pop();` for a
  store to a register, and every operation is a `V.*` call that checks
  its operands' types, `V.toBoolean(V.not(V.less2(...)))` for a loop's
  test.
- **A call's allocations.** `call` makes an activation, a Scope and an
  object for locals at every call, though a DefineFunction2 that keeps
  everything in registers never reads that object; with property lookups
  by Map (`exact`), it is most of avm1-calls.
- **Clips removed from the front.** Removing clips in depth order takes
  each out of its parent's children by `splice` at index 0
  (`Container.takeOut`), quadratic in the clips left.
- **Liveness walks.** `removed()` walks a clip up to its level to tell
  whether a reference to it still holds, and `targetPath` parses a path
  each time: a sizeable part of avm1-scope's path sections.

## AVM2 eager and lazy compilation

`pnpm bench:avm2 [--runs 5] [--frames 600] [--json /tmp/avm2.json]`
compares the default eager loader with the optional lazy compiler, in
fresh node processes, alternating their order. The generated movie
exercises captured functions, arrays, properties and frame events across
three scenes, with nested bodies left unused; the libraries, startup,
first-use scenes and warmed ticks are measured apart, each scene's value
is checked, and warmed ticks must compile no further methods.
`--swf /path/to/movie.swf` measures a local movie's startup and ticks,
without interaction. `node tests/player/run.ts --lazy` and `pnpm corpus
--lazy avm2/` run the browser cases lazily.

## Reference numbers

Measured on one laptop (Intel Core i9-13900H; Intel Iris Xe and an
NVIDIA RTX 4060 Laptop GPU), Node 24 and Chrome, one benchmark at a time.
They are for comparing changes on this machine, not across machines.

### 0.1.23 against 0.1.22

2026-11-15, the CDN build of each release swapped into the comparison
branch's `players.ts --only swf2es drawing stage3d pixels` (three rounds
on Intel, two on NVIDIA, old and new in turn), then `bench.ts` four
rounds each in alternating order. Medians, with ranges.

Every drawing and Stage3D level holds 60 fps with a 17 ms median frame in
both versions, except:

| Level | GPU | 0.1.22 fps | 0.1.23 fps |
|---|---|---|---|
| vectors-8000 | Intel | 57.3 (56.9–57.3) | 57.4 (57.0–57.4) |
| filters-400 | Intel | 59.7 (55.7–59.9) | 55.3 (55.1–56.6) |
| text-800 | Intel | 59.0 (59–60) | 59.2 (59–60) |
| text-800 | NVIDIA | 58.5 (58.4–58.6) | 59.0 (58.8–59.2) |
| stage3d-8000 | Intel | 47.8 (46.3–48.9) | 47.9 (46.1–50.0) |
| stage3d-20000 | Intel | 32.2 (31.4–33.2) | 32.5 (32.1–32.6) |

Intel's filters-400 flips between about 55 and 60 fps from run to run in
every version, as its frames fall either side of the frame-pairing rule
(Player.advance runs SWF frames in pairs where the display seems to miss
half its vsyncs); its p50 column moves with the same flip, so neither
figure is a regression.

`pixels` on Intel, ms:

| Section | 0.1.22 | 0.1.23 |
|---|---|---|
| setPixels-opaque | 17 (16–17) | 19 (16–22) |
| setPixels-little-opaque | 15 (15–15) | 19 (15–27) |
| setPixels-transparent | 34 (33–34) | 38 (34–41) |
| setVector-opaque | 37 (37–40) | 36 (36–44) |
| setVector-transparent | 96 (95–101) | 90 (89–101) |
| getPixels-transparent | 91 (90–92) | 91 (90–93) |
| getVector-transparent | 96 (93–97) | 93 (93–95) |
| total | 387 (383–391) | 399 (376–407) |

The same within their ranges.

`tests/player/bench.ts`, frame medians in ms:

| Scene | | 0.1.22 | 0.1.23 |
|---|---|---|---|
| `--town 200 --gpu`, Intel | frame | 25.5 (23.1–29.9) | 25.2 (23.7–26.1) |
| | tick | 3.88 (3.21–5.16) | 3.38 (3.14–3.59) |
| | draw | 7.52 (6.91–9.58) | 7.87 (7.28–8.03) |
| | gl | 13.7 (13.0–14.5) | 13.8 (13.4–14.0) |
| 2,000 shapes, SwiftShader | frame | 14.80 (14.72–14.84) | 14.81 (14.79–14.99) |
| `--text 600 --gpu`, Intel | frame | 5.50 (5.37–5.75) | 5.47 (5.29–5.95) |

The town's tick is steadier (its spread narrowed; its median is within
noise), from the advance walk (#994); the rest is within noise.

### The walks, 2026-11-14

From `walk-bench.ts`, each change against the dev before it, interleaved:

| Change | Scene | Before | After |
|---|---|---|---|
| Frame-script rounds by marks (#979) | menu of 200 rows built beside 1,000 orphans | 514–617 ms | 5.1–5.3 ms |
| | the same, tick | 1,575–1,770 µs | 720–776 µs |
| Old-version clips listed, not everything (#981) | menu of 50 beside 2,600 clips of a version 9 SWF | 64–66 ms | 10.8–11.1 ms |
| Advance only clips that advance (#994) | 1,000 orphans, 10 playing, 50 churning, tick | 2,250–2,580 µs | 543–588 µs |
| | default tree, tick | 156–163 µs | 53–55 µs |
| Pointer pick by kept bounds (#997) | still pointer over a list of 800 rows, tick | 2.05–2.16 ms | 0.156–0.160 ms |

The same week, `bench.ts --text 600` (#984) went from 1,804 to 604
uniform calls a frame, and decoding a 1,200 × 900 JPEG on a canvas in
memory rather than on the GPU (#980) from 8.4 to 4.9 ms on Intel and from
500 to 7.5 ms on SwiftShader.

### Against Flash

`players.ts`, swf2es in Chrome against `adl -nodebug`, ms:

| Benchmark | Date | swf2es | Flash | Ruffle |
|---|---|---|---|---|
| enumeration, total (#729) | 2026-11-05 | 5,350 | 3,759 | 10,371 (before #729) |
| dictionary, total (#727) | 2026-11-05 | 1,518 | 2,148 | 1,607 |
| vector, total (#745) | 2026-11-06 | 6,415 | 5,449 | |

Flash leads on enumeration by its sparse Arrays and nested walks, both
since made faster (#747, #948, #949, measured in node only); swf2es leads
on strong Dictionaries and `in`. The vector figures predate the typed
Vector accesses at the call site (#752) and are due a new run.

Bitmap pixel transfers (`pixels`, #962, 2026-11-13), medians of five
interleaved rounds, ms:

| Section | swf2es | adl |
|---|---|---|
| setPixels-opaque | 22 (17–30) | 15 |
| setPixels-little-opaque | 16 (15–19) | 14 |
| setPixels-transparent | 38 (34–46) | 93 |
| setVector-opaque | 38 (37–44) | 9 |
| setVector-transparent | 93 (90–105) | 85 |
| getPixels-transparent | 96 (88–107) | 123 |
| getVector-transparent | 100 (97–119) | 125 |

`setVector` on an opaque bitmap is still about four times adl's: a
`Vector.<uint>`'s elements are doubles read and converted one at a time,
which another storage for the Vector would fix.

### Generated code: as3pb

as3pb's benchmark (100 messages, 300 iterations; see Inputs below),
compiled by swf2es and run in node, its output matching avmshell's.
Totals, encode plus decode, in ms:

| | Through ByteArray | Through domain memory |
|---|---|---|
| First working version (#20) | 1104 | 1412 |
| Structured control flow (#22) | 289 | 410 |
| Runtime hot paths (#23, milestone 1, 2026-09-28) | 207 | 251 |
| finddef read at its site (#513, 2026-10-23) | 155 | 148 |
| AwayFL JIT, headless, first run (2026-09-28) | 525 | 689 |
| Ruffle 0.6.0, web, first run (2026-10-02) | 1118 | 1389 |
| PepperFlash (2026-09-28) | 188 | 83 |
| avmshell (its JIT, in the oracle's container, 2026-09-28) | 107 | 74 |

`pnpm bench`, after a warm-up, median of 5 samples, as last recorded
(2026-09-28, with typed verification):

| ABC | Size | Instructions | Parse | Decode every body | Per instruction | Typed verification |
|---|---|---|---|---|---|---|
| abcdump.abc | 32 KB | 6,489 | 0.056 ms | 0.240 ms | 37 ns | 1.42 ms |
| as3pb (avmshell build) | 209 KB | 96,575 | 0.128 ms | 2.90 ms | 30 ns | 13.3 ms |
| Tamarin `as3/Vector/initializerLargeVector` | 3.8 MB | 1,002,071 | 1.33 ms | 68.2 ms | 68 ns | 135 ms |

Verification's second pass, which walks every block again to emit its
IR, is 34% of as3pb's and 52% of initializerLargeVector's: in a worklist
that reaches a fixed point, each block's last visit follows the last
change to its entry state, so the IR could be kept from that visit.

## What changed and why

The compiler and runtime:

- #5: one decoder's buffers reused across bodies, 3.4 to 5.2 times
  faster decoding.
- #14: AssemblyScript's minimal runtime (below).
- #20–#23: typed comparisons, type references made once a module,
  elements by number, structured control flow, then Vectors kept packed,
  coercions without the builtin switch and no rest arrays on ByteArray's
  methods; as3pb 1104 → 207 ms.
- #27, #29: domain memory's length in a field and its DataView kept
  until the bytes move (253 → 224 ms, from a run of the build the table
  times at 251; runs vary by a few percent); registers swapped through a
  temporary rather than by destructuring, an array and an iterator a
  swap (224 → 199 ms). V8 refuses to inline the codec's small methods
  for their bytecode size; raising its limits gains about 7% more.
- #30: `utf8()` through `TextEncoder` from 96 characters; AMF numeric
  Vectors reserved at once (47 → 15 ms).
- #31: JSON through the host's `JSON.stringify` and `JSON.parse`,
  numbers in the host's digits (as3pb's stringify 2279 → 522 ms).
- #32: AMF3 decoding from views of the input, Vector classes kept
  (821 → 457 ms).
- #33: typed verification's bindings memoized, its tables half full.
- #248, #904: inline caches for untyped names, eight entries a name,
  kept on the traits past a name's room, and a sealed prototype's names.
- #513: finddef reads the global kept on the name at its site, as V8
  does not inline the call in a large method.
- #724–#730, #747, #948, #949: cheaper for-in starts, steps and ends,
  sparse Arrays by their indices, a step record that keeps what it read.
- #759, #947: an absent Dictionary key at a third of the cost; a weak
  Dictionary's references read once a job.
- #752, #754: typed Vector elements read and written at the call site;
  a class-typed parameter's own class tested inline.
- #762, #768, #770: known classes constructed in place, bound calls
  through an unchecked entry, interface and super calls bound, interface
  methods by an alias every implementer shares.
- #797: script objects of thousands of slots kept fast in V8.
- #908, #912, #891, #882: untyped keys and string names made cheaply.
- #938, #941, #943: a String's length read in place, a primitive's
  methods kept from their first call.

The player:

- #803: only objects ever given a pointer method are asked whether a
  clip is a button.
- #950, #854: a still stage ticks by a timer and leaves the canvas be.
- #954, #962: a BitmapData's pixels set and read in runs, the long ones
  in the native module; #900, #902 copyPixels by rows and SIMD.
- #979, #981: frame-script rounds walk only where a script may be due,
  with old-version clips always listed, since their gotos run no cycle.
- #980: images decoded on a canvas in memory, as a GPU canvas's readback
  waits for the GPU.
- #984: advanced text's tables in a texture rather than uniform arrays,
  which hung Intel GPUs and cost a 49-vector upload a draw.
- #994: the tick advances only clips whose advance does something.
- #997: a button's pick bounds kept while its hit test state stands
  still.

The renderer's are described in [renderer.md](renderer.md).

What paid, in the compiler: a call the emitter can make for a known type
in place of a helper shared by many kinds of values (`coerceTo`, the
Vector accessors), arrays kept as V8 wants them, and no rest arrays on
calls made millions of times. Small helpers V8 already inlines (domain
memory's, `findDef` in a small method) gained nothing when kept.

## The AssemblyScript runtime

codegen.wasm uses AssemblyScript's `minimal` runtime: the TLSF allocator
and a collector that runs only when the host calls `__collect()`, which
the wrapper does between calls once memory has grown by 64 MB. The
`incremental` runtime collects during calls and pays a write barrier on
every store of an object reference: switching halved the decoder's time
per instruction on abcdump.abc and as3pb (67.5 → 37.0 and 61.6 → 30.0
ns) and took loading and verifying every Tamarin ABC from 9.8 to 5.5 s.
The `stub` runtime, which never frees, was no faster. Neither were the
optimizer's `converge` and `noAssert`, nor `uncheckedBehavior: "always"`;
releases use the last anyway, so the code needs no `unchecked()`, and
`pnpm test:checked` runs the tests with every access checked instead.

## Inputs

- **as3pb** ([33TU/as3pb](https://github.com/33TU/as3pb), MIT): a
  protobuf runtime for AS3, whose benchmark encodes and decodes through
  `ByteArray` and domain memory, so its bytecode covers bit operations,
  `lookupswitch`, `int`/`uint` coercions and the `li*`/`si*` opcodes in
  hot loops. Build it with `-compiler.float=false` (`AS3_FLOAT=false`),
  so that the same SWF runs in Flash Player and the non-float avmshell.
- **abcdump.abc**: avmplus' `utils/abcdump.as`, compiled by the oracle
  into `tests/conformance/out/` on every conformance run; MPL-2.0
  derived, so regenerated rather than committed.
