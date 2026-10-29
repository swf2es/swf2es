# Loading SWFs and images

A `Loader` is a container whose one child is the root of the SWF it
loaded, and a `LoaderInfo` is made for each `Loader` and one for the main
SWF: a root display object carries its SWF's, and `loaderInfo` and `root`
on a display object are the nearest root's up from it, null off the
display list, as Flash has it (Ruffle's `loaderinfo_root` trace; a
loaded SWF's root is its own root from its constructor on). Its values
are the loaded SWF's: `bytesLoaded` and `bytesTotal`, `content`, `url`
and `loaderURL`, `contentType`, the header's version, frame rate, width
and height, `loader`, `applicationDomain`, `bytes`. The main SWF's
dispatches `init`, final `progress`, and then `complete` at the end of its
first frame, after its scripts and `exitFrame`. A preloader that subscribes
in frame 1 can advance from that final progress before `complete`, as AIR
does when a SWF is streamed over HTTP. `MainLoadProgress` checks that order
in eager and lazy compilation. Content loaded by `loadBytes` keeps its
different sequence: progress precedes its construction, so a listener it
installs in frame 1 sees only `init` and `complete`.

PNG, JPEG and GIF files use the same Loader queue, sniffed from their bytes
and decoded through the host's image decoder. The content is a `Bitmap` with
its own `loaderInfo` and `root`; image dimensions and MIME type become available
after progress and before `INIT`. SWF-only metadata throws Error #2098 for an
image, and dimensions throw #2099 before any content is ready. Alpha capability
comes from the file's format and transparency metadata, including unused
transparent colors. Partial-alpha PNG channels use Flash's eight-bit shift
when premultiplied. The `loader-images`, `loader-image-alpha` and
`loader-image-formats` cases compare these behaviors with AIR; unit tests cover
URL loading, decoder failures, cancellation and replacement during decoding.

`parameters` is a new object at each ask, so a script's changes to one
stay in it. The main SWF's, which the stage's and every root's under it
report too, are the query of the URL the host gave `Scripting` as `url`
and then the flashvars it gave as `parameters`, which override a name
the query has, as Ruffle's do (Flash's order was not checked: its
harness can give neither). A SWF loaded by URL has its URL's query from
its second `PROGRESS` on, decoded, `+` as a space, a name without `=`
empty, an empty name left out and the last of a name kept; one from
bytes has none here, which adl could not tell from the loader's own
query (Ruffle passes that on). A `LoaderContext`'s `parameters` take the place of the
query from the call on, and a value in them that is not a String, null
included, is refused at the call with `IllegalOperationError` #2196. An
unload leaves none (the `loader-parameters` case and the node tests).
The player's AVM1 has no variables yet, so an AVM1 root's `_root`
variables get no flashvars.

The order is Flash's, traced by adl (the `loads` case; the Flash Player
traces in Ruffle's corpus agree where they overlap). `loadBytes` tells
the whole of the progress in the call, `PROGRESS` with nothing loaded and
again with all of it, `bytes` set and `url` still null, and has no
`OPEN`; a `load` of a URL has `OPEN` once the bytes come. The content
comes in a later frame, for `loadBytes` the next, after `ENTER_FRAME`
and before `FRAME_CONSTRUCTED`:
its SWF's code runs, its document class is constructed with `parent` and
`stage` null and its timeline's first frame in place, it gets `ADDED`
while it still has no parent, then `url` and `content` are set and it is
made the `Loader`'s child, `ADDED` again and `ADDED_TO_STAGE` if the
loader is on the stage. Its first frame's script runs in the frame's
script phase, after its parents', and `INIT` and `COMPLETE` follow
`EXIT_FRAME`, before `RENDER`. The content's timeline advances from the
next frame on, with the stage's frame rate. `unload` takes the content
out at once and keeps the `Loader`; a frame script the content had queued
still runs. The URL of content loaded from bytes is the loading SWF's
with `/[[DYNAMIC]]/n` appended, and `ApplicationDomain.currentDomain` is
a new object at each ask, as in Flash, so two are never `==`.

