// What the main process's modules share: the window, its page, the
// settings and the sandbox of what plays. main.ts alone changes the
// window, the settings and whether the page listens, through the setters
// here, since a module cannot assign another's bindings; the rest read
// them as they are now.
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { APP_ORIGIN } from "./protocol.ts";
import { Sandbox } from "./sandbox.ts";
import type { SettingsFile } from "./settings.ts";

export const TITLE = "swf2es";

export const sandbox = new Sandbox();
export let settings: SettingsFile;
export let window: BrowserWindow | null = null;
/**
 * The page has asked to start and listens for what opens: until then, start() hands it the movie.
 */
export let listening = false;

export function setWindow(created: BrowserWindow | null): void {
  window = created;
}

export function setSettings(read: SettingsFile): void {
  settings = read;
}

export function setListening(now: boolean): void {
  listening = now;
}

/** Whether a message comes from the window's own page, on swf2es://app/. */
export function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    window !== null &&
    event.sender === window.webContents &&
    frame !== null &&
    frame.parent === null &&
    // Node's URL gives a scheme it does not know no origin: compare the text.
    frame.url.startsWith(`${APP_ORIGIN}/`)
  );
}
