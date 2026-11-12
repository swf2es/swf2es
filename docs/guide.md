# Using swf2es

How to put swf2es on a page, compile ahead of time, run a SWF in node or
on the desktop, and give it sockets and files. The
[README](../README.md) has the short version; [architecture.md](architecture.md)
how it all works.

## Install

```sh
npm install @swf2es/web     # the element, for a page; it brings the rest
npm install -g @swf2es/cli  # the swf2es command, for node
npx @swf2es/desktop         # the desktop app, in Electron
```

The packages are ES modules with no dependencies outside `@swf2es/*`, but
for the desktop app's Electron.
Each package's README says what it is for.

## From a CDN

A page without a bundler loads `swf2es`, the browser build: `@swf2es/web`
and everything it loads, bundled by Rspack into a folder of ES modules
that find one another by relative URL (`packages/swf2es`). One tag
defines the element:

```html
<script type="module" src="https://unpkg.com/swf2es@0.1.15"></script>

<swf2es-player src="movie.swf" width="800" height="600"></swf2es-player>
```

The module exports what `@swf2es/web` does; import it from the same URL
to call `configure` or `watchFlash`, so that the page has one copy.
Players in the markup start as it loads, before such a script runs, so a
page that configures its players adds them from that script. Until
1.0 a minor release may break a page, so pin a version: on unpkg at least
the minor one (`swf2es@0.1` redirects to the newest 0.1 release, whose
files then load together); on jsDelivr the exact one
(`https://cdn.jsdelivr.net/npm/swf2es@0.1.15`), as it serves a range
without redirecting, and the files loaded later would follow the range.
`swf2es.js` defines the element; `codegen.wasm`, the renderer and the
workers' host load with the first player, `worker.js` for a SWF that uses
workers, and Stage3D's code only on a page that configures it.

A page with a Content-Security-Policy allows, in `script-src`, the CDN's
origin, `'wasm-unsafe-eval'` and `'unsafe-eval'`: the player evaluates
the JavaScript it compiles a SWF's ActionScript to, so without
`'unsafe-eval'` only modules compiled ahead of time play
([below](#compile-ahead-of-time)). Flash Workers also need `worker-src`
with the CDN's origin and `blob:` ([Workers](#workers)):

```
script-src 'self' https://unpkg.com 'unsafe-eval' 'wasm-unsafe-eval'; worker-src https://unpkg.com blob:
```

A policy that sets `connect-src` or `default-src` lists the CDN there too,
for `codegen.wasm`. A cross-origin isolated page, which workers sharing
memory need, works with either CDN: both send
`Cross-Origin-Resource-Policy: cross-origin` and CORS headers.

To host it yourself, serve the package's `dist/` folder as it is
(`npm pack swf2es` has it) and load `dist/swf2es.js` from it; serve
`.wasm` as `application/wasm`, and from another origin, with
`Access-Control-Allow-Origin`. In a checkout, `pnpm build` builds the
folder (`packages/swf2es/build.ts`).

## Libraries

A SWF's ActionScript 3 links against `builtin.abc` (avmplus' standard
library, MPL-2.0) and a playerglobal (the `flash.*` classes). swf2es ships
both: `builtinLibrary` in `@swf2es/runtime`, the avmplus submodule's
`oracle/avmplus/generated/builtin.abc` (`tools/avmplus-libraries.ts`
embeds it), and its own playerglobal, `playerglobalLibrary` in
`@swf2es/player`: Flash Player's API, compiled from `as3/playerglobal`
(Ruffle's AS3 and the player's own, see [as3/README.md](../as3/README.md)).
`@swf2es/player` and `@swf2es/player/libraries` export all three
libraries the player loads, `airLibrary` among them, so nothing needs
setting up.

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
`@swf2es/context3d/device` among them.

`configure({ libraries: { builtin, playerglobal } })` takes URLs of
other ABCs to load in place of the shipped ones, each optional: a page
that would rather play on Flash Player's own playerglobal gives its URL.

## The element and its options

The element also takes `salign`, `wmode`, `bgcolor`, `base`, `quality`
and `allownetworking`. It has `load(url | bytes)` and `destroy()`, which
gives back its GL context, audio and sockets. It fires `load`, `error` and
`fscommand` events, and with Stage3D on, `stagelayout` as the SWF starts
and whenever it sets its stage's `scaleMode` or `align` (`event.detail`
holds both): a page may size the element to the SWF's own size while it
asks for `noScale`, as an embedding at that size shows it.

