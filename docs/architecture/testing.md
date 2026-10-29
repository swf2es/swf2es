# Testing against oracles

- **avmshell** (avmplus/Tamarin shell) for AS3 semantics: the output of the
  compiled test must match avmshell's `trace()` output exactly. The Tamarin
  acceptance suite supplies thousands of cases.
  The oracle's avmshell is a 32-bit x86 build, whose C++ double arithmetic
  may run in the x87's extended precision. Where that shows, swf2es follows
  IEEE doubles and the cases avoid it: `Number.toString(radix)` of a value
  above 2^53 writes digits that are neither exact nor a double's, and in
  its JIT a multiplication past 2^53 comes out exact, as as3pb's wire
  checksum shows (`tests/programs` compares all but that line).
  `tests/programs` also builds C, LZ4's from the com-lz4-as3 submodule
  with a driver of its own (`tests/programs/lz4`), with the image's
  Crossbridge, and runs it as avmshell's projector and its ABC in
  swf2es. That avmshell has Crossbridge's ShellPosix, which swf2es's
  shell has not, so its start, which then goes as in a player, is left
  out of the comparison.
  for-in and for each visit an object's dynamic properties in the order
  they were added; avmplus visits them in its hashtable's, which for names
  that are not indexes follows their interned strings' addresses, so the
  cases do not depend on it.
- **Flash, as AIR's `adl` runs it**, for what the player draws and traces
  (`oracle/flash.ts`, `oracle/flash/Harness.as`). The harness is an AIR
  application that loads each SWF with a `Loader`, in a hidden window of
  the SWF's size, and sends back the frames asked for, drawn with
  `BitmapData.drawWithQuality` at the SWF's stage quality, and its traces.
  Frame 1 is the one its `INIT` follows and frame k the one after k - 1
  `EXIT_FRAME`s, a frame later for AVM1, whose movie in a `Loader` shows
  its frame 2 a frame late; adl prints an AVM1 movie's first frame's
  traces only with its second's, so a corpus test or case of one frame is
  run for two. A frame's load completions (`INIT`,
  `COMPLETE`) follow its `EXIT_FRAME`, so what their listeners change
  shows in the next frame's capture (the `loads-init` case captures frame
  3 for its unload at frame 2's `INIT`). A SWF's clips taken off the
  display list play on in Flash until collected, so a case that leaves
  one is recorded last, or its traces would reach the next case's. A SWF the harness runs is loaded content, and
  Flash constructs that before it is the `Loader`'s child: its document
  class finds `stage` null in its constructor, where a main movie's finds
  the stage, as the player's does. A case whose trace depends on that
  waits for the player's own `Loader`, to run as loaded content too. adl is not in CI (here it runs the Windows AIR
  runtime under Wine), so what the player's tests compare against is drawn
  once and committed (`tests/player/references`, `node tests/player/run.ts
  --update`); CI needs only Chrome.
  [Ruffle's test corpus](https://github.com/ruffle-rs/ruffle/tree/master/tests/tests/swfs)
  supplies thousands of SWFs with Flash Player's traces, and some with its
  frames (`tests/player/corpus/fetch-ruffle.ts` fetches it, uncommitted). Flash
  under adl traces what their `output.txt` holds (`timeline/`: all 15 that
  finish; `visual/`: 104 of 107). The expected frames are not all Flash's,
  some are Ruffle's own, and Flash under adl draws 42 of the 101 in
  `visual/` within their tolerance or a pixel's anti-aliasing of it, so
  the oracle decides, not the corpus's PNGs (`tests/player/corpus/check-references.ts`).
- **Ruffle's corpus, as a baseline for the player** (`pnpm corpus`,
  `tests/player/corpus/run.ts`): the player plays each `avm1/`, `avm2/`
  and `timeline/` test that has Flash's `output.txt` for the frames its
  `test.toml` names, in Chrome as the player's tests run, and its trace is
  compared to Flash's line by line. The page runs the runtime as the
  debugger player, since Ruffle recorded its traces with one and adl is
  one: an uncaught error's line carries its text, "Error #1010: A term is
  undefined and has no properties.", where the release player's and
  avmshell's has the number alone. `baseline.json` records each test's
  standing, as `tests/tamarin/swf2es-baseline.json` records swf2es's on
  Tamarin: the lines matched before the first difference, of how many,
  and what stopped the player, if anything. A change may not lower a
  standing, and one that raises it updates the baseline with
  `--update-baseline`; a test whose standing varies from run to run is
  set to null and not compared. Only the traces are compared: the frames
  Flash drew are the oracle's matter (above), and a test needing audio,
  video or a default font is ignored, as the collector marks it. A test's
  `input.json`, the mouse, keys and text Ruffle's runner plays into it, is
  played as Ruffle plays it (`tests/player/replay.ts`): after each frame,
  the events up to the next `Wait`. A key's press sends its events and
  moves focus with Tab, and only the recorded text and editing keys edit
  a field, as Ruffle's input keeps them apart; a press is a first click
  unless its `index` counts it as a second, as Ruffle's runner has it.
  A test that gives its window (`viewport_dimensions`) recorded its
  positions in it, the stage shown whole and centred: they are scaled
  back to the stage's, and an AVM1 movie told the window's pixels to a
  stage pixel, which `_xmouse` is measured in.
  Flash's harness plays no input, so `check-references.ts` leaves these
  tests out.
  A test that does not finish in its time is a timeout, a standing of its
  own. The corpus is fetched, not committed: CI's `corpus` job, beside
  the test jobs on every pull request and every push to main or dev,
  fetches it at
  `RUFFLE_COMMIT`, caches it by that commit, and fails on a lowered
  standing, naming the test, its standing before and after, and where its
  trace parts from Flash's. It is what says, in order of what real SWFs
  hit first, what the player lacks.

