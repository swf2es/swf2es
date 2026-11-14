# @swf2es/player-hosts

Optional hosts for the [swf2es](https://github.com/swf2es/swf2es) player,
each a subpath of its own, so that a page loads only what it uses.
[`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web) uses those it
needs itself; this package is for a host built on `@swf2es/player`.

```sh
npm install @swf2es/player-hosts
```

- `@swf2es/player-hosts/indexeddb`: `indexedDbModuleCache()`, the compiled
  modules kept in IndexedDB for a page's next visit.
- `@swf2es/player-hosts/precompiled`: `precompiledModules()` reads what the
  `swf2es` command compiled ahead of time; `chainCaches()` puts a cache
  behind it.
- `@swf2es/player-hosts/websocket`: `webSocketSocketHost()`, flash.net.Socket
  over a WebSocket relay.
- `@swf2es/player-hosts/node`: `nodeSocketHost()`, flash.net.Socket over
  node's TCP, and `nodeWorkerHost()`, flash.system.Worker on worker threads.
- `@swf2es/player-hosts/workers`: `webWorkerHost()`, flash.system.Worker
  on Web Workers, which run `@swf2es/player-hosts/web-worker`
  (`node-worker` is node's); and `webCompilerHost()`, a player's
  background compiler (Scripting's `compileHost`) on a Web Worker running
  `@swf2es/player-hosts/web-compiler`.
- `@swf2es/player-hosts/stage3d`: `stage3DCanvasHost()`, Stage3D's canvas
  layers in a page.

```js
import { indexedDbModuleCache } from "@swf2es/player-hosts/indexeddb";
import { chainCaches, precompiledModules } from "@swf2es/player-hosts/precompiled";

const moduleCache = chainCaches(
  precompiledModules("/movie.swf2es/manifest.json"),
  indexedDbModuleCache(),
);
// new Scripting(codegen, { moduleCache, ... })
```

`dist/thread/` holds copies of the modules a Web Worker loads, which
resolve without the page's import map.

The [guide](https://swf2es.github.io/swf2es/docs/) has more.

Apache-2.0 ([LICENSE](LICENSE)); the code from elsewhere in its copies of
the other packages, and its terms, in [LICENSE.third-party](LICENSE.third-party).
