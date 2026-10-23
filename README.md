<img src="apps/site/static/icon.svg" alt="" width="96" height="96" align="right">

# swf2es

swf2es plays SWF files in the browser and compiles their ActionScript 3
bytecode to JavaScript. A single compiler, written in AssemblyScript and
shipped as `codegen.wasm`, runs in two places: in the page as a SWF loads
(JIT), and in node ahead of time (AOT). Both write the same modules, byte
for byte, so the output of either can stand in for the other.

**Status:** ActionScript 3 (AVM2) runs as avmshell runs it, and 97.9% of
Tamarin's acceptance tests match it ([coverage](docs/coverage.md)). The
player covers the display list and timeline, shapes, morphs, text, bitmaps,
filters, blend modes, sound, input, loading, sockets and ExternalInterface,
each checked against Flash under AIR's `adl`. AVM1 (ActionScript 1 and 2)
does not run yet: an AVM1 SWF plays its timeline with no actions. Video,
Stage3D and the clipboard are not there either.
[docs/architecture.md](docs/architecture.md) describes how it all works.

**Try it** at https://swf2es.github.io/swf2es/: open or drop a SWF (it is
read in your browser, never uploaded), or play a demo. The site is
`apps/site`, built from `main`.

## Libraries

A SWF's ActionScript 3 links against `builtin.abc` (avmplus' standard
library, MPL-2.0) and a playerglobal (the `flash.*` classes). swf2es ships
its own playerglobal, `playerglobalLibrary` in `@swf2es/player`: Flash
Player's API, compiled from `as3/playerglobal` (Ruffle's AS3 and the
player's own, see [as3/README.md](as3/README.md)). You supply
`builtin.abc`; the repository's tests take it from the avmplus submodule
(`oracle/avmplus/generated/`) into `tests/player/out/libraries/`
(`tests/player/libraries.ts`).

## Examples

### Embed a SWF in a page

`@swf2es/web` defines `<swf2es-player>` when it loads. It takes the same
main attributes as an `<embed>`. The page calls `configure()` once, before the
first player loads:

```html
<swf2es-player id="movie" src="movie.swf" width="800" height="600"
  flashvars="lang=en" scale="showAll" allowscriptaccess="sameDomain">
</swf2es-player>

<script type="module">
  import { configure } from "@swf2es/web";

  configure({
    libraries: { builtin: "/flash/builtin.abc" },
    cache: true, // keep compiled modules in IndexedDB for the next visit
  });

  const movie = document.getElementById("movie");
  movie.addEventListener("error", (e) => console.error(e.detail.error));
  await movie.ready; // resolves once the SWF plays
</script>
```

The packages are ES modules, so serve them with a bundler or an import map
for `@swf2es/*` and `pixi.js` (`tests/player/serve.ts` has one). The
element also takes `salign`, `wmode`, `bgcolor`, `base`, `quality` and
`allownetworking`. It has `load(url | bytes)` and `destroy()`, which gives
back its GL context, audio and sockets. It fires `load`, `error` and
`fscommand` events.

ActionScript's workers (`flash.system.Worker`) run on Web Workers by
default, as in Flash. `configure({ workers: false })` turns them off for
the page, and `workers="false"` or `"true"` on an element for its own
SWFs. Under an import map, map `@swf2es/player-hosts/workers` too, or
SWFs play without workers (the console says why). The
workers load `@swf2es/player-hosts`' `dist/thread/`, which needs no import
map, from wherever the package is served (a CDN's needs CORS, and a
Content-Security-Policy that allows `blob:` workers);
`configure({ workerUrl })` names another script, such as a bundler's.
Sharing memory between workers (a shareable ByteArray, Mutex, Condition)
needs a cross-origin isolated page: serve it with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`. Elsewhere workers only
pass messages, and sharing throws an error that says so
([docs/workers.md](docs/workers.md)).

### Replace the Flash tags on an existing page

```js
import { configure, watchFlash } from "@swf2es/web";