## WebAssembly and CSP

Fills, lines and BitmapData's filters and pixel operations are computed by
`@swf2es/native/render`'s Wasm module, which the page must let compile:
with WebAssembly SIMD, and under a CSP with `'wasm-unsafe-eval'`. Include
that entry in the import map: the player loads it with itself, so a
page without it has no player. Where it cannot compile, the SWF does not
play, and the element says why.

## Workers

ActionScript's workers (`flash.system.Worker`) run on Web Workers by
default, as in Flash. `configure({ workers: false })` turns them off for
the page, and `workers="false"` or `"true"` on an element for its own
SWFs. Under an import map, map `@swf2es/player-hosts/workers` too, or
SWFs play without workers (the console says why). The
workers load `@swf2es/player-hosts`' `dist/thread/`, which needs no import
map, from wherever the package is served (a CDN's needs CORS, and under a
Content-Security-Policy, `worker-src` with the CDN's origin and `blob:`:
the worker starts on a `blob:` module of the page's that imports the
script, and a module worker's imports are held to `worker-src` too);
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
([why](architecture/services.md#externalinterface)).

## Compile ahead of time

The `swf2es` command (`packages/cli`) writes the same modules the player
would compile, a log for each, and a `manifest.json` of their keys:

```sh
swf2es movie.swf -o movie.swf2es --emit-libraries
```

against the libraries the player loads: builtin.abc and swf2es's
playerglobal, and AIR's library too with `--air`, all shipped with the
command. `--lib` names others in their place, in order, such as Flash
Player's playerglobal for a player given that one. In a checkout,
`node packages/cli/dist/main.js` is the command.

The player reads them as a module cache. Chain an IndexedDB cache behind
it to keep whatever the command did not compile:

```js
import { createCodegen } from "@swf2es/codegen";
import { builtinLibrary, Player, playerglobalLibrary, Scripting } from "@swf2es/player";
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
await scripting.loadLibraries([builtinLibrary, playerglobalLibrary]);
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
import { builtinLibrary, Player, playerglobalLibrary, Scripting } from "@swf2es/player";

const wasm = await readFile(new URL(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
const scripting = new Scripting(await createCodegen(await WebAssembly.compile(wasm)), {
  print: (line) => console.log(line), // trace()
  realTime: null, // getTimer() follows the frames, so every run prints the same
});
await scripting.loadLibraries([builtinLibrary, playerglobalLibrary]);

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

`@swf2es/desktop` is an Electron app that plays SWFs in a window, the
`<swf2es-player>` element inside. With Node 22.18 or later, npm runs it
with nothing to set up:

```sh
npx @swf2es/desktop movie.swf                       # a local SWF
npx @swf2es/desktop https://example.com/movie.swf   # one by its URL
npx @swf2es/desktop app.xml                         # an AIR application, by its descriptor
npx @swf2es/desktop                                 # the window: File › Open, or drop a SWF or a descriptor on it
```

The first run downloads Electron's binary, about 100 MB, once. Installed
(`npm install -g @swf2es/desktop`), the command is `swf2es-desktop`.

Each SWF plays in the sandbox Flash Player gave it. A local SWF goes by its
UseNetwork bit: it reads the files beside it and reaches no network, or
reaches the network, and sockets you allow, and reads no local file. A SWF
opened by its URL plays in Flash's remote sandbox. ActionScript 3 plays on
the builtin.abc and playerglobal the player ships.

| Option | What it does |
| --- | --- |
| `--trace` | Prints what the SWF traces to the terminal: `trace()` to stdout, warnings and errors to stderr. |
| `--log-network` | Prints each request, socket and WebSocket of the SWF to stderr: method, URL, status, size and time. The window's DevTools show none of them, as the main process sends them. |
| `--log-sockets` | `--log-network`, and what each socket and WebSocket sends and receives: its size and first 512 bytes, as text or in hex. It prints whatever the SWF sends, a login among it. |
| `--ignore-certificate-errors` | Does not verify any HTTPS or WSS server's certificate, for this run. |
| `--ignore-certificate-errors=dev.test,localhost` | The same for the hosts named alone, on any port. |
| `-- arguments...` | After an AIR application's descriptor: the application's own arguments. |

`--ignore-certificate-errors` is for a server of your own whose certificate
it signed itself. Whoever sits between you and such a host can then read and
change what the SWF loads from it, so name the hosts you mean, and leave the
switch off otherwise. It is never remembered: the app says so on stderr each
time it starts with it.

In a checkout of the repository the app runs from its sources:

```sh
pnpm build
pnpm --filter @swf2es/desktop start movie.swf
```

[apps/desktop/README.md](../apps/desktop/README.md) has the rest: the menus,
the sandboxes in full, sockets, files and AIR applications.

## Play an AIR application in a page

The element also plays an AIR application from its package (`.air`), a
ZIP of its folder, or the files of one. `openAirApp` finds the
descriptor: the package's `META-INF/AIR/application.xml`, or else the
shallowest `*-app.xml`. `loadAir` then plays its content SWF under AIR's
API and the application sandbox, as adl does:

```js
import { openAirApp } from "@swf2es/web";

const response = await fetch("/games/MyGame.air");
const app = openAirApp(new Uint8Array(await response.arrayBuffer()));
const movie = document.querySelector("swf2es-player");
movie.addEventListener("airexit", (e) => console.log("exit", e.detail.code));
await movie.loadAir(app, { arguments: ["--level", "3"] }); // InvokeEvent's arguments
```

The application's files are held in memory. `File` sees them under its
directory, `FileStream` reads them (at once, or over frames with
`openAsync`), `app:` and `file:` URLs into it load from there, and any
other URL goes to the network as a page's would. Its own directory is
read-only, as an installed application's is. What it writes elsewhere,
in its storage directory (`app-storage:`) or the user's directories, is
kept in the browser's IndexedDB by the application's id, and is there
the next time the page plays it; `loadAir(app, { keepFiles: false })`
keeps it in memory alone, for that play. `EncryptedLocalStore` keeps its
items in IndexedDB too, by the application's id: a page has no keychain
to encrypt them by, and the browser keeps them as it keeps the site's
other data.
The element is its one window, at the descriptor's size, and
`flash.display.Screen` has the one screen the page is on (`window.screen`);
the play page opens `.air` and `.zip` files too.

A SWF played on its own that names a class only AIR has, such as
`NativeApplication` or `File`, plays as an AIR application too: the
browser's Flash Player would refuse it (VerifyError #1014). Its directory
holds it alone, and its `app:` URLs load any other file from beside it on
the server.

The [desktop app](#play-a-swf-on-the-desktop) runs an AIR application from
its descriptor on disk instead, with the real file system, sockets, WebSockets and the
network, as adl runs one:

```sh
npx @swf2es/desktop app.xml [root-dir] [-- arguments...]
```

The descriptor's first window's content SWF plays from `app:/`, at the
descriptor's size and with its title; the arguments after `--` reach its
InvokeEvent, and `flash.display.Screen` has the system's displays. File › Open, or a descriptor dropped on the window, runs the
application too, from its own directory; the app asks first, as an
application reaches your files and the network unasked.

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

An AIR application's `air.net.WebSocket` uses the page's own `WebSocket`.
An embedder whose page may not connect, as the desktop app's, whose main
process holds the connections, gives a `WebSocketHost` of its own as
`configure({ webSockets })`: its `connect(url, protocols, events)` opens
a connection, tells `events` its `open`, `message`, `close` and `error`,
and returns its `send` and `close`.

FileReference and FileReferenceList use the browser's file chooser. Saving
uses the File System Access picker where available, or a Blob download;
uploads and downloads use the player's host fetch. A custom embedder can
supply `configure({ fileHost })` (`FileHost` from `@swf2es/player`), or set
`fileHost: null` to make dialogs cancel. The desktop app supplies native
dialogs. Browser dialogs require a recent user click or keypress.
