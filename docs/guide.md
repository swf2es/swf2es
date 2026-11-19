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
<script type="module" src="https://unpkg.com/swf2es@0.1.28"></script>

<swf2es-player src="movie.swf" width="800" height="600"></swf2es-player>
```

The module exports what `@swf2es/web` does; import it from the same URL
to call `configure` or `watchFlash`, so that the page has one copy.
Players in the markup start as it loads, before such a script runs, so a
page that configures its players adds them from that script. Until
1.0 a minor release may break a page, so pin a version: on unpkg at least
the minor one (`swf2es@0.1` redirects to the newest 0.1 release, whose
files then load together); on jsDelivr the exact one
(`https://cdn.jsdelivr.net/npm/swf2es@0.1.28`), as it serves a range
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

Capture uses the browser's permission prompt when a SWF attaches a camera
to a Video, listens for microphone samples, or enables microphone loopback.
It requires a secure context (HTTPS or localhost); an embedding iframe must
allow `camera` and/or `microphone` for the devices it uses. Device names may be blank until the
user grants permission. Set `allowcapture="false"` on an element, or
`configure({ allowCapture: false })` for new loads, to refuse capture.
Changing that attribute to false also stops the current capture; reload
before enabling it again. Replacing or destroying the player stops its
tracks, including a permission request that finishes later.

The element also takes `salign`, `wmode`, `bgcolor`, `base`, `quality`,
`allownetworking` and `relativeurls`. As in Flash's plug-in, relative
URLs resolve against the page, or against `base`, where `base="."` is
the SWF's directory and any other value is relative to the page. A player page
that shows SWFs from elsewhere sets `relativeurls="movie"` on the
element, or `configure({ relativeUrls: "movie" })` for all of them, to
resolve them against each SWF's own URL instead. Like `base`, the
attribute is read when a movie loads, not watched while it plays; Flash
tags have no such parameter, so for players `replaceFlash` makes only
`configure` sets it. It has `load(url | bytes)` and `destroy()`, which
gives back its GL context, audio and sockets. It fires `load`, `error` and
`fscommand` events, and with Stage3D on, `stagelayout` as the SWF starts
and whenever it sets its stage's `scaleMode` or `align` (`event.detail`
holds both): a page may size the element to the SWF's own size while it
asks for `noScale`, as an embedding at that size shows it.

Browsers hold a page's sound until the user first clicks or presses a key
in it, where Flash Player's plug-in played it at once. When a SWF's sound
waits so, the element fires `audioblocked` and shows a "Click to unmute"
button over the stage; a click on it, or Enter or Space, lets the sound
play, as far in as a streamed soundtrack has gone meanwhile, and does not
reach the SWF. A click or key on the SWF itself lets the sound play too,
the SWF hearing it as usual. Either way the element fires
`audiounblocked`, as it does when the SWF that held the sound is
destroyed or another is loaded in its place; a SWF that plays no sound
shows no button. Each element on a page shows a button of its own, whose
click unmutes its own SWF.
`unmuteprompt="false"` on the element, or `configure({ unmutePrompt:
false })` for the page's elements, leaves the button out, for a page that
shows its own: its click handler calls `element.player?.audio?.resume()`,
which a browser allows only while it handles the user's click or key. The
desktop app's window lets sound play at once.

A SWF goes full screen by setting `Stage.displayState`, as under Flash
Player's plug-in: only with `allowfullscreen="true"` on the element
(`allowfullscreeninteractive="true"` for `"fullScreenInteractive"`), and
only from a mouse or key handler, as the browser's Fullscreen API asks
too; otherwise the setter throws SecurityError #2152. The element then
covers the screen, the stage placed by its scale mode, or its
`fullScreenSourceRect` alone, fitted and centred. Esc leaves, and the SWF
gets its `FullScreenEvent` either way. `replaceFlash` carries both
parameters over. An AIR application needs neither attribute, but still
the click. A page that makes the element full screen itself
(`element.requestFullscreen()`) puts the stage in full screen too.
`configure({ fullScreen })` takes a full screen of the embedder's own
instead, as the desktop app's window, which needs no click.

