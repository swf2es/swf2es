// The page's one way to the shell, window.swf2esDesktop: a few messages,
// each checked again by the main process. A sandboxed preload is a
// CommonJS script that may require only Electron's renderer modules.
import type {
  CaptureKind,
  CapturePermission,
  ConnectionEvents,
  DesktopApi,
  LibraryName,
  NetworkProgress,
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
/** Those told of as they come: who hears of it, and the pieces of its body so far. */
const streams = new Map<number, { progress: NetworkProgress; chunks: Uint8Array[] }>();
ipcRenderer.on("net:response", (_event, id: number, response: NetworkResponse) => {
  const stream = streams.get(id);
  streams.delete(id);
  if (response.streamed && stream) {
    const { streamed: _, ...rest } = response;
    responses.get(id)?.({ ...rest, bytes: joined(stream.chunks) });
    return;
  }

  responses.get(id)?.(response);
});
ipcRenderer.on("net:open", (_event, id: number, head: Omit<NetworkResponse, "bytes">, total) =>
  streams.get(id)?.progress.open(head, Number(total)),
);
ipcRenderer.on("net:data", (_event, id: number, chunk: Uint8Array) => {
  const stream = streams.get(id);
  if (stream) {
    stream.chunks.push(chunk);
    stream.progress.data(chunk);
  }
});

function joined(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }

  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  return bytes;
}

// One cache per movie lifetime; reads after the first never block on the main process.
let captureEpoch = -1;
let captureStopped = false;
const captureStatus = new Map<CaptureKind, CapturePermission>();
function captureLifetime(epoch: number): boolean {
  if (epoch < captureEpoch) {
    return false;
  }

  if (epoch > captureEpoch) {
    captureEpoch = epoch;
    captureStopped = false;
    captureStatus.clear();
  }

  return !captureStopped;
}
ipcRenderer.on("capture:stop", (_event, epoch: number) => {
  if (captureLifetime(epoch)) {
    captureStopped = true;
    captureStatus.clear();
  }
});
ipcRenderer.on("capture:probe", (_event, epoch: number, probe: number) => {
  ipcRenderer.send("capture:responsive", epoch, probe);
});

const api: DesktopApi = {
  capture: {
    epoch: () => ipcRenderer.sendSync("capture:epoch"),
    status: (epoch, kind) => {
      if (!captureLifetime(epoch)) {
        return "denied";
      }
      let status = captureStatus.get(kind);
      if (!status) {
        status = ipcRenderer.sendSync("capture:status", epoch, kind) as CapturePermission;
        captureStatus.set(kind, status);
      }

      return status;
    },
    request: async (epoch, kind) => {
      if (!captureLifetime(epoch)) {
        return "denied";
      }
      const result = (await ipcRenderer.invoke(
        "capture:request",
        epoch,
        kind,
      )) as CapturePermission;
      if (epoch !== captureEpoch || captureStopped) {
        return "denied";
      }
      captureStatus.set(kind, result);

      return result;
    },
    live: (epoch, kind, id, active) => ipcRenderer.send("capture:live", epoch, kind, id, active),
    stopped: (epoch) => ipcRenderer.send("capture:stopped", epoch),
    onStop: (listener) => {
      ipcRenderer.on("capture:stop", (_event, epoch: number) => listener(epoch));
    },
  },
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
    connect: (host, port, noDelay, secure) => {
      const id = nextSocket++;
      const asked = typeof noDelay === "boolean" ? noDelay : undefined;
      ipcRenderer.send("socket:connect", id, String(host), Number(port), asked, secure);
      return id;
    },
    isCertificate: (bytes) => ipcRenderer.sendSync("socket:is-certificate", bytes) === true,
    certificate: (id, accepted) => ipcRenderer.send("socket:certificate", id, accepted),
    send: (id, bytes) => ipcRenderer.send("socket:send", id, bytes),
    close: (id) => ipcRenderer.send("socket:close", id),
    onEvents: (listener) => {
      ipcRenderer.on("socket:events", (_event, events: ConnectionEvents<SocketEvent>) =>
        listener(events),
      );
    },
  },
  webSockets: {
    connect: (url, protocols) => {
      const id = nextWebSocket++;
      ipcRenderer.send("websocket:connect", id, String(url), Array.from(protocols, String));
      return id;
    },
    frame: (id, opcode, payload) => ipcRenderer.send("websocket:frame", id, opcode, payload),
    certificate: (id, accepted) => ipcRenderer.send("websocket:certificate", id, accepted),
    onEvents: (listener) => {
      ipcRenderer.on("websocket:events", (_event, events: ConnectionEvents<WebSocketEvent>) =>
        listener(events),
      );
    },
  },
  network: {
    fetch: (request, cancel, progress) => {
      const id = nextRequest++;
      cancel(() => ipcRenderer.send("net:abort", id));
      if (progress) {
        streams.set(id, { progress, chunks: [] });
      }

      // The response comes as a message of its own, before the answer that says it went.
      return new Promise<NetworkResponse>((resolve, reject) => {
        responses.set(id, (response) => {
          responses.delete(id);
          resolve(response);
        });
        ipcRenderer.invoke("net:fetch", id, request, progress !== undefined).then(
          ({ delivered }: { delivered: boolean }) => {
            if (!delivered) {
              responses.delete(id);
              streams.delete(id);
              reject(new Error("swf2es: the request was refused"));
            }
          },
          (error: unknown) => {
            responses.delete(id);
            streams.delete(id);
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
