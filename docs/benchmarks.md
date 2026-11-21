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

    node tests/bench/players.ts [--runs N] [--ruffle DIR] [--only swf2es,ruffle,flash]
      [--write-swf OUT] [bench...]

- `enumeration`: for-in and for each over Arrays, Vectors, Objects and
  Dictionaries (`tests/bench/enumeration/Enumeration.as`);
- `dictionary`: gets, misses, writes, `in` and deletion on strong and weak
  Dictionaries (`dictionary/DictionaryAccess.as`);
- `vector`: indexed reads, writes, push and pop on Vectors and Arrays of
  int, Number, String, Object and a class (`vector/VectorAccess.as`);
- `pixels`: a BitmapData's pixels set and read whole, by ByteArray and by
  Vector (`pixels/BitmapPixels.as`);
- `random`: Math.random summed, scaled to an index and compared, ten
  million calls each (`random/Random.as`); `tests/bench/random.ts` times
  Flash's generator against JavaScript's in node;
- `primitives`, `typed`, `untyped`, `native-collections`, `display`,
  `display-frames`, `as3pb` and `lz4`: see "AVM2 against Flash" below;
- `avm1-*`: see "AVM1 against Flash".

`avm1` and `avm2` name the groups. `--ruffle DIR` (or `RUFFLE`) names
Ruffle's unpacked self-hosted build; without it Ruffle is left out.
`--write-swf OUT` writes each benchmark's SWF into OUT and plays none,
to profile one in node or open it elsewhere. The draft comparison branch
(#835) adds `drawing`, scenes of vectors, bitmaps, filters, text,
redrawn graphics and a Pixel Bender fill at three loads each, and
`stage3d`, played at 60 frames a second on the GPU through the browser
build's element, with frame times and memory; startup; and Flash
Player's projectors under Wine. The 0.1.25 numbers below were taken with
it.

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
- `--readback N`: each frame a new BitmapData of 546 by 693, an outline
  of N edges drawn into it, its getColorBoundsRect and those pixels read
  into a ByteArray after a 54-byte header (`--opaque` for an opaque
  bitmap): a fresh bitmap's texture, the readback after a draw and the
  scan;
- `--timelines N`: N sprites of their own, each 240 frames (`--loop K`)
  of 12 parts moving and a third of them fading, as tweens laid out frame
  by frame are; with `--allocs`, what the timelines hold after a full
  collection;
- and others for one path each: `--rig`, `--pulse`, `--branches`,
  `--toggle`, `--masks`, `--scroll`, `--stamps`, `--pen`, `--triangles`,
  `--redraw`, `--vectors` (the script's header says what each plays).

`--counts` adds the GL calls a frame, `--allocs` the KB allocated,
`--checkout DIR` plays another built checkout on the same SWF, and
`--write-swf FILE` writes the SWF for another player.

`--swf FILE` plays a SWF of one's own instead, in real time as the web
element plays it: on each animation frame the player advances by the time
passed, streamed sound and all, and draws what changed, with the samples
the element takes for the quality, at `--resolution R` canvas pixels a
stage pixel (a device pixel ratio). It plays `--frames N` of the SWF's
frames, all by default, and lists the animation frames whose work took
longer than one of the SWF's frames (`--spike MS`), the worst `--top N`,
each with what the renderer did in it: programs linked and the ms Chrome
waited for them, programs drawn with for the first time, buffers made
and copied, textures uploaded, filter passes, layers composited and morph shapes blended for a
new ratio. `--cpu-profile FILE` samples the whole play and names the
functions each listed frame spent its time in. It reports too how long
the first frame took and how many programs the renderer linked before
it. Keep SWFs that may not be shared out of the repository: the file is
only an argument.

    node tests/player/bench.ts --swf FILE [--frames N] [--resolution R] [--spike MS] [--top N]
      [--gpu] [--cpu-profile FILE] [--checkout DIR] [--json]

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

### The desktop app's sockets and WebSockets

`tests/desktop/relay-bench.ts` has servers in a process of their own send
many small messages, 8 sockets 20,000 of 48 bytes each and 4 WebSockets
20,000 of 32, and the desktop app's main-process side of them
(`connections.ts`, `websocket-connections.ts`, through `relay.ts` where
the checkout has it) take them in node, without Electron. It counts the
IPC messages the page would be sent, the socket's reads, the stores they
made and a batch's joins among them, collections and CPU time. Each
message is serialized by V8's serializer, as IPC serializes it, so the
CPU time holds serialization, but not the posting to the page nor the
page's side.

    node tests/desktop/relay-bench.ts [runs]                             this checkout
    node tests/desktop/relay-bench.ts <checkout A> <checkout B> [runs]   two, interleaved
        [--burst N]   the messages a server writes a turn, 40 by default
        [--busy MS]   the main process held MS ms of every 2 MS, as by its other work

`tests/desktop/keepalive-bench.ts` has servers in a process of their own,
http and https on loopback (the certificate made with openssl, https
skipped without), answer 1 KB to each of 200 GETs, one after another and
then all at once, made by `network.ts` in node as a SWF's URLLoaders make
them, and counts the connections the servers took. Loopback has no round
trip to speak of, so what a connection saves there is the main process's
own work, TLS's handshake above all; over a real network each also saves
its round trips.

    node tests/desktop/keepalive-bench.ts [runs]                             this checkout
    node tests/desktop/keepalive-bench.ts <checkout A> <checkout B> [runs]   two, interleaved
        [--loads N]   the loads of each kind, 200 by default

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
- **A clip's allocations.** A clip attached and removed allocates about
  5 KB: the clip itself, Maps for its depths and its AVM1 object's
  properties, an activation, its face, native and name, and splice's
  arrays; the collector is about 11% of avm1-clips. `splice` at index 0
  (`Container.takeOut`) is about 6% of its samples, but moving the
  children by hand gained nothing that repeated.
- **Path parsing.** `targetPath` parses a path each time, about 10% of
  eval-set; the rest of it is the lookups the parse interleaves.

Changes since, on the same machine, medians of 6 interleaved runs of
`--only swf2es`, in ms:

- 2026-11-15: `removed()` keeps its answer on the clip until a parent
  changes or a level is made (`parentage`), rather than walking to the
  level at every reference: with-clip 78.5 → 74, root-paths 92.5 → 68,
  parent-paths 99 → 69, eval-set 117.5 → 113.
- 2026-11-15: a clip's frame entry a field of it, and only clips' places
  in a WeakMap, so placing and entering add no WeakMap entries for the
  collector to walk (with the line above): attach-remove 115 → 107,
  duplicate-remove 107.5 → 95.5, create-remove 97.5 → 87.5.

## AVM2 against Flash

`node tests/bench/players.ts avm2` times every AS3 benchmark in swf2es
(headless Chrome), Flash (adl `-nodebug`) and, given `--ruffle DIR`,
Ruffle's web build: the four above (enumeration, dictionary, vector,
pixels) and eight more. Each but lz4 is compiled by ASC 2.0 against
playerglobal into a SWF of version 18 (Flash Player 11.5's, for JSON;
the four older ones ran as SWF 10 in the earlier dated rows, and Flash's
enumeration total moved 3,759 to 3,756 with it),
and times its sections by the Date. Every section also traces a checksum
or a count of its work, which must be as Flash traces it: `players.ts`
prints a line a player traces otherwise beside Flash's, and still times
it, so a run is only sound if it prints none for swf2es. Each runs as
one long script, which ScriptLimits allows 1,200 s, in the first frame
(lz4's in the second, after Crossbridge's preloader), but for
display-frames.

- **primitives** (`primitives/Primitives.as`): String's `charCodeAt`,
  `charAt`, `indexOf`, `substring`, `substr` and `slice`, and int's and
  Number's `toString` and `toFixed`, on typed values.
- **typed** (`typed/Typed.as`): `new` of classes shallow and deep in a
  hierarchy and with class-typed arguments, and calls the compiler binds:
  a class's method given its own class, a subclass and null, through an
  interface (one class, then four), through `super`, with parameters of
  int, uint, Number, Boolean and String, and on a final class. Each
  section is one loop of 3 to 9 million iterations, without a warm-up.
- **untyped** (`untyped/Untyped.as`): names on values typed `*`: a tree
  of the file's own display-like classes (getters, setters and methods by
  name, no flash.display), JSON-decoded data objects, dynamic Objects,
  calls on several classes, string building, names on many classes,
  number and object keys into Arrays, Vectors, Dictionaries and Objects,
  methods on a prototype, and names written as strings. One run of each
  loop, without a warm-up.