The player's context menu has a "Show performance" item, just above
"About swf2es", that shows a small meter over the stage's top left
corner. It shows the SWF's frames a second against its frame rate, the
player's ms in a frame (median and worst over the last second), draw
calls, the JS heap where the browser reports it, and the WebAssembly
memories. The viewer's choice is kept in localStorage for every element of
the origin, and the meter is off by default. `performancemeter="false"`
on an element, or `configure({ performanceMeter: false })` for all of
them, leaves the item out and ignores the kept choice. A script can still
show or hide the meter with `element.performanceMeter = true` or `false`,
which is kept like the menu's choice, and the element fires
`performancemeterchange` (`event.detail.shown`) either way. While hidden
it costs nothing: it hears no frames, runs no timer and leaves the WebGL
context alone. While shown, it counts draw calls by wrapping the
context's draw functions. A page can style it with the custom properties
`--swf2es-meter-font`, `--swf2es-meter-color`,
`--swf2es-meter-background`, `--swf2es-meter-border` and
`--swf2es-meter-muted` on the element; by default it takes the browser's
light or dark colours.

A page can measure the player itself, as the meter does, by
setting `element.frameListener` to a function. After each animation frame
the player calls it with a `FrameStats` object: `time`, the frame's time
by `performance.now()`; `frames`, the SWF's frames it played, often 0
where the display runs faster than the SWF; `frameRate`, the SWF's rate
then; `play`, the ms those frames took (scripts, events, timeline and
sound); `drew`, whether it drew the stage; `draw`, the ms drawing took on
the CPU, with the little work just before it (keeping the text input's
focus, choosing samples again after a quality change), and 0 where it did
not draw; and `shown`, false for the frames a timer plays while the page
gets no animation frames, which draw nothing. Tell a drawn frame by
`drew`, not by `draw`: a browser with a coarse clock (Safari's, or
Firefox's on a page that is not cross-origin isolated) may time a short
drawing as 0 ms. The same object comes each time, overwritten by the next
frame, so copy what you keep. There is one listener: setting it replaces
the one before. It holds across loads until set to `null`; without one
the player measures nothing, and the listener's own time is not counted
as the player's, so it does not change how frames are paced.
`element.wasmMemory` gives the bytes of the WebAssembly memories behind
the player: `codegen`, its compiler's, and `native`, the bitmap kernels',
tessellators' and decoders' on the page, which every player on it shares.
A Flash Worker's thread holds its own, which are not counted.
`element.gl` is the WebGL context it draws with, for counting draw calls.

With Stage3D on, a back buffer may be from 32 to 16384 pixels a side in
every profile, as Flash Player 32 and AIR 51 take one on a desktop GPU,
so a SWF that sizes its back buffer to its stage plays on a 2K or 4K
screen. `maxBackBufferWidth` and `maxBackBufferHeight` read 16384
whatever the GPU. Where the GPU allows less, the back buffer is drawn at
the largest size it allows and stretched to the size asked for; AIR
would read the GPU's own limit there and refuse larger sizes. In the
`baselineConstrained` profile AIR draws no back buffer larger than the
stage (Error #3710, or #3723 for SWFs before version 30); swf2es draws
it.

A back buffer configured with `wantsBestResolution` is drawn at the
screen's pixels: its size times `Stage.contentsScaleFactor`, which is the
page's `devicePixelRatio` (1 for an AIR application whose descriptor does
not ask for `<requestedDisplayResolution>high</requestedDisplayResolution>`,
as in AIR). `backBufferWidth`, `backBufferHeight` and `drawToBitmapData`
then count those pixels, the scissor rectangle stays in stage pixels, and
the canvas keeps its size on the page. The ratio holds the browser's zoom
too, which Flash kept apart as `browserZoomFactor` (1 here), so
`wantsBestResolutionOnBrowserZoom` adds nothing; a best-resolution back
buffer follows the ratio as the page is zoomed or moved to another screen,
and must be cleared again. It costs the ratio squared in memory: a
1920 by 1080 back buffer at a ratio of 2 is 3840 by 2160, 33 MB for each
of its colour, depth and stencil, and the canvas's two buffers, about
130 MB, and 265 MB more in multisampled buffers at 4x antialiasing; one of
3840 by 2160 at a ratio of 2 is four times all that.

Every Stage3D profile is served, from `baselineConstrained` to
`standardExtended`, `requestContext3DMatchingProfiles` taking the best
asked for, as Flash does on a desktop GPU. The standard profiles run AGAL 2
and 3 programs (conditionals, derivatives, depth output and their larger
register files), half-float textures and up to four colour outputs at once;
the packed 16-bit formats work in every profile. Instanced drawing, which
only AIR has, is not there yet.

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

## Declarations of a SWF's classes

```sh
swf2es types movie.swf -o movie-types.ts --name Movie
```

writes TypeScript declarations of the classes the SWF's ActionScript 3
defines: for each, an interface of its instances' public members and one of
its static ones, keyed by qualified name in `MovieClasses` and
`MovieStatics`. A class extends the declarations of the one it extends in
the player's libraries (`@swf2es/player/as3-types`), so a subclass of
`flash.display.Sprite` has Sprite's members; a type that no library
defines is `avm2.Value`. `--air` takes AIR's library in too. With them, a
host's code reads a script's objects by name, checked as it compiles:

```ts
import type { avm2 } from "@swf2es/runtime";
import type { MovieClasses } from "./movie-types.js";

const hero = value as avm2.Ref<MovieClasses["game::Hero"]>;
const hp = scripting.rt.prop(hero, "hp"); // a number; "hpp" would not compile
scripting.rt.callProp(hero, "attack", null, 2);
```

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

The first run downloads Electron's binary, about 100 MB, once. npx may run a version it cached before
rather than a newer one: `npx @swf2es/desktop@latest` takes the newest. Installed
(`npm install -g @swf2es/desktop`), the command is `swf2es-desktop`.

Each SWF plays in the sandbox Flash Player gave it. A local SWF goes by its
UseNetwork bit: it reads the files beside it and reaches no network, or
reaches the network, and sockets you allow, and reads no local file. A SWF
opened by its URL plays in Flash's remote sandbox. ActionScript 3 plays on
the builtin.abc and playerglobal the player ships.

| Option | What it does |
| --- | --- |
| `--trace` | Prints what the SWF traces to the terminal: `trace()` to stdout, warnings and errors to stderr. |
| `--flashvars="a=1&b=2"` | Gives the SWF FlashVars, as a page's `flashvars` parameter: its `loaderInfo.parameters`, or an AVM1 SWF's `_root` variables. Repeated, they are joined. |
| `--param=name=value` | Gives the SWF one of the parameters a page's `<object>` or `<embed>` gave it, as the element's attribute of that name: `quality`, `scale`, `salign`, `wmode`, `bgcolor`, `menu`, `base` or `allowNetworking`. Repeatable. |
| `--log-network` | Prints each request, socket and WebSocket of the SWF to stderr: method, URL, status, size and time. The window's DevTools show none of them, as the main process sends them. |
| `--log-sockets` | `--log-network`, and what each socket and WebSocket sends and receives: its size and first 512 bytes, as text or in hex. It prints whatever the SWF sends, a login among it. |
| `--ignore-certificate-errors` | Does not verify any HTTPS or WSS server's certificate, for this run. |
| `--ignore-certificate-errors=dev.test,localhost` | The same for the hosts named alone, on any port. |
| `--ignore-policy-files` | Lets the SWF read every public host's data, send it headers and open sockets to it as if its cross-domain policy files allowed it, for this run. This machine and private networks still need their own policy file. |
| `--ignore-policy-files=data.example,localhost` | The same for the hosts named alone, exactly (not their subdomains), this machine's and private networks' too. |
| `--no-http-cache` | Neither reads nor keeps the HTTP cache, for this run. |
| `--software-gl` | Draws with SwiftShader, on the CPU: where Chromium takes no GPU (a server, Xvfb), or one that gives WebGL but not WebGL 2. Only for SWFs you trust. |
| `--proxy=socks5://host:1080` | Sends the SWF's requests, sockets and WebSockets through a SOCKS5 proxy, for this run (`socks5h://` is the same). |
| `--proxy=http://user:pass@host:3128` | The same through an HTTP proxy, by a `CONNECT` tunnel for each connection; either kind takes a username and password. |
| `-- arguments...` | After an AIR application's descriptor: the application's own arguments. |

A SWF built for a page reads what its `<object>` or `<embed>` gave it, and
gets it from the command line:

```sh
npx @swf2es/desktop --flashvars="user=guest&lang=en" --param=scale=noScale --param=salign=TL movie.swf
npx @swf2es/desktop "https://example.com/movie.swf?user=guest"   # the query is among its parameters
```

They mean what they mean to the element, case-insensitive in their names
as in a page; any other name is left out, as the app says. Write them with
`=`: a value may also follow as an argument of its own, but not one that
starts with `-`, which other switches would read as theirs. `base` is an
http or https URL, or a relative one, resolved against the SWF's own URL
as a page's against the page's: for a local SWF, its directory or below,
where it reads. The loads it resolves are judged by the SWF's sandbox as
any other. A SWF URL's query
is among its parameters as Flash had it, the FlashVars over it. They are
for the SWF the command line names, a second start's handed to the app
already open too, and stay with it as it is reloaded; one opened from the
menus, the recent list or a drop gets none. `allowScriptAccess`,
`allowFullScreen` and `allowFullScreenInteractive` change nothing here, as
the app says: ExternalInterface stays off, and a SWF's full screen is the
window's, always allowed. An AIR application gets none, as the app says:
it has no page.

npx reads the first `--` on its command line as the end of its own
options, so an application's arguments need one before the package too:
`npx -- @swf2es/desktop app.xml -- --server=local` (with `-y`, `npx -y --
@swf2es/desktop …`). The installed command, `swf2es-desktop`, takes them as
they are.

`--ignore-certificate-errors` is for a server of your own whose certificate
it signed itself. Whoever sits between you and such a host can then read and
change what the SWF loads from it, so name the hosts you mean, and leave the
switch off otherwise. It is never remembered: the app says so on stderr each
time it starts with it.

`--ignore-policy-files` is for a SWF you trust whose servers no longer
serve the policy files Flash asked for. It takes away what those files
guarded: the SWF reads, as your machine, whatever your machine reaches of
the hosts it covers, and may send it anywhere. No cookies or passwords go
with its requests, so your accounts on those sites stay out of its reach,
but what is open to your network position is not (a site that trusts your
address, say). Bare, it covers public hosts alone: a SWF from the internet
still reaches your machine and your local network only where a policy file
there grants it, unless you name the host (`--ignore-policy-files=localhost`,
`=192.168.1.5`). A name matches as written, not its subdomains nor its
address. Flash's other rules stay: a local SWF without UseNetwork reaches
no network, sockets still ask you first, and `--log-network` ends the line
of each request the switch let through in `allowed by --ignore-policy-files`.
It covers every SWF the running app opens, one you double-click into it
later included; a second start with the switch hands its SWF to the app
already open, which keeps what it started with. It is never remembered,
and the app says on stderr what it covers each time it starts with it.

Both `--ignore-certificate-errors=` and `--ignore-policy-files=` take host
names and addresses, matched exactly as a URL writes them, whatever their
case, an IPv6 address with or without brackets. An address written another
way (`127.1`, `192.168.010.5`) is the address it stands for, a port
(`dev.test:8443`) is taken as every port of the host, a wildcard (`*`,
`*.dev.test`) matches nothing, and an entry that is not a host alone
(`https://dev.test`, `dev.test/x`) is left out; the app says each of these
on stderr.

`--proxy` is never remembered either, and the app says on stderr which
proxy it uses (its credentials, which come from the command line alone,
never). Every connection the main process makes for the SWF goes through
it: http and https loads, policy files, sockets and an AIR application's
WebSockets. TLS is the app's own, over the tunnel, so certificates are
checked as without a proxy. The app still resolves a host itself, to tell
whether it is on this machine or your network, which a SWF from the
internet may not reach without a policy file there, and then asks the
proxy for the address it judged; so a host this machine cannot resolve is
not reached through the proxy either. A proxy that fails or refuses is a
failed load or socket to the SWF, and a line on stderr saying why. An HTTP
proxy that allows `CONNECT` only to port 443, as Squid does by default,
refuses plain http and sockets on other ports.

The player draws with WebGL 2. Where Chromium takes no GPU, because there
is none or its blocklist refuses the one there is, as on a server, a CI
runner or a virtual machine, nothing draws and the app says so on stderr.
`--software-gl` draws with SwiftShader, Chromium's GPU on the CPU, instead.
Chromium calls SwiftShader unsafe for untrusted content, as it compiles code
in the GPU process, which on Linux runs outside Chromium's sandbox, so use it
for SWFs you trust.

On a server with no display, run the app under Xvfb, whose only GL Chromium
refuses:

```sh
xvfb-run -a npx @swf2es/desktop --software-gl --trace movie.swf
```

Where a Wayland session is about (`WAYLAND_DISPLAY`, or
`XDG_SESSION_TYPE=wayland`), Electron goes to it rather than to Xvfb: add
`--ozone-platform=x11`.

The app caches the SWF's http and https GETs as a browser would, by what
the server's Cache-Control, Expires, ETag, Last-Modified and Vary say, up to
512 MB under the system's cache directory, after Flash's sandbox and policy
files have judged each request, cached or not; each SWF's origin has a
cache of its own. A response with no Cache-Control or Expires of its own is
kept for a day at most, by a guess from its Last-Modified, so a SWF updated
on its server may play in its old version until then: File › Clear HTTP
Cache empties the cache and picks up the new one. File › HTTP Cache turns it
off, which the app remembers.

In a checkout of the repository the app runs from its sources:

```sh
pnpm build
pnpm --filter @swf2es/desktop start movie.swf
```

A SWF or an AIR application that sets `Stage.displayState` takes the
window full screen, with no click needed, as in AIR and Flash's projector;
Esc or F11 leaves. F11 is the View menu's key for it; a SWF or an
application that acts on F11 itself, setting `Stage.displayState` in its
`keyDown` listener, has the key to itself, and one press toggles once.

A SWF gets a Context3D, as in Flash Player and AIR on a desktop: Stage3D
content plays with nothing to set up. View › Stage3D turns
it off, after which a SWF's `requestContext3D` gets Error #3702, "Context3D
not available", and on again; the app remembers the choice and restarts
the movie playing.

On Linux, a local file a SWF or an AIR application names that is not there
as named is found as Windows and macOS find it, ignoring case, so content
made there finds its files whatever case it names them in. Where two names
in a directory differ only in case, neither is taken.

The desktop app asks before a movie uses your camera or microphone. The dialog
names the top-level movie's source and the requested kind, camera or microphone.
A loaded child movie uses that same attribution. Device names may remain blank
until consent. The window title shows capture while active; View → Stop Camera and Microphone stops both until the movie is
reloaded. Consent is cleared when the movie or page closes. If a movie freezes
while stopping capture, the app terminates its renderer to release the devices
and offers to reload it. A responsive page awaiting a slow device is allowed to
finish opening, then stops the late stream; the title stays marked until closure
is confirmed. On macOS, system permission is required as well.

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
keeps it in memory alone, for that play. `File.createTempFile()` and
`File.createTempDirectory()` make theirs in its cache directory
(`File.cacheDirectory`, `/cache`), kept the same way until it deletes
them, as AIR leaves them for the application to delete.
`EncryptedLocalStore` keeps its items in IndexedDB too, by the
application's id: a page has no keychain to encrypt them by, and the
browser keeps them as it keeps the site's other data.
The element is its one window, at the descriptor's size, and
`flash.display.Screen` has the one screen the page is on (`window.screen`);
the play page opens `.air` and `.zip` files too.

A `URLLoader` or `URLStream` whose response tells an HTTP error (404, 500)
gets the response's body in an AIR application, here and in the desktop
app, as in AIR: with a listener for `httpResponseStatus` added before
`load`, the load completes, the body its `data`; without one it ends in
`ioError`, the body in `data` all the same. A SWF that is no AIR
application gets `ioError` and no data, as in Flash Player.

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
InvokeEvent, and `flash.display.Screen` has the system's displays, their
`colorDepth` counted as AIR counts it (32 for true colour, where the
system says 24). File › Open, or a descriptor dropped on the window, runs the
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
so does the desktop app, through its main process; both send each write
at once, without Nagle's algorithm, unless an AIR SWF set `tcpNoDelay`
to false before it connected. An embedder with a transport of its own
gives it as `configure({ sockets })`; its `connect(host, port, events,
options)` gets `options.noDelay` where the SWF set `tcpNoDelay`.

`flash.net.SecureSocket` works in node and the desktop app. The desktop
asks for the same host-and-port permission as a plain socket, then checks
the TLS certificate against the original hostname, including through a
proxy. It exposes the peer's `X509Certificate` and distinguished names.
A SWF can add DER certificates with `addBinaryChainBuildingCertificate`;
they apply only to that Socket. In AIR mode, a self-signed leaf requires the application to
accept AIR 51's cancelable `certificateError` event explicitly; Flash Player mode refuses it. Expired,
wrong-name and broken-chain certificates are refused.

The browser relay does not provide SecureSocket: TLS to a WebSocket relay
alone cannot supply the target server's certificate or TLS session. A
custom `SocketHost` may implement its optional `secure` capability; without
one, `SecureSocket.isSupported` is false.

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
