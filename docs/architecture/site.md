# The demo site

`apps/site` is a static page, published by `.github/workflows/pages.yml`
from `main` to https://swf2es.github.io/swf2es/, that plays the SWFs
people open: one `<swf2es-player>`, the panels a person trying a SWF wants
around it, and three demos. It is the web embedding with nothing in
between, so a static host is all it needs: `build.ts` copies the packages
as `tsc` wrote them, `codegen.wasm` and
`builtin.abc` into `apps/site/dist/site/`, under an import map of relative
URLs, so it plays under Pages' `/swf2es/` as at a server's root.

- **A SWF** comes from a file the browser reads, never uploaded; from a
  URL the page fetches, which works only where the server allows another
  origin (CORS); from `?swf=`; or from a demo. The page reads its bytes
  itself, for the header it shows, and gives them to the element with
  `base` set to the URL they came from, so the SWF's own loads resolve as
  if the element had fetched it. Its `allowscriptaccess` is `never`: a
  stranger's SWF does not script the page.
- **The console** shows what the element sends to the browser's console,
  trace on `console.log` and uncaught errors on `console.error`, which
  the page wraps. **The stats** count the frames the player's `advance`
  plays, wrapped on the instance, the main thread's time per animation
  frame, and Chromium's JS heap.
- **Report a problem** opens a new issue filled in with the build, the
  browser, the renderer, the SWF's header and the last errors: never the
  SWF, nor a local file's name.
- **No sockets**: a static site has no WebSocket relay. Compiled modules
  are kept in IndexedDB (`cache: true`).
- **The demos** are built from the repository's sources as the site is:
  `demos/Bounce.as` compiled by ASC in the oracle's image, an AVM1 SWF
  whose actions `tests/avm1-script.ts` writes, and the player benchmark's
  crowd. The workflow pulls the oracle's image for the first.
- **Licences**: `notices.html` gives builtin.abc's MPL-2.0 and lists the
  files translated from avmplus and taken from Ruffle, found by their
  headers as the site builds, with the licences of minimp3, libtess2, zlib and
  the LZMA SDK.

`tests/site/run.ts`, part of `pnpm test`, builds the site and checks it in
Chrome under `/swf2es/`; `--serve` serves it to look at.
