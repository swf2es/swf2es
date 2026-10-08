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

## Libraries you provide

A SWF's ActionScript 3 links against `builtin.abc` (avmplus' standard
library, MPL-2.0) and `playerglobal.abc` (Adobe's `flash.*` declarations).
playerglobal is not redistributable, so swf2es does not ship it: you
supply both files. The repository's tests take builtin.abc from the
avmplus submodule (`oracle/avmplus/generated/`) and playerglobal.abc from
the oracle's container image, into `tests/player/out/libraries/`
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
    libraries: { builtin: "/flash/builtin.abc", playerglobal: "/flash/playerglobal.abc" },
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

### Replace the Flash tags on an existing page

```js
import { configure, watchFlash } from "@swf2es/web";

configure({ libraries: { builtin: "/flash/builtin.abc", playerglobal: "/flash/playerglobal.abc" } });
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

The player reads them as a module cache. Chain an IndexedDB cache behind
it to keep whatever the command did not compile:

```js
import { createCodegen } from "@swf2es/codegen";
import { Player, Scripting } from "@swf2es/player";
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
await scripting.loadLibraries([await bytes("/flash/builtin.abc"), await bytes("/flash/playerglobal.abc")]);
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
import { Player, Scripting } from "@swf2es/player";

const wasm = await readFile(new URL(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
const scripting = new Scripting(await createCodegen(await WebAssembly.compile(wasm)), {
  print: (line) => console.log(line), // trace()
  realTime: null, // getTimer() follows the frames, so every run prints the same
});
await scripting.loadLibraries([await readFile("builtin.abc"), await readFile("playerglobal.abc")]);

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
`nodeSocketHost()` (`@swf2es/player-hosts/node`) connects directly.

## Packages

```
packages/
  format/        SWF container and tag parsers (a DoABC's bytes; codegen parses the ABC)
  codegen/       bytecode → ES modules, in AssemblyScript (codegen.wasm), for JIT and AOT
  runtime/       the AS3 language runtime
  player/        display list, timeline, playerglobal, PixiJS renderer
  player-hosts/  optional hosts: Node TCP, WebSocket relay, IndexedDB and precompiled module caches
  web/           <swf2es-player>, replaceFlash and ExternalInterface for any page
  cli/           the swf2es ahead-of-time compiler
oracle/          avmshell and Flash (adl) references
tests/           unit, conformance, player, web and fuzz tests
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
the top.