The AS3 half of a player test is an `.as` file beside its case, compiled
in the oracle's container by ASC against `builtin.abc` and
`playerglobal.abc` (which stays in the image, not the repository), and
placed in the
SWF the test builds as a `DoABC` with a `SymbolClass`. Flash's trace of
the SWF is recorded by `--update` beside its frames, and the player's
must match it line for line, as the conformance cases must match
avmshell's.

CI (`.github/workflows/ci.yml`) runs `pnpm check`, the typecheck and the
native binaries' rebuild in a job of its own, and `pnpm test` and `pnpm
test:checked` split into parts side by side: the player's cases in
thirds (`run.ts --shard i/n`), its other checks, the compiler's packages
with `pnpm determinism` and the Tamarin subset after them, and the pages
and fuzzers. A test package that no part runs fails the lint job, so a
new one cannot drop out of CI unnoticed. The corpus is a job beside
them (above). The full Tamarin suite runs nightly (`tamarin.yml`), and
the desktop app's builds and the site's publishing have workflows of
their own.

## Fuzzing the compiler

The JIT compiles whatever bytes a SWF holds, so codegen must reject any
malformed ABC with a VerifyError, never trap. `tests/fuzz/abc.ts` mutates
seed ABCs (the unit tests' hand-built ones and the conformance cases) a
few bytes at a time, mostly toward the end, where the method bodies are,
and checks that the compiler does not trap, that a module it accepts
imports as an ES module, and that each of its methods compiled alone is its
entry in the module. A seeded generator makes a run repeat; a failing case
is written to `tests/fuzz/out/failures/`. `pnpm test` runs a short round,
`pnpm test:checked` the same in the build that checks every array access,
which catches a read past a table's end the release build lets through.

`tests/fuzz/avm1.ts` does the same for AVM1's decoder and flow
(`codegen/assembly/avm1/`): action blocks generated from the actions'
grammar, nested bodies and branches among them, and shapes at the edges
(bodies that jump back before their own start, long `WaitForFrame` chains,
deep nesting, blocks that read the same bytes from many offsets), mutated
a few bytes at a time or cut short. A block must decode without a trap, no
region may hold an action in two of its blocks, and a block must decode
the same again after others. The flow refuses a block whose regions would
hold more than 2M actions or whose decoding would read more than eight
bytes per byte of it (and a megabyte besides), so a crafted block costs
time in proportion to its size.

`tests/fuzz/pbj.ts` does it for Pixel Bender's bytecode, which a script
hands `Shader` as any bytes: kernels built of operations whose register
kinds and sizes adl takes, branches and matrices among them, mutated or
cut short or garbage alone. `readPbj` must refuse each with PbjError
(2004 or 2030) or read it, the same twice, and the interpreter must run
whatever it reads over a few pixels, any parameters and images, writing
only its output.

`tests/fuzz/domains.ts` gives two instances the same ABCs, child domains
and findings in a seeded random order, and lets one of them also drop,
evict, revive and rebuild domains; every module, entry, method compiled
alone and resolved slot type of a live ABC must come out of both the same.
Besides the conformance cases, it loads classes made to collide, and
again and again has a domain resolve a type its ancestor then defines
anew, the order a rebuild must not change.
