# AGENTS.md

Instructions for coding agents working on swf2es. Humans may find them
useful too; the design itself is in [docs/architecture.md](docs/architecture.md),
and the specs and implementations to consult are in
[docs/references.md](docs/references.md).

## What this is

swf2es plays SWF files in the browser and compiles their ActionScript
bytecode to JavaScript. One compiler (`packages/codegen`, AssemblyScript →
`codegen.wasm`) runs both as the browser JIT and as the AOT compiler, and
must give **identical output** in both modes.

## Commands

```sh
git submodule update --init   # oracle/avmplus (Tamarin tests), tests/programs/as3pb,
                              # vendor/pixijs (the Pixi fork the player draws with), and
                              # vendor/minimp3, vendor/zlib and vendor/lzma-sdk (C compiled to wasm)
pnpm install
pnpm build       # the Pixi fork, asc → codegen.wasm, then tsc -b for all packages
pnpm build:debug # the same with unoptimized wasm, names and source maps
pnpm check       # Biome format + lint; `pnpm format` applies fixes
pnpm typecheck   # tests/ and oracle/ (.ts run directly by node)
pnpm test        # unit, conformance, library, program, fuzz, player and web tests
                 # (needs podman or docker, and Chrome; CHROME names another browser)
pnpm test:checked # the same with every array access bounds-checked
pnpm determinism              # each module the same however it is compiled, and each method
                              # compiled alone its entry in the module (after the runners)
pnpm oracle path/to/file.as   # print avmshell's output for a file (oracle:abcdump its dump)
                              # what ASC, gcc and abcdump made is kept for every checkout in
                              # ~/.cache/swf2es/oracle ($XDG_CACHE_HOME; SWF2ES_ORACLE_CACHE
                              # names another directory)
pnpm oracle:pull              # pull the oracle's pinned container image
pnpm oracle:cases             # the unit tests' hand-built ABCs vs avmshell
pnpm tamarin [prefix...]      # Tamarin acceptance tests vs baseline.json (about 10 minutes
                              # uncached; SWF2ES_ORACLE_JOBS sets parallelism, default 10)
pnpm tamarin --update-baseline [prefix...]   # after an oracle or harness change
pnpm tamarin:swf2es [--update-baseline | --relax] [prefix...]   # the same tests in swf2es, vs
                              # swf2es-baseline.json (compiles them itself, without avmshell)
node oracle/flash.ts file.swf [frames] [capture...] [low|medium|high|best]
                              # what Flash traces and draws, with AIR's adl (not in CI)
node tests/player/run.ts [--table-ab] [case...]   # the player's cases in Chrome vs Flash's frames
node tests/player/run.ts --update [case...]  # draw the player's references in Flash
node tests/player/corpus/fetch-ruffle.ts     # Ruffle's test corpus, for the two below
pnpm corpus [--update-baseline] [--diff [--dump]] [prefix...]   # the player on the corpus's avm2 and
                              # timeline tests vs corpus/baseline.json (Chrome; about 5 minutes); --diff
                              # shows where a failing test parts from Flash, --dump its whole trace
node tests/player/corpus/check-references.ts [prefix...]   # the corpus's expected outputs vs Flash
node tests/fuzz/abc.ts [cases, 2000] [seed, 1]   # malformed ABCs: codegen never traps, its modules
                              # parse, JIT equals AOT (SWF2ES_CHECKED=1 for the checked build)
node tests/fuzz/avm1.ts [cases, 2000] [seed, 1]   # malformed AVM1 action blocks: the decoder
                              # and flow never trap, and decode a block the same after others
                              # (SWF2ES_CHECKED=1 for the checked build)
node tests/fuzz/compress.ts [cases, 2000] [seed, 1]   # malformed CWS, ZWS, zlib and LZMA: the
                              # decoders never trap, refuse with CompressedDataError, and a
                              # SWF that decodes has its prefix
node tests/fuzz/domains.ts [steps, 3000] [seed, 1]   # drops, evictions, revivals and rebuilds of
                              # application domains change no module against a reference
SWF2ES_FUZZ_STEPS=50000 SWF2ES_FUZZ_SEED=14 node --test tests/unit/player/playerglobal/flash/display/BitmapData.test.ts
                              # BitmapData's natives and filters fed odd numbers longer, or from
                              # another seed, than pnpm test's 2000 steps from 1; a failure names
                              # the two to reproduce it, SWF2ES_FUZZ_LOG=1 prints each step
node tests/player/leak.ts [--loads N] [--snapshots DIR]   # load SWFs over and over in Chrome; the
                              # heap after a full collection must stay bounded, and codegen's
                              # memory must not grow (part of pnpm test)
node packages/cli/dist/main.js compile file.swf [-o dir] [--lib x.abc ...] [--emit-libraries]   # AOT:
                              # the player's modules for the SWF, their logs and a manifest (libraries
                              # from tests/player/out/libraries/ by default; `compile` may be left out)
node packages/cli/dist/main.js run file.abc [more.abc ...] [--lib x.abc ...]   # avmshell in node: the
                              # ABCs after builtin and shell_toplevel (oracle/avmplus/generated/ by
                              # default), their output on stdout, avmshell's exit status
node packages/cli/dist/main.js help [command]   # the commands, or one's options
node tests/player/module-cache.ts   # the IndexedDB module cache in Chrome (part of pnpm test)
node tests/player/precompiled.ts    # AOT modules played in Chrome, imported under a policy
                              # without 'unsafe-eval' too (part of pnpm test)
node tests/player/resize.ts         # filters inside filters drawn while the renderer is resized
                              # in Chrome (part of pnpm test)
node tests/player/context-loss.ts   # a WebGL context lost and given back mid-play draws the same
                              # in Chrome (part of pnpm test)
node tests/web/run.ts               # @swf2es/web's element, replaceFlash and ExternalInterface in
                              # Chrome (part of pnpm test)
pnpm --filter @swf2es/desktop fetch-electron   # Electron's binary, once; pnpm install skips it
pnpm --filter @swf2es/desktop start [--trace] [file.swf]   # the desktop app (apps/desktop);
                              # --trace prints the SWF's trace() to the terminal
pnpm --filter @swf2es/site build   # the demo site (apps/site) into apps/site/dist/site/, as
                              # GitHub Pages serves it (after pnpm build; ASC in the oracle's image)
node tests/site/run.ts [--serve]   # the built site in Chrome under /swf2es/, or served to look at
                              # (part of pnpm test)
node tests/desktop/smoke.ts         # the desktop app in headless Electron: plays, draws, loads, a
                              # socket, a drop (part of pnpm test; skipped without Electron's binary)
node tests/player/bench.ts [--shapes N] [--frames N] [--gpu]   # time the player on a busy synthetic
                              # timeline in Chrome; keep a change only for a gain that repeats;
                              # --write-swf FILE writes its SWF for another player instead
node tools/abc-surface/main.ts file.abc [--classes | --json]   # an ABC's classes, traits and
                              # signatures; how many methods are native and how many AS3
node tools/abc-surface/as3.ts lib.abc out-dir [package...] [--names dir]   # AS3 skeletons of
                              # an ABC's public API, parameter names from sources such as Ruffle's
pnpm as3                      # the AS3 libraries under as3/, compiled by ASC 1 in the oracle's
                              # image: as3:playerglobal, the player's playerglobal held to Flash
                              # Player's API and into playerglobal-library.ts; as3:air, the AIR
                              # library into air-library.ts
pnpm as3:format               # format them with Apache Royale's asformat, in its default style
                              # (ASFORMAT names its script if it is not on the PATH)
SWF2ES_PLAYERGLOBAL=adobe ... # the unit, player, web and corpus tests on Flash Player's
                              # playerglobal in place of the player's own (tests/player/libraries.ts)
node tools/pixijs.ts [--force]   # build vendor/pixijs's lib/ and the bundles swf2es loads (pnpm
                              # build's first step; skipped while the fork is unchanged)
pnpm bench [file.abc...]      # time the ABC parser and decoder
node tests/bench/untyped/run.ts [<dir A> <dir B>] [runs]   # untyped property access through the
                              # runtime's lookup, output vs avmshell; two ab.ts snapshots interleaved
node tests/bench/native-collections/run.ts [<dir A> <dir B>] [runs]   # the natives that walk Arrays
                              # and Vectors (map, filter, sort, conversion), as the one above
```

