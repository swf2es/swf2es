# swf2es

Play SWF files in the browser, and compile their ActionScript bytecode to
modern JavaScript, either on load (JIT) or ahead of time (AOT) with the same
output.

> Early days: the repository layout and test harness are in place; the
> compiler is not written yet. See [docs/architecture.md](docs/architecture.md)
> for the design and the first milestone.

## Layout

```
packages/
  format/    SWF, ABC and AVM1 parsers
  codegen/   bytecode → ES modules, AssemblyScript → wasm (same output for JIT and AOT)
  runtime/   AS3/AS2 language runtime (avm2/, avm1/)
  player/    browser player: display list, playerglobal, renderers
  player-hosts/  optional transports: Node TCP, a WebSocket relay for sockets
  web/       <swf2es-player>, replaceFlash and ExternalInterface for any web page
  cli/       ahead-of-time compiler
oracle/      avmshell and Flash Player references
tests/       unit and conformance tests
docs/        design, references, benchmarks and roadmap
```

## Playing SWFs on a web page

`@swf2es/web` defines a `<swf2es-player>` element as it loads. The page
gives, once, the URLs of the libraries a SWF's ActionScript 3 links
against (Adobe's, which swf2es cannot ship) and, for flash.net.Socket,
the WebSocket relays that reach its servers:

```html
<script type="module">
  import { configure, replaceFlash } from "@swf2es/web";

  configure({
    libraries: { builtin: "/flash/builtin.abc", playerglobal: "/flash/playerglobal.abc" },
    // codegen: "/swf2es/codegen.wasm",  // by default the import map's @swf2es/codegen/codegen.wasm
    socketProxy: [{ host: "game.example", port: 5588, proxyUrl: "wss://relay.example/5588" }],
    cache: true, // keep compiled modules in IndexedDB for the next visit
  });
  // The page's Flash <object> and <embed> tags, swapped for the element.
  replaceFlash();
</script>

<swf2es-player id="movie" src="movie.swf" width="800" height="600"
  flashvars="lang=en" scale="showAll" wmode="opaque" allowscriptaccess="sameDomain">
</swf2es-player>
```

The element takes an `<embed>`'s attributes (`src`, `width`, `height`,
`flashvars`, `scale`, `salign`, `wmode`, `bgcolor`, `base`,
`allowscriptaccess`, `allownetworking`, `quality`), follows its size and the device's
pixels, and has `load(url | bytes)`, `ready`, `destroy()` and `load`,
`error` and `fscommand` events. A SWF's ExternalInterface callbacks are
methods of the element, and its `call`s run in the page, where
`allowscriptaccess` lets them:

```ts
const movie = document.getElementById("movie");
await movie.ready;
movie.sendScore(120); // ExternalInterface.addCallback("sendScore", ...) in the SWF
movie.destroy(); // stops it and lets go of its GL context, audio and sockets
```

