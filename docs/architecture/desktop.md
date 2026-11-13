# The desktop app

`apps/desktop` plays local SWFs, and SWFs by their http or https URL, in
an Electron window. It is the web embedding with a shell around it: the
page is one `<swf2es-player>` filling the window, configured with the
IndexedDB module cache and the libraries the user pointed the app at,
and the main process opens the files, keeps the settings and carries the
sockets and the SWF's network requests. The page knows the shell only
through `window.swf2esDesktop`, whose types are `src/shared/api.ts`:
`start`, which hands the page the libraries' state and the SWF to play;
`onOpen` and `onClose`; `openDialog`, `openUrlDialog`, `openDropped` and
`chooseLibrary`, requests the main process answers with dialogs and
`onOpen`; `sockets`; `webSockets`; and `network`. The page (`src/renderer`, `static/`)
imports nothing of Electron's, so a Tauri shell can serve it as it is.

## Serving the page

Nothing is loaded from `file:`. One privileged scheme, `swf2es:`,
standard and secure, so fetch, CORS, IndexedDB and localStorage treat it
as https, has two hosts. `swf2es://app/` is the page,
`static/index.html` and its stylesheet, the renderer's build,
`/modules/<package>/` for the packages' builds, which the page's import
map names as
`tests/player/serve.ts`'s does, and `/libraries/playerglobal.abc`, read
from where the settings say.
`swf2es://file/` is the local files the SWF playing may read, by its
sandbox (below); its answers carry `Access-Control-Allow-Origin:
swf2es://app`. The two hosts are two origins: a SWF's files are never
the page's. Anything but GET and HEAD is refused, and a path with
malformed %-escapes is a 400.

## The sandbox

A local SWF plays in the sandbox Flash Player gave it, chosen by its
FileAttributes' UseNetwork bit (`fileAttributes` in `format`), and
`src/main/sandbox.ts` holds it:

- **local-with-filesystem**, without the bit: the SWF reads the files in
  its own directory and below, its real directory, links followed, and
  reaches no network. The main process refuses its http and https
  requests (with a word on stderr), no socket is made, and navigateToURL
  opens no page, as Flash refused it, since a URL can carry what the SWF
  read.
