// FileReference's host boundary. Paths stay with the host; scripts see metadata and bytes only.
import type { FetchRequest, FetchResult } from "./hosts.js";

export interface FileFilter {
  description: string;
  extension: string;
}

export interface SelectedFile {
  name: string;
  size: number;
  modificationDate: number;
  creationDate?: number;
  read(signal: AbortSignal): Promise<Uint8Array>;
}

export interface SaveFile {
  name: string;
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

export interface FileHost {
  browse(filters: FileFilter[], multiple: boolean, signal: AbortSignal): Promise<SelectedFile[]>;
  save(name: string, signal: AbortSignal): Promise<SaveFile | null>;
}

/** Browser dialogs are asked synchronously, while transient user activation is still present. */
export function browserFileHost(): FileHost | null {
  if (typeof document === "undefined") {
    return null;
  }

  const active = () => globalThis.navigator?.userActivation?.isActive === true;
  return {
    browse(filters, multiple, signal) {
      if (!active() || signal.aborted) {
        return Promise.resolve([]);
      }

      return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        input.accept = filters
          .flatMap((filter) => filter.extension.split(";"))
          .map((ext) => ext.trim().replace(/^\*\./, "."))
          .filter((ext) => /^\.[\w-]+$/.test(ext))
          .join(",");
        input.hidden = true;
        const finish = (files: SelectedFile[]) => {
          signal.removeEventListener("abort", abort);
          input.remove();
          resolve(files);
        };
        const abort = () => finish([]);
        input.addEventListener("cancel", () => finish([]), { once: true });
        input.addEventListener(
          "change",
          () =>
            finish(
              Array.from(input.files ?? [], (file) => ({
                name: file.name,
                size: file.size,
                modificationDate: file.lastModified,
                read: async () => new Uint8Array(await file.arrayBuffer()),
              })),
            ),
          { once: true },
        );
        signal.addEventListener("abort", abort, { once: true });
        document.body.append(input);
        try {
          if (typeof input.showPicker === "function") {
            input.showPicker();
          } else {
            input.click();
          }
        } catch (error) {
          signal.removeEventListener("abort", abort);
          input.remove();
          reject(error);
        }
      });
    },
    async save(name, signal) {
      if (!active() || signal.aborted) {
        return null;
      }

      const picker = (
        globalThis as typeof globalThis & {
          showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
            name: string;
            createWritable(): Promise<{
              write(bytes: Uint8Array): Promise<void>;
              close(): Promise<void>;
              abort(): Promise<void>;
            }>;
          }>;
        }
      ).showSaveFilePicker;
      if (picker) {
        try {
          const handle = await picker.call(globalThis, { suggestedName: name });
          return {
            name: handle.name,
            async write(bytes, signal) {
              signal.throwIfAborted();
              const stream = await handle.createWritable();
              try {
                await stream.write(bytes);
                signal.throwIfAborted();
                await stream.close();
              } catch (error) {
                await stream.abort();
                throw error;
              }
            },
          };
        } catch (error) {
          if ((error as { name?: string }).name === "AbortError") {
            return null;
          }

          throw error;
        }
      }

      return {
        name,
        async write(bytes, signal) {
          signal.throwIfAborted();
          const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
          const link = document.createElement("a");
          link.href = url;
          link.download = name;
          link.hidden = true;
          document.body.append(link);
          link.click();
          link.remove();
          // The browser may consume the URL after click returns.
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
      };
    },
  };
}

export interface FileServices {
  host: FileHost | null;
  signal: AbortSignal;
  defer(deliver: () => void): void;
  track(task: Promise<void>): void;
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
  error(id: number): never;
}

type Operation = { generation: number; signal: AbortSignal; abort(): void };

export type FileEvent = (type: string, loaded?: number, total?: number, text?: string) => void;

/** One reference's operation, with stale host callbacks suppressed after cancel or destruction. */
export class FileReference {
  file: SelectedFile | null = null;
  data: Uint8Array | null = null;
  private operation: Operation | null = null;
  private generation = 0;

  constructor(
    private readonly services: FileServices,
    private readonly event: FileEvent,
  ) {}

  cancel(): void {
    this.generation++;
    this.operation?.abort();
    this.operation = null;
  }

  private begin(): Operation {
    if (this.operation) {
      this.services.error(2174);
    }

    const abort = new AbortController();
    const operation = {
      generation: ++this.generation,
      signal: AbortSignal.any([abort.signal, this.services.signal]),
      abort: () => abort.abort(),
    };
    this.operation = operation;
    return operation;
  }

  private emit(operation: Operation, type: string, loaded = 0, total = 0, text = ""): boolean {
    if (operation.signal.aborted || operation.generation !== this.generation) {
      return false;
    }

    this.event(type, loaded, total, text);
    return !operation.signal.aborted && operation.generation === this.generation;
  }

  private fail(operation: Operation): void {
    this.operation = null;
    try {
      this.emit(operation, "ioError", 0, 0, "Error #2038: File I/O Error.");
    } finally {
      // Hosts may hold a save destination even when the transfer never reached write().
      operation.abort();
    }
  }

