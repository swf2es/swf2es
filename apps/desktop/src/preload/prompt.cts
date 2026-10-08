// The URL dialog's one way to the main process, window.swf2esPrompt: what
// to show first, and the user's answer. Apart from the player's page and
// its API, so that nothing a SWF runs can open a URL.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("swf2esPrompt", {
  initial: (): Promise<string> => ipcRenderer.invoke("prompt:initial"),
  /** The URL to open, or null for none. */
  answer: (url: string | null) =>
    ipcRenderer.send("prompt:answer", url === null ? null : String(url)),
});