`watchFlash()` replaces Flash tags the page adds later too. See
[docs/architecture.md](docs/architecture.md#the-web-embedding).

## Embedding the player

A page plays a SWF with a `Player` and draws it with a `PixiView` over a
Pixi renderer it makes itself:

```ts
const renderer = await autoDetectRenderer({
  preference: "webgl",
  width: player.width,
  height: player.height,
  background: player.background,
  // Required for filter-backed blend modes: they read what is below from
  // the back buffer, and without it draw as normal (the view warns once).
  // It costs one full-screen copy a frame on the GPU.
  useBackBuffer: true,
});
const view = new PixiView(renderer);
const unbind = view.bindPointer(player); // mouse input, until unbind()
const unbindKeys = bindKeyboard(player, window); // keys, and typing into the SWF's fields
await player.start();
let drawn = -1;
// Each animation frame: play what the time is worth, and draw only when
// `changes` moved: a frame ran, a key, a pointer event that changes what
// shows, updateAfterEvent, or a call from the page into the SWF; the
// frames between would draw the same picture.
player.advance(elapsedMs);
if (player.changes !== drawn) {
  drawn = player.changes;
  // A script may set Stage.color, which moves `changes`: read it as you draw.
  renderer.background.color = player.background;
  view.render(player.stage);
}
```

`Scripting` runs the SWF's ActionScript 3 and needs `builtin.abc` and
`playerglobal.abc`, which the host loads (`scripting.loadLibraries`);
Adobe's `playerglobal.abc` is not part of this repository. A page passes
the SWF's URL, which its relative loads resolve against, and its
flashvars, which `loaderInfo.parameters` holds after the URL's query, as
options:

```ts
const scripting = new Scripting(codegen, {
  url: new URL("movie.swf?lang=en", location.href).href,
  parameters: { server: "wss://example.test", debug: "0" }, // FlashVars
});
```

An error the SWF's code throws and nothing catches is reported, as Flash
reports one, and the SWF plays on. A host that wants them passes a hook:

```ts
const scripting = new Scripting(codegen, {
  // Each error nothing caught, as it happens: a listener's, a frame
  // script's, a constructor's.
  onUncaught: (error) => console.error(scripting.rt.toString(error as never)),
});
```

Without `onUncaught`, `advance()` (and `start()`) throw them once the
frame they came in has ended: one error alone, or an `AggregateError`
when there were several. The frame has run to its end either way. A
hook should not throw; if it does, its error is thrown so too.

## Compiling ahead of time

`swf2es` compiles a SWF's ActionScript 3 to the modules the player would
compile for it, byte for byte, with what each compile fixed in the
compiler and a manifest of their hashes, keys and the compiler:

```sh
node packages/cli/dist/main.js movie.swf -o movie.swf2es \
  --lib builtin.abc --lib playerglobal.abc
```

Without `--lib` it uses the copies the player's tests keep in
`tests/player/out/libraries/`. `swf2es --help` lists the options. It
exits with 2 for a mistake in the command line or missing default
libraries, and 1 for any other failure: an unreadable, AVM1 or rejected
input or library, or an output it cannot write.

A page serves the output and gives it to the player as a module cache,
so that what it holds is not compiled again; it is found only for the
SWF loaded after the same libraries, by the same `codegen.wasm`, into a
domain that sees nothing else: as the main movie, or by a `Loader` into
`new ApplicationDomain(null)`. Anything else compiles as usual. Chained before an
IndexedDB cache, what the output lacks is kept across page loads:

```ts
import { indexedDbModuleCache } from "@swf2es/player-hosts/indexeddb";
import { chainCaches, precompiledModules } from "@swf2es/player-hosts/precompiled";

const scripting = new Scripting(codegen, {
  moduleCache: chainCaches(
    precompiledModules("/movie.swf2es/manifest.json"),
    indexedDbModuleCache(),
  ),
});
```

With `--emit-libraries` and `precompiledModules(url, { importModules: true })`,
every module is imported from its URL rather than evaluated, so the page
needs no `'unsafe-eval'` in its Content-Security-Policy:
`script-src 'self' 'wasm-unsafe-eval'` is enough, as the player still
runs `codegen.wasm` to replay each module's log. Modules served from
another origin need that origin in `script-src` and CORS headers. Pixi
then needs `import "pixi.js/unsafe-eval"` too.

## Development

```sh
git submodule update --init   # avmplus (Tamarin tests) and as3pb
pnpm install
pnpm build
pnpm check       # Biome: formatting and lint (pnpm format fixes them)
pnpm typecheck   # tests and scripts (packages are checked by build)
pnpm test        # needs podman or docker for the avmshell oracle, and Chrome for the player
pnpm tamarin     # the Tamarin acceptance tests in avmshell and swf2es
```

Formatting and linting use [Biome](https://biomejs.dev), installed with the
other dev dependencies. VS Code suggests its extension on opening the repo
and formats on save.

Node 24 is the default: tests and scripts are `.ts` files that node runs
directly. Deno works too once the packages are built, for example
`deno test -A --no-check` in `tests/unit`; its type-checker uses its own lib
settings, so type-checking stays with `pnpm typecheck`.

## Contributing

See [AGENTS.md](AGENTS.md) for the commands, rules and code style (written
for coding agents, and just as true for people).

## License

Apache-2.0