- **native-collections** (`native-collections/Collections.as`): Array's
  `map`, `filter`, `forEach`, `every` and `some`, Vector's `map` and
  `filter`, a numeric `sort` of a copy of each, over 8,192 numbers, and a
  Vector made from the Array; 80 rounds after 12.
- **display** (`display/Display.as`): 300 Sprites made, placed, added to a
  layer on the stage and removed; 300 of the library's "ball" (a
  MovieClip of one shape, linked to Ball) added, their `width` read, and
  removed from the top; 300 Shapes drawn by `graphics` and added, then
  `removeChildren`; 300 named Sprites found by `getChildByName` and
  removed by name; and 300 kept Sprites moved by `addChildAt`,
  `swapChildrenAt` and `setChildIndex`. 200 rounds each after 20 to warm
  up, as avm1/Bench.as runs its own.
- **display-frames** (`display/EnterFrame.as`): 10,000 Sprites, each a
  square drawn once, each with an ENTER_FRAME listener of its own: 30
  frames that move them in their own fields (script), then 30 that also
  set `x`, `y`, `rotation` and `alpha` (display), after an untimed
  warm-up. As avm1-frames, at 255 frames a second, drawn as the web host
  draws, multisampled; five times its clips, since Flash's JIT ran 2,000
  listeners in less than a frame at 255 fps, which would have timed its
  pace (about 121 ms for 31 frames) rather than its work.
