// What the shell gives the page, and all it gives: the preload puts it on
// window.swf2esDesktop. The renderer knows the shell only through it, so
// another shell (Tauri, later) plays the same page by giving the same API.

/** Flash's sandboxes, as Security.sandboxType names them, and AIR's application sandbox. */
export type SandboxType = "localWithFile" | "localWithNetwork" | "remote" | "application";

/**
 * An AIR application the shell opened by its descriptor, as adl runs one:
 * what NativeApplication and File see of it.
 */
export interface AirLaunch {
  /** The descriptor's XML and its id. */
  descriptor: string;
  id: string;
  /** What followed `--` on the command line. */
  arguments: string[];
  /** Where the shell was started, a native path. */
  currentDirectory: string;
  /** The system's path separator. */
  separator: string;
  /** The directories AIR names: the application's (the descriptor's) and its storage's among them. */
  directories: {
    application: string;
    applicationStorage: string;
    user: string;
    documents: string;
    desktop: string;
    cache: string;
  };
}

/** What is at a path, as the player's FileStat has it. */
export interface AirFileStat {
  directory: boolean;
  size: number;
  modified: number;
  created: number;
  hidden?: boolean;
  symbolicLink?: boolean;
}

/** The window as NativeWindow reads it: bounds frame included, and the content's corner in it. */
export interface AirWindowState {
  bounds: { x: number; y: number; width: number; height: number };
  contentOffset: { x: number; y: number };
  title: string;
  displayState: string;
  active: boolean;
  visible: boolean;
}

/** One of the system's displays as flash.display.Screen reads it: all of it, and what a window may fill. */
export interface AirScreenState {
  bounds: { x: number; y: number; width: number; height: number };
  visibleBounds: { x: number; y: number; width: number; height: number };
  colorDepth: number;
  main: boolean;
}

/**
 * An AIR application's own reach, only while one the user opened plays:
 * the file system, read and written synchronously as File does, and the
 * window.
 */
export interface DesktopAir {
  stat(path: string): AirFileStat | null;
  list(path: string): string[] | null;
  read(path: string): Promise<Uint8Array | null>;
  /** A file's bytes at once, as FileStream's open reads them; null where none can be read. */
  readSync(path: string): Uint8Array | null;
  /** EncryptedLocalStore's items, at once, as the player's EncryptedStoreHost has them. */
  getItem(name: string): Uint8Array | null;
  setItem(name: string, bytes: Uint8Array): void;
  removeItem(name: string): void;
  resetItems(): void;
  /** FileStream's writes and File's changes, at once, as FileSystemHost's; false where they fail. */
  writeSync(path: string, bytes: Uint8Array, offset: number, length: number): boolean;
  createDirectory(path: string): boolean;
  remove(path: string): boolean;
  move(from: string, to: string): boolean;
  window(): AirWindowState;
  /** The displays as they are now; none where no application plays. */
  screens(): AirScreenState[];
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setTitle(title: string): void;
  minimize(): void;
  maximize(): void;
  restore(): void;
  activate(): void;
  setVisible(visible: boolean): void;
  close(): void;
  exit(code: number): void;
}

/** A SWF the shell opened, by the URL the page fetches it from. */
export interface OpenedMovie {
  url: string;
  /** Its file name, for the page to show. */
  name: string;
  /** The sandbox it plays in, for Security.sandboxType. */
  sandbox: SandboxType;
  /** For an AIR application opened by its descriptor: its launch, which plays it as AIR's. */
  air?: AirLaunch;
}

/** The libraries' paths on disk, null for one the shell has not found. */
/** A playerglobal.abc the user chose in place of swf2es's own; builtin.abc ships with the player. */
export interface LibraryState {
  playerglobal: string | null;
}

/** What the page starts from: the libraries, and the SWF to play, if one is open. */
export interface StartState {
  /** The user's opt-in; changing it restarts the page. */
  stage3D: boolean;
  libraries: LibraryState;
  movie: OpenedMovie | null;
  /** The app's build, a short commit, for the context menu's About item; null where unknown. */
  build: string | null;
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

/** What befalls a WebSocket, as player's WebSocketEvents has it. */
export type WebSocketEvent =
  | { type: "open"; protocol: string }
  | { type: "message"; data: string | Uint8Array }
  | { type: "close"; code: number }
  | { type: "error" };

/** air.net.WebSocket's connections, opened by the shell, for an AIR application alone. */
export interface DesktopWebSockets {
  /** A connection's id; its events follow, an "error" then a "close" if the shell refuses it. */
  connect(url: string, protocols: string[]): number;
  /** A text message for a string, a binary one for bytes. */
  send(id: number, data: string | Uint8Array): void;
  close(id: number, code?: number): void;
  onEvent(listener: (id: number, event: WebSocketEvent) => void): void;
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

export interface DesktopFile {
  id: number;
  name: string;
  size: number;
  modificationDate: number;
  creationDate: number;
}

export interface DesktopFiles {
  browse(
    filters: { description: string; extension: string }[],
    multiple: boolean,
  ): Promise<DesktopFile[]>;
  save(name: string): Promise<{ id: number; name: string } | null>;
  read(id: number): Promise<Uint8Array>;
  write(id: number, bytes: Uint8Array): Promise<void>;
  release(id: number): void;
}

export interface DesktopApi {
  files: DesktopFiles;
  /** The page has loaded and listens: what it is to show. */
  start(): Promise<StartState>;
  /** The shell opened a SWF: play it in place of what plays. */
  onOpen(listener: (movie: OpenedMovie) => void): void;
  /** The shell closed the SWF playing. */
  onClose(listener: () => void): void;
  /** Ask for the open dialog. */
  openDialog(): void;
  /** Ask for the dialog that opens a SWF by its URL, which only the user answers. */
  openUrlDialog(): void;
  /** A file dropped on the page: the shell opens it if it is a SWF. */
  openDropped(file: File): void;
  /** Ask the user for a library; the page reloads once the shell has it. */
  chooseLibrary(name: LibraryName): void;
  sockets: DesktopSockets;
  webSockets: DesktopWebSockets;
  network: DesktopNetwork;
  air: DesktopAir;
}
