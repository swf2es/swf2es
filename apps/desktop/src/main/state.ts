// What the main process's modules share: the window, its page, the
// settings, the HTTP cache and the sandbox of what plays. main.ts alone
// changes the window, the settings, the cache and whether the page
// listens or is gone, through the setters here, since a module cannot assign
// another's bindings; the rest read them as they are now.
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { HttpCache } from "./http-cache.ts";
import { APP_ORIGIN } from "./protocol.ts";
import { Sandbox } from "./sandbox.ts";
import type { SettingsFile } from "./settings.ts";

export const TITLE = "swf2es";

export const sandbox = new Sandbox();
export let settings: SettingsFile;
export let window: BrowserWindow | null = null;
/** The HTTP cache, open whether or not the File menu uses it; none under --no-http-cache. */
export let httpCache: HttpCache | null = null;
/**
 * The page has asked to start and listens for what opens: until then, start() hands it the movie.
 */
export let listening = false;
/**
 * The page's renderer process has gone and no page has started since: the window shows nothing
 * until it is loaded again.
 */
export let pageGone = false;

export function setWindow(created: BrowserWindow | null): void {
  window = created;
}

export function setSettings(read: SettingsFile): void {
  settings = read;
}

export function setHttpCache(opened: HttpCache | null): void {
  httpCache = opened;
}

export function setListening(now: boolean): void {
  listening = now;
}

export function setPageGone(now: boolean): void {
  pageGone = now;
}

/** Whether a message comes from the window's own page, on swf2es://app/, while it lives. */
export function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    window !== null &&
    event.sender === window.webContents &&
    // What a page sent before its process went may still come: a connection it asked for would
    // be the dead page's. The next page starts with a navigation, which clears this. Its frame,
    // gone before render-process-gone comes, would throw for its URL.
    !pageGone &&
    !event.sender.isCrashed() &&
    frame !== null &&
    frame.parent === null &&
    // Node's URL gives a scheme it does not know no origin: compare the text.
    frame.url.startsWith(`${APP_ORIGIN}/`)
  );
}
