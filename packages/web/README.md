# @swf2es/web

Plays SWF files on any web page: the `<swf2es-player>` element,
`replaceFlash` and `watchFlash` for a page's Flash tags, and
ExternalInterface. It is the package to install for a page; it brings the
rest of [swf2es](https://github.com/swf2es/swf2es) with it.

```sh
npm install @swf2es/web
```

```html
<swf2es-player id="movie" src="movie.swf" width="800" height="600"
  scale="showAll" allowscriptaccess="sameDomain"></swf2es-player>

<script type="module">
  import { configure } from "@swf2es/web"; // defines <swf2es-player>

  configure({ cache: true }); // optional: keep compiled modules in IndexedDB

  const movie = document.getElementById("movie");
  movie.addEventListener("error", (e) => console.error(e.detail.error));
  await movie.ready; // resolves once the SWF plays
</script>
```

Or turn a page's Flash `<object>` and `<embed>` tags into players:

```js
import { watchFlash } from "@swf2es/web";

watchFlash();
```

ActionScript 3 needs no setup: builtin.abc and swf2es's own playerglobal
ship with the packages. The packages are ES modules: serve them through a
bundler or an import map. The page must let them compile WebAssembly
(`'wasm-unsafe-eval'` under a CSP).

The [guide](https://swf2es.github.io/swf2es/docs/) covers the element's
attributes and options, workers, sockets, files, ExternalInterface and
precompiled modules.

Apache-2.0 ([LICENSE](LICENSE)).
