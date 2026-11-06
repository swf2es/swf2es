// An AIR application the shell opened by its descriptor, as the player
// sees it: NativeApplication's launch and window, and the file system
// File reads, all through the shell (window.swf2esDesktop.air), which
// answers only while that application plays. Its SWFs' app:, app-storage:
// and file: URLs are read from disk the same way (`airPath`).
import type { AirApplication, FileSystemHost } from "@swf2es/player";
import type { AirLaunch, DesktopAir } from "../shared/api.js";

/** The player's view of `launch`: its application and window, and its file system. */
export function airHosts(
  launch: AirLaunch,
  air: DesktopAir,
): { application: AirApplication; fileSystem: FileSystemHost } {
  return {
    application: {
      descriptor: launch.descriptor,
      id: launch.id,
      arguments: launch.arguments,
      currentDirectory: launch.currentDirectory,
      window: {
        bounds: () => air.window().bounds,
        setBounds: (bounds) => air.setBounds(bounds),
        title: () => air.window().title,
        setTitle: (title) => air.setTitle(title),
        displayState: () => air.window().displayState,
        minimize: () => air.minimize(),
        maximize: () => air.maximize(),
        restore: () => air.restore(),
        active: () => air.window().active,
        activate: () => air.activate(),
        visible: () => air.window().visible,
        setVisible: (visible) => air.setVisible(visible),
        close: () => air.close(),
        stageOffset: () => air.window().contentOffset,
      },
      exit: (code) => air.exit(code),
    },
    fileSystem: {
      separator: launch.separator,
      directories: launch.directories,
      stat: (path) => air.stat(path),
      list: (path) => air.list(path),
    },
  };
}

/**
 * The native path an app:, app-storage: or file: URL names in `launch`;
 * null for any other URL. The shell judges what it may read.
 */
export function airPath(launch: AirLaunch, url: string): string | null {
  const m = /^(app|app-storage|file):(.*)$/i.exec(url);
  if (!m) {
    return null;
  }

  const sep = launch.separator;
  let rest: string;
  try {
    // A query or a fragment is no part of the file's name.
    rest = decodeURIComponent(m[2].replace(/[?#].*$/, ""));
  } catch {
    return null;
  }

  switch (m[1].toLowerCase()) {
    case "app":
      return join(launch.directories.application, rest, sep);
    case "app-storage":
      return join(launch.directories.applicationStorage, rest, sep);
    default: {
      // file:///path, or file:///C:/path on Windows.
      const path = rest.replace(/^\/\/[^/]*/, "");
      return sep === "\\" ? path.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\") : path;
    }
  }
}

/** `rest`, a URL's path, under `base`, a directory: its segments joined by `sep`. */
function join(base: string, rest: string, sep: string): string {
  const segments = rest.split("/").filter((s) => s !== "" && s !== ".");
  return [base.replace(/[\\/]+$/, ""), ...segments].join(sep);
}
