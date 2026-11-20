# @swf2es/desktop

swf2es's desktop app: an Electron window that plays local SWFs, SWFs by
their http or https URL, and AIR applications, with the `<swf2es-player>`
element of `@swf2es/web`.

```sh
npx @swf2es/desktop [options] [--flashvars=vars] [--param=name=value]... [file.swf | https://host/movie.swf]
npx @swf2es/desktop [options] app.xml [root-dir] [-- arguments...]
```

npx takes the first `--` on its command line as the end of its own
options, so with arguments for the application write one before the
package too: `npx -- @swf2es/desktop app.xml -- --server=local`. The
installed command, `swf2es-desktop`, needs only the second.

Node 22.18 or later runs it. The first run downloads Electron's binary
(about 100 MB), once; installed, the command is `swf2es-desktop`. A
relative path is taken from the directory the command was run in.

In a checkout of the repository:

```sh
pnpm install && pnpm build
pnpm --filter @swf2es/desktop start [options] [file.swf | https://host/movie.swf]
```

`pnpm install` does not download Electron's binary (pnpm-workspace.yaml
lists electron under `ignoredBuiltDependencies`), so the rest of the
repository builds and tests without it. `start` downloads it the first
time, as the installed command does; `pnpm --filter @swf2es/desktop
fetch-electron` does so ahead, for the tests.

- **Open** a SWF with File › Open (Ctrl+O), by dropping it on the window,
  by its http or https URL with File › Open URL (Ctrl+L), or on the
  command line, a path or a URL, which also hands it to an app already
  open; File › Open Recent lists the last ten, files and URLs. The
  window takes the SWF's name. View › Reload Movie (Ctrl+R) starts it
  again, View › Toggle Full Screen (F11) fills the screen, and File ›
  Close Movie (Ctrl+W) stops it. Should the page's process stop, crashed
  or out of memory, its sockets close, stderr says why, and the window
  offers to reload the movie, which it never does unasked. A SWF's own full screen
  (`Stage.displayState`) is the window's too: it needs no click, as in AIR
  and Flash's projector, draws its `fullScreenSourceRect` alone where it
  set one, and ends with Esc or F11, which the SWF hears of as a
  `FullScreenEvent`. Opening another SWF destroys the
  player before the next starts.
- **Camera and microphone.** A dialog names the top-level movie's source and
  requested kind (camera or microphone) before capture starts. Child movies use
  the same attribution; physical device names may be blank until consent. Consent lasts for that movie; macOS also
  requires system permission. The title marks live capture, and View › Stop
  Camera and Microphone stops both until the movie reloads. If a frozen movie
  cannot stop its tracks, the app terminates its renderer and offers a reload.
- **Stage3D.** SWFs get a Context3D, as in Flash and AIR on a desktop. View ›
  Stage3D turns it off, after which a SWF's `requestContext3D`
  gets Error #3702 "Context3D not available", and on again; the app remembers
  that choice in `settings.json` (`stage3DChoice`) and restarts the current
  movie when it changes. Until it is changed there it is on, also for a
  `settings.json` from before Stage3D was on by default: that one saved
  `"stage3D": false` whether or not it was chosen, so it is not read. The
  WebGL2 backend loads when a SWF first requests a context, so a SWF that
  never does starts as fast as with Stage3D off. The desktop uses the web
  element's composition, live AS3 Stage layout and context recovery. If the
  backend cannot load, requests get Error #3702 and the cause is logged.
  Each slot owns a separate WebGL2 context; closing or reloading the movie
  releases its resources and browser contexts.
  Each resource type has its own 4,096-resource count limit.
  Buffer and texture byte allowances follow the shared backend's AIR-backed
  limits, with separate host budgets for target attachments. Supported
  formats and remaining gaps are in [Context3D](../../packages/context3d/README.md).
