# Roadmap

Near-term work, in order. The goal of milestone 1 is in
[architecture.md](architecture.md#milestone-1).

1. **Tamarin acceptance tests through the oracle**: done. `pnpm tamarin`
   checks avmshell against `tests/tamarin/baseline.json` and swf2es against
   abcdump; CI runs a subset on every push and the full set nightly. A
   second run with ASC 1.0 from the Flex SDK is still open.
2. **Faster decoding**: done. `pnpm bench` measures it; see
   [benchmarks.md](benchmarks.md).
3. **as3pb in avmshell**: done. `tests/programs` builds as3pb's benchmark
   (the `tests/programs/as3pb` submodule) through the oracle; its
   deterministic output is `tests/programs/expected/as3pb.txt`, the expected
   result for milestone 1, and swf2es parses and decodes its ABC like abcdump.
4. **The verifier**, in three steps (see
   [architecture.md](architecture.md#compiling-a-method)):
   1. Structure: done. Stack, scope and register depths, merges, handler
      entry states and the operand checks that need no types. Every
      Tamarin method body verifies except the one avmshell also rejects,
      and `pnpm tamarin` checks that swf2es reports the VerifyErrors
      avmshell prints.
   2. Value types and scope chains, in three parts:
      - 2a. A domain and linking: classes looked up by qualified name
        across ABCs and linked to their base classes and interfaces with
        avmplus' errors. Builtin ABCs parse in a mode that allows native
        methods and multi-namespace trait names; `tests/libraries` checks
        the image's builtin, shell_toplevel, playerglobal and airglobal
        against abcdump and links them, and every Tamarin ABC links as in
        avmshell.
      - 2b. Traits and types: each class's, script's and activation's
        members laid out as the ABC loads (slot and dispatch ids,
        overrides), and resolved as avmplus resolves a class when it is
        created (slot types and initial values, method signatures, final
        methods, override signatures, implemented interfaces).
      - 2c. The typed verifier: frame states with each value's type, merged
        until they settle; each method's declaring scope, captured where it
        is created; and the checks that need them (1013, getouterscope,
        slots, callstatic's binding, operand types). Declaring scopes need
        the scope stack's types and those types need the declaring scopes,
        so they come together, as in avmplus' Verifier.
   3. The IR, written by the same pass.

Tracked separately: SWF decompression in `format` (issue #3).

## Later

Nothing yet.

## Not planned

- **`float` (ABC 47.16 with float pools).** Only HARMAN's AIR runtime has it
  (AIR 51.x, 32-bit `float` only, AIR-6279); Flash Player never did, and
  neither does Ruffle. swf2es reads every 47.x version with the 46.16
  layout, as Flash Player builds of avmplus do. Supporting AIR content
  would mean the float pools and opcodes, starting from avmplus' open
  `VMCFG_FLOAT` code and its float tests. HARMAN differs from that design in
  places (`typeof` of a float is `"number"`), so the exact semantics would
  need AIR itself as the oracle: `adl` from the AIR SDK, as
  [as3pb-conformance](https://github.com/33TU/as3pb-conformance) uses it.
  AIR allows one instance per application id, so parallel runs need a
  descriptor copy with a unique `<id>` each, and AIR apps cannot use binary
  stdio (as3pb-conformance goes through a loopback TCP shim).
