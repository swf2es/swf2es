# The host's services

## ExternalInterface

`ExternalInterface` is available only when the embedding page gives
`Scripting` an `externalInterface` host. Its public methods stay in
`playerglobal.abc`; the player supplies their private native bridge:
initialization, enumerable property names, callbacks, and the synchronous
JavaScript and XML call paths. The host receives the JavaScript source or
XML invocation and decides what to execute; the player does not evaluate
script text. Without a host, `available` is false, `objectID` is null,
and calls and callback registration throw Error #2067 as Flash does in a
container without a bridge.

A callback the page calls goes through playerglobal's `_callIn` either
way it can: with an array of AVM2 values, applied as they are and
answered with JavaScript source (`_toJS`), which the host would have to
evaluate; or, given null for the array, read from an XML invocation, as
Flash's plug-in sent one, whose arrays and objects playerglobal makes
AS3 ones, and answered in XML for `returntype="xml"`. The browser host
(`@swf2es/web`, see [The web embedding](web.md#the-web-embedding)) takes the
second, so a page's calls into a SWF need no eval.

### Which SWF is calling

A host may refuse some SWFs (`allows`): each native asks it about the SWF
whose code is calling, as Flash checked allowScriptAccess against the
calling SWF's domain, so a child that a same-domain SWF loads from
elsewhere finds ExternalInterface as if there were no bridge. fscommand
gives its host the same URLs. The check never takes the main SWF's word
where it cannot tell (`Code.securityUrls`).

The caller is a SWF only when its own code called the gate directly,
which the player reads from the stack:

- The stack is taken whole, the engine's `stackTraceLimit` lifted for that
  one capture: its default of ten frames lost the caller under an
  `Array.forEach` of `ExternalInterface.call`.
- The player's frames above the native are counted off, then the library
  function the SWF called (playerglobal's `ExternalInterface.call`,
  `fscommand`, `Loader.loadBytes`), and the frame after must be a SWF
  module's: a direct call.
- `fscommand`, a package-level function, a SWF reaches by its name through
  the runtime, `Runtime.call`, `callValue` and the method closure's
  wrapper, so that one chain is accepted too, frame for frame, at the
  sites the player measures once, at the first check, by making such a
  call to a probe of its own (`Code.byNameChain`) (the build's own sites, minified or not; if the probe does
  not see the chain, no call matches).
- Anything else there, the player's or the runtime's code that calls a
  function value (a listener a dispatchEvent calls, an Array's forEach or
  sort, `.call`, `.apply`, `o.f()`, a timer), or a frame line it cannot
  read, leaves the caller untold.

A frame line's location is read inside its last parentheses in V8's
frames, and after its first `@` in the others, whose URLs may hold one
(`/npm/p@1.0/m.js`) (`avm2.frameSites`), so a name cannot
stand for a location; and a SWF cannot set one anyway: codegen names
functions, methods, getters and classes from `[A-Za-z0-9_$]`, a SWF has no
eval or `new Function`, an AS3 function's JavaScript `name` is not its to
set, and a module's `sourceURL` is the player's.

Where the caller is untold, the URL of every SWF whose code was ever
loaded is asked, and all must pass, so single-origin content works from
timers and callbacks, and mixed-origin content fails closed. Ever, not
now: an unloaded child's timers and closures outlive its modules, which
the player holds weakly, so the URLs are kept in a set that never
shrinks. A loadBytes' content is the calling SWF's, as Flash gave it the
loader's domain, not the main SWF's; where the caller cannot be told, it
is the one origin's while only one ever loaded, else no one's, an opaque
URL no check allows. A load a redirect took elsewhere is the final URL's
(`FetchResult.url`), for its LoaderInfo and its checks alike.

That has a cost in mixed-origin content: ExternalInterface reached by a
late-bound path from the SWF's own code, `ExternalInterface.call.apply(...)`,
the common `callJS(...args)` wrapper that uses `.apply`, `.call`, `o.call`
on an Object-typed reference, `getDefinitionByName(...)["call"]`, is
treated as an untold caller and denied. A `Function`-typed local called as
`f(...)` goes the same way through the runtime as a call by name, and
counts as the calling SWF's. Single-origin content is unaffected.

Only V8's stacks are read so. JavaScriptCore elides tail calls, which the
runtime keeps out of its call paths, and names a SWF's module by its Blob
URL, but the libraries' modules, made by `Function` there, name no script,
as a native's frame does: a frame that names none could be either, so its
stacks, and SpiderMonkey's, which have the same form, leave every caller
untold until the libraries name theirs too. If the page froze
`Error.stackTraceLimit` (SES lockdown), the caller is untold too.

The player has no sandbox between SWFs, though, and the check knows
only which SWF's code made the call. A cross-origin child can call the
main SWF's functions, or a grandchild's: a main-SWF function that
forwards its arguments to ExternalInterface acts as the main SWF for
whichever SWF called it. Main-SWF code that itself calls a function
value a child supplied, ExternalInterface.call returned by a child's
getter, fetched from a Worker's shared property, or kept in a reference
the child stored, fails closed on V8 where it goes through `.call`,
`.apply` or a property call (`o.f()`), but a plain `f(...)` of a local
cannot be told from a call by name, and acts as the main SWF. A page that
loads SWFs it does not trust beside ones it does should give none of them
script access.

## AIR's WebSocket

AIR 51's `air.net.WebSocket` and `flash.events.WebSocketEvent` are
newer than the oracle's playerglobal, and Adobe's airglobal that has
them may not be committed. The player declares them itself, in AS3 of its
own under `as3/air/src` (`air/net/WebSocket.as`,
`flash/events/WebSocketEvent.as`), with AIR's API as adl shows it. `tests/player/air-library.ts` compiles them with ASC in the
oracle's container against builtin and playerglobal into one ABC,
committed as `playerglobal/air-library.ts`, and a unit test compiles them
again and compares. ASC keeps no default values for a native method's
parameters, so `connect` and `close` are AS3 calling private natives.
Loaded as a builtin, which native methods need, an unmarked URI that
playerglobal marks, the empty one or `flash.events`, would be VM-internal
and hidden from the SWF's code (see
[Parsing, linking and verifying](compiler.md#parsing-linking-and-verifying)), so the script marks each
package namespace's URI with API version 0, every version's, through a
marked copy of its string. A host that plays AIR content passes
`airLibrary` to `loadLibraries` after playerglobal, and `air: true` to
`Scripting` for the rest of AIR's API, with Security.sandboxType
"application", as AIR's application sandbox; Flash Player has no such
classes, so neither is the default.

The natives (`playerglobal/air/net/WebSocket.ts`) run over a
`WebSocketHost` (`hosts.ts`), by default the global WebSocket, a
browser's or node's; `webSocket: null` has every connect fail, and the
element takes an embedder's own as `configure({ webSockets })`, as the
desktop app's, whose main process holds the connections
([WebSockets](desktop.md#websockets)). What they
throw and dispatch is what adl does: TypeError 2007 for a null URL, then
IllegalOperationError 2082 for a second connect, a WebSocket connecting
only once, then ArgumentError 2147 for a scheme other than `ws://` or
`wss://`; ArgumentError 1508 for data that is not a String or a
ByteArray, whose bytes go from the start whatever the opcode; Event.CONNECT,
WebSocketEvent.DATA with a ByteArray each read of `data` rewinds, and
Event.CLOSE when the server closes, with `closeReason` its code, none
after `close()`; IOError 2002 for a send or close once closed;
ArgumentError 2014 for setting `protocol` once open, which becomes the
subprotocol the server chose, `connect`'s vector offered, not
`protocol`. A send or close while connecting ends the connection, an
IOErrorEvent with the URL and a close, as adl's handshake breaks on the
frame. A failed connection is an IOErrorEvent with its host, as adl's
refused one; a browser does not tell a refused connection from a
refused handshake, which adl reports with the URL and a close. A host
that throws a `SecurityError`, as a browser does for a blocked port,
gives a SecurityErrorEvent. Before connect, where adl crashes, a send or
close throws IOError 2002. `startServer` throws AIR's IllegalOperationError
for a method its profile lacks, as `Updater.update` in adl.

A browser sends no frame but text, binary and close, and close codes
1000 and 3000 to 4999 alone. AIR sends any opcode's low four bits as
they are: text and binary go, `fmtCLOSE` closes with the payload's
first two bytes as the code (AIR sends no reason either, and then
dispatches the close), and pings, pongs and reserved opcodes are
dropped, since the browser answers the server's pings itself and AIR
dispatches nothing for a pong. `close` with a code a browser refuses
closes without one. There is no `certificateError`: a browser rejects a
bad certificate as any failed connection. A text message's leading BOM
is sent, as AIR sends the bytes, but one received is gone, as a browser
decodes it away, where adl's `data` keeps its three bytes. Two of adl's
races the player does not run: a send in the close listener of a
connection a send or close ended while connecting goes in adl, where it
throws #2002 here, and adl at times dispatches a close after `close()`
when a send goes out while it closes, where the player never does.
WebSocketEvent has no `clone` of its own, in AIR as here, so a
redispatched one is a plain Event.

`Player.destroy` (`Scripting.destroy`) closes every WebSocket and
flash.net.Socket still open, as [Shutting down](#shutting-down) tells.
Not done yet: one is not closed when its SWF alone is unloaded. Where adl is at fault the
player is not: adl stops reading at an empty message, which the player
dispatches, and a close frame without a code throws #2030 in it.


## AIR's application and its window

In AIR (`air: true`), `NativeApplication.nativeApplication` and
`Stage.nativeWindow` stand for the application the host runs, which it
describes with an `AirApplication` (`hosts.ts`, Scripting's
`application`): the descriptor's XML and id, which `applicationDescriptor`
and `applicationID` give, the launch's arguments, a window, and what
`exit` does. Without one, the application has no window, as a player in
a page has none, and was launched with no arguments.

The launch reaches each `InvokeEvent.INVOKE` listener once it listens,
as adl hands it out: one added in the document class's constructor has
it before the first frame's ENTER_FRAME, one added in a frame's scripts
at that frame's end (`afterExitFrame`), each once and the others not
again; a script's own InvokeEvent goes to every listener, as any event
does (`playerglobal/flash/desktop/NativeApplication.ts`). The window
(`playerglobal/flash/display/NativeWindow.ts`) reads and sets the host's
`AirWindow`: its bounds on the screen, frame included, as AIR's are,
while the stage keeps the size its scale mode gives it; its title, state,
visibility and focus; and `globalToScreen` past the frame's border and
title bar, by the window's `stageOffset`. A window a script opens itself
is not supported. Where the host does not say, the values are adl's
(`NativeApplication.test.ts` holds them to what adl traced); a browser's
or Electron's window has no menu, dock icon or tray of AIR's, so the
`supports` flags are false.

`flash.display.Screen` (`playerglobal/flash/display/Screen.ts`) has the
screens the host's `AirApplication.screens` gives, each with its bounds on
the desktop the window's bounds are on, the part of it the system's bars
leave free, its colour depth and whether it is the main one: a page's one
screen (`@swf2es/web`'s `pageScreens`, from `window.screen`), the system's
displays in the desktop app, and without a host one screen of the screen
capabilities' size. `colorDepth` counts the bits a pixel is kept in, as
AIR does: adl says 32 on a desktop of true colour, where a browser's
`screen.colorDepth` and Electron's display say 24, the bits of its red,
green and blue, so a host's 24 reads as 32 (`airColorDepth`). A host's 30,
a deep-colour screen's, reads as 32 too, its pixels being kept in 32 bits
(a choice: AIR documents the property only as the screen's bits, and none
was at hand to measure); 16 and 8, and anything past 32, read as the host
counts them. As adl has them, `screens`, `mainScreen` and
`getScreensForRectangle` make new Screen objects at every call, each
keeping its two Rectangles; `getScreensForRectangle` rounds the
rectangle's x, y, width and height each to an integer, a half to the even
one, and gives the screens it shares any area with, in `screens`' order,
so one that only touches a screen's edge, or has no area, finds none;
`new Screen()` throws ArgumentError 2012, and nothing is dispatched on a
Screen (`Screen.test.ts`).

## AIR's file system

In AIR, `flash.filesystem.File` reads the host's file system through a
`FileSystemHost` (`hosts.ts`, Scripting's `fileSystem`): synchronous, as
File's properties are, with native absolute paths of the host's system,
POSIX or Windows by its separator, and the directories AIR names. A File
keeps a native path and where its URL starts
(`playerglobal/flash/filesystem/File.ts`, the paths in `paths.ts`): the
file system's root (`file:`), the application's directory (`app:/`) or its
storage's (`app-storage:/`). It keeps that start as paths resolve and as
it goes up, never climbing out of `app:/`, whose `parent` is null; URLs
encode each segment as `encodeURIComponent` does. The constructor, `url`
and `resolvePath` take a native path or a `file:`, `app:` or
`app-storage:` URL. A relative path is refused with ArgumentError 2004, a
File made with no path throws Error 2037, and what reads a file that is
not there throws Error 3003 (3007 for listing a file). FileReference's
`name`, `size`, dates and `type` read a File's on disk. The launch's
`InvokeEvent` carries the directory it was launched from as a File. What
writes, the dialogs and the asynchronous methods are not supported yet.
`File.test.ts` holds all of it to what adl traced for the same scripts,
with a POSIX host's paths in place of Windows'.

## AIR applications in the desktop app

The desktop app (`apps/desktop`) runs an AIR application by its
descriptor, adl's way (`app.xml [root-dir] [-- arguments...]`; the
descriptor read in `main/descriptor.ts`, the launch in `main/air.ts`).
`@swf2es/web`'s `configure({ air })` makes the element play as AIR does:
AIR's library loaded after playerglobal, `air: true`, the host's
`AirApplication` and `FileSystemHost`, and Security.sandboxType
"application". The renderer gives them over the shell
(`renderer/air.ts`): the window's state, the displays, and `stat` and `list`, by
synchronous messages, as File and NativeWindow read; its app:,
app-storage: and file: URLs are read through the shell too. The main
process answers them only while the application the user opened plays
(`Sandbox.playApplication`, granted as the page reads its content SWF),
and its requests and sockets go unjudged, without policy files or a
prompt, as AIR's application sandbox has them (`network.ts`'s
"application" movie). `tests/desktop/smoke.ts` runs one in headless
Electron.

## Full screen

`Stage.displayState` asks the host's `FullScreenHost` (`hosts.ts`):
`allowed` is the embedding's allowFullScreen and
allowFullScreenInteractive, `request` goes full screen or refuses, and
`exit` leaves; the host tells of what no script asked for, the user's Esc
say, with `Scripting.fullScreen.hostChanged`. `scripting/full-screen.ts`
keeps the state as adl (AIR 51.3) has it: the stage is in full screen, and
its `FullScreenEvent.FULL_SCREEN` dispatched, before the setter returns,
from a timer as from a click; nothing is dispatched for a state the stage
is in, nor between `"fullScreen"` and `"fullScreenInteractive"`; another
string throws ArgumentError #2008, null TypeError #2007. The event's
`interactive` is false in adl even for the interactive state, and
`allowsFullScreenInteractive` false though it works; outside AIR both
follow the host. A host that refuses throws SecurityError #2152, Flash
Player's without allowFullScreen or outside a click or key, which adl
never throws and could not show. `mouseLock` may be set only in full
screen (Error #3707, even for false) and its end clears it, and the
window's `restore()` and `minimize()` leave it first.

The stage keeps its size in full screen but in noScale, where it is the
screen's, and Event.RESIZE follows as for any change of its box: before
the FullScreenEvent where the host's box has changed by then, after it
where it changes later, as a window's does. `fullScreenSourceRect` is
kept in any state, read back as a copy, and in full screen that part of
the stage alone is drawn, fitted to the screen and centred whatever the
scale mode and alignment, the rest the stage's colour; in noScale the
stage is the rect's size. A rect with no area is reported but draws as
the one before it. adl dispatches two more RESIZEs that change no size as
it leaves full screen in noScale; the player none. Without a host, as in
node, the stage stays `"normal"` and nothing throws. AVM1's
`Stage.displayState` is not there yet.

## Screen capabilities

`flash.system.Capabilities` reads screen resolution, pixel aspect ratio and
DPI from the `Scripting` instance. A host may supply any of the four values
through `screenCapabilities`; omitted values fall back separately. Values are
copied when the player is made, so another player can report a different
screen. By default, resolution comes from the browser's `screen` (zero in a
non-browser host), pixel aspect ratio is 1 and DPI is 72. The corpus harness
supplies the screen on which its Flash traces were recorded.

## Globalization

`flash.globalization` (`playerglobal/flash/globalization/`) is Flash on
Windows' as AIR's adl shows it (the `*-formatter-natives`,
`collator-natives`, `string-tools-natives` and `locale-id-natives` cases),
with its locale data from the host's `Intl`, ICU's, where Flash takes the
system's. Its rules are its own and are followed here; only the data is
ICU's.

- **Locales.** A name is kept as Flash keeps it: one it takes apart, its
  subtags parted by single hyphens or underscores, canonical (`EN_us` as
  `en-US`, variants in upper case), one parted otherwise as it came
  (`en--us`, `en.US`, `en US`), one it cannot take apart (extensions, a
  variant of digits alone, a language of one letter or nine, a keyword
  other than calendar, collation, currency or numbers) in lower case. It
  resolves to a locale Intl supports: the language's likely region where
  none is given (`de` is `de-DE`, Chinese named by region, `zh-TW`),
  `usingFallbackWarning` and the likely region for a region whose data ICU
  does not resolve to (`en-ZZ`; `nb-NO` resolves to `nb`, Norway's), and
  the default, `usingDefaultWarning`, for a language Intl does not know or
  knows by another code (`iw`, `in`, `tl`, `und`). The default, also for
  `""` and `i-default`, is `PlatformCapabilities.locale`, the browser's
  language unless a host sets it; the player's tests start Chrome in
  en-US, as adl's machine is. Methods and setters set
  `lastOperationStatus`; getters leave it. What Intl gives a locale is
  read once per locale; a name's resolution is kept for the last 64 names
  only, as a SWF may make any number of them and every player shares the
  cache (a unit test holds it to that).
- **Numbers and currencies** take only their settings from Intl: the
  separators, digits, grouping, the negative format, the currency's
  digits, its narrow symbol (`$` in Hong Kong) and, for its formats,
  Intl's currency and accounting formats with a narrow symbol, matched
  against Windows' sixteen negative and four positive ones. A region's
  currency comes from a table, as Intl has none; an area of several
  countries (`419`, `150`) has Windows' XDR with no symbol. Formatting is
  Flash's: the number printed with nine decimals, then rounded half up to
  `fractionalDigits` (2 by default, Windows'; padded to a thousand at
  most, where adl crashes), grouped by `groupingPattern` (five fields at
  most), its digits from `digitsType` (`invalidAttrValue` for a
  surrogate, a noncharacter or past Unicode's last, `illegalArgumentError`
  past int's range), cut at a NUL as Flash's C strings are. Separators of
  four characters or more are illegal, and a NUL ends one. `parse` finds
  the first number anywhere, signed by the negative format around it at
  most a plain, no-break, narrow or ideographic space away, U+2212 a minus
  too; `parseNumber` and a currency's `parse` take a string that holds
  nothing else but spaces, a currency one space from its number and any
  more spaces its own.
- **Dates** are formatted by Flash's LDML pattern, interpreted here as
  Windows does: Gregorian, European digits, long and medium alike, a long
  month's genitive when a day is its nearest field, the letters it cannot
  format left out with `unsupportedError`, a run too long cut and an
  unclosed quote closed with `usingFallbackWarning` (and the pattern so
  kept formatted), an unknown letter or a pattern past 255 characters,
  counted past a NUL, rejected with `patternSyntaxError`, one that closing
  its quote takes past them emptied with `bufferOverflowError`, a NUL
  ending it. A pattern with the date (or one of the letters of it Flash
  cannot format) formats only Windows' dates, from 1601 to 14 September
  30828, a year past 65535 wrapping as a 16-bit year does, local times
  past JavaScript's range too, and gives `""` with `illegalArgumentError`
  otherwise; one of the time alone formats any. An invalid date is
  midnight of 1 January 1970 to a pattern without the date in UTC and to
  one of the date alone in local time, and refused otherwise. The
  locale's patterns are read off Intl's parts for its full date, its
  numeric date and its medium and short times, the cased letters of their
  literals quoted (`d 'de' MMMM`). The shortest weekday names are CLDR's
  short width, which Intl does not give: a cased script's short names cut
  to two letters, other scripts' short ones of two characters at most,
  else the narrow ones, and the short ones wherever that would name two
  days alike (Vietnamese, Portuguese).
- **Collation** is `Intl.Collator`, with Windows' word sort, hyphens and
  apostrophes compared last, `ß` as `ss`, symbols ignored with
  punctuation, and the empty string apart from one of what is ignored;
  width and kana are folded before comparing, as Intl has no options for
  them. `numericComparison` is kept and reports `unsupportedError`, as in
  adl, without changing the order.
- **Case** is mapped a character at a time, as Windows does: no locale's
  rules but Turkish, Azerbaijani and Lithuanian ones (Greek keeps its
  accents), a character whose full mapping expands taking its simple one
  where its decomposition gives one (`ᾳ` to `ᾼ`, Lithuanian `Ì` to `ì`).
- **LocaleID** fills in the script and region of the whole name from
  Intl's likely subtags (`zh-TW` is Hant), but for `und` and the codes
  Windows does not know (`ji`, `jw`, `sh`). `determinePreferredLocales`
  gives, for each locale wanted, those of its language and script: the
  same locale (as Windows names it, `zh-Hant-HK` being `zh-HK`), those its
  likely locale is, another locale wanted, other regions, then the
  language alone; `und` matches only itself.

What ICU's data gives differently from the system adl runs on, and so
the cases leave out: separators (French and Swiss German group with
U+202F and U+2019 where Windows has U+00A0 and an apostrophe; Arabic
locales' are Arabic; Russian's and Bulgarian's date spaces are no-break
where Windows' are narrow), symbols and formats of some currencies
(Egyptian, Iranian, Norwegian's, Indonesian's and Malay's position,
Turkish's parentheses, Curaçao's symbol), Finnish weekdays (`sunnuntai`
for `sunnuntaina`), German abbreviated weekdays without a dot, the
shortest weekday names where CLDR's short width is not two letters
(Spanish `DO`, Catalan `dg.`, Arabic, Thai), Korean day periods, kana and
width in collation, Windows' likely regions and scripts for some
languages (`ar` is Saudi Arabia's, `ckb`, `mzn` have none, `mo` is
Moldova's), script subtags, variants and keywords in Windows' resolved
names (`az-Latn-AZ`, `ca-ES-VALENCIA`, `de-DE@collation=phonebook`,
`zh-Hans-HK`), and `no` without a region. Chrome's ICU leaves out some
locales' data (Georgian, Armenian, Mongolian, Basque, Galician, Kazakh,
Irish, Hawaiian, Nynorsk among them): those fall back to the default or
format with ICU's root data. Windows' collation is its own in what it
ignores as a symbol (an emoji or ™ it does not) and in matching mode,
where a precomposed letter differs from its decomposition and "áb" from
"ab". Some pattern corners differ: a run cut short before an unclosed
quote (`MMMMMMM'`), and the unsupported `W` with invalid and early dates.
Local times far in the future follow the runtime's Date, which, as
avmplus, applies no daylight saving after 2038. The oddities of adl
under Wine are not reproduced: an era printed twice (`ADAD`), a lone `*`
grouping pattern grouping by eleven, astral digits printed as
replacement characters, a crash for a thousand fractional digits.
`getAvailableLocaleIDNames` lists each region's likely locale that Intl
supports, as Intl lists none.

## File dialogs

AS3's `FileReference` and `FileReferenceList`, and AS2's `flash.net`
versions, share `files.ts`: a host supplies selected files' metadata and
reads, and save destinations' writes, through `fileHost`. The browser's
host opens a hidden file input while transient user activation is still
present. `load()` reads the chosen File into a ByteArray. Saving asks
`showSaveFilePicker` where available; otherwise it starts a Blob download.
The latter cannot report whether the browser ultimately saved the file.
Without a host or user activation, a dialog reports cancellation in a
later frame, preserving the headless player's fallback.

Uploads encode multipart form data, or send the selected bytes directly
for `uploadUnencoded`; downloads fetch only after choosing a destination.
Unencoded uploads retain their URLRequest method and headers. Hosts still
decide which methods are allowed: the desktop SWF network permits GET and
POST and rejects PUT, while browser fetch can send PUT subject to CORS.
Both pass through the existing host fetch as `data` requests, retaining
CORS or the host's sandbox and policy checks. Completion and errors cross
into player frames. Cancellation and player destruction suppress stale
callbacks and abort transfers; progress reports the complete byte count,
not streaming increments. The browser has no creation timestamp and uses
the file's modification timestamp for creationDate as well.

The desktop host uses Electron's native dialogs. The main process checks
that a recent click or key requested the dialog, keeps paths behind
opaque IDs, and accepts reads and writes only for IDs granted by a dialog.
The renderer releases them on player destruction; navigation revokes them.
The unit tests exercise both VMs' bindings and transfers with controlled
hosts; the web tests exercise Chrome's actual file input and File reads.

## What a browser player lacks

Some of playerglobal stands for what the player does not have, and acts
as Flash does without it (the `system-natives` case). `Stage.stage3Ds` are Flash's four Stage3Ds, whose
positions are kept within -8192 to 8191, ArgumentError 2006 beyond, and
by default each request for a Context3D gets ErrorEvent #3702 in the next frame, as
Flash without a GPU gives, so content can fall back to the display list.
`stageVideos` is empty, and a `Video` is a box of the size it was made
at, 320 by 240 where either is 0, RangeError 2006 for a negative one,
which bounds, scales and hits as Flash's and shows nothing: no stream or
camera plays in it, and a timeline's DefineVideoStream is not read yet.
Camera and Microphone are Flash's on a machine with neither (the
`camera-microphone` case): supported, but `names` empty and no camera or
microphone to get; one made with `new` reads as zeros and nulls whatever
is set, its copies and setters throwing only TypeError 2007 for a null.
Once `getEnhancedMicrophone` is called, whatever it gives, every
Microphone shares one MicrophoneEnhancedOptions, copied in and out.
NetConnection has its local mode, `connect(null)`, with Flash's status
events and its properties, ArgumentError 2126 for those of a connection
it does not have; and Flash Remoting over an HTTP URI
(`playerglobal/flash/net/remoting.ts`), as adl sends and reads it: a
frame's calls POSTed together at its end, numbered `/1`, `/2`... on the
connection from each `connect`, with its headers (one of a name, the
last set). In AMF0 every value is AMF0, a call's arguments one table of
references whose first object is 0; in AMF3, the default, strings,
numbers, booleans, null and undefined stay AMF0, and the rest is 0x11
and AMF3, a call's arguments sharing its tables, a header's value its
own. An answer's `/n/onResult` and `/n/onStatus` go to the call's
Responder; an HTTP error is `Call.Failed` ("HTTP: Status n", or "HTTP:
Failed" with no answer), one that is no packet `Call.BadVersion`, an
empty one nothing; a call on a local connection, or on none, sends
nothing. In a browser the gateway must allow the page's origin (CORS).
`fscommand` goes to the host's
`fsCommand` if it gives one; the SWF chooses both strings, so a host must
never evaluate them or use them as a URL or as HTML. `Stage.color` is the
SWF's background until set, opaque; `Player.background` follows it, and
setting it moves `changes`, so a host that reads `background` as it draws
(as `@swf2es/web`'s `playback.ts` does) shows it, while one that reads it only when it makes
its renderer does not. The rest of the stage's properties are a desktop
browser player's (`colorCorrectionSupport` "unsupported", scale factors
1, no soft keyboard, orientation unknown). `getObjectsUnderPoint` gives
the descendants that draw under a point of the stage, parents first, as
Flash does, leaving out masks, a timeline's or a script's, and all an
invisible container holds, as the pointer's pick does;
`areInaccessibleObjectsUnderPoint` is false, there being no sandbox to
hide them.

AMF0, which avmshell refuses (#1508), is the player's own
(`playerglobal/flash/net/amf0.ts`): ByteArray's `writeObject` and
`readObject` of an objectEncoding below 3 (as a signed number:
`defaultObjectEncoding` takes any uint) override the runtime's, and
Socket, URLStream and FileStream reach them through their ByteArrays. It
is what adl writes and reads (the `amf0` case): every number a double, an
Array always an ECMA array, a Date with its zone, an XMLDocument as its
text but E4X as an empty object, any other object its public variables and
read-write accessors, [Transient] ones too, then what for-in finds; an
IExternalizable writes no properties and reads as a plain typed object,
and 0x11 reads as undefined, not as AMF3. An IExternalizable's
ObjectOutput and ObjectInput are AMF3 whatever their objectEncoding, in
avmshell and Flash alike. A SharedObject's .sol file is AMF0 or AMF3 by
its objectEncoding, its properties sharing one writer's tables (in AMF3
the names among the strings), as adl writes it. An AMF3 file is kept under
its key with `#amf3` after it (`AMF3_KEY`), an AMF0 one, which AS2 reads
too, under the key alone. An AMF3 file under the key alone can only be one
swf2es 0.1.16 or earlier wrote, each value with tables of its own, and is
read so; its next write moves it. The header cannot tell the two apart:
the old writer's was Flash's, byte for byte.

The legacy `flash.xml.XMLDocument` is playerglobal's own code over the
runtime's XML tokenizer, avmplus' that E4X reads with too, exported for
it: `XMLParser.getNext` fills an `XMLTag` with each tag, an element's
attributes as an object, and playerglobal builds the tree and throws its
errors from the status (the `legacy-xml` case). `XMLNode`'s escaping
replaces the five XML characters.

## Workers

`flash.system.Worker` runs each background worker as a VM of its own on a
thread the host starts (`WorkerHost`, hosts.ts): its own codegen, runtime
and playerglobal playing the SWF `createWorker` was given, headless, its
frames on a timer at the SWF's rate (`workers/thread.ts`, the entry of
`@swf2es/player/worker`). `player-hosts` has the threads: `webWorkerHost`
starts module Web Workers, `nodeWorkerHost` node's `worker_threads`, each
given codegen's compiled module. A worker on the primordial's ABCs loads
the modules the primordial compiled, read from its cache or imported, in
place of compiling them (`scripting/handover.ts`). Without a host,
`Worker.isSupported` is false. `scripting/workers.ts` is what one VM sees: the primordial routes
every message between workers, and shared properties and channels' messages
cross as copies, made as avmplus' `ChannelItem` makes them, but for a
shareable ByteArray's memory, which the threads share where the page is
cross-origin isolated. What content needs, shared memory and
blocking, and the order the rest comes in are in
[docs/workers.md](../workers.md).

## Shutting down

A page that takes its player away calls `Player.destroy`. No frame plays
after it: `advance` and `tick` do nothing. With scripts, `Scripting.destroy`
then stops every sound and closes the audio host (`AudioHost.close`, which
closes the browser's AudioContext, whose thread a page otherwise keeps),
terminates the background workers' threads, closes the Sockets' and
WebSockets' connections still open, and aborts
the fetches under way of the host's `fetch`. First it writes the
SharedObjects scripts opened and changed since they were read or last
written, as Flash wrote them as a SWF unloaded, so data a SWF set without
flushing is kept; never a removal, since an object whose stored file the
player could not read starts empty, and writing it back would lose the
save. Scripting wraps the hosts
it is given to keep each connection from its connect until either end
closes it or it fails, so the natives keep no list of their own. Left open, a
connection went on receiving and queueing for a player no one played,
its listeners holding the player. What the host made for the player, its
renderer, input bindings and loop, the host lets go itself, as
`@swf2es/web`'s element does.