The loaded SWF's code goes through `Codegen` and the runtime as the main
SWF's does (`scripting/loads.ts`). Linking is asynchronous (its ABCs are hashed by `crypto.subtle`), so a load
asked for is compiled and linked between frames, in the order asked, and
each takes its place in the first frame after its code is linked; a host
that steps frames by hand awaits `Scripting.settled()` between them, as
the tests do, to see Flash's frame. Flash has a `loadBytes`' content in
the frame after the call whatever its size (the `loader-bytes-frames`
case): it parses the SWF before that frame's `ENTER_FRAME`, which comes
late by the parse's time, a few to a few tens of milliseconds in adl for
0.5 MB of ABC (8 MB of sounds cost nothing). Its timers count that time:
those due by the frame's slot fire between frames before it, those due
during the parse fire once each in the frame after `ENTER_FRAME`, a
repeating one's lost ticks dropped, and the rest at their times after.
Content counts on the content coming first, as a timer of a second set at
the call that reads the `Loader`'s child. Compiling such an ABC takes a
few hundred milliseconds here, seconds on a slow machine, so
`Player.advance` holds the next frame while a load from bytes due next
still compiles: the frames stop at the frame's slot and do not catch up
the time held; the timers count it, but none due after the slot fires
until the held frame has played, its content made and `INIT` and
`COMPLETE` told, the call in which the load came included. Each wait
lasts ten seconds at most, so that a load that never ends does not stop
the player. Several loads from bytes asked in one frame all come in the
next, here in the order asked; adl completes them in an order of its
own, neither that order nor its reverse. `SymbolClass` bindings are the
library's, since character ids collide across SWFs. The player package
has no I/O: `load` of a URL asks the host for the bytes through a
function the `Scripting` is given, with a resolved URL, method, headers,
copied body and `AbortSignal`. A fetch that fails, or bytes that are no SWF,
end in `IO_ERROR` on the `LoaderInfo` in the frame. `close` drops a
pending load and aborts its fetch; `unload`, and a new load on the same
`Loader`, do that and take the content out at the call, the `LoaderInfo`
knowing nothing again (Ruffle's `loader_reuse` trace), so a `Loader`
never holds two; the content let go of has `UNLOAD` dispatched on the
`LoaderInfo`, its `content` and byte counts already cleared and the child
still attached, before `REMOVED` (the `loads-init` case). A load closed
or replaced from one of its own events, `OPEN`, `PROGRESS`, the content's
constructor or `INIT` among them, ends there: an unload from `INIT` has
no `COMPLETE`, as Flash has none. An `unload` asked for from `REMOVED`
finds the content already let go of, and a load asked for there is the
one that counts. What a `LoaderInfo` knows of its SWF's header
(`swfVersion`, `frameRate`, `width`...) is refused
before the SWF is loaded, Error #2099, as Flash refuses it. `applicationDomain`
is null before loading and after unloading; a byte load publishes its domain
after the synchronous progress events, before its content is placed.
The SWF a `Loader` belongs to, which its content's
`loaderURL` reports and its relative URLs resolve against, is in Flash
the one whose code made it, even before the first load; the runtime does not
track callers, so it is the SWF the `Loader` is on the display list of when
it loads, else the main one (Ruffle's `loader_loaderurl` adds the loader first, as SWFs
usually do).

An AVM1 SWF (no FileAttributes, or one without the ActionScript 3 flag)
loads as Flash loads one into AS3: the content is an `AVM1Movie`, a
`DisplayObject` whose other face is the AVM1 root's clip, so AS3 sees
none of its children; `actionScriptVersion` is 2, and the header's
version, frame rate and size are the SWF's, `parameters` the context's
or the URL's as for an AS3 SWF. `new AVM1Movie()` is refused, #2012.
Flash makes a `loadBytes`' `AVM1Movie` in the call, which names it then,
and has it in the `Loader` at the end of that frame, after `EXIT_FRAME`,
with its `INIT` and `COMPLETE`, the last asked first; the movie keeps its
first frame through the next frame's advance (the `avm1-movie` case, as
adl traces and draws it). One with images comes at the end of the frame
after they are decoded, or ends in #2124 if the decoder refuses them.
One from a URL comes as an AS3 SWF's content does, `OPEN`, the progress
and the child in the frame's construct phase, `INIT` and `COMPLETE` at
its end, and plays on from the next frame: that follows Ruffle, which
loads both kinds alike, not adl, whose harness loads only from bytes.
The `AVM1Movie` is no `InteractiveObject`: hits on its noninteractive
artwork go to its `Loader` (the corpus's `mouse_pick_loader_avm1`). Its
AVM1 buttons and selectable fields take mouse input themselves, without
AS3 mouse events on the Loader. `input/avm1.ts` joins their picks into
the AS3 display-list search, respecting transforms, masks, scrolls,
overlays and `mouseChildren`. Global AVM1 mouse listeners run before the
pick, even in a hidden or detached loaded movie; button events go only
to the winning movie, with hover and capture reconciled as the display
list changes. Each loaded movie reuses `Avm1Pointer`, and unloading drops
its input state. Ordinary AS3 content creates no such input manager.
These rules follow an authored native Flash Player 32 probe.
The movie's timeline plays at the stage's
frame rate as an AVM1 main SWF's does, and, as an AVM1 timeline, has as
many frames as its ShowFrame tags end, whatever its header says, and stays
on its last without an End tag. The loaded movie now runs its AVM1
actions in its own realm, using the parent player's codegen and host
services. A movie from bytes runs its first-frame script after the
following frame's AS3 ENTER_FRAME; a URL-loaded movie runs it in the load
frame. Subsequent frames tick that VM once, and the AS3 timeline walker
skips its subtree. Timeline sounds
and script-driven playback run with the child. Unloading destroys the
child VM and its connections without closing the parent's audio device.
Keyboard and wheel routing into these loaded movies, and `AVM1Movie`'s
`call` and `addCallback`, remain incomplete; those methods still throw #2014.

`LocalConnection` uses one native broker (`player/src/localconnection.ts`)
shared by a player's AS3 and loaded AVM1 movies. A standalone AVM1 player
has its own broker; an embedding may explicitly share a `LocalConnections`
instance across players. Connections live in a map keyed by ASCII-folded
names, prefixed with the SWF's domain unless the name starts with `_`.
Messages snapshot arguments as bounded bytes (40 KiB) and use the
sender's existing host-event queue. AVM1 sends AMF0; AS3 sends AMF3 to
preserve ByteArray, XML, Vector and class aliases, converting the snapshot
to AMF0 only when an AVM1 receiver needs it. AMF3 scratch buffers are
reused except for externalizable streams that may escape the call. A broker
with no messages does no frame work. Receiver methods, domain permissions
and sender status events enter the appropriate VM, never sharing live script objects. Closing or
destroying a receiver frees its name. This is in-process messaging, not
Flash's machine-wide transport: browser tabs and desktop processes do not
share connections.

`URLStream` uses the same host fetch, which gives bytes (or a failure), HTTP
status and headers. A `URLRequest`'s GET string or URLVariables data is appended to the query;
GET ByteArray data is currently left out and has not been checked against Flash;
other methods send its string, URLVariables or ByteArray data as the body.
Only POST forwards custom headers in the browser player, as Flash Player does;
the host's fetch decides which requests its environment permits. Each
request says what it is for (`purpose`), as Flash's security model told
them apart: a Loader's or Sound's `content`, which Flash let a SWF load
from any domain, a URLStream's `data`, which it let a SWF read from
another domain only as that domain's policy file allowed, and
sendToURL's `send`; a browser's fetch ignores it, and a host that judges
requests as Flash did (the desktop app) reads it. Such a host also gets
the policy files `Security.loadPolicyFile` names, resolved against the
SWF (`loadPolicyFile`), and names the sandbox `Security.sandboxType`
reports (`sandboxType`, "remote" by default). The result
arrives on the player thread in a later frame.
A successful stream reports `OPEN`, `PROGRESS`, `HTTP_STATUS`, `COMPLETE`;
a failed one reports `HTTP_STATUS` before `IO_ERROR`. A URL load through
`Loader` reports status on its `LoaderInfo` between `INIT` and `COMPLETE`,
or before `IO_ERROR` on failure. A local file reports status 0 and no
response headers. The host's response URL and headers are not surfaced by
the Flash Player path; AIR-only `HTTP_RESPONSE_STATUS` is not sent.
Stream fetches are independent of Loader's ordered preparation, so a
stalled stream cannot hold up a later Loader; `settled()` waits for both
when a host explicitly asks it to. A new load or `close` aborts the old
request, and `close` without one throws IOError #2029 as Flash does; reads use the
runtime's ByteArray DataInput implementation. Relative
URLs resolve against the main SWF until the runtime tracks the creator of
each stream.

`navigateToURL` hands the request, taken and resolved as `URLStream`'s is,
and the window name (null when none is given, "blank" in any case and
with or without its underscore as `_blank`, as Ruffle's corpus records
Flash doing) to `Scripting`'s `navigate` host; an empty URL is ignored, as
Ruffle's navigators ignore it. `sendToURL` sends its request through the
host fetch and drops the response, as Flash ignores it. Both throw
TypeError #2007 for a null request, then for a null `url`, as adl does.

A browser navigates only by GET or POST, so a request with any other
method goes as a GET, its data appended to the query, as Flash's does from
a browser.

The browser's default `navigate` is deliberately conservative, since a SWF
is not to be trusted by the page that embeds it. Only `http:` and `https:`
URLs open, so a `javascript:` URL cannot run script in the page. The
targets that would replace the page or a frame around it, `_self`,
`_parent`, `_top` and an empty name, are dropped, as Ruffle's web navigator
drops them without script access. Every other target, a name included,
opens a new window (`_blank`): a name reaches an existing window or frame
of that name, the page's own among them, even with `noopener`, so naming a
window to reuse it does not work. A GET opens with `window.open` and
`noopener`; a POST goes as a hidden form with `rel="noopener"` into a new
window, the only way a browser posts into one, its body read as form data
whatever it is, as Ruffle sends a string's, so a JSON or ByteArray body is
sent form-encoded. A host that trusts its SWFs further, or models
`allowScriptAccess` and `allowNetworking`, gives a `navigate` of its own.
Without a window, as in node, nothing opens; the test page gives none.

`Socket` uses an optional host transport supplied to `Scripting`. The host
opens the TCP connection and reports open, bytes, close and failure; the
player delivers those reports on its next frame. ActionScript's reads and
buffered writes use ByteArray's DataInput/DataOutput implementation; `flush`
sends the pending bytes. A local close invalidates late host reports and
does not dispatch `CLOSE`, while a remote close does. Without a socket host,
connect fails on a later frame; reads, writes and close on an invalid socket
throw IOError #2002. The browser player has no default raw TCP transport:
an embedding page must provide one through its own permitted bridge.
`@swf2es/player-hosts/node` supplies a direct Node TCP transport;
`@swf2es/player-hosts/websocket` sends binary frames through a WebSocket
relay whose URL the embedder chooses. They live outside `player` so its
browser entrypoint has no Node I/O dependency. WebSocket message boundaries
are only transport chunks; ActionScript reads the resulting byte stream.
AIR's `localAddress`, `localPort`, `remoteAddress` and `remotePort` read as
adl's do: null and 0 before a connection and after `close()`, "" and 0
while one opens and after it fails, and once open the ends the host gives
with its open report, kept after the peer closes. The Node host gives its
socket's; a WebSocket relay's are not the script's, so they stay "" and 0,
what Flash reads while it does not know them.

The Flash cases use `loadBytes`, the inner SWF carried in the outer's
script as base64; the oracle runs under AIR, which refuses code from
bytes unless the `LoaderContext` has `allowCodeImport`, which Flash
Player does not need.

The player's application domains are the runtime's and the compiler's
(see [Application domains](runtime.md#application-domains) and [Parsing, linking and
verifying](compiler.md#parsing-linking-and-verifying)). The root is Flash's system
domain, the player's own classes; the main SWF loads into a child of it
(`Scripting.mainDomain`), so `new ApplicationDomain(null)` sees none of
the main SWF's classes, and the main SWF's `parentDomain` is null, as
Flash hides the system domain. A Loader loads into its `LoaderContext`'s
`applicationDomain`, or by default into a new child of the domain of the
code that asked: the parent cannot see the loaded SWF's classes by name,
a class it defines again is ignored for the one its domain's chain has,
and `LoaderInfo.applicationDomain.getDefinition` finds its own
(`loader_duplicate_class`). The domain of the code that asks, for
`ApplicationDomain.currentDomain`, `getDefinitionByName` and a load's
default, is `Runtime.codeDomain`'s, so each module is evaluated under a
`sourceURL` of its own, or as a script of its own (`scripting/evaluate.ts`), and the player's own modules load as builtin,
whose frames do not count, as avmplus skips builtin code. SymbolClass
binds a character to the class its name finds in the SWF's domain, by
the module that defines it, so the same name in another domain is
another class; a class keeps the symbol first bound to it, so another
SWF binding a parent's class makes its own timeline's instances of the
class, but `new` makes the first's. `ApplicationDomain.getDefinition`
lets the error of a lazy script's initializer through, running it again
at each call, where `hasDefinition` says false and a lookup by code keeps
the script as run, as avmplus does (`Runtime.definitionNamed`, the
`definitions` case).

A SWF the player loads is in the position the oracle's harness puts
every SWF in, so what the harness could not judge for a main movie, the
document class's `stage` in its constructor among it, compares exactly
once the case loads its SWF.