- **Theme.** View › Theme is System, the default, Light or Dark: the app's
  pages, the element's performance meter and context menu, and the URL
  dialog follow it, as `prefers-color-scheme`, and so do the title bar and
  menus where the platform lets an app choose (macOS and Windows). The
  SWF's stage keeps its own background colour, whatever the theme. The app
  remembers the choice in `settings.json` (`theme`) and applies it before
  its window opens; `--theme=system`, `--theme=light` or `--theme=dark`
  sets it for one run, said on stderr, and leaves the saved one as it is.
- **Libraries.** ActionScript 3 plays on the `builtin.abc` (avmplus',
  MPL-2.0) and playerglobal that ship with the player, with nothing to set
  up. File › Choose playerglobal.abc… plays on another playerglobal, such
  as Flash Player's, in place of the app's own; the app keeps its path in
  `settings.json` in Electron's user data directory, across updates of the
  app, and says so on stderr at each start. File › Use the App's
  playerglobal goes back to the app's own.
- **FlashVars and parameters.** A SWF made for a page reads what its
  `<object>` or `<embed>` gave it; the command line gives it the same, as
  the `<swf2es-player>` element's attributes of those names:

  ```sh
  swf2es-desktop --flashvars="user=guest&lang=en" --param=quality=low movie.swf
  swf2es-desktop --param=scale=noScale --param=salign=TL --param=base=assets/ movie.swf
  swf2es-desktop "https://example.com/movie.swf?user=guest"
  ```

  `--flashvars="a=1&b=2"` is its FlashVars, URL-encoded as a page's:
  `loaderInfo.parameters`, or an AVM1 SWF's `_root` variables; given again,
  they are joined. `--param=name=value`, repeatable, is one of `quality`,
  `scale`, `salign`, `wmode`, `bgcolor`, `menu`, `base` and
  `allowNetworking`, any case, the last of a name winning
  (`--param=flashvars=…` is `--flashvars`); any other name is left out,
  with a word. Write them with `=`: the value may also follow as the next
  argument (`--flashvars "a=1"`), but not one that starts with `-`, which
  other switches, `--proxy` and `--trace` among them, would read as their
  own. `base` is an http or https URL, or a relative one, resolved against
  the SWF's own URL as a page's against the page's: for a local SWF, to its
  directory or below, as it reads nothing outside it. Anything else is left
  out, with a word as the app starts. The loads it resolves are judged by
  the SWF's sandbox like any other. A SWF URL's query is among its parameters, as Flash had it, the
  FlashVars over it, with or without the switches. They are for the SWF the
  command line names, a second start's handed to the app already open too,
  and stay with it through View › Reload Movie and a reload of the page; a
  SWF opened from the menus, the recent list or a drop gets none, and the
  recent list keeps none. `allowScriptAccess`, `allowFullScreen` and
  `allowFullScreenInteractive` change nothing, said on stderr:
  ExternalInterface stays off, and a SWF's full screen is always the
  window's. An AIR application gets none, having no page, and the app says
  so; an HTML page wrapping a SWF does not open.
- **Trace.** `--trace` prints what the page logs, a SWF's `trace()` among
  it, to the terminal: trace lines to stdout, warnings and errors to stderr.
