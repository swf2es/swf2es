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
git submodule update --init   # oracle/avmplus (Tamarin tests)
pnpm install
pnpm build       # asc → codegen.wasm, then tsc -b for all packages
pnpm check       # Biome format + lint; `pnpm format` applies fixes
pnpm typecheck   # tests/ and oracle/ (.ts run directly by node)
pnpm test        # unit tests + conformance (needs podman or docker)
pnpm oracle path/to/file.as   # print avmshell's output for a file
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

## Git

- Work on `dev`; `main` receives merges from `dev`.
- One logical change per commit, with a message that explains why.
- No `Co-Authored-By` or other attribution trailers in commit messages.
