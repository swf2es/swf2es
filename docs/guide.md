# Using swf2es

How to put swf2es on a page, compile ahead of time, run a SWF in node or
on the desktop, and give it sockets and files. The
[README](../README.md) has the short version; [architecture.md](architecture.md)
how it all works.

## Libraries

A SWF's ActionScript 3 links against `builtin.abc` (avmplus' standard
library, MPL-2.0) and a playerglobal (the `flash.*` classes). swf2es ships
its own playerglobal, `playerglobalLibrary` in `@swf2es/player`: Flash
Player's API, compiled from `as3/playerglobal` (Ruffle's AS3 and the
player's own, see [as3/README.md](../as3/README.md)). You supply
`builtin.abc`; the repository's tests take it from the avmplus submodule
(`oracle/avmplus/generated/`) into `tests/player/out/libraries/`
(`tests/player/libraries.ts`).

## Embed a SWF in a page

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
for `@swf2es/*` (`tests/player/serve.ts` has one), the renderer's
`@swf2es/player/scene`, `@swf2es/render/webgl` and
`@swf2es/context3d/device` among them. The element also takes `salign`,
`wmode`, `bgcolor`, `base`, `quality` and `allownetworking`. It has `load(url | bytes)` and `destroy()`, which gives
back its GL context, audio and sockets. It fires `load`, `error` and
`fscommand` events.

Fills, lines and BitmapData's convolution are computed by
`@swf2es/native/render`'s Wasm module, which the page must let compile:
with WebAssembly SIMD, and under a CSP with `'wasm-unsafe-eval'`. Include
that entry in the import map: the player loads it with itself, so a
page without it has no player. Where it cannot compile, the SWF does not
play, and the element says why.

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
([workers.md](workers.md)).

## Replace the Flash tags on an existing page

```js
import { configure, watchFlash } from "@swf2es/web";

configure({ libraries: { builtin: "/flash/builtin.abc" } });
// Each Flash <object>/<embed> becomes a <swf2es-player> with its params, now and as the
// page adds more, until stop(). replaceFlash() does it once, for the tags there now.
const stop = watchFlash();
```

## ExternalInterface

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
([why](architecture.md#externalinterface)).

## Compile ahead of time

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
without `'unsafe-eval'`.
To draw the player, see `RenderView` (`@swf2es/player/scene`,
`packages/player/src/scene/view.ts`) and how the element uses it
(`packages/web/src/playback.ts`).

## Run a SWF headless in node

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

## Play a SWF on the desktop

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
for builtin.abc, and the app remembers where it is. [apps/desktop/README.md](../apps/desktop/README.md) has the rest.

## Sockets and files

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
