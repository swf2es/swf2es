# Roadmap

Near-term work, in order. The goal of milestone 1 is in
[architecture.md](architecture.md#milestone-1).

1. **Tamarin acceptance tests through the oracle.** Compile and run
   `oracle/avmplus/test/acceptance` with ASC 2.0 (the compiler stays a
   parameter, so ASC 1.0 from the Flex SDK can be a second run), record a
   baseline of avmshell's results, and parse and decode every compiled ABC.
   A fast subset runs on every push, the full set separately.
2. **Faster decoding**, with a `pnpm bench` script: reuse one decoder's
   scratch buffers across bodies, order instructions by index instead of
   copying, and presize the output (a body has at most one instruction per
   byte). See [benchmarks.md](benchmarks.md).
3. **as3pb in avmshell**: a shell entry point for the as3pb benchmark that
   reports through `trace()`, built with `-compiler.float=false`, as the
   first real program for milestone 1.

Tracked separately: SWF decompression in `format` (issue #3).

## Later

- **A built-in parse mode** that accepts native methods (1079 for user
  code), so `playerglobal.swc` and `airglobal.swc` parse: large real ABCs
  for testing, and the API definitions swf2es needs for playerglobal.

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