  private after<T>(operation: Operation, task: Promise<T>, deliver: (value: T) => void): void {
    this.services.track(
      task.then(
        (value) =>
          this.services.defer(() => {
            if (!operation.signal.aborted && operation.generation === this.generation) {
              deliver(value);
            }
          }),
        () =>
          this.services.defer(() => {
            if (!operation.signal.aborted && operation.generation === this.generation) {
              this.fail(operation);
            }
          }),
      ),
    );
  }

  browse(
    filters: FileFilter[],
    multiple = false,
    selected?: (files: SelectedFile[]) => void,
  ): void {
    const operation = this.begin();
    const task =
      this.services.host?.browse(filters, multiple, operation.signal) ?? Promise.resolve([]);
    this.after(operation, task, (files) => {
      this.operation = null;
      if (files.length) {
        this.file = files[0];
        this.data = null;
        selected?.(files);
      }

      this.emit(operation, files.length ? "select" : "cancel");
    });
  }

  load(): void {
    const file = this.file ?? this.services.error(2037);
    const operation = this.begin();
    this.after(operation, file.read(operation.signal), (bytes) => {
      this.data = bytes;
      if (
        this.emit(operation, "open") &&
        this.emit(operation, "progress", bytes.length, bytes.length)
      ) {
        this.operation = null;
        this.emit(operation, "complete");
      }
    });
  }

  save(name: string, bytes: Uint8Array | FetchRequest): void {
    const operation = this.begin();
    const task = this.services.host?.save(name, operation.signal) ?? Promise.resolve(null);
    this.after(operation, task, (destination) => {
      if (!destination) {
        this.operation = null;
        this.emit(operation, "cancel");
        return;
      }

      this.file = {
        name: destination.name,
        size: 0,
        modificationDate: 0,
        read: async () => this.services.error(2037),
      };
      this.data = null;
      if (!this.emit(operation, "select") || !this.emit(operation, "open")) {
        return;
      }

      const transfer = async () => {
        const result =
          bytes instanceof Uint8Array
            ? bytes
            : (await this.services.fetch(bytes, operation.signal)).bytes;
        if (result === null) {
          throw new Error("download failed");
        }

        operation.signal.throwIfAborted();
        await destination.write(result, operation.signal);
        return result;
      };
      this.after(operation, transfer(), (bytes) => {
        if (this.file) {
          this.file.size = bytes.length;
          this.file.modificationDate = Date.now();
          this.file.read = async () => bytes.slice();
        }

        if (this.emit(operation, "progress", bytes.length, bytes.length)) {
          this.operation = null;
          this.emit(operation, "complete");
        }
      });
    });
  }

  upload(request: FetchRequest, field: string | null, test = false): void {
    const file = this.file ?? this.services.error(2037);
    const operation = this.begin();
    const transfer = async () => {
      const bytes = await file.read(operation.signal);
      operation.signal.throwIfAborted();
      const outgoing =
        field === null
          ? { ...request, method: "POST", body: bytes }
          : await multipart(request, file.name, field, bytes);
      if (test && bytes.length > 10 * 1024) {
        const probe = await this.services.fetch(
          { ...outgoing, body: new Uint8Array() },
          operation.signal,
        );
        if (probe.bytes === null) {
          throw new Error("test upload failed");
        }
      }

      const result = await this.services.fetch(outgoing, operation.signal);
      return { result, size: bytes.length };
    };
    this.services.defer(() => this.emit(operation, "open"));
    this.after(operation, transfer(), ({ result, size }) => {
      if (!this.emit(operation, "progress", size, size)) {
        return;
      }

      if (result.bytes === null || result.status >= 400) {
        if (result.status && !this.emit(operation, "httpStatus", result.status)) {
          return;
        }

        this.fail(operation);
        return;
      }

      this.operation = null;
      if (this.emit(operation, "complete")) {
        this.emit(
          operation,
          "uploadCompleteData",
          0,
          0,
          new TextDecoder().decode(result.bytes as Uint8Array),
        );
      }
    });
  }
}

/** Let the platform encode multipart quoting and the boundary, then send through the host's fetch. */
async function multipart(
  request: FetchRequest,
  name: string,
  field: string,
  bytes: Uint8Array,
): Promise<FetchRequest> {
  const form = new FormData();
  if (request.body) {
    for (const [key, value] of new URLSearchParams(new TextDecoder().decode(request.body))) {
      form.append(key, value);
    }
  }

  form.append("Filename", name);
  form.append(field, new Blob([bytes.slice().buffer], { type: "application/octet-stream" }), name);
  form.append("Upload", "Submit Query");
  const encoded = new Response(form);
  return {
    ...request,
    method: "POST",
    headers: [
      ...request.headers.filter(([key]) => key.toLowerCase() !== "content-type"),
      ["Content-Type", encoded.headers.get("content-type") as string],
    ],
    body: new Uint8Array(await encoded.arrayBuffer()),
  };
}