- **Without a GPU.** The player draws with WebGL 2. Where Chromium takes
  no GPU, because there is none or its blocklist refuses the one there is
  (a server, a CI runner, a virtual machine, Xvfb, whose only GL is Mesa's
  llvmpipe), there is no WebGL 2 and nothing draws, and the app says so on
  stderr. `--software-gl` draws with SwiftShader, Chromium's GPU on the CPU,
  there, and also where Chromium takes a GPU that gives WebGL but not WebGL 2
  or draws wrong. It is a switch, not a fallback, because Chromium calls
  SwiftShader unsafe for untrusted content: it compiles code in the GPU
  process, which on Linux runs outside Chromium's sandbox (see
  [What draws](../../docs/architecture/desktop.md#what-draws)). SwiftShader
  is slower than a GPU, more so the larger the window. On a server with no
  display: `xvfb-run -a swf2es-desktop --software-gl movie.swf`. Where a
  Wayland session is about (`WAYLAND_DISPLAY`, or
  `XDG_SESSION_TYPE=wayland`), Electron goes to it rather than to Xvfb
  unless told otherwise: add `--ozone-platform=x11`.
- **Network log.** `--log-network` prints each of the SWF's requests to
  stderr as it is answered (`swf2es: net GET https://… 200 12.3 kB 48 ms`),
  an aborted one too, and each socket and each WebSocket of an AIR
  application as it is asked for, opened, refused, failed and closed
  (`swf2es: websocket #1 connecting to ws://…`, `open`, `close 1000`). A
  refused request is said with or without it. The
  window's DevTools show none of these in their Network tab: the page has
  no network, and the main process sends them.
  `--log-sockets` prints those lines and each message a socket or a
  WebSocket sends (`>`) and receives (`<`): its size and its first 512
  bytes, as text where it is text and in hex otherwise, a WebSocket's
  text message as its text. That is whatever the SWF sends, a login
  and its password among it: mind where the terminal's output goes.
- **HTTP cache.** The SWF's http and https GETs, its own SWF and the
  policy files they need among them, are cached as a browser's private
  cache would, by what the server says (Cache-Control, Expires, ETag,
  Last-Modified, Vary): a fresh response is served from the cache, a
  stale one is revalidated, and its 304 serves what is stored. Flash's
  sandbox and policy files still judge every request first, cached or
  not, and a response is kept for the address it came from and the
  origin of the SWF that asked, so no SWF reads another site's cached
  responses. Nothing from a host `--ignore-certificate-errors` names is
  cached. A freshness the cache guesses from Last-Modified alone lasts
  a day at most; a SWF updated on its server within it shows after File ›
  Clear HTTP Cache. It lives in `HTTP Cache` under the system's cache directory
  (`~/.cache/@swf2es/desktop/` on Linux, `~/Library/Caches/@swf2es/desktop/`
  on macOS, `%LOCALAPPDATA%\@swf2es\desktop\` on Windows) and holds 512 MB
  at most, the least recently used going first. File › Clear HTTP Cache
  empties it; File › HTTP Cache turns it off and on, which the app
  remembers in `settings.json` (`httpCache`); `--no-http-cache` leaves it
  off for one run, neither read nor written. `--log-network`'s line for a
  response from the cache ends in `from cache`, or `revalidated` after a
  304.
- **Certificates.** `--ignore-certificate-errors` leaves every HTTPS
  server's certificate, and every `wss:` server's that an AIR
  application's WebSocket connects to, unverified for this run, and
  `--ignore-certificate-errors=dev.test,localhost` those hosts' alone, on
  any port: for a server of your own whose certificate it signed itself.
  Whoever is between you and such a host can then read and change what the
  SWF loads from it or says to it. It is never kept in the settings, and the app says on
  stderr, each time it starts with it, which hosts go unverified. The page
  itself has no network (the main process makes a SWF's requests and
  connections), so nothing but those is affected.
- **Policy files.** `--ignore-policy-files` lets the SWF read every
  public host's data, send it headers and open sockets to it (as you
  allow each server) as if its cross-domain policy files allowed it, for
  this run: for a SWF you trust whose servers no longer serve the files
  Flash asked for. `--ignore-policy-files=data.example,localhost` does so
  for those hosts alone, matched exactly (not their subdomains, and a
  name is not its address). It is unsafe in the way policy files exist to
  prevent: the SWF reads, as this machine, whatever this machine reaches
  of those hosts (no cookies or credentials go, but a site that trusts
  your address answers it) and may send it anywhere. The bare switch
  never reaches this machine or your local network: a SWF from the
  internet still needs a policy file there unless you name the host
  (`--ignore-policy-files=localhost,192.168.1.5`). The sandbox stays as
  it is: a local SWF without the network reaches none. `--log-network`'s
  line for a request it let through ends in
  `allowed by --ignore-policy-files`. It holds for every SWF the running
  app opens, one double-clicked into it later included; a second start
  with the switch hands its SWF to the app already open, which plays it
  as it started. It is never kept in the settings, and the app says on
  stderr, each time it starts with it, what it covers.
- **Naming hosts.** `--ignore-certificate-errors=` and
  `--ignore-policy-files=` take host names and addresses, each matched
  exactly as a URL writes it: case does not count, an IPv6 address goes
  with or without its brackets, and an address written another way
  (`127.1`, `0x7f.0.0.1`, `192.168.010.5`) is the address it stands for,
  which the app says. A port (`dev.test:8443`) is taken as every port of
  the host, which the app says too. A wildcard (`*`, `*.dev.test`)
  matches nothing: the switch alone covers every host it can. An entry
  that is not a host alone (`https://dev.test`, `user@dev.test`,
  `dev.test/x`) is left out, with a word on stderr.
- **Proxy.** `--proxy=socks5://host:1080` sends everything the SWF does
  on the network through a SOCKS5 proxy (RFC 1928; `socks5h://` is the
  same), and `--proxy=http://host:3128` through an HTTP proxy, by a
  `CONNECT` tunnel for each connection, plain http too: its http and https
  requests, the policy files they need, its sockets with their socket
  policies, and an AIR application's WebSockets. A username and password
  go in the URL (`socks5://user:pass@host:1080`, %-escaped where they need
  it): RFC 1929's for SOCKS5, `Proxy-Authorization: Basic` for HTTP. They
  come from the command line alone, and are never kept nor said: the app
  says on stderr, as it starts, which proxy it uses, by its host and port.
  TLS is the app's own, over the tunnel, so certificates are verified, or
  not for the hosts `--ignore-certificate-errors` names, as without a
  proxy. Whether a host is on this machine or the local network (below)
  is still judged by this machine's DNS, and the proxy is then asked for
  the address judged, not the name, so it reaches nothing the judgement
  did not; a socket or WebSocket nothing judged (a local SWF's, an AIR
  application's) goes by its name, for the proxy to resolve. A proxy that
  is not there, refuses the credentials or refuses a connection is, to
  the SWF, a server that is not there (IOErrorEvent, a socket's #2031), and
  a line on stderr says why: `swf2es: not loading http://…: the proxy
  socks5://127.0.0.1:1080 refused: connection refused (SOCKS reply 5)`.
  `--log-network`'s lines name the target, and end in `via proxy`. A
  second start of the app with another `--proxy` opens nothing in the
  first. An HTTP proxy that allows `CONNECT` only to port 443, as Squid
  does by default, refuses plain http and sockets on other ports.
- **Sandbox.** A SWF plays in the sandbox Flash Player gave a local SWF,
  by its FileAttributes' UseNetwork bit. Without it,
  local-with-filesystem: it reads the files in its own directory and below
  (only itself if that is your home directory, the one holding every
  user's, a temporary directory or a drive's root; keep a SWF in a
  directory of its own) and reaches no network, no socket and no page.
  With it, local-with-networking: it reads no local file but itself, loads
  content (images, sounds, SWFs) from the network, reads data only where
  the server's `crossdomain.xml` grants every domain (`domain="*"`), as
  Flash had it, and connects sockets as you allow. Only the SWF playing
  has access; opening another or closing it takes it away. Its URL
  (`loaderInfo.url`) does not tell where on the disk it is. A SWF opened
  by its URL plays in Flash's remote sandbox: it reads no local file,
  loads anything from its own origin, reads another's data only as that
  site's `crossdomain.xml` grants its domain, and opens a socket only
  where you allow it and the server's socket policy (port 843, or the
  port itself) grants it.
- **Network.** A SWF's http and https requests go through the main
  process, judged by Flash's rules and policy files rather than CORS, so
  `http:` and servers without CORS work. No request carries your cookies
  or credentials, and none reaches this machine or your local network
  unless the SWF came from there or a policy file there grants it. That
  is judged by address range, as a browser judges it: this machine's own
  public address, or a LAN device's global IPv6 address, counts as the
  internet, which any web page could reach too.
- **Sockets** (`flash.net.Socket`) connect over TCP through the main
  process. The first connection to each server asks: Allow Once, Always
  Allow for This SWF (remembered in `settings.json`) or Deny.
- **WebSockets** (`air.net.WebSocket`, AIR's and not Flash Player's)
  connect through the main process too, with the WebSocket client of
  Electron's Node, for an AIR application alone: to any `ws:` or `wss:`
  URL, unasked, text and binary messages, subprotocols and close codes.
  As in a browser, it sends the close codes 1000 and 3000 to 4999 (any
  other closes with none), answers a server's pings itself and sends
  none of the application's own.
- **AIR applications** run by their descriptor (`app.xml`), as adl runs
  them: its first window's content SWF, from the descriptor's directory
  or the root directory given after it, at the descriptor's size and with
  its title, the arguments after `--` handed to its InvokeEvent. It plays
  with AIR's API (NativeApplication, the window, the system's displays as
  `flash.display.Screen`, `flash.filesystem.File`)
  in AIR's application sandbox: it is played from `app:/`, reads any
  local file through File, FileStream and its `app:`, `app-storage:` and
  `file:` URLs, writes any file but through its `app:` URLs, as AIR does,
  makes temporary files and directories (`File.createTempFile()`,
  `createTempDirectory()`) in the system's temporary directory, its
  `File.cacheDirectory`, which it leaves for the application to delete,
  and reaches the network, sockets and WebSockets (`air.net.WebSocket`)
  without Flash's policy files or a prompt, as an installed application
  does. Its storage directory is
  under the app's user data, by its id, and its `EncryptedLocalStore`
  beside it, encrypted by the system's keychain (Electron's
  `safeStorage`) where there is one. Only the application playing has
  that reach, and only while it plays; run one you trust, as you would
  install it. A descriptor chosen with Open…, dropped on the window or
  opened with the app runs the application too, from its own directory
  with no arguments; the app asks first, once, until the descriptor
  leaves the recent list.