Run `pnpm check`, `pnpm build`, `pnpm typecheck` and `pnpm test` before
calling a change done; CI runs the same steps.

## Rules that must hold

- **Codegen is pure.** No DOM or node APIs, no clock, no randomness, and a
  method's output never depends on what was compiled before it.
  `codegen.wasm` may import only `env.abort`; a unit test enforces this.
- **Package boundaries.** `compress` depends on nothing, `format` on `compress`, `codegen` and
  `runtime` on `format`, `mp3` on nothing, `cli` on `format`, `codegen` and
  `runtime`, `player` on those and `mp3`, `player-hosts` on `player`, `web` on
  `codegen`, `format`, `player` and `player-hosts`. `codegen` never imports the runtime implementation.
  `compress`, `format`, `codegen` and `runtime` load no DOM or node types. Apps
  (`apps/*`) may use any package; no package may use an app.
  `tests/unit/boundaries.test.ts` checks this; change the table there only
  together with docs/architecture.md.
- **The Tamarin baseline is avmshell's behaviour**, failures included:
  swf2es must reproduce what avmshell prints, not what a test expects.
  Update `tests/tamarin/baseline.json` only when the oracle or the harness
  changes, never to make swf2es pass. `tests/player/corpus/baseline.json`
  is the player's own standing on Ruffle's corpus, failures included:
  a change may not lower a test's standing, and one that raises it
  updates the baseline with `--update-baseline`.
