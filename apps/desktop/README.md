# @swf2es/desktop

swf2es's desktop app: an Electron window that plays local SWFs, and SWFs
by their http or https URL, with the `<swf2es-player>` element of
`@swf2es/web`. Not packaged yet; it runs from
a checkout of the repository.

```sh
pnpm install && pnpm build
pnpm --filter @swf2es/desktop fetch-electron   # Electron's binary, once (about 100 MB)
pnpm --filter @swf2es/desktop start [--trace] [file.swf | https://host/movie.swf]
```

`pnpm install` does not download Electron's binary (pnpm-workspace.yaml
lists electron under `ignoredBuiltDependencies`), so the rest of the
repository builds and tests without it; `fetch-electron` runs Electron's
own installer. A relative path is taken from the directory pnpm was run in.

- **Open** a SWF with File › Open (Ctrl+O), by dropping it on the window,
  by its http or https URL with File › Open URL (Ctrl+L), or on the
  command line, a path or a URL, which also hands it to an app already
  open; File › Open Recent lists the last ten, files and URLs. The
  window takes the SWF's name. View › Reload Movie (Ctrl+R) starts it
  again, View › Toggle Full Screen (F11) fills the screen, and File ›
  Close Movie (Ctrl+W) stops it. Opening another SWF destroys the
  player before the next starts.
- **Libraries.** ActionScript 3 needs `builtin.abc` and `playerglobal.abc`.
  playerglobal is Adobe's and may not be redistributed, so the app does
  not include it: the first ActionScript 3 SWF shows what is missing and a
  button to choose it (or File › Choose playerglobal.abc…), and the app
  keeps the path in `settings.json` in Electron's user data directory.
  builtin.abc (avmplus', MPL-2.0) is taken from beside playerglobal.abc,
  else from the checkout's `oracle/avmplus/generated/`, else chosen too.
- **Trace.** `--trace` prints what the page logs, a SWF's `trace()` among
  it, to the terminal: trace lines to stdout, warnings and errors to stderr.
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
- **Pages** a SWF with the network opens with navigateToURL go to
  the system's browser, http and https only, one for each click or key in
  the window.

## Layout

```
src/main/       the main process: window, menu, settings, swf2es://, sockets and the network
src/preload/    window.swf2esDesktop, the page's only way to the main process, and the
                URL dialog's window.swf2esPrompt
src/renderer/   the page: the element, the welcome and library panels, the socket and
                fetch hosts; and the URL dialog's page
src/shared/     api.ts, the types of window.swf2esDesktop
static/         index.html (with the page's import map), open-url.html and style.css
launch.ts       `start`: finds Electron and runs the app
```

The page (`src/renderer`, `static`) knows the shell only through
`window.swf2esDesktop` (`src/shared/api.ts`), so another shell, Tauri
say, can serve the same page by giving the same API.
[docs/architecture.md](../../docs/architecture.md#the-desktop-app) has
the design, its security among it.
