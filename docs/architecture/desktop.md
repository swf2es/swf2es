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
`/shared/` for what it shares with the main process (`src/shared`),
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
(`src/main/network.ts`; its types and limits in `network-types.ts`, the
rules that need no state, the Referer's and redirects' among them, in
`network-rules.ts`), not the page's: the element is configured with
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
machine.

Connections are kept alive between requests (`src/main/http-pool.ts`),
HTTP/1.1 only, as a browser keeps them, but a request is given a kept
connection only where it would have opened exactly that one: one of the
same key, which is the scheme, the host's name (TLS's server name and the
certificate it is checked against), the address the request pinned that
name to, the port, the route (`direct`, or the proxy by its kind, host and
port, never its credentials) and, for https, whether the host's
certificate goes unchecked under `--ignore-certificate-errors`; the
authorities are the network's own, one set for all. So the pool keeps the
rebinding protection whole: a name pinned to another address, as DNS that
changes its answer gives it, gets a connection to that address, judged
there, and never one kept to the address before; a host whose certificate
goes unchecked shares no connection with one checked, nor with another
host; and a tunnel, which is to one target, serves only that target. Each
key is a Node Agent of its own (`keepAlive`), whose connections reach the
pinned address whatever the resolver says now, through a `lookup` that
answers with it, or through a tunnel to it; Node's Agent can keep that
pin, since its options override each request's, so no pool of the app's
own was needed. A key keeps six connections at most, idle, in use or,
through a proxy, a tunnel still being made (which Node's Agent does not
count until it is made, so the pool counts it), as browsers keep to a
host. A request queued behind six busy connections to one host waits
for one to come free, its own timeout counting as it waits: thirty
seconds of silence, five minutes all told. An idle one is closed after
four seconds, or sooner where the server's `Keep-Alive` says it closes
sooner, and no more than 64 are kept idle all told, direct and proxied. A
connection goes back to the pool only once its response has been read
to the end and the server meant to keep it: one whose body is not
wanted, a redirect's, a 304's or a sendToURL's answer, is read to its end
where it is small (64 KB, two seconds), so that a redirect's next hop
reuses it, the request's timers and abort holding until it has been, and
closed otherwise, as is any connection of a request that
fails, times out or is aborted, so that none comes back with half a
response on it. A connection the server closes while idle leaves the pool
(Node's Agent drops it); a GET whose kept connection the server closed
just as it was reused, before any answer, is sent once more on another,
as browsers do, and a POST's failure is the SWF's. Every connection,
idle, in use or a tunnel still being made, is closed as the page goes,
reloads or opens another movie, and as the app quits: the pool keeps
each one it opened until it closes, whichever agent holds it. `--log-network` ends the line of a request
answered over a kept connection in `reused`.

Every redirect is judged as a request of its own, a POST
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

### The HTTP cache

The main process keeps a private HTTP cache, as RFC 9111 has one
(`src/main/http-cache.ts`), of the GET responses it receives for a SWF:
its own SWF when opened by its URL, what it loads, and the policy files
it needs. It stands where the network would, in `network.ts`'s
`exchange`, for one hop at a time, once that hop has been judged: its
sandbox, the policy files, the address's place and its port are decided
first, hit or miss, so a load a policy refuses is refused whatever is
stored, and a hit still resolves the host to judge it. What it answers
with is what that very address answered, by the same route, for this
movie's origin, and nothing else: each response is kept for the address
its host was pinned to, for its route (the `--proxy` it went through, by
its kind, host and port, or `direct`: an address is a machine only along
one way to it), and for the playing movie's origin, its partition (a
local SWF's partition is `local`, an application's `application`). A
policy file's fetch is kept apart from a SWF's own GET of the same URL. So DNS that
rebinds a name gains nothing through the cache: a policy file kept from
a public address never answers for the name now at a private one, which
is asked for its own, as the session's policy files are kept by their
address; a body from one address never serves a request judged against
another, nor does one address's 304 confirm another's body. And one
movie never reads, nor times, what another origin's movie loaded, as a
browser partitions its cache by site. Two things are never cached at
all, neither read nor kept: what comes from an https host whose
certificate `--ignore-certificate-errors` leaves unchecked, which whoever
was on the way may have written and which would otherwise outlive the run
that allowed it; and a policy file from an address that is not public (a
private network's, link-local, this machine's), whose grant is one
network's alone, while the same address on another network is another
machine, however long its max-age.