- **as3pb** (`tests/programs/as3pb`): its benchmark, 100 messages
  encoded and decoded 300 times by protobuf through ByteArray and
  through domain memory, by AMF3 (`writeObject`/`readObject`) and by
  JSON; the data sizes and the wire checksum are compared.
- **lz4** (`tests/programs/lz4`): LZ4's C compiled by Crossbridge's gcc
  `-O4` into a SWF, with `lz4/Console.as` as its console: 2 MB of
  prose, of noise and of sparse records, each compressed and
  decompressed 50 times by the block format and compressed once by HC
  at level 9, in domain memory; sizes and xxh32 checksums compared. It times itself by getTimer, which the test page
  then keeps by the wall clock.

Medians of 5 runs, 2026-11-15, i9-13900H, Chrome 157 (SwiftShader),
AIR 51.5.1's adl under Wine, Ruffle 0.7.1, in ms. Ruffle's figures are
bracketed where they are not comparable: display-frames is played at
the display's rate in a page 100 × 50 CSS pixels, as avm1-frames is; and
Ruffle computes other results for as3pb (its JSON size and wire
checksum) and lz4 (every xxh32 checksum), so its times there are of
other work. swf2es and Flash traced the same lines in every benchmark.

| Section | swf2es | Flash | Ruffle | Flash / swf2es |
|---|---|---|---|---|
| **primitives** | | | | |
| charCodeAt | 14 | 40 | 692 | 2.86× |
| charAt | 22 | 74 | 534 | 3.36× |
| indexOf | 59 | 64 | 469 | 1.08× |
| substring | 50 | 313 | 446 | 6.26× |
| substr-slice | 52 | 227 | 399 | 4.37× |
| int-toString | 56 | 326 | 608 | 5.82× |
| number-toString | 67 | 607 | 233 | 9.06× |
| toFixed | 138 | 214 | 150 | 1.55× |
| total | 458 | 1,865 | 3,531 | 4.07× |
| **typed** | | | | |
| newSmall | 111 | 221 | 548 | 1.99× |
| newDeep | 147 | 252 | 956 | 1.71× |
| newChained | 93 | 235 | 719 | 2.53× |
| callClass | 38 | 34 | 1,230 | 0.89× |
| callSubclass | 43 | 33 | 1,219 | 0.77× |
| callInterface | 10 | 52 | 1,299 | 5.20× |
| interfaceCall | 14 | 20 | 554 | 1.43× |
| interfacePoly | 16 | 11 | 475 | 0.69× |
| superCall | 18 | 15 | 691 | 0.83× |
| newArgs | 94 | 242 | 558 | 2.57× |
| callNull | 4 | 30 | 989 | 7.50× |
| callNumbers | 31 | 63 | 2,480 | 2.03× |
| callFinal | 14 | 26 | 1,071 | 1.86× |
| total | 633 | 1,234 | 12,789 | 1.95× |
| **untyped** | | | | |
| display | 145 | 80 | 473 | 0.55× |
| data | 72 | 63 | 181 | 0.88× |
| object | 293 | 354 | 815 | 1.21× |
| poly | 77 | 132 | 296 | 1.71× |
| string | 94 | 101 | 228 | 1.07× |
| names | 49 | 63 | 153 | 1.29× |
| churn | 83 | 69 | 159 | 0.83× |
| handles | 44 | 43 | 179 | 0.98× |
| many | 94 | 98 | 162 | 1.04× |
| proto | 27 | 38 | 99 | 1.41× |
| numkeys | 33 | 34 | 130 | 1.03× |
| objkeys | 34 | 93 | 106 | 2.74× |
| litkeys | 127 | 183 | 357 | 1.44× |
| total | 1,172 | 1,351 | 3,338 | 1.15× |
| **native-collections** | | | | |
| array-map | 12 | 41 | 48 | 3.42× |
| array-filter | 10 | 27 | 64 | 2.70× |
| array-forEach | 10 | 26 | 63 | 2.60× |
| array-every | 8 | 15 | 42 | 1.88× |
| array-some | 8 | 16 | 43 | 2.00× |
| vector-map | 16 | 28 | 48 | 1.75× |
| vector-filter | 11 | 22 | 68 | 2.00× |
| array-sort | 94 | 78 | 93 | 0.83× |
| vector-sort | 95 | 72 | 156 | 0.76× |
| vector-convert | 4 | 7 | 15 | 1.75× |
| total | 268 | 332 | 640 | 1.24× |
| **display** | | | | |
| sprite-add-remove | 117 | 229 | 1,468 | 1.96× |
| clip-add-remove | 189 | 739 | 4,002 | 3.91× |
| shape-add-remove | 177 | 228 | 147 | 1.29× |
| by-name | 127 | 321 | 6,342 | 2.53× |
| reorder | 93 | 1,209 | 112 | 13.00× |
| total | 703 | 2,726 | 12,071 | 3.88× |
| **display-frames** | | | | |
| enterframe-script | 50 | 225 | (3,678) | 4.50× |
| enterframe-display | 776 | 1,554 | (3,897) | 2.00× |
| total | 826 | 1,779 | (7,575) | 2.15× |
| **as3pb** | | | | |
| serialize-as3pb-bytes | 57 | 193 | (405) | 3.39× |
| serialize-as3pb-memory | 37 | 38 | (592) | 1.03× |
| serialize-amf3 | 303 | 506 | (562) | 1.67× |
| serialize-json | 462 | 3,305 | (457) | 7.15× |
| deserialize-as3pb-bytes | 63 | 78 | (584) | 1.24× |
| deserialize-as3pb-memory | 45 | 51 | (673) | 1.13× |
| deserialize-amf3 | 358 | 841 | (518) | 2.35× |
| deserialize-json | 279 | 728 | (499) | 2.61× |
| total | 1,604 | 5,740 | (4,290) | 3.58× |
| **lz4** | | | | |
| prose-compress | 41 | 80 | (1,949) | 1.95× |
| prose-decompress | 24 | 37 | (1,228) | 1.54× |
| prose-compress-hc | 6 | 13 | (45) | 2.17× |
| noise-compress | 18 | 10 | (208) | 0.56× |
| noise-decompress | 8 | 6 | (40) | 0.75× |
| noise-compress-hc | 123 | 128 | (5,884) | 1.04× |
| records-compress | 104 | 178 | (6,569) | 1.71× |
| records-decompress | 52 | 94 | (3,448) | 1.81× |
| records-compress-hc | 311 | 522 | (25,536) | 1.68× |
| total | 687 | 1,068 | (44,907) | 1.55× |

