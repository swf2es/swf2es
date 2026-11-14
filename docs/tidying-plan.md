# Tidying plan

A plan for a pass of tidying, to be agreed before anything moves: big
files split into dedicated ones, long ActionScript taken out of TypeScript
tests, the tests' ActionScript formatted, and the documentation brought up
to date. Nothing here changes behaviour. This file is removed by the last
pull request of the pass.

Made on dev at 9cac3702 (0.1.20 is f65ba694) from each file's outline (its top-level
declarations and, for `runtime.ts`, its methods), not from a full reading:
line numbers are where things start, and each split is to be confirmed by
reading the file when its turn comes.

## Rules for every step

- Move, do not rewrite: a split's diff is code leaving one file and
  arriving in another, with imports. No renames of what compiled code
  reaches by name (the emitters under `packages/codegen/assembly` write
  119 of `Runtime`'s members as strings, and natives are bound by name):
  grep the emitters and the native tables before any rename that is still
  wanted, and leave those for a pull request of their own.
- Tests mirror the source: a file split takes its `tests/unit` file with
  it, split the same way.
- Package boundaries stay as `tests/unit/boundaries.test.ts` has them.
- One area a pull request, small enough to review by its moves.
- A split of anything on a hot path (property access, calls, for-in,
  drawing) is measured before and after with the benchmarks that cover
  it, since a method that becomes a call into another module can change
  what the engine inlines: `tests/bench/players.ts` (enumeration,
  dictionary, vector, as3pb, lz4), `tests/bench/typed`, `untyped`, and
  `tests/player/bench.ts`.
- `pnpm check`, `build`, `typecheck`, `test`, and `corpus`; `determinism`
  and `test:checked` where `packages/codegen` is touched.

## 1. Files to split

Largest first. "Leave" means the file is long but one thing.

### `packages/runtime/src/avm2/runtime.ts` (3,843 lines)

One class, `Runtime`, of 228 methods, 302 to 3,840. Its methods fall
into groups that already follow one another in the file:

| Lines | Group | Methods |
|---|---|---|
| 337–650 | names, namespaces, domains, ABCs | `ns`, `name`, `runtimeName`, `childDomain`, `abc`, `claim`, `run` |
| 655–1010 | scripts and scopes | `globalOf`, `initScript`, `findProperty`, `findDef`, `scopeHas`, `withHas` |
| 1009–1150 | traits and builtins | `traitsOf`, `builtinTraits`, `prototypeOf` |
| 1149–2060 | property access | `getProperty`, `setProperty`, `getIndexed`, `getKeyed`, `vectorGet*`, `deleteProperty`, `in`, `hasProperty` |
| 2061–2390 | calls | `callProperty`, `call`, `callInterface`, `callSuper`, `getSuper` |
| 2388–2660 | construction and new objects | `construct*`, `instantiate`, `newObject`, `newArray`, `newFunction`, `newClass`, `applyType` |
| 2662–2990 | classes, types, coercion | `classOf`, `resolve`, `isInstance`, `coerce`, `asType`, `typeOf` |
| 2987–3300 | conversion and operators | `toNumber`, `toString`, `add`, `equals`, `compare` |
| 3304–3465 | for-in | `hasNextIn`, `nextName`, `nextValue` |
| 3466–3580 | errors | `error`, `caught`, `catches`, `describe` |
| 3578–3840 | aliases, domain memory, XML, natives | `registerClassAlias`, `li8`…`sf64`, `getDescendants`, `native`, `callBound` |

A class cannot be spread over files in TypeScript, and compiled code
calls its members by name, so the members stay on `Runtime`. What can
move is each group's body, to a module of functions that take the
runtime, the method left as a line that calls it.

Proposed, coldest first, each its own pull request and each measured:

1. `errors` (`runtime-errors.ts`), `aliases`, XML helpers
   (`runtime-xml.ts`), domain memory (`domain-memory.ts`): cold, about 400
   lines out.
2. names, namespaces and domains (`runtime-names.ts`), scripts and scopes
   (`scopes.ts`): warm, about 650 lines.
3. construction and new objects (`construction.ts`), classes, types and
   coercion (`types.ts`): about 600 lines.
4. Conversion and operators, property access, calls, for-in: **leave in
   `runtime.ts`**. They are the hot paths, tuned against the engine's
   inlining budget this month (for-in's is nearly full), and a delegate
   adds a call to each. Revisit only with a benchmark that shows no cost.

That takes `runtime.ts` to about 2,200 lines, of hot paths alone, which is
the honest floor without rewriting it.

### `packages/context3d/src/webgl/context.ts` (2,414 lines)

One class, `WebGLContext3D`, from line 122: the back buffer and render
targets, buffers, programs, textures, state (blend, depth, stencil,
scissor, culling), draws and readback. `textures.ts`, `programs.ts` and
`targets.ts` beside it already hold parts as functions over the context's
state. Proposed, the same way: `back-buffer.ts` (configure, unconfigure,
present, the storage limit and scaling added by #953 and #955),
`readback.ts` (drawToBitmapData's rows and scaling), `buffers.ts`
(vertex and index buffers), leaving state and draws in the class. Covered
by `tests/context3d`, which compares with AIR, so a move that breaks
anything shows at once.

### `packages/player/src/playerglobal/context3d/context.ts` (956 lines)

One function, `registerContext`, holding the natives class. Three pull
requests landed in it in a week (#953, #955, #960). Proposed: the helpers
it closes over that need nothing of it (`most`, the usage and
program-type checks, the register limits) to `context3d/arguments.ts`,
and the texture-creating natives to join `resources.ts`. Worth doing after
`webgl/context.ts`.

### `apps/desktop/src/main/main.ts` (1,344 lines)

About forty functions in one module: opening movies and AIR applications
(197–530), socket and WebSocket permissions (533–647), dialogs and the
library chooser (648–711, 828–884), the menu (712–793), the window and
its IPC (885–1047), AIR's services (1048–). Proposed: `open.ts`,
`permissions.ts`, `menu.ts`, `dialogs.ts`, `air.ts`, with `main.ts` left as
start-up and `listen`. The functions share module state (`window`,
`current`, `settings`), which goes to a small `state.ts` they import.
Covered by `tests/desktop`.

### `apps/desktop/src/main/network.ts` (1,327 lines)

A class, `Network` (249–1,190), with its types before and helpers after.
Proposed: the types and limits to `network-types.ts`, the helpers that
take no instance (`trustworthy`, `refererFor`, `redirectOf`, `cached`,
`checkPort`) to `network-rules.ts`; the class stays whole, as its methods
share the session and budget. Security-relevant: move-only, and
`tests/desktop/network.test.ts` must pass unchanged.

### `packages/runtime/src/avm2/natives/bytearray.ts` (1,317 lines)

Three things: shared memory between workers (49–118, 646–672), the
`Bytes` class (136–590) and the ByteArray natives (719–1,290). Proposed:
`bytes.ts` (the class and `copyBytes`), `shared-bytes.ts`, and
`bytearray.ts` left with the natives. `Bytes` is imported widely, so
`bytearray.ts` re-exports it until the importers are moved, in the same
pull request.

### `packages/player/src/input/pointer.ts` (1,247 lines)

Hit testing as functions (120–482: `pointerTarget`, `toLocal`,
`missesShape`, `pickBounds`), dragging (483–564) and the `PointerInput`
class (565–). Proposed: `hit-test.ts` and `drag.ts`, the class left.

### `packages/player/src/bitmap/bitmap.ts` (1,135 lines)

Rect helpers (16–108), premultiplying and the pixel runs added by #962
(109–326), the `BitmapStore` class (344–1,019), and colour helpers after.
Proposed: `pixel-runs.ts` (the runs and `packedDoubles`) and
`pixel-math.ts` (`premultiply`, `unmultiply`, rect rounding); the store
stays.

### `packages/runtime/src/avm2/enumeration.ts` (717 lines)

Three pull requests this week. Its sparse-Array half (`dropSparse`,
`takeSparse`, `stepBy`, `startOrGoOn`, `nextSparse`, `retake`, `hashed`,
`indicesOf`, `firstAtOrAfter`) is about 250 lines with state of its own.
Proposed: `sparse-indices.ts`. **Measure first**: #948 found the for-in
step within a few bytes of the engine's inlining budget, and these are
called from it.

### `packages/web/src/element.ts` (1,073 lines)

Attribute parsing and fetching as functions (104–326), then the element
class. Proposed: `attributes.ts` (`cssLength`, `parseColor`,
`parseFlashVars`, `scriptAccess`, `quality`, the workers options) and
`fetching.ts` (`fetchMovie`, `fetchFor`, `browserFetch`).

### Leave

- `packages/player/src/avm1/avm1.ts` (1,678), `scene/view.ts` (1,669),
  `scripting/loads.ts` (1,171), `scripting/workers.ts`,
  `scripting/code.ts`: each one class whose methods share its state. To
  be read for free functions that could leave, not split by force.
- `packages/codegen/assembly/**` (`emit/objects.ts`, `emit/method.ts`,
  `link/domain.ts`, `abc/code.ts`): AssemblyScript, grouped by compiler
  stage as AGENTS.md asks, and anything moved must keep JIT and AOT
  output identical. Not in this pass unless a file is found to hold two
  stages.
- `packages/player/src/avm1/globals/MovieClip.ts`,
  `playerglobal/flash/display/BitmapData.ts`: one class's natives each.
- `packages/render/src/webgl/draws.ts`, `backend.ts`: just changed by
  #945 and #963, and hot; leave to settle.

## 2. ActionScript in TypeScript tests

Counted on dev: about 469 ActionScript snippets inside TypeScript, in 80
test files, beside 488 `.as` files. About 380 are fixed text; about 90
are built from parameters.

- Move to `.as` files: the 9 fixed snippets over 60 lines (the longest:
  `tests/desktop/smoke.ts:114`, 152 lines; `tests/unit/player/input/pointer.test.ts:917`,
  108; `tests/unit/player/scripting/full-screen.test.ts:115`, 102), then
  those of 21 to 60 lines (51) that are a whole class or are used twice.
- Leave: snippets of 20 lines or fewer, which read best beside their
  assertion; anything built from a seed, a table or a parameter; ABCs
  assembled in code.
- A moved script goes next to its test, or to the suite's `scripts/`
  folder where it has one, and the test reads the file.

## 3. `asformat` over the tests' ActionScript

Last, in a pull request of nothing else. Apache Royale's `asformat` in its
default style, as `pnpm as3:format` already applies to `as3/`, over
`tests/**/*.as`, and `as3:format` extended to those folders.

- Every line changes (the tests use two spaces and braces on the line;
  the default is tabs and braces on their own), so it must stand alone.
- Proof that nothing changed: every script compiled before and after and
  its ABC compared with line numbers ignored; then conformance, the
  player cases and `tests/context3d`. Conformance cases use odd syntax on
  purpose (E4X, labels, semicolons), which a formatter may mangle: any
  such file is left out and listed.
- Expectations that name a line number (stack traces, error positions)
  are updated in the same pull request.
- CI has no `asformat`; as for `as3/`, it stays a local step.

## 4. Documentation

- Done in #965: Stage3D no longer called experimental; #966: the README tells of
  the desktop app. Left from this section: the file names after each split.
- (Was:) Stage3D is described as an opt-in experiment in places where it no
  longer is: `packages/context3d/README.md` (its title, and lines about
  the desktop keeping it off by default and the checkbox opting in),
  `docs/roadmap.md` ("Stage3D as an experimental option"). The desktop has
  it on by default (#959) and the standard profiles and AGAL 2 and 3 are
  in (#960). Whether the word "Experimental" stays on the menu is the
  owner's decision; the documents should say what is true either way.
- `docs/architecture/*.md` after each split: the file names they give.
- AGENTS.md's command list, for anything a split renames.

## Order

Each pull request of the pass ticks its row here.


| # | Pull request | Size | Risk |
|---|---|---|---|
| 1 | This plan | 1 file | none |
| 2 | ~~Documentation brought up to date (section 4)~~ done: #965, #966 | small | none |
| 3 | ~~`apps/desktop`: `main.ts`, `network.ts`~~ done: #970 (also `switches.ts`; `air-bridge.ts` for `air.ts`, which exists) | medium | low; desktop tests |
| 4 | ~~`packages/web/src/element.ts`; `input/pointer.ts`~~ done: #971 (also `workers.ts`) | medium | low |
| 5 | `bitmap.ts`; `natives/bytearray.ts` | medium | low to medium; bitmap benches |
| 6 | `context3d`: `webgl/context.ts`, then the player's `context.ts` | medium | low; AIR references |
| 7 | `runtime.ts` steps 1 to 3, a pull request each | large | medium; benchmarks each |
| 8 | `enumeration.ts` | small | medium; measure inlining |
| 9 | ActionScript out of TypeScript tests (section 2) | medium | low |
| 10 | `asformat` (section 3), and this file removed | very large, mechanical | low once the ABCs compare |
