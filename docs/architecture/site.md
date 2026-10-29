# The demo site

`apps/site` is the static site published by `.github/workflows/pages.yml`
from `main` to https://swf2es.github.io/swf2es/: a player for the SWFs
people open, the guide, and how compatible swf2es is. Astro builds it, Starlight frames each page
(header, search, sidebar, light and dark themes), and a static host is all
it needs. Its pages, under the base path:

- `/` — the home page: what swf2es is, the way to the player and the
  guide. A link with `?swf=`, which the player took when it was the home
  page, goes on to `play/` with its query.
- `/play/` — the player: one `<swf2es-player>`, the panels a person trying
  a SWF wants around it, and three demos. It is the web embedding with
  nothing in between: its scripts (`src/`) are served as `tsc` writes them,
  in `app/`, under an import map of the packages as `tsc` wrote them, in
  `modules/`. The import map's URLs are absolute under the base path, and
  it is the head's first script, before any module of Starlight's.
- `/docs/` — the guide, made from `docs/guide.md` as it builds, so the
  repository keeps one copy: `guide.ts` is a content loader that makes
  each `##` section a page, the guide's introduction at the top of the
  first, and `/docs/` redirects there. It reads
  the Markdown as GitHub does (fences by their character and length,
  headings numbered when repeated), sends links to the repository's other
  files to GitHub at the site's commit, and links to a heading to the page
  that has it. The sidebar links Architecture to `docs/architecture.md` on
  GitHub.
- `/compatibility/` — how much of ActionScript and Flash Player swf2es
  runs as Flash does, every figure worked out as the site builds by
  `compatibility.ts`, from what the repository's tests keep, so a deploy
  from `main` is as current as its baselines:
  - ActionScript 3: `tests/tamarin/swf2es-baseline.json` against
    avmshell's `baseline.json`, by the rules of `tests/tamarin/score.ts`,
    which `swf2es.ts` scores its runs with, by suite, with the tests left
    out said;
  - Ruffle's corpus: `tests/player/corpus/baseline.json`, tests passed
    (`standing.ts`, as `run.ts` counts them) and lines matched by area, and what stops the most, by the groups of
    `unimplemented-natives.json` the natives in their errors fall in;
  - the `flash.*` API: the player's playerglobal, read from
    `playerglobal-library.ts` with `tools/abc-surface/read.ts`. Its
    surface is Flash Player's (`pnpm as3:playerglobal` checks it), so no
    file of Adobe's is needed: a member counts as implemented unless it is
    a native `unimplemented-natives.json` lists, which
    `natives-coverage.test.ts` keeps to exactly the natives the player
    does not register. AIR's own API is left out, by its API versions
    (`tools/playerglobal-air.ts` marks the AIR-only classes Flash's
    playerglobal leaves unmarked) and the list's `air` group;
  - the player's features, by hand, with counts from the same list.

  Reading and scoring all three takes about 25 ms, so every build does it
  afresh; `tests/unit/site/compatibility.test.ts` checks the scoring.
- `/notices/` — the licences, below. `notices.html`, their old address,
  sends its links on.

The base path is `SITE_BASE`, by default `/swf2es/`, as Pages serves it.
`facts.ts` reads it once, with what the pages show of the build (its
commit, the avmplus commit, the import map, the files under each licence),
and the pages take them, and the compatibility page's figures, through
virtual modules (`astro/site.ts`), as Astro bundles them away from
`facts.ts`'s own URL.

`build.ts` stages what the player loads in Astro's public directory
(`dist/public/`): the packages, `codegen.wasm`, `builtin.abc`, the demos,
the licence texts and the service worker. Then it runs Astro, which writes
the pages, with Pagefind's index for the search, into
`apps/site/dist/site/`, the folder Pages publishes.

- **A SWF** comes from a file the browser reads, never uploaded; from a
  URL the page fetches, which works only where the server allows another
  origin (CORS); from `?swf=`; or from a demo. What the page names by a
  relative URL resolves against the site's root, which `app/main.js` finds
  from its own URL, wherever the page is. The page reads a SWF's bytes
  itself, for the header it shows, and gives them to the element with
  `base` set to the URL they came from, so the SWF's own loads resolve as
  if the element had fetched it. Its `allowscriptaccess` is `never`: a
  stranger's SWF does not script the page.
- **Keys** pressed in the player are the SWF's: Starlight's search opens
  on Ctrl or Cmd+K from the window, and the stage stops that key on its
  way there.
- **Isolation**: GitHub Pages sends no headers of a site's choosing, so a
  service worker at the site's root (`src/service-worker.ts`, registered by
  `isolation.ts`) adds COOP and COEP to the site's own responses, for
  every page, and the player's first visit loads it again once it serves
  it ([workers.md](../workers.md)).
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
- **Licences**: `notices/` gives builtin.abc's MPL-2.0 and lists the
  files translated from avmplus and taken from Ruffle, found by their
  headers as the site builds, with the licences of minimp3, libtess2, zlib and
  the LZMA SDK.

`tests/site/run.ts`, part of `pnpm test`, builds the site and checks it in
Chrome under `/swf2es/`: the player's checks, the old addresses, and that
every page of the guide renders and every link within the site leads
somewhere, and that the compatibility page shows figures above zero and
links only to files the repository has. `--serve` serves it to look at.
