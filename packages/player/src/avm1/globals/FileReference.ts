// AS2's flash.net file references use the same dialogs and transfers as AS3's.
import { avm1 } from "@swf2es/runtime";
import { FileReference, type FileServices, type SelectedFile } from "../../files.js";
import type { Avm1 } from "../avm1.js";

type Obj = avm1.Avm1Object;

export function fileReferenceClasses(movie: Avm1): avm1.Avm1Object {
  const realm = movie.realm;
  const version = movie.version;
  const states = new WeakMap<Obj, FileReference>();
  const services: FileServices = {
    host: movie.fileHost,
    signal: movie.fileLifetime.signal,
    defer: (deliver) => movie.net.after(Promise.resolve(), deliver),
    track: (task) => movie.net.after(task, () => {}),
    fetch: (request, signal) =>
      movie.net.request(
        {
          ...request,
          method: request.method === "POST" ? "POST" : "GET",
          headers: request.headers.map(([name, value]) => [name, value]),
        },
        "data",
        signal,
      ),
    error: (id): never => {
      throw new Error(`Error #${id}`);
    },
  };
  const notify = (self: Obj, name: string, args: avm1.Value[] = []) => {
    movie.callback(self, "broadcastMessage", [name, self, ...args]);
  };
  const state = (self: Obj): FileReference => {
    let ref = states.get(self);
    if (!ref) {
      ref = new FileReference(services, (type, loaded, total, text) => {
        switch (type) {
          case "select":
            notify(self, "onSelect");
            break;
          case "cancel":
            notify(self, "onCancel");
            break;
          case "open":
            notify(self, "onOpen");
            break;
          case "progress":
            notify(self, "onProgress", [loaded, total]);
            break;
          case "httpStatus":
            notify(self, "onHTTPError", [loaded]);
            break;
          case "complete":
            notify(self, "onComplete");
            break;
          case "ioError":
            notify(self, "onIOError");
            break;
          case "uploadCompleteData":
            notify(self, "onUploadCompleteData", [text]);
            break;
        }
      });
      states.set(self, ref);
    }

    return ref;
  };
  const proto = new avm1.Avm1Object(realm.objectProto);
  const construct = (self: Obj) => {
    state(self);
    avm1.initializeBroadcaster(self, realm, version);
    return self;
  };
  const reference = realm.classOf(proto, construct, () => undefined);
  const hidden = avm1.DONT_ENUM | avm1.DONT_DELETE;
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), hidden);
  const metadata = (name: string, read: (file: SelectedFile) => avm1.Value) => {
    const p = proto.define(name, undefined, hidden);
    p.get = realm.method((self) => {
      const file = states.get(self as Obj)?.file;
      return file ? read(file) : undefined;
    });
    p.set = realm.method(() => undefined);
  };
  metadata("name", (file) => file.name);
  metadata("size", (file) => file.size);
  metadata("type", (file) => {
    const dot = file.name.lastIndexOf(".");
    return dot < 0 ? "" : file.name.slice(dot);
  });
  metadata("creator", () => undefined);
  metadata("creationDate", (file) =>
    realm.construct(realm.Date.constr, [file.creationDate ?? file.modificationDate], version),
  );
  metadata("modificationDate", (file) =>
    realm.construct(realm.Date.constr, [file.modificationDate], version),
  );
  const filters = (args: avm1.Value[]) => {
    if (args.length === 0) {
      return [];
    }

    const value = args[0];
    if (!(value instanceof avm1.Avm1Object) || !value.own("length", version)) {
      return null;
    }

    const count = avm1.toNumber(avm1.get(value, "length", version), version) >>> 0;
    if (count === 0) {
      return null;
    }

    const result: { description: string; extension: string }[] = [];
    for (let i = 0; i < count; i++) {
      const filter = avm1.get(value, String(i), version);
      if (
        !(filter instanceof avm1.Avm1Object) ||
        !filter.own("description", version) ||
        !filter.own("extension", version)
      ) {
        return null;
      }

      const read = (name: string) => {
        try {
          return avm1.get(filter, name, version);
        } catch {
          return undefined;
        }
      };
      const description = read("description");
      const extension = read("extension");
      if (description == null || extension == null) {
        return null;
      }

      const text = avm1.stringOf(description, version);
      const pattern = avm1.stringOf(extension, version);
      const mac = read("macType");
      if (mac != null) {
        avm1.stringOf(mac, version);
      }
      if (!text || !pattern) {
        return null;
      }
      result.push({ description: text, extension: pattern });
    }

    return result;
  };
  method("browse", (self, args) => {
    const chosen = filters(args);
    if (chosen === null) {
      return false;
    }
    try {
      state(self as Obj).browse(chosen);
      return true;
    } catch {
      return false;
    }
  });
  method("cancel", (self) => {
    state(self as Obj).cancel();
  });
  method("download", (self, args) => {
    if (!args.length) {
      return false;
    }

    const url = avm1.stringOf(args[0], version);
    const name =
      args.length > 1
        ? avm1.stringOf(args[1], version)
        : url.split(/[?#]/, 1)[0].split("/").pop() || "download";
    try {
      state(self as Obj).save(name, {
        url: movie.net.resolve(url),
        method: "GET",
        headers: [],
        body: null,
        purpose: "data",
      });
      return true;
    } catch {
      return false;
    }
  });
  method("upload", (self, args) => {
    if (!args.length || !state(self as Obj).file) {
      return false;
    }

    try {
      state(self as Obj).upload(
        {
          url: movie.net.resolve(avm1.stringOf(args[0], version)),
          method: "POST",
          headers: [],
          body: null,
          purpose: "data",
        },
        args.length > 1 ? avm1.stringOf(args[1], version) : "Filedata",
        avm1.toBoolean(args[2], version),
      );
      return true;
    } catch {
      return false;
    }
  });
  const listProto = new avm1.Avm1Object(realm.objectProto);
  const list = realm.classOf(
    listProto,
    (self) => {
      avm1.initializeBroadcaster(self, realm, version);
      return self;
    },
    () => undefined,
  );
  listProto.define(
    "browse",
    realm.method((self, args) => {
      const chosen = filters(args);
      if (chosen === null) {
        return false;
      }
      try {
        state(self as Obj).browse(chosen, true, (files) => {
          const objects = files.map((file) => {
            const object = realm.construct(reference, [], version);
            state(object as Obj).file = file;
            return object;
          });
          avm1.set(self as Obj, "fileList", realm.newArray(objects, version), version);
        });
        return true;
      } catch {
        return false;
      }
    }),
    hidden,
  );
  const net = new avm1.Avm1Object(realm.objectProto);
  net.define("FileReference", reference, 0);
  net.define("FileReferenceList", list, 0);
  return net;
}
