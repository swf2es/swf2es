<img src="apps/site/static/icon.svg" alt="" width="96" height="96" align="right">

# swf2es

swf2es plays SWF files in the browser. It compiles their ActionScript,
AS3 and AS1/2 alike, to JavaScript, so the browser's own JIT runs it, and
draws them with a WebGL 2 renderer of its own. Fills, lines and BitmapData
filters are computed in WebAssembly (Zig).

**Try it** at https://swf2es.github.io/swf2es/: open or drop a SWF (it is
read in your browser, never uploaded), or play a demo. For Stage3D SWFs,
tick **Stage3D (experimental)** first.

**Status:**
- **ActionScript 3** runs as avmshell runs it: 97.9% of Tamarin's
  acceptance tests match it ([coverage](docs/coverage.md)).
- **AVM1** (ActionScript 1 and 2) runs, compiled to JavaScript as well.
- **The player** covers the display list and timeline, shapes, morphs,
  text, bitmaps, filters, blend modes, sound, input, loading, sockets,
  workers and ExternalInterface, each checked against Flash under AIR's
  `adl`. Stage3D is an experimental opt-in.
- **Not yet:** video, printing and Pixel Bender shaders. Compatibility is
  incomplete.

## Quick start

`@swf2es/web` defines a `<swf2es-player>` element that takes an
`<embed>`'s attributes:

```html
<swf2es-player id="movie" src="movie.swf" width="800" height="600"
  scale="showAll" allowscriptaccess="sameDomain"></swf2es-player>

<script type="module">
  import { configure } from "@swf2es/web";

  configure({ libraries: { builtin: "/flash/builtin.abc" } });

  const movie = document.getElementById("movie");
  movie.addEventListener("error", (e) => console.error(e.detail.error));
  await movie.ready; // resolves once the SWF plays
</script>
```

You supply `builtin.abc` (avmplus' standard library); swf2es ships its own
playerglobal. The packages are ES modules: serve them through a bundler or
an import map, and let the page compile WebAssembly (SIMD, and
`'wasm-unsafe-eval'` under a CSP).

Or turn an existing page's Flash tags into players:

```js
import { configure, watchFlash } from "@swf2es/web";

configure({ libraries: { builtin: "/flash/builtin.abc" } });
watchFlash(); // each <object>/<embed> becomes a <swf2es-player>, those the page adds later too
```

Compile ahead of time, so the page loads modules instead of compiling them:

```sh
node packages/cli/dist/main.js movie.swf -o movie.swf2es --lib builtin.abc
```

Or run AS3 bytecode as avmshell does, its `trace()` on stdout:

```sh
node packages/cli/dist/main.js run program.abc
```

[docs/guide.md](docs/guide.md) covers the rest: the element's options,
workers, ExternalInterface, precompiled modules, a SWF headless in node, the
desktop app, sockets and files.

## Packages

```
packages/
  native/        WebAssembly: fills, lines and bitmap kernels (Zig), zlib and LZMA, MP3
  format/        SWF container and tag parsers
  codegen/       bytecode → ES modules, in AssemblyScript (codegen.wasm), for JIT and AOT
  runtime/       the AS3 and AVM1 language runtimes
  render/        the renderer: scene list, planner and WebGL 2 backend
  player/        display list, timeline, playerglobal, and the view that drives render/
  player-hosts/  optional hosts: workers, sockets, module caches
  web/           <swf2es-player>, replaceFlash and ExternalInterface for any page
  context3d/     Stage3D's Context3D on WebGL 2
  cli/           the swf2es command: ahead-of-time compiler, avmshell-style runner
apps/
  site/          the demo site on GitHub Pages
  desktop/       an Electron app that plays local SWFs
```

[docs/architecture.md](docs/architecture.md) explains how it works, and
[docs/renderer.md](docs/renderer.md) the renderer.

## Development

```sh
git submodule update --init
pnpm install
pnpm build
pnpm check       # Biome format and lint (pnpm format fixes)
pnpm typecheck
pnpm test        # needs podman or docker for the avmshell oracle, and Chrome
```

Node 22.18 or later runs the `.ts` tests and scripts directly.
[AGENTS.md](AGENTS.md) lists every command and the rules. It is written
for coding agents, and it applies to people just as well.

## License

Apache-2.0. Files translated from avmplus are MPL-2.0 and say so at the
top; the third-party code in `packages/native` is listed in its
`LICENSE.third-party`.