configure({ libraries: { builtin: "/flash/builtin.abc" } });
// Each Flash <object>/<embed> becomes a <swf2es-player> with its params, now and as the
// page adds more, until stop(). replaceFlash() does it once, for the tags there now.
const stop = watchFlash();
```

### ExternalInterface

When a SWF calls `ExternalInterface.addCallback`, the callback becomes a
method of the element. When it calls `ExternalInterface.call`, the call
runs in the page as it did under Flash's plug-in. `allowscriptaccess`
decides whether a SWF may do either:

```js
// The SWF: ExternalInterface.addCallback("setScore", setScore);
//          ExternalInterface.call("onLevelDone", 3, { stars: 2 });
window.onLevelDone = (level, result) => console.log(level, result.stars);

const movie = document.querySelector("swf2es-player");
await movie.ready;
movie.setScore(120); // arrays and objects go both ways; the call is synchronous
```

The page's calls into the SWF need no `eval`. Any SWF that runs can reach
the page through another's code, so on a page that mixes trusted and
untrusted SWFs, do not give script access to any of them
([why](docs/architecture.md#externalinterface)).

### Compile ahead of time

The `swf2es` command (`packages/cli`) writes the same modules the player
would compile, a log for each, and a `manifest.json` of their keys:

```sh
node packages/cli/dist/main.js movie.swf -o movie.swf2es \
  --lib builtin.abc --lib playerglobal.abc --emit-libraries
```

with the playerglobal the player loads: its own, which the repository's
tests write to `tests/player/out/libraries/playerglobal-swf2es.abc`, and the command takes
by default there.

The player reads them as a module cache. Chain an IndexedDB cache behind
it to keep whatever the command did not compile:

```js
import { createCodegen } from "@swf2es/codegen";
import { Player, playerglobalLibrary, Scripting } from "@swf2es/player";
import { indexedDbModuleCache } from "@swf2es/player-hosts/indexeddb";
import { chainCaches, precompiledModules } from "@swf2es/player-hosts/precompiled";

const bytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const codegen = await createCodegen(await WebAssembly.compileStreaming(fetch("/codegen.wasm")));
const scripting = new Scripting(codegen, {
  url: new URL("movie.swf", location.href).href,
  moduleCache: chainCaches(
    precompiledModules("/movie.swf2es/manifest.json", { importModules: true }),
    indexedDbModuleCache(),
  ),
});
await scripting.loadLibraries([await bytes("/flash/builtin.abc"), playerglobalLibrary]);
const player = new Player(await bytes("movie.swf"), scripting);
await player.start(); // nothing compiled: every module came from movie.swf2es
```

A module the command wrote is found only for the SWF in the position it
was compiled for: loaded after the same libraries into a domain that sees
nothing else, as the main movie or by a `Loader` into
`new ApplicationDomain(null)`. Other modules compile as usual. If `importModules` is on and the libraries were
compiled with `--emit-libraries`, every module is imported rather than
evaluated, so the page runs under `script-src 'self' 'wasm-unsafe-eval'`,
without `'unsafe-eval'`. Pixi then needs `import "pixi.js/unsafe-eval"`.
To draw the player, see `PixiView` (`packages/player/src/render/view.ts`)
and how the element uses it (`packages/web/src/playback.ts`).

### Run a SWF headless in node

```ts
import { readFile } from "node:fs/promises";
import { createCodegen } from "@swf2es/codegen";
import { Player, playerglobalLibrary, Scripting } from "@swf2es/player";

