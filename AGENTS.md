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
pnpm test        # unit, conformance and program tests (needs podman or docker)
pnpm oracle path/to/file.as   # print avmshell's output for a file
pnpm tamarin [prefix...]      # Tamarin acceptance tests vs baseline.json (about 10 minutes
                              # uncached; SWF2ES_ORACLE_JOBS sets parallelism, default 10)
pnpm tamarin --update-baseline [prefix...]   # after an oracle or harness change
```

Run `pnpm check`, `pnpm build`, `pnpm typecheck` and `pnpm test` before
calling a change done; CI runs the same steps.

## Rules that must hold

- **Codegen is pure.** No DOM or node APIs, no clock, no randomness, and a
  method's output never depends on what was compiled before it.
  `codegen.wasm` may import only `env.abort`; a unit test enforces this.
- **Package boundaries.** `format` and `runtime` depend on nothing, `codegen`
  on `format`, `cli` on `format` and `codegen`, `player` on `format`,
  `codegen` and `runtime`. `codegen` never imports the runtime implementation.
  `format`, `codegen` and `runtime` load no DOM or node types.
  `tests/unit/boundaries.test.ts` checks this; change the table there only
  together with docs/architecture.md.
- **The Tamarin baseline is avmshell's behaviour**, failures included:
  swf2es must reproduce what avmshell prints, not what a test expects.
  Update `tests/tamarin/baseline.json` only when the oracle or the harness
  changes, never to make swf2es pass.
- **avmshell is the reference.** For AS3 semantics, the expected result is
  what avmshell prints, not what JavaScript or the spec suggests. Add a case
  under `tests/conformance/cases/` for any semantic you implement.
- **Never edit `oracle/avmplus`.** It is a submodule (MPL-2.0). Patches go to
  the swf2es/avmplus fork, and its source is not copied into the Apache-2.0
  packages.
- **Only redistributable SWFs** go into the repository.

## Code style

- TypeScript everywhere, including tests and scripts (`.ts`, not `.mjs`).
  Files node runs directly must use erasable syntax only: no enums,
  namespaces or parameter properties; `import type` for types; `.ts`
  extensions on relative imports.
- Biome formats and lints (2 spaces, double quotes, semicolons, 100
  columns). Braces are required on every `if`, `else` and loop.
- Separate logical steps inside a function with a blank line (after guard
  clauses, around loops, before the final `return`). Biome cannot enforce
  this, so keep it by hand.
- Comments explain why, not what. Keep them short, and leave out comments
  that only restate a name, a type or the obvious.
- Prefer no new dependencies; ask before adding one.

### AssemblyScript (`packages/codegen/assembly`)

- Group files by compiler stage (`abc/`, later `ir/`, `emit/`), not by kind:
  no `utils/`. A helper lives next to its only user.
- Keep any object read through a raw pointer (`changetype<usize>`, `load`)
  referenced from a live variable, field or global; otherwise the collector
  may free it mid-read.
- The dialect is stricter than TypeScript: no `import type`, and `@inline`
  only on class members (Binaryen inlines small functions at `-O3` anyway).
  Biome's import-type fix is off for this folder for that reason.
- Mark classes `@final` unless they are meant to be extended, so calls on
  them never need virtual dispatch.
- Errors are sticky flags or VerifyError numbers, never `throw`: an abort
  kills the wasm instance, and the JIT must survive a malformed SWF.
- Use avmplus' error numbers (`assembly/abc/constants.ts`) so rejections match
  avmshell.

## Git

- Work on `dev`; `main` receives merges from `dev`.
- One logical change per commit, with a message that explains why.
- No `Co-Authored-By` or other attribution trailers in commit messages.
