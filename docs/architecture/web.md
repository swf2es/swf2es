# The web embedding

`@swf2es/web` (`packages/web`) plays SWFs on any page, as Flash's plug-in
did and a browser extension will: a custom element, `<swf2es-player>`,
defined as the module loads, a function that swaps a page's Flash tags
for it, and a configuration the page sets once. It depends on the player
and on player-hosts, whose WebSocket relay carries flash.net.Socket.

The element (`element.ts`) takes an `<embed>`'s attributes: `src`,
`width` and `height` (a number is pixels, as an `<embed>`'s, anything
else a CSS length), `flashvars`, `scale`, `salign`, `wmode`, `bgcolor`,
`base`, `allowscriptaccess`, `allownetworking` and `quality`, and
`workers` of its own ([Workers in the page](#workers-in-the-page)). Its
JavaScript side is `load(url | ArrayBuffer | Uint8Array)`, which plays a SWF in place of the
one playing; `ready`, which resolves once the SWF loading plays and
rejects with what kept it from playing; `destroy()`; and the events
`load`, `error` (the error in `detail`) and `fscommand`, which also goes
to the page's `<id>_DoFSCommand` as the plug-in's did. Its size is its
attributes', or its SWF's stage, in `:host` rules the page's own styles
override. A SWF with no ActionScript 3 plays with no Scripting.

## Showing a player

`playback.ts` shows a player in the element: a `RenderView` whose
screen is the element's box taken into stage coordinates, and whose
resolution is the device's pixels to a stage pixel, so the canvas covers
the box and the view's pointer mapping, which reads the canvas's box, holds
for every placement. As in Flash, what lies past the stage's edges shows
in showAll's and noScale's margins, and a press there reaches the stage at
coordinates past its edges (negative to the left and above); the stage
keeps the SWF's size. exactFit, which leaves no margin, keeps a canvas of
the stage's size stretched by CSS. `layout.ts` places it as Flash's plug-in did:
showAll fits the stage whole, noBorder fills the element and crops,
exactFit stretches it, noScale leaves it its size, and `salign`'s T, B,
L and R hold the edges they name, the stage centred along an axis that
names neither. A stretched stage is drawn as fine as its finer axis
needs; no side passes 4096 device pixels. A ResizeObserver places it
again as the element changes, and each animation frame checks
`devicePixelRatio`, which a move to another display or a zoom changes.
`wmode="transparent"` draws no background, so the page shows through;
otherwise the stage's colour, `bgcolor`'s if given, fills the element
around the stage too. Each animation frame advances the player by the
time passed and draws when `changes` moved or the element did. The keys
go to the element, focusable and focused as it is pressed, as a plug-in
had them only while focused.

It draws by the stage's quality (`Player.quality`): the element's
`quality` attribute at the start and as the page changes it, then what a
script sets, `Stage.quality` or AVM1's `_quality`, from the next frame.
Flash draws edges aliased and smooths no bitmap at low, a Bitmap's or a
bitmap fill's that asks for it among them, and supersamples on a grid
of 2×2 at medium and 4×4 at high and best (the `stage-quality-*` cases).
The canvas is not multisampled; the buffers the stage is drawn into
are, resolved onto it, but at low, where `RenderView.quality` also
smooths no bitmap. Medium and high are the GPU's multisampling, which
costs the GPU memory and bandwidth but no shading: supersampling, 4 or
16 times the pixels, would cost more than the edges show. The stage's
buffers and the filter and blend layers take 4 samples at medium, 8 at
high and 16 at best, as many as the GPU allows (`RenderView.samples`),
remade at the next frame. Flash covers an edge with 16 at high; 8 look alike but on
the longest, shallowest edges, at half the memory, and best takes 16.
Every sample costs its pixels 8 bytes, colour and depth-stencil, so a
canvas larger than about 1080p takes fewer (`fittingSamples`: what fits
256 MB, 4 at least): 8 at 1440p, 4 at 4K. A BitmapData's draw at low
quality smooths no bitmap either.

## The page's configuration

Fills and lines are drawn through `@swf2es/native/render`. Each
`RenderView` makes a `Tessellator` of its own, which compiles the render
module as it is made, unless it is given one (`fillTessellator`), and
disposes its Wasm scratch with itself. Where the page cannot load or
compile the module, the view throws and the SWF does not play, the
element saying why. A shape layer's fills are tessellated in one call
into one position and one index buffer (`packages/native/README.md`); a
fill the tessellator refuses (not finite, malformed or past its memory)
is left out. The renderer's geometry owns its buffers independently of
Wasm scratch, including for context restoration.

`configure` (`config.ts`) sets what every player on the page shares:
`libraries`, the URLs of builtin.abc and playerglobal.abc, which the page
gives, as playerglobal is Adobe's and cannot ship with swf2es; `codegen`, codegen.wasm's URL, by
default what the import map gives `@swf2es/codegen/codegen.wasm`;
`socketProxy`, a function from a socket's host and port to a WebSocket
relay's URL or a list of them as Ruffle's, a socket without one refused
with #2031; `sockets`, a SocketHost of the embedder's own that takes the
relays' place, as the desktop app's, which reaches TCP itself; `fetch`,
an embedder's fetch in place of the browser's for what the SWFs load and
for the SWF the element plays (purpose `movie`), with `loadPolicyFile`
and `sandboxType` for the player, as the desktop app judges requests by
Flash's sandboxes and policy files rather than CORS; and
`cache`. The page fetches and compiles codegen.wasm once and the
libraries once, and each player instantiates the compiled module
and reads the same bytes. A player has a Codegen of its own: Scripting
resets the compiler it is given, and its domains' numbers are its own,
so two players on one instance would take each other's over. `cache:
true` gives every player one IndexedDB module cache
(`player-hosts/indexeddb`, see [Caching modules](modules.md#caching-modules)); it
is off by default, as the player's is, a first visit being slower for
the writes.

## Workers in the page

`workers`, on by default as Flash had them, gives each player a
`webWorkerHost` (`player-hosts/workers`, see [Workers](services.md#workers)); the
element's `workers` attribute, `"true"` or `"false"`, decides for its own
SWFs over the configuration, and off, `Worker.isSupported` is false. A
player's host starts Web Workers ahead only for a SWF whose ABCs name
`WorkerDomain`, and the element awaits them before the SWF's first
frame, as Crossbridge's start a worker and wait for it in one script, for
ten seconds at most, so that a script that never says it loaded keeps
no SWF from playing; a
SWF that names no worker starts none, and one that a loaded SWF starts
later starts as it is asked for. The workers started ahead are the
page's, shared by its players, and go ten seconds after the last player
that used them does, the element's destroy among them. A host's
`ready` waits for each worker it started ahead though another player's
host took it before it loaded. The element imports
`player-hosts/workers` only when a SWF has workers, so a page whose
import map does not name it plays its SWFs without them.

A Web Worker sees no import map, so the worker script is
`player-hosts`' `dist/thread/`: `build-thread.ts`, after tsc, copies
`web-worker.js` and every module it imports, from player-hosts and the
packages under it, with each bare specifier made a relative path inside
the tree. The tree resolves wherever the package is served, under a
page's import map, from a CDN or from the demo site and the desktop app
as they serve the packages, at the cost of its 3.9 MB loaded again by
the workers; `webWorkerHost` finds it beside its own module.
`workerUrl` names another script, a bundler's. A browser starts a
worker only on a script of the page's origin, and throws SecurityError
for another's, so a script from another origin starts through a `blob:`
module of the page's whose one line imports it: the script needs CORS,
as a CDN serves it, and a Content-Security-Policy that names
`worker-src` (or `script-src`) must allow `blob:`; where it does not,
the worker never runs, and the player reports its thread's failure
(where the browser refuses at once, `Worker.start` throws 3807). Shared memory
needs a cross-origin isolated page, which the demo site and the desktop
app are (see [docs/workers.md](../workers.md)); elsewhere workers pass
messages, and sharing memory with one throws the error that says so.

## ExternalInterface in the page

ExternalInterface (`external.ts`) speaks Flash's protocol, but takes
every call from a SWF as data. playerglobal's `call` first offers the
JavaScript it writes, `name(args)` inside `__flash__toXML`, which writes
an object's keys unquoted, as Flash's did, so a SWF's key such as
`a:(code),b` would run in the page: the host declines every one, and
playerglobal sends the call as an XML invocation instead. Its name is
read as written, unescaped, up to the first
`" returntype="xml"><arguments>`,
which the arguments after it cannot move, and its arguments parsed as
data. A name that is a path, `a.b.c` give or take spaces, is the
function that path finds, called on what holds it. Any other name, an
inline function's source as pages wrote them (`function(){return
window.location.href;}`), is evaluated alone, `(name)`, as the code the
SWF gave it to be, and what it gives applied to the arguments, without
an object for `this`; the arguments never reach eval.

A callback the SWF adds becomes a method of the element, called with an XML invocation
and answered in XML, so the page gets plain arrays and objects back,
synchronously, as from Flash; one that throws is reported and throws
"Error calling method on NPObject" into the page, an `<exception>`,
which marshallExceptions sends, throws its message, and one the page
kept after the SWF stopped does nothing. A callback whose name the
element already has, its own methods' or the DOM's (`destroy`,
`getAttribute`, `dispatchEvent`), or one of the protocols other code
looks for on any object (`then`, which would make the element a
thenable, `toJSON`, `handleEvent`), is refused with a warning, and the
element calls its own internals as `#private` methods and the DOM's
through functions taken as the module loads, never looked up on itself.
A value met again inside itself crosses as null, where Flash recursed
until its stack ran out.

`allowscriptaccess` is `always`, `never`, or by
default `sameDomain`, the calling SWF's origin the page's, an opaque
origin no one's; a SWF it denies finds ExternalInterface unavailable and
its fscommand dropped, `available` false and a call throwing #2067, as
Ruffle has it, where Flash's plug-in threw a SecurityError.
`allownetworking` is `all`, `internal`, which takes ExternalInterface,
fscommand, navigateToURL and sendToURL away (Scripting's `sendToUrl`), or
`none`, which takes every fetch, socket and WebSocket too; Flash threw SecurityErrors for them, where
here they fail as networks do. `objectID` is the element's id, else its
name, as the plug-in's was the `<object>`'s id or the `<embed>`'s name.

## Replacing Flash tags

`replaceFlash(root)` (`replace.ts`) finds the Flash tags under `root`:
an `<object>` or `<embed>` of Flash's type, an `<object>` of its ActiveX
class, or one whose movie is a .swf. Each outermost one is replaced by
an element carrying what it and the Flash tags nested in it as
fallbacks say, the outer first: an IE `<object>`'s `<param>`s, then an
inner `<embed>`'s attributes for what those left out; and its id, name,
class, style, width and height, so the page's scripts and styles find
it. `watchFlash(root)` does it again for each tag the page adds later,
or makes Flash later by setting its src, type, data, classid or a
`<param>`'s value, until it is stopped. Where there is no
`customElements` registry, as in an extension's isolated world, where
it is null, the element is not defined and replaceFlash replaces
nothing.

## Letting go

`destroy()` (or the element's removal from the page, a microtask later,
so that a move is not one) releases everything a load holds: the
animation frame, the ResizeObserver, the pointer and keyboard bindings,
the renderer, which loses its GL context as it goes, the callbacks on
the element, the fetch of the SWF itself, and the player through
`Player.destroy` (see [Shutting down](services.md#shutting-down)): its
SharedObjects written, its sounds and AudioContext, its sockets and
fetches. A load that is still under way when the next load
or a destroy comes stops at its next step, and what it made is let go.

## Tests and what is missing

`tests/web/run.ts` plays a page in headless Chrome with two elements,
for two of the player tests' SWFs, and two Flash tags for
replaceFlash, a nested `<object>` and `<embed>` and an ActiveX
`<object>` with `allowScriptAccess` never, at two device pixels a CSS
pixel. It checks that each boots and draws (from a screenshot), the
tags' parameters, ExternalInterface both ways and none where it is
denied, a SWF's callbacks named `destroy`, `getAttribute` and
`dispatchEvent` refused, an object key written as code not run, one
fetch and compile of codegen.wasm and one fetch of each library, the canvas's size as the element widens, and that destroy and
removal let go: 20 elements made and destroyed leave no player and no
codegen instance after a collection, no WebSocket or AudioContext
open, and the heap within 256 KB of each.

Not done yet: the SWF's scripts see Flash Player's showAll, the stage
the SWF's size, whatever the element's `scale`, and noScale does not
resize the stage or dispatch Event.RESIZE (but under the Stage3D
opt-in's live Stage layout); AVM1 custom context menus are not implemented; a
`javascript:` URL from navigateToURL never runs, allowed or not; and
`document[name]`, which found an `<embed>` by its name, does not find
the element. Nor can a page give the element modules compiled ahead of
time yet: its only cache is `cache`'s IndexedDB.

## A browser extension, later

A content script's isolated world has no registry (above), so the element
must be defined in the page's main world, where the page's
Content-Security-Policy applies to it. The player evaluates the modules it
compiles with `new Function` (on JavaScriptCore, as Blob URLs' scripts
where `blob:` is allowed, else by `Function` too),
and codegen is WebAssembly, so a page needs `'unsafe-eval'` and
`'wasm-unsafe-eval'` in its script-src, which an extension cannot lift for
the page, unless every module is compiled ahead of time and imported (see
[Pages without 'unsafe-eval'](modules.md#pages-without-unsafe-eval)). A page
with `object-src 'none'` had no Flash tags that worked, but replaceFlash
swaps them all the same. And under a CSP without eval, inline-function
calls come to nothing, but a call by a path still reaches any function
a global path names, `eval` itself among them: script access is the
page's whole, as it was in Flash.