- **local-with-networking**, with it: the SWF reads no local file but
  itself, reaches the network through the main process by Flash's rules
  (see [The network](#the-network)), content from anywhere and data only
  where a policy file grants every domain, and sockets as the user
  allows (below).

A SWF opened by its URL plays in Flash's **remote** sandbox: its
security domain is its origin, the one its URL came to after redirects,
which is also its `loaderInfo.url`; it reads no local file at all (the
file host has no grant for it, and the page fetches nothing else), and
reaches the network as [The network](#the-network) has it, sockets with
a socket policy and the user's word. Its grant takes effect as the page
asks the main process for that very URL as the movie, after the last
player has gone, as a local SWF's does as the page fetches its file.

So no SWF can both read the disk and send what it read away. A directory
others share is never granted whole: the user's home, the one that holds
every user's (`/home`, `/Users`, `C:\Users`), the temporary ones (the
OS's, `/tmp`, `/var/tmp`) and a file system's root; a SWF there reads
only itself. Only those directories themselves: a SWF one level below,
in `C:\Users\Public` or a directory of `/tmp`, reads all that directory
holds, which may be other programs' or users' files, so a SWF from
elsewhere is best kept in a directory of its own.

On Linux a path that is not there exactly is first found as Windows and
macOS would find it, ignoring case (`src/main/case-paths.ts`), for the
file host, an AIR application's File and its URLs alike; each grant is
then judged on the real path found, so case reaches nothing a grant did
not.

The main process chooses the sandbox from the SWF's first 64 KB, with
`fileAttributes` (`format`), which decompresses only as far as the first
tag: a SWF's header may name a length of 4 GB, which it never trusts.
The page decompresses the SWF whole, with what `@swf2es/native/compress`'s LZMA decoder
bounds (see [Packages](overview.md#packages)).

Only the SWF playing has a grant: opening another or closing it revokes
it, so nothing accumulates over a run, and the next SWF's grant takes
effect only as the page fetches it, which it does once the element has
let the last player go, so that player never runs in the next one's
sandbox. What the SWF loads, a child SWF among it, plays in its sandbox,
which is the page's. The URL the page plays a SWF from, which is also
its `loaderInfo.url`, names its directory by a token, a hash of the
path, and the file by its name, so the SWF learns nothing of where it is
or whose disk it is on, and the token, the same from run to run, keeps
its SharedObjects.

The page's Content-Security-Policy, a header the main process writes, is
`default-src 'none'` and what the player needs: `script-src 'self'
'unsafe-eval' 'wasm-unsafe-eval'` and the import map's hash, as the
player evaluates the modules it compiles with `new Function` and codegen
is WebAssembly; inline styles, for the element's shadow root; images,
media and fonts from the page, the SWF's files, `data:` and `blob:`; and
`connect-src` for the page and the SWF's files alone. The page never
reaches the network itself: a SWF's http and https loads go through the
main process (below), and every http, https, ws and wss request the page
makes is cancelled in the session's `webRequest`, with a word on stderr,
whatever the policy would allow. So `air.net.WebSocket`, AIR's and not
Flash Player's, never uses the page's WebSocket here: its connections
are the main process's too ([WebSockets](#websockets)). Nothing may
frame the page, and it frames nothing.

## The network

A SWF's http and https requests are the main process's to send
(`src/main/network.ts`), not the page's: the element is configured with
a fetch (`configure({ fetch })`, `src/renderer/network.ts`) that hands
each one, with its purpose, over IPC, and the main process judges it as
Flash Player judged it, by the SWF's sandbox and the policy files of the
sites it reaches, not by CORS. So a SWF reaches `http:` and servers that
never heard of CORS, as it did in Flash. A swf2es://file URL, a local
SWF's own files, the page fetches as before, and any other scheme is
refused.

Flash's rules, from Adobe's security documentation (the ActionScript 3.0
Developer's Guide's "Security sandboxes", "Loading data" and "Permission
controls") and its Cross Domain Policy File Specification (2.0):

- A **remote** SWF may load anything from its own origin (scheme, host
  and port), and content, a Loader's or a Sound's, from anywhere; it
  reads another origin's data, a URLLoader's or URLStream's, only as
  that origin's policy files grant its domain; sendToURL sends anywhere.
- A **local-with-networking** SWF has no domain: it loads content from
  anywhere, sends anywhere, and reads data only where a policy file
  grants every domain (`domain="*"`), as the Developer's Guide says.
- **Policy files** (`src/main/policy.ts`) are read as the specification
  defines them. The master policy file is `/crossdomain.xml`; others,
  named with `Security.loadPolicyFile`, count only as the master's
  meta-policy permits (site-control, or the
  `X-Permitted-Cross-Domain-Policies` header, the stricter of the two
  winning), and Flash Player 10's default is master-only: a site without
  a master policy file has no other either. A policy covers its own
  origin, and a non-master one only its directory and below. A policy
  file must come as `text/*`, `application/xml` or
  `application/xhtml+xml`, with a 200, without a redirect (the
  specification ignores one to another domain; one within the site would
  move the file's scope), and with a root of `<cross-domain-policy>`; a
  DOCTYPE is skipped, so no entity of its own is expanded. Domains match
  by the specification's table: `*.example.com` is example.com and every
  name under it, an address is never its host's name, and only `*` names
  a local SWF. An HTTPS policy's rule grants an HTTP SWF, or a local
  one, only with `secure="false"`. Headers other than Content-Type go to
  another origin only as its `allow-http-request-headers-from` lists
  them. Each policy file is fetched once a movie and address, and
  forgotten as the movie closes.
- Flash Player outside AIR sent GET and POST only, and refused a SWF the
  headers `URLRequestHeader` lists (Cookie, Host, Referer, User-Agent
  and the rest); the main process refuses those too, and Proxy- and Sec-
  headers, and any header value with a control character or beyond
  Latin-1, which Node would throw for, saying so on stderr.

What Flash never guarded, the machine's place on the network, is guarded
here, since a request from the main process is one from this machine. No
request carries the user's credentials: no cookies (a response's are
dropped), no HTTP authentication, no client certificate, no proxy but
the one `--proxy` names ([Through a proxy](#through-a-proxy)). The
Referer is what a browser's default policy,
strict-origin-when-cross-origin, sends: the SWF's URL to its own origin,
its origin alone to another, and none from an https SWF to what is not
potentially trustworthy (http, but for this machine's loopback addresses
and localhost names), a URL past 4096 characters going as its origin; a
local SWF sends none. `x-flash-version` goes as Flash Player 32 sent it.
Every address is placed (`src/main/addresses.ts`): on this machine
(127/8, ::1), on a private network (10/8, 172.16/12, 192.168/16,
100.64/10, link-local 169.254/16, where clouds keep their metadata
service, unique and link-local IPv6, the documentation blocks), or
public; an IPv4 address inside an IPv6 one, mapped, translated
(`::ffff:0:a.b.c.d`), compatible, by NAT64 or by 6to4, is that address.
A request to a place more private than the SWF's own needs a policy file
from that very address that grants the SWF, whatever its purpose and
even within its origin, as Chromium's Private Network Access asks a
server there before a public page may. A remote SWF's place is that of
the address it came from; a local one stands for the internet, so it
reaches this machine and the LAN only where a policy there grants every
domain. Addresses no server has (0.0.0.0/8, ::, multicast, 240/4) are
never reached, nor the ports the Fetch standard blocks (SMTP's, SSH's
and the rest), as Flash in a browser never reached them either.

Addresses are placed by their ranges alone, as a browser's Private
Network Access places them: the app does not know which public addresses
are this machine's own or its network's. So this machine's own public
IPv4 address or global IPv6 one, and a LAN device reached by its global
IPv6 address (as most on an IPv6 network are), count as the internet: a
SWF from the internet reaches a service listening there as any web page
in a browser could, though still without the user's credentials. A
service that is to stay private should listen on loopback or a private
address, or ask for authentication.

Each request resolves its host once and connects to that address, its
policy file fetched from the same one (Node's `lookup` pinned, the name
kept for TLS's server name and the Host header), so DNS that changes its
answer between the policy and the request, rebinding, gains nothing:
same-origin by name, a request now at 127.0.0.1 is judged as one to this
machine. Every redirect is judged as a request of its own, a POST
redirected by a 301, 302 or 303 going on as a GET without its body, to
http or https only and ten at most. HTTPS is verified against Node's
roots and the system's. A response is read up to 128 MB, and a movie's
responses under way hold 256 MB at most all told (no compression is
asked for, and a body a server compresses anyway, gzip, deflate or br,
is decompressed as it comes, the limits counting what comes out, so a
small bomb stops at them (`decompress.ts`); gzip's header is read by the main process and
its stream inflated raw, so what follows the stream is ignored, as
Chromium ignores it, deflate is zlib's or raw as its first two bytes
tell, and a body coded twice is refused), past which the next is refused
(each is copied once, into memory of its own, and counts until the main
process has sent it to the page in a message of its own, which copies it
there); a body is sent up to 32 MB, a URL up to 64 KB, 32 headers in 8
KB; a request that hears nothing for 30 seconds fails, and one that
takes five minutes all told, from its turn, however its bytes trickle
in, its redirects and the policy files it waits on included, as does a
socket's search for its policy (a policy file's whole fetch takes ten
seconds at most, port 843's socket policy three); 16 requests run at
once, a thousand more wait, and the rest are refused. A sendToURL's
response is not read. Requests the page aborts are aborted, and a
movie's all are as the next opens, closes, or the page reloads. A
refused request is a failed load to the SWF (IOErrorEvent, or the
player's error for the SWF itself) and a line on stderr saying why.

The page says what a request is for, and the main process cannot check
it; nor does the player keep Flash's other half of the content rule,
which let a SWF show another domain's image but not read its pixels or
bytes without a policy. So a content load's bytes are the SWF's to read,
and the line that holds against a SWF, or a page that misbehaves, is the
one above: nothing with the user's credentials, and nothing more private
than the SWF without that place's own policy. What a SWF reads from the
internet that way is what its author's own server could fetch. The page
also tells the player the sandbox, which `Security.sandboxType` reports.

## Through a proxy

`--proxy=<url>` (`src/main/proxy.ts`) puts a proxy under every
connection the main process makes for a SWF: `socks5://` (RFC 1928, its
alias `socks5h://`), with RFC 1929's username and password where the URL
gives them, or `http://`, a `CONNECT` tunnel for each connection, plain
http too, rather than absolute-URI requests, so that one path serves
http, https, sockets and WebSockets alike, with `Proxy-Authorization:
Basic` where the URL gives credentials. The URL is the command line's
alone: never kept in the settings, never said (stderr names its kind,
host and port as the app starts), and refused whole where it does not
parse, `--proxy` with its URL apart included, the app exiting rather than
running without it. A second start with another proxy is refused by the
first, which would otherwise play what it names past the proxy it asked
for.

Each path keeps what it judged and only changes how it connects.
`network.ts`'s requests and URL policy files give Node's request a
`createConnection` that makes the tunnel and, for https, TLS over it with
the same server name, authorities and `--ignore-certificate-errors`
hosts; the socket policies (port 843, and the others) go through the same
tunnel. The address rules above still resolve the host on this machine
and place that address, and the proxy is then asked for that address,
never the name: a proxy's DNS that answers otherwise, or rebinding
between the two, reaches nothing the judgement did not, and the policy
file that granted an address came through the same proxy from that very
address. So DNS stays local wherever a rule judges; a name only the
proxy resolves is not reached. Where no rule judges an address, a local
SWF's sockets and an AIR application's sockets and WebSockets, the
proxy is asked for the name, and resolves it itself. A socket
(`connections.ts`) is opened once the tunnel is, its peer reported as
the target; one closed before is closed. A WebSocket goes through an
undici Agent, of the class the global dispatcher has, whose `connect`
makes the tunnel and the TLS, passed as the dispatcher, as
`--ignore-certificate-errors` passes its own; where none can be made, no
WebSocket opens.

The proxy's own address is not judged: it is the user's. Anything a SWF
names is judged as before, the proxy's host and port as a target among
them. A connection the proxy fails is a failure the SWF sees as a server
that is not there, with a line on stderr saying why (the SOCKS reply, the
HTTP status); a proxy that fails itself, unreached, refusing the
credentials or making no sense, also fails a policy file it was to fetch,
said as such rather than as a site without one, while a target the proxy
did not reach has no policy, as a server that is not there. Credentials
appear in no message. `--log-network` names the target, as before, and
ends in `via proxy`.

## What the page may do

The window's renderer is sandboxed (`app.enableSandbox()`), with context
isolation, no node integration and web security on. The preload, a
CommonJS script as a sandboxed one must be, puts the API on the page
through `contextBridge` and passes the path of a dropped file
(`webUtils.getPathForFile`) to the main process without showing it to
the page. The main process answers a message only from the window's own
top frame on `swf2es://app/`, and checks each argument: a path must be
absolute and its file start with a SWF's signature, a library must be an
ABC (major version 46), a socket's host a string and its port in range.
The page never navigates: `will-navigate` is refused, and a new window,
as a SWF's navigateToURL asks for, is refused too, its URL opened in the
system's browser with `shell.openExternal` if it is http or https, the
SWF has the network (local-with-networking or remote), and a click, key
or tap in the window asked for it: one page a gesture, within five
seconds of it and a second after the last, as a browser's popup blocker
allows, so a SWF cannot launch the browser in a loop. `<webview>`s are
refused, and the only permission granted is full screen. A SWF's
`Stage.displayState` does not go through that permission, which wants a
gesture: the page asks the shell (`fullScreen.set`), which sets the
window's own full screen while a SWF the user opened plays, and tells
the page as the window enters or leaves it, by the menu's F11 too, so
that the stage follows (`renderer/full-screen.ts`). Esc in the page
leaves it, as in Flash. F11 is View › Toggle Full Screen's accelerator,
and may be the SWF's own key as well: AIR leaves it to the application
(adl has no key for full screen), and one that sets `displayState` in
its `keyDown` listener would enter by its own doing and leave at once by
the menu's. So a key in whose events a script took the stage into or out
of full screen counts as used by the SWF (`KeyboardInput.handle`,
`FullScreen.asked`), and `bindKeyboard` cancels the page's `keydown` for
it, as for any key the SWF used. Electron runs a menu's accelerator only
for a key the page left alone: Chromium sends the key to the renderer
first and hands back what it did not cancel
(`WebContents::HandleKeyboardEvent`), where Electron looks the
accelerator up, in the window's accelerator table on Linux and Windows
and in the main menu's key equivalents on macOS. A SWF that does nothing
with F11 leaves it to the menu. One that acts on the key's `keyUp`
instead is not covered: the menu has taken the key by then.
ExternalInterface is off (`allowscriptaccess="never"`): a SWF's calls
into the page would run beside the API.

## Files, settings and libraries

The main process opens a SWF from File › Open, a drop on the window, the
command line (the last argument that is an http or https URL or names a
.swf file there is, as a switch may take a value), macOS's `open-file`,
a second start of the app, which hands its SWF to the first and quits,
File › Open URL (Ctrl+L), and the recent list, and sends the page its
swf2es://file URL, or the http or https one, which it plays with `load`
in place of what played, the element letting the last player go. The URL
dialog is a window of its own (`static/open-url.html`,
`src/renderer/open-url.ts`), modal over the player's, with a preload of
its own (`src/preload/prompt.cts`) whose only messages are what to show
first and the user's answer, which the main process takes only from that
window's own page; the player's page may only ask for the dialog
(`openUrlDialog`). So nothing a SWF runs opens a URL: a SWF's movie
fetch reaches any address, as the user chose it, and the dialog keeps
that choice the user's. Only http and https URLs open, with a host and
without credentials, their fragment dropped. It keeps `settings.json` in
Electron's user data directory (`SWF2ES_DESKTOP_USER_DATA` names
another, for the tests): a chosen playerglobal's path, the last ten SWFs, by
path or URL, and the servers each SWF, by path or URL, may always reach.
A settings file that cannot be written keeps them for the run, with a
word. ActionScript 3 plays on the builtin.abc and playerglobal the player
ships; a playerglobal.abc the user chooses, such as Flash Player's, takes
the place of swf2es's own, and choosing one reloads the page, which
fetches it once.

## Sockets

The element takes the shell's SocketHost through `configure({ sockets
})`. Each `flash.net.Socket` is an id the preload numbers, and the main
process connects it with `node:net`, as `player-hosts/node` does,
relaying its bytes and events over IPC. Only a SWF with the network has
sockets, and only as the user allows: the first connection to each host
and port asks, Allow Once (until the SWF closes), Always Allow for This
SWF (kept in the settings by the SWF's real path) or Deny (until it
closes); connections there while the question is open wait on its
answer, and where no one can be asked it is a refusal. A remote SWF then
needs the server's socket policy too, as Flash Player 9.0.124 and later
asked of every socket, its own server's included: the main process
connects to port 843, sends `<policy-file-request/>` and its NUL and
reads the policy up to its NUL (three seconds at most), and, as its
meta-policy allows ("all" by default for sockets), tries the ports
`Security.loadPolicyFile("xmlsocket://host:port")` named and the port
itself; a policy grants the SWF's domain the ports its `to-ports` lists,
one from a port of 1024 or above only ports of 1024 and above. The
policy is asked only after the user allows the server, so no SWF makes
the app speak to a server the user did not allow, and the socket then
connects to the address the policy came from. A local SWF with
networking needs no socket policy, as before. A refused socket fails
with #2031, as one no server took. A page holds at most 64 at once, and
one with more than 4 MB its peer has not read fails, so a peer that
stops reading cannot fill the main process's memory. A page's sockets
close, silently, as it navigates or reloads, and with it. TLS
(`SecureSocket`) waits for the player to have it.

## WebSockets

`air.net.WebSocket` runs over a WebSocketHost
([AIR's WebSocket](services.md#airs-websocket)), by default the page's
own WebSocket, which here would be refused twice, by the page's policy
and by the session's `webRequest`. Neither is loosened: the element
takes the shell's host through `configure({ webSockets })`
(`src/renderer/websockets.ts`), and each connection is an id the preload
numbers, which the main process opens (`src/main/websockets.ts`,
`websocket-connections.ts`) with the WHATWG `WebSocket` of Electron's
Node, undici's, relaying its events over IPC: `open` with the
subprotocol the server chose, `message` with a string for a text message
and bytes for a binary one, `close` with its code and `error`. Only an
AIR application has them (`sandbox.application`), to any `ws:` or `wss:`
URL and unasked, as AIR's application sandbox connects and as its
sockets do here; for anything else the connection is refused with a
word on stderr, and a refusal is an error and then a close with 1006, as
a server that took no connection. The client is a browser's: it sends
the close codes 1000 and 3000 to 4999, any other closing with none,
answers pings itself and sends no ping or pong of the application's, and
fails a connection whose server chose none of the subprotocols offered.

`--ignore-certificate-errors` holds for `wss:` as for https. The WHATWG
WebSocket has no option for it, and Node exports none of undici's
classes, so the connection to a host the switch names is given, in the
options undici's constructor takes in the protocols' place, a dispatcher
made from the class of the one undici keeps for everything else
(`Symbol.for("undici.globalDispatcher.1")`), with `rejectUnauthorized`
off; every other connection is the global's as it is. Where a Node gave
no such dispatcher the app would say so at its start and verify every
certificate; the unit test fails if node's does not.

A page holds at most 64 at once, and one with more than 16 MB its peer
has not read fails. A page's WebSockets close, silently, as it navigates
or reloads, and with it: the client has no way to drop a connection, so
each is sent a close frame, and is gone once its server answers.
`--log-network` says each connection asked for, opened, refused, failed
and closed, and `--log-sockets` each message, a text one as its text
(`src/main/netlog.ts`).

## Running and testing

`pnpm install` leaves Electron's binary undownloaded (pnpm's
`ignoredBuiltDependencies`), so nothing else pays for it; `pnpm --filter
@swf2es/desktop fetch-electron` fetches it, and `start` runs the app,
`--trace` printing the page's console, a SWF's traces to stdout.
`tests/desktop/smoke.ts`, part of `pnpm test`, skips with a word where
there is no binary; with one, it runs the app in Chromium's headless
mode with SwiftShader, so it needs no display, and checks that a SWF
named on the command line, through a link, draws and traces; that in
local-with-filesystem it reads the file beside it, nothing outside its
directory, no network and no socket, and its URL tells nothing of its
path; that playing it again leaves one canvas, that one dropped on the
window opens, and that a second start hands the first its SWF, which, in
local-with-networking, reads no file, the last SWF's grant gone, and
talks to a TCP server it is allowed through the bridge; that no page
opens without a gesture, and that the policy refuses nothing; that
without playerglobal the page says what is missing; and that a SWF
opened by its http URL, from the command line and then from the URL
dialog, which starts with the URL playing, plays in the remote sandbox:
it reads its own origin and one whose crossdomain.xml grants it, not one
without, no local file by swf2es:// or file://, connects the socket
whose server answers with a socket policy and not the one without, and
both URLs join the recent list; and that an AIR application's
`air.net.WebSocket` exchanges a text and a binary message with a server
of the test's own (`websocket-server.ts`: node has a client and no
server), over TLS too to the host `--ignore-certificate-errors` names
and not to another, while a SWF's page is refused one. The remote SWF,
and the AIR application's socket, HTTP load and WebSockets, run again
through a SOCKS5 proxy with a password and an HTTP proxy of the test's
own, which see every connection, by address or by name as above, with
the same results; a wrong password and a proxy that is not there stop
the movie with the reason on stderr and no password in it, and `--proxy`
with its URL apart stops the app. The AIR
application also goes full screen from its InvokeEvent, with no gesture:
the window is in full screen as the main process has it, the source rect
alone drawn, and Esc leaves, as the stage traces. Headless, no window
manager resizes the window, so that it covers a screen is not checked.
It acts on F11 itself too: one press enters and stays, a second leaves,
where the SWF with no such listener enters and leaves by the menu's F11.
A URL answered 404 completes for the application, with the response's
body, and fails for the remote SWF.
`connections.test.ts` and
`sandbox.test.ts` test the sockets' limits and the sandbox's grants in
node, `websocket-connections.test.ts` the WebSockets' messages, close
codes, refusals, limits and certificates, `addresses.test.ts` where each address is, in every form an IPv4
address takes inside an IPv6 one, `policy.test.ts` the policy parser and
what policies grant, by the specification's examples, and
`proxy.test.ts` `--proxy`'s URL and the tunnels through a SOCKS5 and an
HTTP proxy of its own (`proxy-server.ts`): by address and by name, IPv6,
credentials right and wrong, refusals, proxies absent, silent or speaking
no proxy, and no credential in any message; `connections.test.ts` and
`websocket-connections.test.ts` sockets and WebSockets through them, and
`network.test.ts` the network against servers of its own, each on
127.0.0.2, which it takes for the internet, and on 127.0.0.1 at the same
port: same-origin and cross-origin loads with and without policies,
meta-policies and named policy files, redirects, this machine reached by
address, by name, by redirect and by a name whose DNS turns to it, HTTPS
with a certificate it makes with openssl (skipped without), socket
policies on a stand-in for port 843 and on the port itself, and the
limits. `tests/desktop/stage3d.ts` drives the native View menu through the main
process's test-only inspector: Stage3D on for a fresh profile and for the
opt-in's old settings, a stored off's fallback without fetching the backend,
the choice remembered, two composed slots, live layout/DPR changes, browser context
loss/restoration, repeated movie reloads and close. It shares the isolated
display and process harness in `tests/desktop/app.ts` with the ordinary smoke
test. `settings.test.ts` covers the default, the stored choice and its persistence. CI's `desktop`
workflow fetches Electron and runs them.

Not done yet: packaging and installers, `SecureSocket`, Flash's Settings
Manager for trusting a SWF or directory (localTrusted), each loaded SWF
in a sandbox of its own rather than its loader's, a POST from
navigateToURL (the system's browser gets its URL alone), reading
playerglobal from a `.swc`, Flash's SecurityErrorEvent for a load a
policy refused (the SWF sees an IOErrorEvent), cookies for a SWF's own
origin, the system's proxy settings (only `--proxy`), proxy authentication
other than a username and password (NTLM, Kerberos, Digest), TLS to the
proxy itself (`https://` proxies), and Flash's checks within the player:
`checkPolicyFile`, pixels and bytes of another domain's content, and
`Security.allowDomain`.
