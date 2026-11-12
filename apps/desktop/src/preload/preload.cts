// The page's one way to the shell, window.swf2esDesktop: a few messages,
// each checked again by the main process. A sandboxed preload is a
// CommonJS script that may require only Electron's renderer modules.
import type {
  DesktopApi,
  LibraryName,
  NetworkResponse,
  OpenedMovie,
  SocketEvent,
  WebSocketEvent,
} from "../shared/api.js";

const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

let nextSocket = 1;
let nextWebSocket = 1;
let nextRequest = 1;
/** The requests waiting for their response, by number. */
const responses = new Map<number, (response: NetworkResponse) => void>();
ipcRenderer.on("net:response", (_event, id: number, response: NetworkResponse) =>
  responses.get(id)?.(response),
);

const api: DesktopApi = {
  files: {
    browse: (filters, multiple) => ipcRenderer.invoke("files:browse", filters, multiple),
    save: (name) => ipcRenderer.invoke("files:save", name),
    read: (id) => ipcRenderer.invoke("files:read", id),
    write: (id, bytes) => ipcRenderer.invoke("files:write", id, bytes),
    release: (id) => ipcRenderer.send("files:release", id),
  },
  fullScreen: {
    set: (fullScreen) => ipcRenderer.send("desktop:full-screen", fullScreen === true),
    onChange: (listener) => {
      ipcRenderer.on("desktop:full-screen", (_event, fullScreen: boolean) => listener(fullScreen));
    },
  },
  start: () => ipcRenderer.invoke("desktop:start"),
  onOpen: (listener) => {
    ipcRenderer.on("desktop:open", (_event, movie: OpenedMovie) => listener(movie));
  },
  onClose: (listener) => {
    ipcRenderer.on("desktop:close", () => listener());
  },
  openDialog: () => ipcRenderer.send("desktop:open-dialog"),
  openUrlDialog: () => ipcRenderer.send("desktop:open-url-dialog"),
  // The page never sees the path, only the URL the shell gives back.
  openDropped: (file) => ipcRenderer.send("desktop:open-path", webUtils.getPathForFile(file)),
  chooseLibrary: (name: LibraryName) => ipcRenderer.send("desktop:choose-library", name),
  sockets: {
    connect: (host, port) => {
      const id = nextSocket++;
      ipcRenderer.send("socket:connect", id, String(host), Number(port));
      return id;
    },
    send: (id, bytes) => ipcRenderer.send("socket:send", id, bytes),
    close: (id) => ipcRenderer.send("socket:close", id),
    onEvent: (listener) => {
      ipcRenderer.on("socket:event", (_event, id: number, event: SocketEvent) =>
        listener(id, event),
      );
    },
  },
  webSockets: {
    connect: (url, protocols) => {
      const id = nextWebSocket++;
      ipcRenderer.send("websocket:connect", id, String(url), Array.from(protocols, String));
      return id;
    },
    send: (id, data) => ipcRenderer.send("websocket:send", id, data),
    close: (id, code) => ipcRenderer.send("websocket:close", id, code),
    onEvent: (listener) => {
      ipcRenderer.on("websocket:event", (_event, id: number, event: WebSocketEvent) =>
        listener(id, event),
      );
    },
  },
  network: {
    fetch: (request, cancel) => {
      const id = nextRequest++;
      cancel(() => ipcRenderer.send("net:abort", id));
      // The response comes as a message of its own, before the answer that says it went.
      return new Promise<NetworkResponse>((resolve, reject) => {
        responses.set(id, (response) => {
          responses.delete(id);
          resolve(response);
        });
        ipcRenderer.invoke("net:fetch", id, request).then(
          ({ delivered }: { delivered: boolean }) => {
            if (!delivered) {
              responses.delete(id);
              reject(new Error("swf2es: the request was refused"));
            }
          },
          (error: unknown) => {
            responses.delete(id);
            reject(error);
          },
        );
      });
    },
    loadPolicyFile: (url) => ipcRenderer.send("net:policy-file", String(url)),
  },
  // Synchronous where File and NativeWindow read: their properties answer at once.
  air: {
    stat: (path) => ipcRenderer.sendSync("air:stat", String(path)),
    list: (path) => ipcRenderer.sendSync("air:list", String(path)),
    read: (path) => ipcRenderer.invoke("air:read", String(path)),
    readSync: (path) => ipcRenderer.sendSync("air:read-sync", String(path)),
    getItem: (name) => ipcRenderer.sendSync("air:item-get", String(name)),
    setItem: (name, bytes) => ipcRenderer.sendSync("air:item-set", String(name), bytes),
    removeItem: (name) => ipcRenderer.sendSync("air:item-remove", String(name)),
    resetItems: () => ipcRenderer.sendSync("air:items-reset"),
    writeSync: (path, bytes, offset, length) =>
      ipcRenderer.sendSync("air:write-sync", String(path), bytes, Number(offset), Number(length)),
    createDirectory: (path) => ipcRenderer.sendSync("air:create-directory", String(path)),
    remove: (path) => ipcRenderer.sendSync("air:remove", String(path)),
    move: (from, to) => ipcRenderer.sendSync("air:move", String(from), String(to)),
    window: () => ipcRenderer.sendSync("air:window"),
    screens: () => ipcRenderer.sendSync("air:screens"),
    setBounds: (bounds) => ipcRenderer.send("air:set-bounds", bounds),
    setTitle: (title) => ipcRenderer.send("air:set-title", String(title)),
    minimize: () => ipcRenderer.send("air:window-do", "minimize"),
    maximize: () => ipcRenderer.send("air:window-do", "maximize"),
    restore: () => ipcRenderer.send("air:window-do", "restore"),
    activate: () => ipcRenderer.send("air:window-do", "activate"),
    setVisible: (visible) => ipcRenderer.send("air:window-do", visible ? "show" : "hide"),
    close: () => ipcRenderer.send("air:window-do", "close"),
    exit: (code) => ipcRenderer.send("air:exit", Number(code) | 0),
  },
};

contextBridge.exposeInMainWorld("swf2esDesktop", api);