- **avmshell is the reference.** For AS3 semantics, the expected result is
  what avmshell prints, not what JavaScript or the spec suggests. Add a case
  under `tests/conformance/cases/` for any semantic you implement.
- **Never edit `oracle/avmplus`.** It is a submodule (MPL-2.0). Patches go to
  the swf2es/avmplus fork. Code translated from avmplus stays in files of
  its own that carry the MPL-2.0 header; nothing from avmplus goes into an
  Apache-2.0 file, so the MPL's file-level copyleft never reaches the rest.
- **Only redistributable SWFs** go into the repository.
- **PixiJS is the fork in `vendor/pixijs`**, pinned to its `swf2es` branch
  (its `SWF2ES.md` has the plan). Change Pixi there, in commits of its own
  on `swf2es`, which is never rebased, then move the submodule. The
  fork's commits carry no attribution trailers either.

## Code style

- TypeScript everywhere, including tests and scripts (`.ts`, not `.mjs`).
  Files node runs directly must use erasable syntax only: no enums,
  namespaces or parameter properties; `import type` for types; `.ts`
  extensions on relative imports.
- Biome formats and lints (2 spaces, double quotes, semicolons, 100
  columns). Braces are required on every `if`, `else` and loop.
- A chain of `if`/`else if` that only compares one value with constants is
  a `switch` (cases that share a body stack their labels); keep `if`s where
  any branch tests something else.
- Separate logical steps inside a function with a blank line (after guard
  clauses, around loops, before the final `return`). Biome cannot enforce
  this, so keep it by hand.
- Comments explain why, not what. Keep them short, and leave out comments
  that only restate a name, a type or the obvious.
- Prefer no new dependencies; ask before adding one.

### AssemblyScript (`packages/codegen/assembly`)

- Group files by bytecode, then by compiler stage (`avm2/abc/`, `avm2/link/`,
  `avm2/ir/`, `avm2/emit/`), not by kind: no `utils/`. A helper lives next to
  its only user; what AVM1 and AVM2 come to share lives beside `avm2/`.
- Keep any object read through a raw pointer (`changetype<usize>`, `load`)
  referenced from a live variable, field or global; otherwise the collector
  may free it mid-read.
- The dialect is stricter than TypeScript: no `import type`, and `@inline`
  only on class members (Binaryen inlines small functions at `-O3` anyway).
  Biome's import-type fix is off for this folder for that reason.
- Import the opcodes and the ABC constants as namespaces, `import * as ops
  from "./opcodes"` and `import * as C from "./constants"`, and write
  `ops.OP_add` and `C.kCorruptABCError`: the constants still inline, and
  the files that use them need no import list. Other names, such as the
  traits module's classes, are imported by name.
- Mark classes `@final` unless they are meant to be extended, so calls on
  them never need virtual dispatch.
- The runtime is `minimal`: garbage is collected only between calls from
  JS, never during one. Nothing allocated in a call is freed before it
  returns, so build large results from a list joined once, not with `+=`
  in a loop, and reuse scratch buffers across iterations.
- Release builds leave every array access unchecked (`uncheckedBehavior:
  "always"`), so do not write `unchecked()`. An index that comes from the
  input needs an explicit comparison that rejects it with avmplus' error;
  any other index must be in range by construction, which `pnpm
  test:checked` checks on every access.
- Errors are sticky flags or VerifyError numbers, never `throw`: an abort
  kills the wasm instance, and the JIT must survive a malformed SWF.
- Use avmplus' error numbers (`assembly/avm2/abc/constants.ts`) so rejections match
  avmshell.

## Git

- Work on `dev`; `main` receives merges from `dev`.
- One logical change per commit, with a message that explains why.
- No `Co-Authored-By` or other attribution trailers in commit messages.
