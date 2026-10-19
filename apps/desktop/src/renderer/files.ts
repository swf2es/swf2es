import type { FileHost } from "@swf2es/player";
import type { DesktopFiles } from "../shared/api.js";

export function shellFiles(files: DesktopFiles): FileHost {
  const collected = new FinalizationRegistry<number>((id) => files.release(id));
  return {
    async browse(filters, multiple, signal) {
      const selected = await files.browse(filters, multiple);
      if (signal.aborted) {
        for (const file of selected) {
          files.release(file.id);
        }
        return [];
      }

      signal.addEventListener(
        "abort",
        () => {
          for (const file of selected) {
            files.release(file.id);
          }
        },
        { once: true },
      );
      return selected.map((file) => {
        const selectedFile: import("@swf2es/player").SelectedFile = {
          ...file,
          async read(signal) {
            signal.throwIfAborted();
            const bytes = await files.read(file.id);
            signal.throwIfAborted();
            return new Uint8Array(bytes);
          },
        };
        collected.register(selectedFile, file.id);
        return selectedFile;
      });
    },
    async save(name, signal) {
      const file = await files.save(name);
      if (!file) {
        return null;
      }
      if (signal.aborted) {
        files.release(file.id);
        return null;
      }

      const release = () => files.release(file.id);
      signal.addEventListener("abort", release, { once: true });
      return {
        name: file.name,
        async write(bytes, signal) {
          try {
            signal.throwIfAborted();
            await files.write(file.id, bytes);
          } finally {
            signal.removeEventListener("abort", release);
            release();
          }
        },
      };
    },
  };
}