const wasm = await readFile(new URL(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
const scripting = new Scripting(await createCodegen(await WebAssembly.compile(wasm)), {
  print: (line) => console.log(line), // trace()
  realTime: null, // getTimer() follows the frames, so every run prints the same
});
await scripting.loadLibraries([await readFile("builtin.abc"), playerglobalLibrary]);

const player = new Player(await readFile("movie.swf"), scripting);
await player.start(); // the document class and the first frame
for (let frame = 2; frame <= 10; frame++) {
  await scripting.settled(); // loads asked for in the last frame arrive
  player.tick();
}
player.destroy();
```

Without a renderer, nothing is drawn, and `BitmapData.draw` of a display
object is not supported. The display list, scripts, timers, loads and
sockets all run.

### Play a SWF on the desktop

`apps/desktop` is an Electron app that plays local SWFs in a window,
the `<swf2es-player>` element inside. Each SWF plays in the sandbox Flash
Player gave a local SWF, by its UseNetwork bit: it reads the files beside
it and reaches no network, or reaches the network, and sockets you allow,
and reads no local file. Electron's binary is fetched once, apart from
`pnpm install`:

```sh
pnpm build
pnpm --filter @swf2es/desktop fetch-electron
pnpm --filter @swf2es/desktop start movie.swf   # or File › Open, or drop a SWF on the window
```

In a checkout the app takes builtin.abc from the avmplus submodule and
plays on its own playerglobal; elsewhere the first ActionScript 3 SWF asks
for builtin.abc, and the app remembers where it is. [apps/desktop/README.md](apps/desktop/README.md) has the rest.

### Sockets

A browser cannot open TCP connections. Each `flash.net.Socket` goes
instead through a WebSocket relay that you run, for example
[websockify](https://github.com/novnc/websockify), which carries binary
frames to the server:

```js
configure({
  socketProxy: [{ host: "server.example", port: 9000, proxyUrl: "wss://relay.example/9000" }],
  // or a function: (host, port) => `wss://relay.example/${host}/${port}`, null to refuse
});
```

A player you set up yourself takes `socket:` from
`webSocketSocketHost(urlFor)` (`@swf2es/player-hosts/websocket`). In node,
`nodeSocketHost()` (`@swf2es/player-hosts/node`) connects directly, and
so does the desktop app, through its main process; an embedder with a
transport of its own gives it as `configure({ sockets })`.

FileReference and FileReferenceList use the browser's file chooser. Saving
uses the File System Access picker where available, or a Blob download;
uploads and downloads use the player's host fetch. A custom embedder can
supply `configure({ fileHost })` (`FileHost` from `@swf2es/player`), or set
`fileHost: null` to make dialogs cancel. The desktop app supplies native
dialogs. Browser dialogs require a recent user click or keypress.

## Packages

```
packages/
  compress/      zlib and LZMA, synchronous, in one WebAssembly module (zlib, the LZMA SDK)
  format/        SWF container and tag parsers (a DoABC's bytes; codegen parses the ABC)
  codegen/       bytecode → ES modules, in AssemblyScript (codegen.wasm), for JIT and AOT
  runtime/       the AS3 language runtime
  player/        display list, timeline, playerglobal, PixiJS renderer
  player-hosts/  optional hosts: Node TCP, WebSocket relay, IndexedDB and precompiled module caches
  web/           <swf2es-player>, replaceFlash and ExternalInterface for any page
  cli/           the swf2es ahead-of-time compiler
apps/
  desktop/       the desktop app: an Electron shell around <swf2es-player>
  site/          the demo site on GitHub Pages: <swf2es-player> on a static page
vendor/
  pixijs/        the swf2es fork of PixiJS (MIT), a submodule built by pnpm build
  zlib/          zlib 1.3.2 (swf2es's fork), a submodule compiled into packages/compress
  lzma-sdk/      the LZMA SDK 26.05 (public domain), a submodule compiled into packages/compress
oracle/          avmshell and Flash (adl) references
tests/           unit, conformance, player, web, desktop and fuzz tests
docs/            architecture, references, coverage, benchmarks, roadmap
```

## Development

```sh
git submodule update --init
pnpm install
pnpm build       # codegen.wasm, then every package
pnpm check       # Biome format and lint (pnpm format fixes)
pnpm typecheck
pnpm test        # needs podman or docker for the avmshell oracle, and Chrome
```

Node 22.18 or later runs the `.ts` tests and scripts directly.
[AGENTS.md](AGENTS.md) lists every command and the rules. It is written
for coding agents, and it applies to people just as well.

## License

Apache-2.0. Files translated from avmplus are MPL-2.0 and say so at
the top. PixiJS, in the `vendor/pixijs` submodule, is MIT, under its own
`LICENSE` there.