- **Case in names.** Windows and macOS find a file whatever case its name
  is given in, so content made there names files as it likes. On Linux, a
  path a SWF or an AIR application names that is not there exactly is
  found the same way: each missing name is the one in its directory equal
  to it ignoring case (both as NFC, lowercased, which is close to how NTFS
  and APFS fold case). `Maps/Town.swf` reads `maps/town.swf`; a file
  written into `Saves/` goes into `saves/` where that is there, under the
  name it was given. Where a directory holds two names that differ only in
  case, neither is taken, and stderr says so once. A sandbox reaches no
  more than before: what it lets a SWF read is judged on the file found.
- **File dialogs** requested by AS2 or AS3 FileReference use native open
  and save dialogs after a click or key. Uploads and downloads use the
  same network permissions as other data requests.
- **Pages** a SWF with the network opens with navigateToURL go to
  the system's browser, http and https only, one for each click or key in
  the window.

## Layout

```
src/main/       the main process: window, menu, settings, swf2es://, sockets, WebSockets
                and the network
src/preload/    window.swf2esDesktop, the page's only way to the main process, and the
                URL dialog's window.swf2esPrompt
src/renderer/   the page: the element, the welcome and library panels, the socket,
                WebSocket and fetch hosts; and the URL dialog's page
src/shared/     api.ts, the types of window.swf2esDesktop
static/         index.html (with the page's import map), open-url.html and style.css
src/launch/     the swf2es-desktop command, and `start`: finds Electron, fetching its
                binary the first time, and runs the app
```

The page (`src/renderer`, `static`) knows the shell only through
`window.swf2esDesktop` (`src/shared/api.ts`), so another shell, Tauri
say, can serve the same page by giving the same API.
[docs/architecture/desktop.md](../../docs/architecture/desktop.md) has
the design, its security among it.