What may be stored, whether a stored response is fresh, the conditional
headers of its revalidation and what a 304 changes are
http-cache-semantics' `CachePolicy` for a private cache (`shared:
false`), which reads Cache-Control's max-age, no-cache, no-store,
private, must-revalidate (revalidated even while fresh, as it has it)
and stale-while-revalidate (revalidated at once), Expires, Age, and a
tenth of the time since Last-Modified where nothing else gives a
freshness. That guess holds a day at most, and never for a policy file,
which is fresh only for as long as its server's max-age or Expires says
and otherwise revalidated each time a movie needs it. A fresh response
is served without the network, with an Age of its age now; a stale one
goes with If-None-Match or If-Modified-Since from its ETag or
Last-Modified, a 304 refreshing its stored headers (but Content-Length
and the like) and serving its body, a 200 replacing it; a stale one
without a validator is fetched again whole. Only a 200 whose body was
read is kept, neither no-store nor `Vary: *`, nor what answered an
Authorization without public, must-revalidate or s-maxage (RFC 9111,
3.5; no SWF may send one, as Flash refused it, so this only guards), nor
anything never fresh with no validator to revalidate it; Set-Cookie is
dropped from what is kept, as from what the SWF gets. A request that
asks something conditional of its own (If-None-Match, If-Modified-Since,
If-Match, If-Unmodified-Since, If-Range, Range) is neither answered nor
kept: its answer is the SWF's to have. A POST answered with a 2xx or 3xx
forgets what its URL has in the movie's partition, and what the URLs its
Location and Content-Location name on its origin have (RFC 9111, 4.4).
Each response's key is the SHA-256 of its partition, its address, its
method, its URL and the request headers its Vary names, as sent, so each
value of those is an entry of its own; a URL whose response comes to
vary otherwise, or at all, has its responses of before dropped, so none
answers what it no longer would. A stored body counts as a fetched one,
against the largest response (128 MB, a policy file's 1 MB) and the
movie's 256 MB under way, and `--log-network` ends its line in `from
cache`, or `revalidated` after a 304.

The cache lives in `HTTP Cache` under the system's cache directory, the
app's name after it (`~/.cache/@swf2es/desktop/HTTP Cache` on Linux, or
under `$XDG_CACHE_HOME`; `~/Library/Caches/…` on macOS;
`%LOCALAPPDATA%\…` on Windows), apart from the settings, which are kept
and backed up; under `SWF2ES_DESKTOP_USER_DATA` where the tests name one.
Its index is SQLite (`node:sqlite`, which Electron's Node 24 has without a
flag or a warning), `index.sqlite` in WAL mode with synchronous=NORMAL,
and holds metadata only, a row a response:

| Column | |
| --- | --- |
| `key` (primary key) | The SHA-256 of the partition, route, address, kind of fetch (a policy file's or a load), method, URL and the Vary'd request headers. |
| `file` | The body's name in `bodies/`: the key. |
| `partition`, `route`, `address` | The movie's origin it was kept for, the proxy or `direct`, and the address it came from. |
| `method`, `url` | What was asked; indexed by URL and partition, to find a request's entries and forget a URL's. |
| `vary` | The request headers the Vary named, and their values, as JSON. |
| `status`, `headers` | The response, its headers as received but Set-Cookie, as JSON. |
| `policy` | http-cache-semantics' `CachePolicy`, serialized: what freshness is judged by. |
| `stored`, `expires` | When it was kept or last revalidated, and when it goes stale. |
| `etag`, `last_modified` | Its validators; `expires` is indexed where both are null, the entries of no more use once stale. |
| `size`, `charge` | Its body's bytes, and what it charges the budget: those, its headers', policy's and URL's text, and 4 KB for its file's disk block and its share of the index. |
| `last_access` | When it was last served (indexed). |

Every body is a file in one flat directory, `bodies/`, named by its key,
with no name of the server's. A body is written to a temporary file,
synced, renamed into place, and only then its row written, the writes in
the background one at a time; a row is deleted before its file. A serve
opens the file and checks its size against the row's, and a file gone or
of another size is a miss and its row dropped; each start sweeps away,
beside the writes rather than before them, and a page of 512 names or
rows at a time, temporary files, files no row names and rows whose file
is gone or of another size, dropping a row only as it read it, from a
listing it takes before the first write begins: a temporary file it
finds is a crash's, never one of a write under way. So a
crash leaves no row pointing at half a file. Past the budget, 512 MB of
charges, or past 50,000 entries, the least recently served go first, by
their index, the charges' total and the count kept in memory rather than
summed, so that the index and the files are bounded as the bodies are,
cache-busted small responses with large headers among them; an entry
stale with no validator, of no more use, is dropped as the cache next
writes; no entry charging more than an eighth of the budget is kept, as
Chromium keeps no larger body, so that no one response empties it. An index that does not
open is started again empty, the bodies with it. A cache that fails
after, its disk full, read only or gone, or a row that does not parse,
is left out where it fails, said once on stderr: the request goes to the
network.

File › HTTP Cache turns it off and on, remembered in `settings.json`
(`httpCache`); off, nothing is read from it nor kept. File › Clear HTTP
Cache forgets every response, the rows at once and the files after the
writes under way, which are dropped. `--no-http-cache` leaves it closed
for the run, whatever the setting says, and the menu's items with it.

## Through a proxy

`--proxy=<url>` (`src/main/proxy.ts`, read with the other switches in
`src/main/switches.ts`) puts a proxy under every
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
`network.ts`'s requests and URL policy files go through an Agent of the
pool whose `createConnection` makes the tunnel and, for https, TLS over
it with the same server name, authorities and `--ignore-certificate-errors`
hosts; a tunnel kept alive serves only requests to its own target, by the
key above, and one still being made is given up as the page goes. The
socket policies (port 843, and the others) go through tunnels of their
own, never kept. The address rules above still resolve the host on this machine
and place that address, and the proxy is then asked for that address,
never the name: a proxy's DNS that answers otherwise, or rebinding
between the two, reaches nothing the judgement did not, and the policy
file that granted an address came through the same proxy from that very
address. So DNS stays local wherever a rule judges; a name only the
proxy resolves is not reached. Where no rule judges an address, a local
SWF's sockets and an AIR application's sockets and WebSockets, the
proxy is asked for the name, and resolves it itself. A socket
(`connections.ts`) is opened once the tunnel is, its peer reported as
the target; one closed before is closed. A WebSocket's connection is
the tunnel, made by the `createConnection` ws is given, with TLS over it
for `wss:`, its certificate checked as without the proxy
([WebSockets](#websockets)).

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
top frame on `swf2es://app/` (`trusted`, `src/main/state.ts`), and
checks each argument: a path must be absolute and its file start with a
SWF's signature, a library must be
an ABC (major version 46), a socket's host a string and its port in range.
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
into the page would run beside the API. No embedding the command line
names changes that ([The embedding](#the-embedding)), and the page never
sets that attribute from one.

### When the page's process goes

A page ends for the main process as it navigates or reloads, as its
WebContents is destroyed, and as its renderer process goes, crashed,
killed or out of memory: the WebContents lives on then, white, and
neither of the others comes, so a SWF kept connected overnight once kept
its server talking to no one, every packet an error on stderr.
The main process learns of a crash only as the process exits, which is
once the system has written its core dump, if it writes one: a second
with systemd-coredump here, over a minute on a CI runner, so the test
below runs the app with core dumps off (`prlimit`). `src/main/page-end.ts`
names the three, and what is the page's goes at each: its sockets and WebSockets, what they had gathered for it, its
requests under way, its file grants. Nothing is sent to a page whose
process is gone, and nothing it sent before is acted on after: a
connection it asked for would be the dead page's. Unless it exited cleanly, stderr says so once, `swf2es:
the page stopped: <reason> (exit <code>)`, with the directory a crash
report would be in (`crashReporter`, started with nothing uploaded, so
a crash leaves a minidump there for the user to look at or send: it
holds what the crashed process had in memory, which may be what the SWF
held, a login or a chat among it, so it is best read before it is sent
to anyone), and
a message box on the window offers Reload Movie, which opens the movie
again as View › Reload Movie does, or Close. Nothing reloads unasked: a
page out of memory would only go again. Reload Movie, opening another
movie or closing it loads a gone page again, as does Reload Movie for a
page that failed to load, and the new page asks for the movie as any
does; a page back by any of them closes the box. A page that goes as the
app quits has not stopped, and says nothing.

## Files, settings and libraries

The main process (`src/main/open.ts`) opens a SWF from File › Open, a
drop on the window, the command line (the last argument that is an
http or https URL or names a
.swf file there is, as a switch may take a value), macOS's `open-file`,
a second start of the app, which hands its SWF to the first and quits,
File › Open URL (Ctrl+L), and the recent list, and sends the page its
swf2es://file URL, or the http or https one, which it plays with `load`
in place of what played, the element letting the last player go. The URL
dialog is a window of its own (`static/open-url.html`,
`src/renderer/open-url.ts`, `src/main/dialogs.ts`), modal over the
player's, with a preload of its own (`src/preload/prompt.cts`) whose
only messages are what to show
first and the user's answer, which the main process takes only from that
window's own page; the player's page may only ask for the dialog
(`openUrlDialog`). So nothing a SWF runs opens a URL: a SWF's movie
fetch reaches any address, as the user chose it, and the dialog keeps
that choice the user's. Only http and https URLs open, with a host and
without credentials, their fragment dropped. It keeps `settings.json` in
Electron's user data directory (`SWF2ES_DESKTOP_USER_DATA` names
another, for the tests): a chosen playerglobal's path, the last ten SWFs, by
path or URL, the servers each SWF, by path or URL, may always reach, and
whether the HTTP cache is on ([The HTTP cache](#the-http-cache)).
A settings file that cannot be written keeps them for the run, with a
word. ActionScript 3 plays on the builtin.abc and playerglobal the player
ships; a playerglobal.abc the user chooses, such as Flash Player's, takes
the place of swf2es's own, and choosing one reloads the page, which
fetches it once.

## The embedding

A SWF made for a page reads what its `<object>` or `<embed>` gave Flash,
and the command line gives the same (`src/main/embedding.ts`):
`--flashvars` and `--param name=value`, each taking its value after `=`
or as the next argument, read from the app's arguments before an AIR
application's `--`, and set aside before the movie or a descriptor is
looked for among the rest, so that a value ending in `.swf` or `.xml` is
neither. A value as the next argument may not start with `-`: the other
switches (`--proxy`, `--trace`, `--ignore-certificate-errors`) look at
every argument, and would take it for theirs too; the docs write the `=`
form. The parameters are the element's, by the same names and with the
same meaning, since the page plays the SWF with the element: nine of them,
listed once in `src/shared/embedding.ts`, which the main process reads
the command line by and the page sets attributes by, so a name the main
process let through by mistake still never reaches the element. The main
process sends them with the movie (`OpenedMovie.params`), and the page
sets them on its `<swf2es-player>` as attributes before it loads the SWF,
taking off the last movie's. So the page's own Scripting and Avm1 options
follow from them as in any page: `flashvars` as `loaderInfo.parameters`
and an AVM1 root's variables, after the SWF URL's own query, which the
player merges as Flash did; `quality`, `scale` and `salign` as the stage's;
`bgcolor` and `wmode` as the background drawn behind the stage, or none;
`menu` as the context menu's; and `allowNetworking` taking away what
Flash's did. Those that would widen
what the page lets a SWF do are refused, with a word on stderr:
`allowScriptAccess`, as ExternalInterface stays off ([What the page may
do](#what-the-page-may-do)), and `allowFullScreen` and
`allowFullScreenInteractive`, as a SWF's full screen is the window's here
anyway. `base` is an http or https URL or a relative one, resolved against
the SWF's URL, which stands in for the page it has not; for a local SWF a
relative one must come to its own directory or below, where alone its
relative loads could be read, and an absolute one other than http or
https is left out. A relative load it resolves is a request like any
other, judged by the SWF's sandbox, the file host's grant and Flash's
policy files, so it reaches nothing the SWF could not name itself.

What the command line leaves out is said once, on the stderr of the start
it was given to, as that start reads it (`settleEmbedding`): a second
start says its own and quits, and the app already open plays the movie
with what is left, silently, as it does again for each Reload Movie.

The embedding goes with the movie the command line names: a second
start's, which Electron would hand over reordered, a switch apart from its
value, comes as the second start's own arguments in the single-instance
lock's data; View › Reload Movie opens it again with it, and a reload of
the page gets it with the movie from `start`. What the menus, a drop or
the recent list open has none, and the settings keep none. An AIR
application has no page, and gets none, which its start says.

## Sockets

The element takes the shell's SocketHost through `configure({ sockets
})`. Each `flash.net.Socket` is an id the preload numbers, and the main
process connects it with `node:net`, as `player-hosts/node` does,
relaying its bytes and events over IPC. Only a SWF with the network has
sockets, and only as the user allows (`src/main/permissions.ts`): the
first connection to each host and port asks, Allow Once (until the SWF
closes), Always Allow for This
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
stops reading cannot fill the main process's memory. Each sends at once
(TCP_NODELAY) unless the SWF set AIR's `tcpNoDelay` to false before it
connected: with Nagle's algorithm, node's default and AIR's, the second
of two small writes waits for the peer to acknowledge the first, which
a peer with nothing to send back delays (about 40 ms on Linux, up to
200 ms on Windows), so a chatty protocol's every exchange would wait
too. `tcpNoDelay` as `connect()` saw it goes with `socket:connect`. A
socket through the proxy takes it once the tunnel is up, Nagle's
algorithm staying on through the handshake, which never writes twice
without an answer between, so nothing in it waits. A page's sockets
close, silently, as it navigates or reloads, as its process goes, and
with it. A socket reserved while its permission dialog is open counts toward
the limit; closing it or ending the page invalidates that reservation, so a
late answer cannot open it.

`flash.net.SecureSocket` uses those same checks and routes. `player-hosts/node`
opens direct TLS connections or wraps an established proxy tunnel, validating
the original hostname and retaining the policy's pinned address for routing. It
reports a certificate snapshot before the connect or error event over IPC.
Certificate getters stay in the renderer; only adding a DER certificate
needs synchronous validation in the main process. Additions are bounded by
64 certificates and 4 MB per connection. A pending self-signed-leaf exception
is sent to AIR-mode ActionScript as AIR 51's `certificateError`; closing or ending the
page discards any later answer. The app's global certificate-error switch
does not disable SecureSocket's validation.

Each plain socket and direct TLS socket is read into a 64 KB buffer of its own
(Node's `onread`), and
each read copied out at its length, where Node's stream would make a
Buffer of the read besides: Electron's IPC sends a typed array's whole
store, so a view of the buffer would not do. A socket's reads that go to
the page in one batch (below) are joined into a store of their own, a
second copy of their bytes, but one data event, and so one `socketData`
event for the SWF, rather than one for each read, which costs it far
more than the copy. A socket through the proxy is read the same way from
its start, its handshake included; it is paused once the tunnel is made,
the bytes that came with the proxy's reply are its first data, and it
reads on once the page is told it is open. Its reads never pause it, as
its stream never paused before. Direct TLS pauses after the handshake while
certificate consent is pending, retaining any plaintext already in flight until
acceptance. Refusal, timeout or close discards it. TLS over a proxy tunnel keeps
Node's stream reads: Node ignores `onread` when wrapping an existing socket.
Both TLS routes pass owned plaintext into the same IPC batches after validation.
`node tests/desktop/tls-bench.ts [rounds]` compares the two read paths with
interleaved runs, including batching and serialization but excluding connection
setup; the server runs in a separate process.

The page is sent its sockets' events, and its WebSockets', gathered
(`src/main/relay.ts`): one IPC message, `socket:events` or
`websocket:events`, carries each event with its connection's id, in the
order they came, a millisecond's at most. The window has a leading edge:
the first event after a millisecond with nothing sent goes at the end of
its turn of the main process's event loop, so that an answer to a
request waits for nothing, and what comes within the millisecond after a
batch waits for its end, by one timer, and goes with the rest that came
by then. Reads that cost little come many to a millisecond, each with a
few bytes: a batch a turn alone still left a message for most of them. A
socket's reads in a batch are one data event, up to its next event, so
its bytes always come before its close or error; each WebSocket message
stays an event of its own, as AIR dispatches one for each. A batch that
reaches 256 KB goes at once, so that neither the main process nor one
message holds more than that and a read.

A batch is one task of the page's: its listener
(`src/renderer/sockets.ts`, `websockets.ts`) hands every event in it on
in one loop, and one that throws leaves the rest to run. What is
gathered is dropped with the connections, its timer cleared, as the page
navigates or goes, so that no event of the last page's reaches the next,
which numbers its connections from 1 again.

On Windows a timer waits for the system's timer resolution, about
15.6 ms unless the process has raised it, as Chromium does only at times,
so the end of a window may come up to about 16 ms late there. That is
acceptable: the leading edge sends the first event after a quiet spell
at once, so a request and its answer wait no more than they did, and
only the tail of a burst waits; and the player hands a socket's bytes,
and a WebSocket's messages, to the SWF only at its next frame anyway
(`Loads.deferHostEvent`, run by `completeLoads` as the frame begins:
`packages/player/src/scripting/loads.ts`, `scripting.ts`).

## WebSockets

`air.net.WebSocket` runs over a WebSocketHost
([AIR's WebSocket](services.md#airs-websocket)), by default the page's
own WebSocket, which here would be refused twice, by the page's policy
and by the session's `webRequest`. Neither is loosened: the element
takes the shell's host through `configure({ webSockets })`
(`src/renderer/websockets.ts`), and each connection is an id the preload
numbers, which the main process opens (`src/main/websockets.ts`,
`websocket-connections.ts`) with [ws](https://github.com/websockets/ws),
a dependency of the app's alone (without its optional native modules),
pinned at 8.22.1, relaying its events over IPC: `open` with the subprotocol the server
chose, `message` with its bytes and whether it is text, `close` with its
code, `error` with how it failed where that is known, and `certificate`
for a self-signed certificate. Only an AIR application has them
(`sandbox.application`), to any `ws:` or `wss:` URL and unasked, as AIR's
application sandbox connects and as its sockets do here; for anything
else the connection is refused with a word on stderr, and a refusal is
an error and then a close with 1006, as a server that took no
connection.

The page sends frames, not messages (`websocket:frame`: an opcode and its
payload), so the host has WebSocketTransport's `frame` and the client
sends what AIR sends, as adl was seen to: text with its bytes as they
are, a leading BOM or bytes that are no UTF-8 among them; binary; pings
and pongs with their payloads; and a close frame with the SWF's code and
reason, any code RFC 6455 lets a frame carry (1001 and 1011 too), one it
does not closing with none, a reason past 123 bytes left out. ws refuses
a ping or pong past 125 bytes, which is not sent, and has no way to send
a reserved opcode, which is dropped. What comes is as adl keeps it: a
text message's bytes unchecked and with its BOM, a server's ping answered
with its payload and, like a pong, not told to the page. The request is
adl's too: no extension offered, no Origin, the subprotocols joined by
", ", and whatever the server chose taken, one offered or not, or none,
but for one not offered when some were, which fails as in adl. A URL
with credentials (`ws://user:pass@host/`) is refused, with a word on
stderr: ws would send them as `Authorization: Basic`, and adl takes what
comes before the `:` for its host and connects nowhere, so no credentials
go anywhere.

The connection is ws's `createConnection`, ours. Without the proxy, the
host is resolved here once and the connection made to its first address,
refused, with why on stderr, for none or for one no request reaches
(addresses.ts), as an application's HTTP requests are; each connection
resolves again, so a name that rebinds gets a connection of its own to
an address checked in turn, and nothing it did not place. Through the
proxy, the tunnel is to the name, for the proxy to resolve, as an AIR
application's sockets are ([Through a proxy](#through-a-proxy)). For
`wss:`, TLS goes over that connection with the URL's host as the server
name, its certificate checked against that name, not the address, by the
system's roots beside Node's, as the network checks https. A host that
`--ignore-certificate-errors` names goes unchecked. A self-signed
certificate otherwise is the application's to accept, as in AIR: the page
dispatches a certificateError, and only a listener that prevents its
default lets the connection go on (`websocket:certificate`), a page that
does not answer within 30 s refusing it. Only OpenSSL's
`DEPTH_ZERO_SELF_SIGNED_CERT` is asked about: a certificate signed by
itself and otherwise sound for the chain, whatever name it carries. Any
other fault fails the connection unasked, as adl fails a certificate
signed by a CA it does not trust; an expired self-signed one among them,
which adl asks about as self-signed but OpenSSL reports as
`CERT_HAS_EXPIRED`, so it fails closed here. A failure before the server was reached is told as such,
one after, a refused handshake, as `handshake`, and a subprotocol not
offered as `subprotocol`, which the natives dispatch as adl does.

A connection is made within 30 s, its lookup, tunnel and TLS included,
until ws takes it (the clock stops while the page is asked about a
certificate), and its handshake within 30 s after; a later one fails as a
server not there, with a word on stderr. A page holds at most 64 at
once. One with more than 16 MB its peer has not read fails, whether what
waits is what the application sent, a message that would take what is
unsent past 16 MB, a single message larger than that among them, or the
pongs a server's pings ask for. ws 8.22.1 would answer those without
bound, the flood 8.23.0 fixed, so the app answers them itself
(`autoPong: false`); once ws 8.23.0 or later is two weeks old, after
2026-11-26, the pin moves to it and ws may answer them again. A message
coming that is larger than 32 MB fails the connection, ws closing it
with 1009: adl took messages of 20 MB, which this leaves room above,
while bounding what one connection holds as a message comes. Its events reach the page gathered, as its sockets' do
([Sockets](#sockets)). A page's WebSockets drop, silently, as it
navigates or reloads, as its process goes, and with it, without a close frame, as AIR's go as
it exits; what is still being made, a lookup, a tunnel or a question
about a certificate, goes with them. `--log-network` says each connection
asked for, opened, refused, failed and closed, and each certificate
asked about and answered, and `--log-sockets` each frame sent and message
received, a text one as its text (`src/main/netlog.ts`).

## What draws

The player draws with WebGL 2, which Chromium gives on the GPU where its
blocklist takes the GPU. Where it takes none, there being none or its
blocklist refusing the one there is (Mesa's llvmpipe among them, Xvfb's
only GL, so every server and CI runner), Chromium no longer falls back to
SwiftShader, its GPU on the CPU, for WebGL unless started with
`--enable-unsafe-swiftshader`, so there is no WebGL 2 and nothing plays.
The app does not append that switch on its own: `--software-gl` does
(`src/main/gpu.ts`), with `--use-angle=swiftshader`, which draws everything
with SwiftShader, compositing included, even where there is a GPU (for one
Chromium takes for WebGL but not WebGL 2, or one that draws wrong). Both go
in before the app is ready, as Chromium reads its GPU switches as it starts
the GPU process, and only in the instance that holds the single-instance
lock; a second start chooses nothing.

It is a switch and not a fallback because it is unsafe by Chromium's own
word: its
[SwiftShader document](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)
calls SwiftShader "a high security risk due to JIT-ed code running in
Chromium's GPU process", and the fallback "not intended for running
untrusted content". The surface is SwiftShader's whole pipeline, its
Reactor JIT, rasteriser and sampling, under draws a SWF drives: what
shapes, bitmaps, filters and Stage3D calls it makes, with sizes and data of
its choosing, not only the shaders' text. A SWF never gives GLSL: Stage3D's
AGAL is validated and translated by `packages/context3d/src/agal.ts`, and
Pixel Bender's bytecode by `packages/format/src/pbj.ts` and the player's
translation, so the shaders SwiftShader compiles are the player's. The
page, where a SWF's compiled code runs, is in Chromium's sandbox
(seccomp-bpf on Linux) unless the user passes `--no-sandbox`. The GPU
process is not: with Electron 44 on Linux it runs without seccomp (`Seccomp:
0` in its `/proc` status, `sandboxed: false` in Chromium's GPU info), so
what SwiftShader does under a SWF's draws runs with the user's rights.

Where nothing draws, the app says so on stderr and names `--software-gl`.
It reads WebGL's status once, at the GPU process's first report
(`gpu-info-update`, about 200 ms in): before it, WebGL reads `disabled_off`
even where the GPU will draw, and the reports after it include the quit's,
which read disabled too. Electron 44 reports no WebGL 2 status, so a GPU that
gives WebGL but not WebGL 2 gets no hint; `disabled_off` or `unavailable_off`
is a GPU refused with no fallback, while `unavailable_software` is SwiftShader
drawing (as with Chromium's own `--enable-unsafe-swiftshader`). A second start
with `--software-gl`, which hands its SWF to the app already open, says that
app keeps drawing as it started.

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
`sandbox.test.ts` test the sockets' limits and reads, each copied out at
its length, through a proxy whose reply comes with the first bytes too,
and the sandbox's grants in node, `websocket-connections.test.ts` the WebSockets' messages, a text one's
bytes as they are, pings and pongs, close codes and reasons, refusals,
refused handshakes and subprotocols, URLs with credentials, limits and
deadlines, the address each name resolves to, rebinding included, and
certificates, self-signed ones accepted, refused or unanswered, expired
ones refused, `relay.test.ts` the events
gathered for the page, the window's leading edge, the order kept, reads
joined, a batch sent at 256 KB and dropped with the page, `addresses.test.ts` where each address is, in every form an IPv4
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
limits; `http-pool.test.ts` the kept connections against servers that
count the connections they take: one for two requests, one of its own for
a name pinned to another address (127.0.0.2, then 127.0.0.3), for a host
whose certificate goes unchecked and for a tunnel to another target, the
idle time and the bound on idle ones, a key's limit direct and through a
proxy, the drain's bounds, and aborts, servers that close a kept one and
a page that goes, with tunnels in use and being made. `tests/desktop/keepalive-bench.ts` times many small loads
over http and https, one checkout or two (docs/benchmarks.md).
`tests/desktop/xvfb.ts` runs the app as a server does, in a window on an
Xvfb with no switch of the test's for the GPU: it has no WebGL 2, takes no
SwiftShader and says to pass `--software-gl`; then with `--software-gl` a
SWF plays and draws on SwiftShader, which a second start does not claim; it
skips where there is no Xvfb, or where the Xvfb's GL is a GPU's.
`tests/desktop/stage3d.ts` drives the native View menu through the main
process's test-only inspector: Stage3D on for a fresh profile and for the
opt-in's old settings, a stored off's fallback without fetching the backend,
the choice remembered, two composed slots, live layout/DPR changes, browser context
loss/restoration, repeated movie reloads and close.
`tests/desktop/page-gone.ts` crashes the page's renderer through that
inspector while a SWF's socket, and an AIR application's socket and
WebSocket, receive from servers that keep sending: each server sees its
connection closed within two seconds of `render-process-gone`, stderr says the page stopped once
and nothing for each packet, the app stays up, and the offer, answered
through the inspector, or View › Reload Movie brings the movie back, the
offer closed reloading nothing; another movie opened brings the page
back and closes an offer left open, and Close Movie brings it back
empty. It shares the isolated
display and process harness in `tests/desktop/app.ts` with the ordinary smoke
test. `settings.test.ts` covers the default, the stored choice and its persistence.
`embedding.test.ts` reads `--flashvars` and `--param` in both forms, refuses
what changes nothing here and values apart that start with `-`, keeps
their values from being taken for the movie or a descriptor, lets no name
but the nine reach the element, from the command line or in the page's
own filter, settles `base` (http, https, or relative and, for a local
SWF, below its directory) and resolves it, takes a second start's
arguments as it sent them or Electron's, and has the launcher keep the
switches' values rather than make them paths; `tests/desktop/params.ts`
plays an AS3 SWF given them, which traces its parameters, its stage's
quality, scale mode and alignment and the file `base` makes a relative
URL read, the same SWF dropped on the window with none of them, then an
AVM1 SWF a second start names by its URL with a query and FlashVars of
its own, as its root's variables, again by View › Reload Movie, and a SWF
by its URL alone, with its query and none of the last's, again as the
page reloads. CI's `desktop`
workflow fetches Electron and runs them.

Not done yet: packaging and installers, Flash's Settings
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
