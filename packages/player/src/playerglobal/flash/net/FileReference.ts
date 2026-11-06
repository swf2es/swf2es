// File dialogs and transfers, shared with AVM1 through the host's file services.
import { avm2 } from "@swf2es/runtime";
import { type FileFilter, FileReference, type SelectedFile } from "../../../files.js";
import type { FetchRequest } from "../../../hosts.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { fileEntry } from "../filesystem/File.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** What FileReference's properties read of a file: a selected one's, or a File's on disk. */
interface Described {
  name: string;
  size: number;
  modificationDate: number;
  creationDate?: number;
  directory?: boolean;
}

export function fileReferenceNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const states = new WeakMap<AsObject, FileReference>();
  const services = {
    host: s.fileHost,
    signal: s.fileLifetime.signal,
    defer: (deliver: () => void) => s.loads.deferHostEvent(deliver),
    track: (task: Promise<void>) => s.loads.trackRequest(task),
    fetch: (request: FetchRequest, signal: AbortSignal) =>
      s.fetch ? s.fetch({ ...request, purpose: "data" }, signal) : Promise.reject(),
    error: (id: number): never => {
      throw s.rt.error("Error", id);
    },
  };
  const state = (target: AsObject): FileReference => {
    let ref = states.get(target);
    if (!ref) {
      ref = new FileReference(services, (type, loaded, total, text) => {
        let event: AsObject;
        switch (type) {
          case "httpStatus":
            event = s.httpStatus(loaded ?? 0);
            break;
          case "progress":
            event = s.rt.construct(
              s.rt.classNamed("flash.events::ProgressEvent"),
              type,
              false,
              false,
              loaded,
              total,
            );
            break;
          case "ioError":
            target.$fileInto = null;
            event = s.rt.construct(
              s.rt.classNamed("flash.events::IOErrorEvent"),
              type,
              false,
              false,
              text,
            );
            break;
          case "uploadCompleteData":
            event = s.rt.construct(
              s.rt.classNamed("flash.events::DataEvent"),
              type,
              false,
              false,
              text,
            );
            break;
          case "complete": {
            const into: AsObject | undefined = target.$fileInto;
            const data = states.get(target)?.data;
            if (into && data) {
              const bytes = avm2.bytesOf(s.rt, into);
              bytes.length = 0;
              bytes.position = 0;
              bytes.write(data);
              bytes.position = 0;
              target.$fileData = into;
            }

            target.$fileInto = null;
            event = s.event(type);
            break;
          }
          case "select":
            target.$fileData = null;
            target.$fileInto = null;
            event = s.event(type);
            break;
          default:
            event = s.event(type);
        }

        dispatchEvent(s, target, event);
      });
      states.set(target, ref);
    }

    return ref;
  };
  const file = (target: AsObject): SelectedFile => state(target).file ?? services.error(2037);
  const property = (target: Value, name: string): Value =>
    s.rt.getProperty(target, s.rt.publicName(name));
  const filters = (value: Value): FileFilter[] =>
    (value?.$a ?? []).map((filter: Value) => ({
      description: s.rt.toString(property(filter, "description")),
      extension: s.rt.toString(property(filter, "extension")),
    }));
  const requestOf = (request: Value): AsObject => {
    if (request === null || request === undefined) {
      throw s.rt.error("TypeError", 2007, "request");
    }

    return request as AsObject;
  };

  /**
   * What a File with a path has on disk, as a selected file's fields: its
   * name whether or not it is there, the rest Error 3003 where it is not.
   */
  const onDisk = (target: AsObject): Described | null => {
    const entry = fileEntry(s, target);
    if (!entry) {
      return null;
    }

    const stat = entry.stat;
    const missing = (): never => {
      throw s.rt.error("Error", 3003);
    };
    return {
      name: entry.name,
      get size() {
        return stat ? (stat.directory ? 0 : stat.size) : missing();
      },
      get modificationDate() {
        return stat ? stat.modified : missing();
      },
      get creationDate() {
        return stat ? stat.created : missing();
      },
      directory: stat?.directory ?? false,
    };
  };
  const described = (target: AsObject): Described => onDisk(target) ?? file(target);

  class FileReferenceNatives {
    get creationDate(): Value {
      const selected = described(this);
      return s.rt.construct(
        s.rt.classNamed("Date"),
        selected.creationDate ?? selected.modificationDate,
      );
    }

    get modificationDate(): Value {
      return s.rt.construct(s.rt.classNamed("Date"), described(this).modificationDate);
    }

    get name(): Value {
      return described(this).name;
    }
    get size(): Value {
      return described(this).size;
    }
    get type(): Value {
      const { name, directory } = described(this);
      // A directory's is empty, a file's its extension with the dot, as adl's.
      if (directory) {
        return "";
      }

      const dot = name.lastIndexOf(".");
      return dot < 0 ? "" : name.slice(dot);
    }
    get creator(): Value {
      return null;
    }
    get data(): Value {
      return (this as AsObject).$fileData ?? null;
    }

    browse(typeFilter: Value = null): boolean {
      state(this).browse(filters(typeFilter));
      return true;
    }

    cancel(): void {
      state(this).cancel();
      (this as AsObject).$fileInto = null;
    }

    download(request: Value, name: Value = null): void {
      const outgoing = s.loads.fetchRequest(requestOf(request), s.url, { requestHeaders: false });
      const suggested =
        name == null
          ? outgoing.url.split(/[?#]/, 1)[0].split("/").pop() || "download"
          : s.rt.toString(name);
      state(this).save(suggested, outgoing);
    }

    upload(request: Value, field: Value = "Filedata", test: Value = false): void {
      const outgoing = s.loads.fetchRequest(requestOf(request), s.url, { requestHeaders: false });
      if (field === null || field === undefined) {
        throw s.rt.error("TypeError", 2007, "uploadDataFieldName");
      }

      const name = s.rt.toString(field);
      const data = (request as AsObject).$data;
      if (
        name === "" ||
        (data && typeof data === "object" && s.rt.traitsOf(data).name === "flash.utils::ByteArray")
      ) {
        throw s.rt.error("ArgumentError", 2004);
      }

      state(this).upload(outgoing, name, Boolean(test) && s.platform.os.startsWith("Windows"));
    }

    uploadUnencoded(request: Value): void {
      state(this).upload(
        s.loads.fetchRequest(requestOf(request), s.url, { requestHeaders: "all" }),
        null,
      );
    }

    "flash.net:FileReference::_load"(into: Value): void {
      state(this).load();
      (this as AsObject).$fileInto = into;
      (this as AsObject).$fileData = null;
    }

    "flash.net:FileReference::_save"(data: Value, name: Value): void {
      const bytes = avm2.bytesOf(s.rt, data);
      state(this).save(
        name == null ? "Untitled" : s.rt.toString(name),
        bytes.buffer.slice(0, bytes.length),
      );
    }

    static "flash.net:FileReference::_ensureIsRootPlayer"(): void {}
  }

  class FileReferenceListNatives {
    declare $fileList: Value;

    get fileList(): Value {
      return this.$fileList ?? null;
    }

    browse(typeFilter: Value = null): boolean {
      this.$fileList = s.rt.array([]);
      state(this).browse(filters(typeFilter), true, (files) => {
        this.$fileList = s.rt.array(
          files.map((file) => {
            const object = s.rt.construct(s.rt.classNamed("flash.net::FileReference"));
            state(object).file = file;
            return object;
          }),
        );
      });
      return true;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::FileReference", FileReferenceNatives);
  avm2.registerNativeClass(natives, "flash.net::FileReferenceList", FileReferenceListNatives);
  return natives;
}
