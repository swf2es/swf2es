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
   2. Value types and scope chains: done, in three parts:
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
      - 2c. The typed verifier: done. Frame states with each value's
        type, merged until they settle; each method's declaring scope,
        captured where it is created in a second pass in code order; and
        the checks that need them. Every method of the libraries and as3pb
        verifies, and every Tamarin method that can be created, with the
        VerifyErrors avmshell prints.
   3. The IR: done, written by the verifier's second pass. Every method
      of the libraries, as3pb and Tamarin that verifies gets well formed
      IR, which the test runs check.
6. **A dispatcher emitter and a minimal runtime**: JavaScript from the IR
   with one `switch` over blocks per method, and enough of the runtime to
   run it, so conformance cases run in node and compare with avmshell. In
   progress: every instruction of the libraries lowers, exception handlers
   included, and `tests/conformance` runs each case compiled by swf2es,
   after builtin.abc and shell_toplevel.abc also compiled by swf2es,
   comparing its output with avmshell's. 18 cases pass, from arithmetic,
   control flow and closures to classes, namespaces, Vectors, sorting and
   avmplus' number formatting, and a module loads only after the ABCs it
   was compiled against. Every instruction of Tamarin, the libraries and
   as3pb lowers. Next: ByteArray and domain memory, so as3pb runs, and more
   cases.
7. **Faster generated code**, measured on as3pb against AwayFL and on small
   loops, including loops with bounds known only at run time:
   1. Typed comparisons and branches: plain `<`, `>` and `===` where the
      IR's types are numbers, instead of the runtime's generic ones.
   2. Structured control flow: loops, `if`s and labelled blocks built from
      the dominator tree, as in Ramsey's "Beyond Relooper", with copies of
      stack registers removed. A method whose control flow is irreducible,
      or whose handler ranges do not nest, keeps the dispatcher. It changes
      only how blocks connect, so int wrapping, evaluation order and where
      an exception comes from stay as they are.
   3. Source maps from the ABC's debugline and debugfile, to step through
      the AS3 in DevTools.
5. **Faster verification**: the minimal runtime halved decoding to about
   35 ns per instruction, against Ruffle's 15 for decoding alone
   ([benchmarks.md](benchmarks.md)); the typed verifier still walks every
   block twice. Profile it with the IR in place.

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
