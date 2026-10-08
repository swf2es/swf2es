// What the shell gives the page, and all it gives: the preload puts it on
// window.swf2esDesktop. The renderer knows the shell only through it, so
// another shell (Tauri, later) plays the same page by giving the same API.

/** Flash's sandboxes, as Security.sandboxType names them. */
export type SandboxType = "localWithFile" | "localWithNetwork" | "remote";

/** A SWF the shell opened, by the URL the page fetches it from. */
export interface OpenedMovie {
  url: string;
  /** Its file name, for the page to show. */
  name: string;
  /** The sandbox it plays in, for Security.sandboxType. */
  sandbox: SandboxType;
}

/** The libraries' paths on disk, null for one the shell has not found. */
export interface LibraryState {
  builtin: string | null;
  playerglobal: string | null;
}

/** What the page starts from: the libraries, and the SWF to play, if one is open. */
export interface StartState {
  libraries: LibraryState;
  movie: OpenedMovie | null;
}

export type LibraryName = keyof LibraryState;

/** What befalls a socket, as player's SocketEvents has it. */
export type SocketEvent =
  | {
      type: "open";
      localAddress: string;
      localPort: number;
      remoteAddress: string;
      remotePort: number;
    }
  | { type: "data"; bytes: Uint8Array }
  | { type: "close" }
  | { type: "error"; message: string };

/** flash.net.Socket's TCP connections, opened by the shell. */
export interface DesktopSockets {
  /** A connection's id; its events follow, an "error" one if the shell refuses it. */
  connect(host: string, port: number): number;
  send(id: number, bytes: Uint8Array): void;
  close(id: number): void;
  onEvent(listener: (id: number, event: SocketEvent) => void): void;
}

/** A request of a SWF's, as player's FetchRequest has it. */
export interface NetworkRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  /** "movie" for the SWF the page plays, else what the SWF loads it for. */
  purpose: "movie" | "content" | "data" | "send";
}

/** Its response, as player's FetchResult has it: no bytes for a failure. */
export interface NetworkResponse {
  bytes: Uint8Array | null;
  status: number;
  headers: [string, string][];
  url?: string;
}

/** A SWF's http and https requests, sent and judged by the shell, as Flash's sandboxes had them. */
export interface DesktopNetwork {
  /**
   * The response, or a rejection where the shell refused the request.
   * `cancel` is called at once with what aborts it.
   */
  fetch(request: NetworkRequest, cancel: (abort: () => void) => void): Promise<NetworkResponse>;
  /** A policy file the SWF named with Security.loadPolicyFile. */
  loadPolicyFile(url: string): void;
}

export interface DesktopApi {
  /** The page has loaded and listens: what it is to show. */
  start(): Promise<StartState>;
  /** The shell opened a SWF: play it in place of what plays. */
  onOpen(listener: (movie: OpenedMovie) => void): void;
  /** The shell closed the SWF playing. */
  onClose(listener: () => void): void;
  /** Ask for the open dialog. */
  openDialog(): void;
  /** A file dropped on the page: the shell opens it if it is a SWF. */
  openDropped(file: File): void;
  /** Ask the user for a library; the page reloads once the shell has it. */
  chooseLibrary(name: LibraryName): void;
  sockets: DesktopSockets;
  network: DesktopNetwork;
}
