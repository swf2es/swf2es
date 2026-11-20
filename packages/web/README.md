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

For the page's scripts that look for Flash before they write its tags,
as swfobject does, `watchFlash` also lists Flash Player's plug-in,
"Shockwave Flash 32.0 r0", in `navigator.plugins` and its MIME types in
`navigator.mimeTypes`, after the browser's own entries;
`watchFlash(document, { plugin: false })` leaves it out. A script that
looks before `watchFlash` runs needs `installFlashPlugin` first, from
`@swf2es/web/plugin` in a classic script ahead of it (the
[guide](https://swf2es.github.io/swf2es/docs/#replace-the-flash-tags-on-an-existing-page)
says how).

ActionScript 3 needs no setup: builtin.abc and swf2es's own playerglobal
ship with the packages. The packages are ES modules: serve them through a
bundler or an import map. The page must let them compile WebAssembly
(`'wasm-unsafe-eval'` under a CSP).

Where the browser holds a page's sound until the user's first click, the
element shows a "Click to unmute" button over the SWF and fires
`audioblocked`, then `audiounblocked` once the sound plays;
`unmuteprompt="false"` leaves the button to the page.

A SWF's relative URLs resolve as Flash Player's plug-in resolved them:
against the page, or against the element's `base`, where `base="."` is
the SWF's directory and any other value is relative to the page. A page
that plays SWFs from elsewhere sets `relativeurls="movie"` on the
element, or `configure({ relativeUrls: "movie" })` for all of them, to
resolve them against each SWF's own URL. Like `base`, the attribute is
read when a movie loads; `replaceFlash` carries `base` from a Flash tag
but not `relativeurls`, which only `configure` sets for those players.

The [guide](https://swf2es.github.io/swf2es/docs/) covers the element's
attributes and options, workers, sockets, files, ExternalInterface and
precompiled modules.

Apache-2.0 ([LICENSE](LICENSE)).
