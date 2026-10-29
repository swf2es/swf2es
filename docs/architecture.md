# Architecture

swf2es plays SWF files in the browser and compiles their bytecode to
JavaScript, with one compiler that runs both as the player's JIT and
ahead of time. How it works is in the files of `docs/architecture/`, a
topic each:

- [Overview](architecture/overview.md): the compiler's API, the JIT/AOT
  invariant, the packages and their boundaries, and milestone 1.
- [The compiler](architecture/compiler.md): parsing, linking and
  verifying ABCs; compiling a method, the generated code, the object
  model, modules and the bootstrap, lazy compilation.
- [The runtime and the standard library](architecture/runtime.md):
  application domains, describeType, avmplus' corners, the builtins,
  ABCs run as avmshell runs them.
- [Compiling ahead of time and caching modules](architecture/modules.md):
  the `swf2es` command, the module cache, precompiled modules in the
  player, pages without `'unsafe-eval'`.
- [The player](architecture/player.md): its source layout, scripts and
  the display list, the frame, errors, a timeline's places, orphans, a
  SWF's code.
- [Loading SWFs and images](architecture/loading.md).
- [Time and input](architecture/input.md): time, the pointer, touch, the
  keyboard and focus, context menus, the clipboard.
- [The host's services](architecture/services.md): ExternalInterface,
  AIR's WebSocket, screen capabilities, globalization, file dialogs,
  what a browser player lacks, workers, shutting down.
- [Rendering and geometry](architecture/rendering.md): what the view
  works out from Flash's shapes and lines, drawing with Graphics, bounds
  and hit tests, scale and rotation, 3D display objects, nine-slice
  scaling.
- [Bitmaps](architecture/bitmaps.md): BitmapData, drawing into a bitmap,
  bitmaps on the GPU, a SWF's bitmaps, bitmap and gradient fills, PNG.
- [Text](architecture/text.md).
- [Colour, blends, filters and masks](architecture/compositing.md):
  colour transforms, blend modes, filters and the native CPU filters,
  masks and scroll rectangles.
- [Sound](architecture/sound.md): sound state, timeline sounds.
- [The web embedding](architecture/web.md): showing a player, the page's
  configuration, workers and ExternalInterface in the page, replacing
  Flash tags.
- [The desktop app](architecture/desktop.md): its page, sandbox,
  network, files, settings and sockets.
- [The demo site](architecture/site.md): the player and the guide on
  GitHub Pages, built by Astro and Starlight.
- [Testing against oracles](architecture/testing.md): avmshell, Flash as
  adl runs it, Ruffle's corpus, fuzzing the compiler.

Elsewhere in `docs/`: [the renderer](renderer.md), [AVM1](avm1.md),
[workers](workers.md), [coverage](coverage.md),
[benchmarks](benchmarks.md), [references](references.md), the
[roadmap](roadmap.md), and the [user's guide](guide.md).
