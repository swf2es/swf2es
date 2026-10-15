// The page's one way to the shell, window.swf2esDesktop: a few messages,
// each checked again by the main process. A sandboxed preload is a
// CommonJS script that may require only Electron's renderer modules.
import type {
  DesktopApi,
  LibraryName,
  NetworkResponse,
  OpenedMovie,
  SocketEvent,
} from "../shared/api.js";

const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

let nextSocket = 1;
let nextRequest = 1;
/** The requests waiting for their response, by number. */
const responses = new Map<number, (response: NetworkResponse) => void>();
ipcRenderer.on("net:response", (_event, id: number, response: NetworkResponse) =>
  responses.get(id)?.(response),
);

const api: DesktopApi = {
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
};

contextBridge.exposeInMainWorld("swf2esDesktop", api);
