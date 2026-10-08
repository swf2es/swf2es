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
git submodule update --init   # oracle/avmplus (Tamarin tests), tests/programs/as3pb
pnpm install
pnpm build       # asc → codegen.wasm, then tsc -b for all packages
pnpm build:debug # the same with unoptimized wasm, names and source maps
pnpm check       # Biome format + lint; `pnpm format` applies fixes
pnpm typecheck   # tests/ and oracle/ (.ts run directly by node)
pnpm test        # unit, conformance, library, program, fuzz, player and web tests
                 # (needs podman or docker, and Chrome; CHROME names another browser)
pnpm test:checked # the same with every array access bounds-checked
pnpm determinism              # each module the same however it is compiled, and each method
                              # compiled alone its entry in the module (after the runners)
pnpm oracle path/to/file.as   # print avmshell's output for a file (oracle:abcdump its dump)
pnpm oracle:pull              # pull the oracle's pinned container image
pnpm oracle:cases             # the unit tests' hand-built ABCs vs avmshell
pnpm tamarin [prefix...]      # Tamarin acceptance tests vs baseline.json (about 10 minutes
                              # uncached; SWF2ES_ORACLE_JOBS sets parallelism, default 10)
pnpm tamarin --update-baseline [prefix...]   # after an oracle or harness change
pnpm tamarin:swf2es [--update-baseline | --relax] [prefix...]   # the same tests in swf2es, vs
                              # swf2es-baseline.json (after pnpm tamarin compiled them)
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
node tests/fuzz/domains.ts [steps, 3000] [seed, 1]   # drops, evictions, revivals and rebuilds of
                              # application domains change no module against a reference
node tests/player/leak.ts [--loads N] [--snapshots DIR]   # load SWFs over and over in Chrome; the
                              # heap after a full collection must stay bounded, and codegen's
                              # memory must not grow (part of pnpm test)
node packages/cli/dist/main.js file.swf [-o dir] [--lib x.abc ...] [--emit-libraries]   # AOT: the
                              # player's modules for the SWF, their logs and a manifest (libraries
                              # from tests/player/out/libraries/ by default)
node tests/player/module-cache.ts   # the IndexedDB module cache in Chrome (part of pnpm test)
node tests/player/precompiled.ts    # AOT modules played in Chrome, imported under a policy
                              # without 'unsafe-eval' too (part of pnpm test)
node tests/web/run.ts               # @swf2es/web's element, replaceFlash and ExternalInterface in
                              # Chrome (part of pnpm test)
pnpm --filter @swf2es/desktop fetch-electron   # Electron's binary, once; pnpm install skips it
pnpm --filter @swf2es/desktop start [--trace] [file.swf]   # the desktop app (apps/desktop);
                              # --trace prints the SWF's trace() to the terminal
node tests/desktop/smoke.ts         # the desktop app in headless Electron: plays, draws, loads, a
                              # socket, a drop (part of pnpm test; skipped without Electron's binary)
node tests/player/bench.ts [--shapes N] [--frames N] [--gpu]   # time the player on a busy synthetic
                              # timeline in Chrome; keep a change only for a gain that repeats;
                              # --write-swf FILE writes its SWF for another player instead
pnpm bench [file.abc...]      # time the ABC parser and decoder
node tests/bench/untyped/run.ts [<dir A> <dir B>] [runs]   # untyped property access through the
                              # runtime's lookup, output vs avmshell; two ab.ts snapshots interleaved
```

Run `pnpm check`, `pnpm build`, `pnpm typecheck` and `pnpm test` before
calling a change done; CI runs the same steps.

## Rules that must hold

- **Codegen is pure.** No DOM or node APIs, no clock, no randomness, and a
  method's output never depends on what was compiled before it.
  `codegen.wasm` may import only `env.abort`; a unit test enforces this.
- **Package boundaries.** `format` depends on nothing, `codegen` and
  `runtime` on `format`, `cli` on `format` and `codegen`, `player` on `format`,
  `codegen` and `runtime`, `player-hosts` on `player`, `web` on `codegen`, `format`,
  `player` and `player-hosts`. `codegen` never imports the runtime implementation.
  `format`, `codegen` and `runtime` load no DOM or node types. Apps
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
