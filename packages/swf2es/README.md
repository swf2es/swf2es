# swf2es

Plays SWF files on a web page from one `<script>` tag: the
`<swf2es-player>` element, `replaceFlash` and `watchFlash` for a page's
Flash tags, and ExternalInterface. It is
[`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web) and the rest of
[swf2es](https://github.com/swf2es/swf2es) bundled into a folder of ES
modules that loads from a CDN, with nothing to install or build. A page
that has a bundler installs `@swf2es/web` instead.

```html
<script type="module" src="https://unpkg.com/swf2es@0.1.7"></script>

<swf2es-player src="movie.swf" width="800" height="600"></swf2es-player>
```

jsDelivr serves it too, at `https://cdn.jsdelivr.net/npm/swf2es@0.1.7`.
The module exports what `@swf2es/web` does. To call it, import it from the
same URL, so that the page has one copy:

```html
<script type="module">
  import { configure, watchFlash } from "https://unpkg.com/swf2es@0.1.7";

  configure({ cache: true }); // keep compiled modules in IndexedDB
  watchFlash(); // the page's Flash <object> and <embed> tags become players
</script>
```

Players already in the markup start as the module loads, before any
script that imports it runs, so a page that configures its players adds
them from that script, after `configure`.

## Versions

Name a version in the URL. Until 1.0, a minor release (0.2) may change
what a page sees, so pin at least the minor version: unpkg's
`swf2es@0.1` takes 0.1's fixes as they are released, and redirects to the
exact version, whose files the page then loads together. On jsDelivr, pin
the exact version (`swf2es@0.1.7`): it serves a range without
redirecting, so the files the main one loads later would come from
whatever version the range names by then.

## What it loads

`swf2es.js` defines the element (1.8 MB, 0.7 MB compressed). The rest
lies beside it and loads as a page needs it: `codegen.wasm`, the
compiler, the renderer's chunk and the Flash Workers' host, a small one,
with the first player; `worker.js` only for a SWF that uses workers;
Stage3D's chunk only on a page that configures it (experimental).

## Content-Security-Policy

A page with a CSP needs, in `script-src`:

- the CDN's origin (`https://unpkg.com`);
- `'wasm-unsafe-eval'`, for its WebAssembly: the compiler, and the native
  code that draws and decodes;
- `'unsafe-eval'`, for the JavaScript the SWF's ActionScript is compiled
  to. Without it, only modules compiled ahead of time play: see
  [Compile ahead of time](https://swf2es.github.io/swf2es/docs/#compile-ahead-of-time).

and, for Flash Workers, `worker-src` with the CDN's origin and `blob:`: a
browser starts a worker only on a script of the page's origin, so swf2es
starts it on a `blob:` module of the page's that imports `worker.js`, and
a module worker's imports are held to `worker-src` too. If the policy sets
`connect-src` or `default-src`, the CDN's origin goes there as well, for
`codegen.wasm`, and so do the origins of the SWFs and what they load; if
it sets `style-src`, that needs `'unsafe-inline'`, for the element's
styles. For example:

```
script-src 'self' https://unpkg.com 'unsafe-eval' 'wasm-unsafe-eval'; worker-src https://unpkg.com blob:
```

## Cross-origin isolation

Only a SWF whose workers share memory (a shareable ByteArray, Mutex,
Condition) needs a cross-origin isolated page, served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`: unpkg
and jsDelivr send `Cross-Origin-Resource-Policy: cross-origin`).
Elsewhere workers pass messages, and sharing throws an error that says
so.

## Hosting it yourself

The package's `dist/` folder is the whole of it (`npm pack swf2es`, or
`node_modules/swf2es/dist/` after `npm install swf2es`). Serve it as it
is, anywhere, and load `dist/swf2es.js` from it: its files find one
another by relative URL. Serve `.wasm` as `application/wasm`. From
another origin, send `Access-Control-Allow-Origin` as a CDN does.

The [guide](https://swf2es.github.io/swf2es/docs/) covers the element's
attributes and options, workers, sockets, files and ExternalInterface.

Apache-2.0 with the notices of what it bundles from elsewhere
([LICENSE](LICENSE), [LICENSE.third-party](LICENSE.third-party)).