In the same run, the four older benchmarks' totals, and their sections
where swf2es is behind:

| Section | swf2es | Flash | Ruffle | Flash / swf2es |
|---|---|---|---|---|
| enumeration holey-each | 70 | 58 | 444 | 0.83× |
| enumeration sparse-in | 169 | 67 | 134 | 0.40× |
| enumeration sparse-each | 189 | 71 | 380 | 0.38× |
| enumeration named-in | 63 | 61 | 144 | 0.97× |
| enumeration named-each | 90 | 57 | 443 | 0.63× |
| enumeration vector-object-each | 80 | 73 | 491 | 0.91× |
| enumeration vector-string-each | 81 | 73 | 491 | 0.90× |
| enumeration object16-each | 136 | 120 | 313 | 0.88× |
| enumeration object1k-each | 89 | 62 | 177 | 0.70× |
| enumeration dict-strings-in | 76 | 68 | 92 | 0.89× |
| enumeration dict-strings-each | 92 | 69 | 93 | 0.75× |
| enumeration nested-each | 107 | 74 | 414 | 0.69× |
| enumeration queue-in | 157 | 154 | 636 | 0.98× |
| enumeration queue-each | 170 | 152 | 734 | 0.89× |
| enumeration total | 3,490 | 3,756 | 10,542 | 1.08× |
| dictionary strong16-miss | 25 | 22 | 44 | 0.88× |
| dictionary total | 669 | 2,154 | 1,627 | 3.22× |
| vector total | 1,568 | 5,002 | 55,277 | 3.19× |
| pixels setPixels-opaque | 17 | 15 | 131 | 0.88× |
| pixels setPixels-little-opaque | 15 | 14 | 117 | 0.93× |
| pixels setVector-opaque | 37 | 9 | 207 | 0.24× |
| pixels setVector-transparent | 90 | 84 | 207 | 0.93× |
| pixels total | 377 | 448 | 1,257 | 1.19× |

