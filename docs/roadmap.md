# Roadmap

Where swf2es stands, and the work queued after it, in order. What is
built is described in [architecture.md](architecture.md); how much of
AS3 and Flash's behaviour it matches, in [coverage.md](coverage.md).

## Where it stands

- **The compiler** (`codegen`, AssemblyScript to `codegen.wasm`) parses,
  links and verifies ABCs with avmplus' VerifyErrors, and compiles them
  to ES modules, structured where the control flow allows, the same in
  the browser as ahead of time. It compiles AVM1 action blocks to
  modules too. Each method compiled alone is its entry in its module,
  which `pnpm determinism` checks.
- **The runtime** runs AS3 as avmshell does on 98.6% of the Tamarin
  acceptance tests it compares, E4X included, and AVM1 by SWF version.
- **The player** plays AS3 and AVM1 SWFs: the display list and
  timelines, its own playerglobal, text, bitmaps and filters, sound,
  loading and security, input, workers, Stage3D as an experimental
  option, and AIR's WebSocket client. It passes 1,380 of the 1,984
  tests of Ruffle's corpus it runs.
- **The renderer** is its own ([renderer.md](renderer.md)), with
  fills, lines and BitmapData's CPU kernels in one Zig module.
- **The embeddings:** the `<swf2es-player>` element and
  `replaceFlash` (`@swf2es/web`), the desktop app (Electron), and the
  demo site on GitHub Pages.

## Next

1. **The site in Astro and Starlight.** The demo site becomes an Astro
   site with Starlight's documentation, daisyUI where it needs
   components and no React, the user documentation taken from
   [guide.md](guide.md), and the player as it is today on a page of its own.
2. **The internal docs brought up to date,** and `architecture.md`
   split by topic.
3. **Pixel Bender.** `Shader` and `ShaderData` from a PBJ's bytecode,
   its parameters and inputs as Flash reports them; a compiler from PBJ
   to GLSL; shader fills (`beginShaderFill`, `lineShaderStyle`); then
   `ShaderFilter`, `blendShader` and `ShaderJob`. Ruffle's corpus has 27
   tests that stop at a `Shader` native.
4. **The compiler's large files split,** move-only, as the renderer's
   backend, the scene view and the AVM2 runtime were.

## Parked

Each waits for a profile, a case or a user that asks for it:

- **Geometry buffers owned by wasm,** so that the native module writes
  vertices where the renderer reads them; only if profiles ask.
- **A filtered layer's edges:** at 4 or 8 samples, its edge samples
  differ from the stage's, which `tests/player/filter-coverage.ts`
  allows a quarter of a pixel's coverage for.
- **A mask before a filter:** adl masks an object's content before its
  filters, so a glow surrounds the masked shape; the renderer filters and
  then clips.
- **Touch gestures:** `supportsGestureEvents` is false, so gesture mode
  leaves touches to the mouse.
- **NetStream and video:** H.264 through WebCodecs first, the older
  codecs as small wasm modules later.
- **The compiler's measured candidates,** after its baseline of
  benchmarks.md's steps 12 to 15: verification's IR kept from the first
  walk, where its second pass is 34% of as3pb's verification and 52% of
  initializerLargeVector's; copy forwarding over only the registers
  that hold copies; and the rest of AMF3 decoding (457 ms on as3pb
  against avmshell's 317), mostly as3pb's own constructors.
- **Domain memory against PepperFlash:** 148 ms on as3pb against its 83
  ([benchmarks.md](benchmarks.md#finddef-at-the-site)).
- **A second Tamarin run with ASC 1.0** from the Flex SDK.

## Done

Milestone 1, the as3pb benchmark compiled by swf2es matching avmshell's
output and faster than AwayFL's JIT, was met at #23
([architecture.md](architecture.md#milestone-1)). Since then, in rough
order:

- the Tamarin suite through the oracle and in swf2es, each with its
  baseline ([coverage.md](coverage.md));
- the structural and typed verifier, its IR, and faster decoding and
  verification ([benchmarks.md](benchmarks.md));
- the dispatcher emitter, then structured control flow, source maps and
  the runtime's hot paths; type references that do not depend on the
  order methods compile in, and lazy compilation;
- JSON through the host's own, faster AMF3, unrolled loops, inline
  caches for untyped property access;
- the player: display list, timeline, playerglobal of its own (AS3 of
  Ruffle's and skeletons, no Adobe bodies), text, bitmaps, filters,
  sound, loading, input, ExternalInterface, globalization, touch, AIR's
  WebSocket;
- workers, slices 1 to 6 ([workers.md](workers.md));
- AVM1, steps 1 to 15 ([avm1.md](avm1.md#the-plan));
- modules compiled ahead of time and cached in IndexedDB, and pages
  without `'unsafe-eval'`;
- the web element, the desktop app and the demo site;
- Stage3D, as an experimental option;
- zlib, LZMA, MP3 and libtess2 in wasm, built by one pinned Zig, then
  lines and BitmapData's kernels in Zig too, with no JavaScript paths
  left;
- the renderer of swf2es's own, replacing Pixi (#650, #651);
- CI's tests in parallel jobs (#652).
