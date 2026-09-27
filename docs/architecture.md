# Architecture

swf2es plays SWF files in the browser and compiles their bytecode to
JavaScript. It has one compiler, which runs at two different times:

- **JIT**: the browser player runs `@swf2es/codegen` when a SWF loads. Each
  method is compiled on its first call, in a worker pool, off the main thread.
- **AOT**: node (or a server) runs the same compiler ahead of time and caches
  the result.

The compiler is written in AssemblyScript and ships as `codegen.wasm`, with
a thin TypeScript wrapper. The one wasm binary runs in browser workers, in
node, and in any server-side wasm runtime (for example wazero in a Go
server), so there is only one implementation to keep correct.

## The JIT/AOT invariant

For the same input, both modes must produce byte-identical output. That
requires:

1. **Compilation is pure.** `format` and `codegen` use no DOM or node APIs, no
   clock and no randomness. Their tsconfigs load no DOM or node types, so the
   build rejects such code, and a unit test fails if `codegen.wasm` imports
   anything besides `env.abort`.
2. **The unit of translation is one method.** A method's output depends only on
   its ABC, never on which other methods were compiled before it.
3. **Both modes use the same facts.** Optimizations use only what the ABC being
   compiled proves (final classes, sealed traits, typed slots). Anything that
   can change at runtime, such as a child SWF redefining a class, gets a
   runtime guard in both modes.
4. **Shared cache key.** Output is keyed by ABC hash plus `COMPILER_VERSION`
   (`cacheKey()` in codegen), so the browser cache, AOT output served by a
   server, and JIT output are interchangeable.

CI compiles every conformance test in both modes and fails if the output
hashes differ.

## Packages

| Package   | Responsibility                                                  | May depend on             |
|-----------|-----------------------------------------------------------------|---------------------------|
| `format`  | SWF container and tags, ABC, AVM1 action records                | —                         |
| `codegen` | bytecode → IR → ES modules, in AssemblyScript (`assembly/`)     | format                    |
| `runtime` | AS3/AS2 language semantics called by generated code             | —                         |
| `player`  | display list, timeline, playerglobal, AVM1 globals, renderers   | format, codegen, runtime  |
| `cli`     | ahead-of-time compiler command                                  | format, codegen           |

`runtime` contains only the language, with no display list, so it runs in node
next to avmshell. `codegen` knows the runtime's function names and signatures
but never imports its implementation. pnpm only links the packages each
`package.json` lists, so the build rejects undeclared imports, and
`tests/unit/boundaries.test.ts` checks the declarations and the tsconfigs.

## Parsing, linking and verifying

avmplus checks an ABC in three places, and swf2es checks it in the same
three, with the same VerifyError numbers:

1. **Parsing** (`codegen/assembly/abc`): everything avmplus rejects while
   parsing that one ABC can decide on its own: counts, pool indices, trait
   kinds and names, class order, a method bound to two owners.
2. **Linking**, when classes are defined: anything that needs classes from
   other ABCs or playerglobal, such as base classes, interfaces, overrides
   and name clashes.
3. **Verifying a method**, when it is first compiled: its signature's types
   and its bytecode.

An ABC with errors in more than one stage may report a different first
error than avmshell. Well-formed ABCs are unaffected.

## Testing against oracles

- **avmshell** (avmplus/Tamarin shell) for AS3 semantics: the output of the
  compiled test must match avmshell's `trace()` output exactly. The Tamarin
  acceptance suite supplies thousands of cases.
- **Flash Player debug projector** for playerglobal behaviour, captured into
  a separate corpus repo. Only redistributable SWFs go there.

## Milestone 1

The as3pb protobuf benchmark (`tests/programs`), compiled by swf2es and run in node:

- its trace output matches avmshell byte for byte;
- it is faster than the AwayFL JIT on the same benchmark (ByteArray 574 ms,
  domain memory 728 ms headless; PepperFlash 188 ms / 83 ms);
- the Tamarin `ecma3/` and `as3/Types/` suites run through the conformance
  runner, with their pass rate tracked.

Out of scope for milestone 1: E4X, `Proxy`, `with`, playerglobal, SWF
timelines.