Against Flash's JIT, swf2es is ahead in total in every benchmark: from
1.1× (enumeration, untyped) to 4× (primitives, display), 3.2–3.6× on
Vectors, Dictionaries and as3pb, and 1.55× on LZ4's C. The display list
is well ahead (1.3–13× in display, 2× drawing 10,000 moving Sprites, 4.5×
dispatching their ENTER_FRAME, though Flash's time there is under twice
its frame pace's floor and may hold some pacing), and so is Flash's slow string, number
formatting and JSON (as3pb's JSON encoding 7×). But ahead in total
hides what is behind, which is the work list, furthest first, down to
about 0.85× (the tables show the rest, up to 0.98×):

- **setVector on an opaque bitmap** (0.24×), already explained above: a
  `Vector.<uint>`'s elements are doubles converted one at a time.
- **for-in and for each over a sparse Array** (0.38–0.40×), and walks of
  named Arrays, nested Arrays, Objects of 1,000 names and string-keyed
  Dictionaries by for each (0.63–0.75×).
- **untyped names on a tree of objects** (untyped's display, 0.55×), and
  its data, churn and handles loops (0.83–0.98×): getters, setters and
  methods called by name on class instances, dynamic properties of a
  dynamic class and of JSON's Objects.
- **LZ4 on incompressible data** (noise-compress 0.56×, noise-decompress
  0.75×): the loop that hashes four bytes at every position and finds no
  match is nearly all domain memory reads and writes.
- **typed calls V8 does not make as cheap as Flash's JIT**: a method
  given a subclass of its parameter's class (0.77×), an interface method
  on four classes in turn (0.69×), `super` (0.83×) and a class's own
  method (0.89×): 4.2–6.0 ns an iteration against Flash's 3.7–5.0.
- **numeric sort** of 8,192 numbers (Array 0.83×, Vector 0.76×).
- **Shapes drawn by `graphics` and added** are the display section
  closest to Flash (1.29×), and Ruffle is faster there (147 ms to 177).

A profile in node (the player playing each section alone, its rounds
raised, `--cpu-prof`; its timings were within 10% of Chrome's, but
LZ4's were up to twice them under the profiler)
points at:

- **Sparse Arrays' indices taken at every walk.** A for-in over the
  sparse Array takes its indices again each time it starts, by
  `Object.keys` and a `Number()` of each key (`indicesOf`, 25% of the
  section), as they are dropped when a walk ends; the step's
  `enumerable` check is 18% more, and `startOrGoOn`, `takeSparse` and
  `sparseElement` 18% between them. avmplus walks its hashtable in place.
  Keeping the indices between walks would save about 40%, but cannot be
  kept exact cheaply: generated code stores an Array's elements in place
  and fills a hole within the length unseen by the runtime, so a cache
  could miss an index; a guard on that store, or a backing store that
  is not a plain array, would cost other code (tried 2026-11-16).
- **Untyped names through the runtime.** Every get, set and call on a
  value typed `*` is a call of `rt.getProperty` (17% of untyped's
  display), `setProperty` or `callProperty`, which looks the name up in
  the receiver traits' cache (`receiverTraits`, 7.5%) and dispatches on
  the entry's kind: a getter by `e.get.call(o)`, a dynamic property by
  a Map's `get` and then `has`. The site keeps nothing of what it found,
  where Flash's JIT caches it at the call site.
- **Domain memory by `rt.view`, ruled out.** Crossbridge's loads and
  stores are `rt.view.getInt32(address, true)` and the like, the DataView
  read from the runtime at every access. Holding the view in a local for
  the method, read again only after what can change the memory, was tried
  on 2026-11-16 and gained nothing (lz4's total 684–687 ms before, 682–687
  after; prose-compress slower): V8 makes the read cheap. The noise
  sections' gap looks like warm-up; the program's first run in node is
  about four times its steady state.
- **Typed calls.** The loops are compiled as they should be: `l1.$b4(l2)`
  calls the method's unchecked entry with no coercion when the argument
  is known to be a subclass, and an interface call is
  `o["$i0.5:Shape:area"]()`. What is left is V8's: the method fetched
  from the prototype at each call, the field loads in `Vec.dot` made
  polymorphic once Vec and Vec3 (one more field) both reach it, and an
  interface method on four prototypes.
- **Sorting through closures.** `qsort` (60% of the sort sections)
  calls a compare and a swap closure by index for every step, and the
  compare converts both elements to Number each time, where avmplus'
  ArraySort compares the elements' doubles in C++.

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
NVIDIA RTX 4060 Laptop GPU), Node 24 and Chrome, one benchmark at a time,
except where a section names another machine. They are for comparing
changes on one machine, not across machines.

### 0.1.31 against 0.1.30

2026-11-20, on a desktop: AMD Ryzen 9 9950X3D (16 cores, 32 threads),
60 GB, an AMD Radeon RX 7900 XTX that Chrome for Testing 154 reached
through ANGLE's Vulkan back end (RADV), Node 24.7, load average 1 to 2
before each run. The comparison branch's `players.ts --only swf2es
drawing stage3d pixels startup-hello startup-as3pb` was run in each
release's built checkout: 0.1.30's browser build is byte for byte the
CDN's (npm's `swf2es@0.1.30`), and 0.1.31's is integration/0.1.31's
(4fea0453). Four rounds each, old and new in turn, then four more of
`drawing` alone; then `bench.ts` four rounds each in alternating order,
twelve for the shapes and text scenes. Medians, with ranges. The
drawings, Stage3D, startup and the `--gpu` scenes drew on the Radeon;
`pixels` and the 2,000 shapes on SwiftShader, as the scripts have them.

Every drawing and Stage3D level holds 60 fps with a 17 ms median frame in
both versions, stage3d-20000 included, except:

| Level | 0.1.30 fps | 0.1.31 fps |
|---|---|---|
| text-800 | 59.3 (58.4–59.6) | 59.2 (58.8–59.4) |
| shader-400 | 59.8 (59.8–60.0) | 59.8 (59.6–60.0) |

What they lose is a few long frames in a run, alike in both versions: the
longest frame's median is 77 and 76 ms in text-800, 51 and 52 ms in
shader-400.

`pixels`, ms:

| Section | 0.1.30 | 0.1.31 |
|---|---|---|
| setPixels-opaque | 7.5 (7–8) | 7 (7–8) |
| setPixels-little-opaque | 6 (6–7) | 6 (6–6) |
| setPixels-transparent | 17.5 (17–18) | 18 (18–20) |
| setVector-opaque | 13 (13–13) | 13.5 (13–14) |
| setVector-transparent | 68.5 (67–70) | 70 (68–72) |
| getPixels-transparent | 42.5 (41–45) | 41.5 (41–43) |
| getVector-transparent | 51.5 (46–56) | 49.5 (48–51) |
| total | 207.5 (198–214) | 205.5 (202–213) |

Startup in Chrome, ms (cold in a new profile with the player's code
fetched, warm in the same page):

| SWF | | 0.1.30 | 0.1.31 |
|---|---|---|---|
| hello | cold | 237.5 (221–262) | 232.5 (216–243) |
| | warm | 59.5 (56–62) | 58 (57–61) |
| as3pb | cold | 323 (294–332) | 312 (296–314) |
| | warm | 96.5 (91–99) | 97 (92–98) |

The browser build's fetched files are 2,715 KB (817 KB in brotli), 19 KB
(5 KB) more than 0.1.30's.

`tests/player/bench.ts`, frame medians in ms:

| Scene | | 0.1.30 | 0.1.31 |
|---|---|---|---|
| `--town 200 --gpu` | frame | 8.91 (8.30–10.07) | 8.42 (8.33–8.99) |
| | tick | 0.87 (0.79–1.06) | 0.89 (0.88–0.94) |
| | draw | 4.43 (4.00–5.39) | 4.02 (3.89–4.51) |
| | gl | 3.38 (3.36–3.48) | 3.38 (3.37–3.41) |
| 2,000 shapes, SwiftShader | frame | 7.22 (7.01–7.44) | 7.35 (6.86–7.61) |
| `--text 600 --gpu` | frame | 1.61 (1.54–1.79) | 1.61 (1.52–1.82) |
| `--scripted 200 --hover --gpu` | frame | 13.06 (12.17–14.74) | 14.25 (13.16–15.22) |
| | tick | 8.36 (7.68–9.56) | 8.88 (8.52–10.25) |

All within noise but the scripted rigs, added for this release's
instance naming at placement and input. The shapes' first four rounds
had 0.1.31 4% slower, all of it in SwiftShader's GL wait, and the next
eight had it 2% faster. The scripted rigs, which replace 2,400 clips
with frame scripts every frame, tick about 5% slower in 0.1.31 (twelve
rounds; eight without `--hover` gave 8.35 (7.76–9.00) and 8.79
(8.29–10.20) ms, so input plays no part). That is about 0.2 µs for each
clip placed. Profiled over 600 frames, four rounds each, the added time
is in the player: #1121 has a clip's first frame placed as its parent's
frame places it, through `library.placed`, where 0.1.30 placed it from
`construct`. The first frames' work in all is no greater (0.71 ms a frame
under `construct` in 0.1.30, 0.68 under `library.placed` and
`enterFirstFrame` in 0.1.31), but `enterFirstFrame` and `placeFirstFrame`
take 0.36 ms a frame of self time where they took 0.09, with
`frameSounds`, `addFrameScript` and the AS3 object's creation a little
more besides. The collector's time is level. The town, whose clips with
frame scripts stay put, does not show it.

### 0.1.25 against 0.1.24

2026-11-16, the CDN build of each release swapped into the comparison
branch's `players.ts --only swf2es drawing stage3d pixels startup-hello
startup-as3pb` (three rounds on Intel, two on NVIDIA, old and new in
turn), then `bench.ts` four rounds each in alternating order. Medians,
with ranges.

Every drawing and Stage3D level holds 60 fps with a 17 ms median frame in
both versions, except:

| Level | GPU | 0.1.24 fps | 0.1.25 fps |
|---|---|---|---|
| vectors-8000 | Intel | 56.8 (56.6–56.8) | 56.6 (56.3–56.7) |
| filters-100 | Intel | 59.8 (56.8–60.1) | 60.0 (60.0–60.0) |
| filters-400 | Intel | 54.7 (53.0–55.3) | 57.0 (55.9–60.0) |
| text-800 | Intel | 59.2 (59.2–59.2) | 59.2 (59.2–59.2) |
| text-800 | NVIDIA | 57.7 (57.6–57.8) | 58.5 (58.4–58.6) |
| stage3d-8000 | Intel | 59.9 (46.8–60.0) | 48.1 (47.2–48.7) |
| stage3d-20000 | Intel | 34.2 (31.4–34.5) | 33.2 (32.2–35.1) |

stage3d-8000 on Intel is 47 to 52 fps in every run of either version but
two of 0.1.24's here, which fell on the frame-pairing rule's other side
as filters-400 does, so it is no change. NVIDIA's text-800, a frame a
second lower in 0.1.24's comparison, is back.

`pixels` on Intel, ms:

| Section | 0.1.24 | 0.1.25 |
|---|---|---|
| setPixels-opaque | 18 (17–20) | 17 (17–31) |
| setPixels-little-opaque | 15 (15–27) | 15 (15–22) |
| setPixels-transparent | 35 (35–41) | 35 (35–36) |
| setVector-opaque | 45 (42–59) | 37 (36–41) |
| setVector-transparent | 92 (90–100) | 90 (89–93) |
| getPixels-transparent | 89 (88–89) | 90 (88–90) |
| getVector-transparent | 94 (93–97) | 96 (93–97) |
| total | 397 (385–419) | 380 (380–403) |

setVector-opaque is #1020's.

Startup in Chrome, ms (Intel; cold in a new profile with the player's
code fetched, warm in the same page):

| SWF | | 0.1.24 | 0.1.25 |
|---|---|---|---|
| hello | cold | 344 (330–357) | 357 (357–359) |
| | warm | 95 (90–97) | 96 (90–97) |
| as3pb | cold | 474 (466–490) | 460 (459–485) |
| | warm | 156 (156–167) | 154 (152–157) |

The browser build's fetched files are 2,625 KB (791 KB in brotli), 1 KB
more than 0.1.24's.

`tests/player/bench.ts`, frame medians in ms:

| Scene | | 0.1.24 | 0.1.25 |
|---|---|---|---|
| `--town 200 --gpu`, Intel | frame | 25.89 (23.76–28.58) | 25.67 (23.14–27.44) |
| | tick | 3.67 (3.22–4.16) | 3.64 (3.08–4.30) |
| | draw | 8.15 (7.19–9.01) | 7.82 (7.11–8.94) |
| | gl | 13.94 (13.50–14.51) | 13.91 (13.27–14.23) |
| 2,000 shapes, SwiftShader | frame | 14.91 (14.89–15.01) | 15.03 (14.98–15.09) |
| `--text 600 --gpu`, Intel | frame | 5.54 (4.62–5.80) | 5.76 (5.60–6.11) |

Within noise, though the text bench's new build has come out a little
slower two releases running (5.54 to 5.65 ms, then 5.54 to 5.76), its
ranges overlapping each time: it is watched.

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
| enumeration, total | 2026-11-15 | 3,490 | 3,756 | 10,542 |
| dictionary, total | 2026-11-15 | 669 | 2,154 | 1,627 |
| vector, total | 2026-11-15 | 1,568 | 5,002 | 55,277 |

Flash led on enumeration by its sparse Arrays and nested walks, both
since made faster (#747, #948, #949); swf2es leads on strong
Dictionaries and `in`, and since the typed Vector accesses at the call
site (#752) on Vectors too. The rows of 2026-11-15 are from "AVM2
against Flash" above, where every AS3 benchmark's sections are.

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
- #1019: Array.NUMERIC sorts of numbers by the same quicksort on their
  doubles, the comparison inline (native-collections' sorts 95 → 55 ms).
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
- #1012, on `bench.ts --readback 300 --gpu` (RTX 4060), a frame of a
  bitmap made, drawn into, scanned and read: a readback's bytes turned
  into words by swapping red and blue in whole words, and the bounds'
  pixels taken once, 10.55 → 9.69 ms; a fresh BitmapData's texture
  cleared on the GPU and its pixels made only when used, 9.69 → 7.70 ms
  (opaque 9.99 → 8.77); a ByteArray's words written at an unaligned
  offset by bytes for an opaque store, and through the scratch row for a
  transparent one, 7.70 → 6.98 ms (opaque 8.77 → 8.27);
  getColorBoundsRect reading each row from both ends to its first and
  last match, 6.98 → 4.77 ms.
- #1020: setVector on an opaque bitmap into a view of a run from the
  Vector's start (pixels' setVector-opaque 38 → 27 ms).

The desktop app:

- #1010: a page's socket and WebSocket events gathered into one IPC
  message a millisecond at most, the first after a quiet spell at once;
  sockets read into a buffer of their own, each read copied out at its
  length (`tests/desktop/relay-bench.ts`, medians of 6, with the main
  process free and then held 4 ms of every 8, `--busy 4`). IPC messages:
  WebSockets 80,008 → 200 and → 23; sockets 7,580 → 116 and 2,639 → 63.
  CPU: WebSockets 445 → 384 ms and 417 → 286; sockets 121 → 113 and 114
  → 113. Stores a read: 2.00 → 1.05, but a socket's reads in one batch
  are joined into another, so the bytes made a byte received went 2.00 →
  1.98 and → 1.60; collections 9 → 5 (12.0 → 4.4 ms) and 5 → 5 (4.9 →
  2.9 ms). A cheaper read comes sooner and carries less: reads 7,564 →
  15,790 and 2,623 → 5,852.
- #1023: keep-alive connections, a pool keyed by scheme, name, pinned address,
  port, route and certificate checking (`tests/desktop/keepalive-bench.ts`,
  200 loads of 1 KB from one loopback server, medians of 6): http one by
  one 74.1 → 47.6 ms, all at once 43.6 → 25.1 ms; https one by one 334.3
  → 39.6 ms, all at once 228.4 → 28.9 ms. Connections: 200 → 1 one by
  one, 200 → 6 all at once, a key's limit.

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
