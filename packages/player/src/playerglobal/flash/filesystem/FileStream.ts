// flash.filesystem.FileStream over the host's FileSystemHost (hosts.ts),
// for reading, as adl (AIR 51.3) has it. open reads the whole file from the
// host at once; openAsync hands it over a 40960-byte chunk a frame, each
// with a progress event, then complete, as adl's do. What is read goes
// through ByteArray's DataInput implementation, as URLStream's does. A
// stream not open refuses everything but close (IOError 2029), as does a
// write or a truncate in READ mode; a missing file is IOError 3003 and a
// directory 3006, thrown by open and an ioError event of openAsync. The
// other modes, which write, are not supported yet.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { fileLocation } from "./File.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** How much of an asynchronously opened file a frame hands over, as adl's reads do. */
const CHUNK = 40960;

const MODES = ["read", "write", "append", "update"];

export function fileStreamNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const host = s.fileSystem;
  const notOpen = (): never => {
    throw s.rt.error("flash.errors::IOError", 2029);
  };
  /** The open stream's buffer; IOError 2029 for one not open. */
  const opened = (stream: FileStreamNatives): AsObject => stream.$buffer ?? notOpen();
  const read = (stream: FileStreamNatives, method: string, ...args: Value[]): Value =>
    s.rt.callProperty(opened(stream), s.rt.publicName(method), ...args);
  /** A write: refused in READ mode, as a stream not open is; the other modes are not supported yet. */
  const write = (stream: FileStreamNatives): never => {
    opened(stream);
    return notOpen();
  };
  /** "Error #id: message", as an IOErrorEvent's text begins. */
  const errorText = (id: number) => `Error #${id}: ${avm2.errorMessages[id]}`;

  /**
   * The native path of `file` and why it cannot be read in `mode`: what
   * open throws at once (no File, no path, no such mode, a mode that
   * writes), then what open throws and openAsync reports: 3003 for nothing
   * there, 3006 for a directory, or the bytes.
   */
  const target = (file: Value, mode: Value): string => {
    if (file === null || file === undefined) {
      throw s.rt.error("TypeError", 2007, "file");
    }

    const at = fileLocation(file as AsObject);
    if (!at) {
      throw s.rt.error("flash.errors::IllegalOperationError", 2037);
    }

    const named = s.rt.toString(mode);
    if (!MODES.includes(named)) {
      throw s.rt.error("ArgumentError", 2004);
    }

    if (named !== "read") {
      throw s.rt.unsupported(`FileStream in ${named} mode`);
    }

    return at.path;
  };
  const contents = (path: string): Uint8Array | 3003 | 3006 => {
    const stat = host?.stat(path);
    if (!stat) {
      return 3003;
    }

    if (stat.directory) {
      return 3006;
    }

    return host?.read?.(path) ?? 3003;
  };

  /** A new buffer for `stream`, empty, with its endian and object encoding, in place of any open one. */
  const reopen = (stream: FileStreamNatives, async: boolean): AsObject => {
    stream.$generation = (stream.$generation ?? 0) + 1;
    const buffer = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject;
    s.rt.setProperty(buffer, s.rt.publicName("endian"), stream.$endian ?? "bigEndian");
    s.rt.setProperty(buffer, s.rt.publicName("objectEncoding"), stream.$objectEncoding ?? 3);
    stream.$buffer = buffer;
    stream.$async = async;
    return buffer;
  };

  class FileStreamNatives {
    declare $buffer: AsObject | null | undefined;
    /** Whether it was opened with openAsync, whose close is an event. */
    declare $async: boolean | undefined;
    /** Counts opens and closes: an asynchronous read handed over for an earlier one stops. */
    declare $generation: number | undefined;
    declare $endian: Value;
    declare $objectEncoding: Value;
    declare $readAhead: number | undefined;

    open(file: Value, mode: Value): void {
      const path = target(file, mode);
      const bytes = contents(path);
      if (typeof bytes === "number") {
        this.$buffer = null;
        throw s.rt.error("flash.errors::IOError", bytes);
      }

      const buffer = avm2.bytesOf(s.rt, reopen(this, false));
      buffer.write(bytes);
      buffer.position = 0;
    }

    openAsync(file: Value, mode: Value): void {
      const path = target(file, mode);
      const buffer = reopen(this, true);
      const generation = this.$generation as number;
      const bytes = contents(path);
      const current = () => this.$generation === generation;
      if (typeof bytes === "number") {
        s.loads.deferHostEvent(() => {
          if (!current()) {
            return;
          }

          this.$buffer = null;
          dispatchEvent(
            s,
            this as unknown as AsObject,
            s.rt.construct(
              s.rt.classNamed("flash.events::IOErrorEvent"),
              "ioError",
              false,
              false,
              `${errorText(bytes)} file: ${path}`,
              bytes,
            ) as AsObject,
          );
        });
        return;
      }

      let loaded = 0;
      const next = () => {
        if (!current()) {
          return;
        }

        // Appended where the reads have not reached, the position left where they are.
        const into = avm2.bytesOf(s.rt, buffer);
        const position = into.position;
        const end = Math.min(loaded + CHUNK, bytes.length);
        into.position = into.length;
        into.write(bytes.subarray(loaded, end));
        into.position = position;
        loaded = end;
        dispatchEvent(
          s,
          this as unknown as AsObject,
          s.rt.construct(
            s.rt.classNamed("flash.events::ProgressEvent"),
            "progress",
            false,
            false,
            loaded,
            bytes.length,
          ) as AsObject,
        );
        if (!current()) {
          return;
        }

        if (loaded < bytes.length) {
          s.loads.deferHostEvent(next);
        } else {
          dispatchEvent(s, this as unknown as AsObject, s.event("complete"));
        }
      };
      s.loads.deferHostEvent(next);
    }

    close(): void {
      if (!this.$buffer) {
        return;
      }

      this.$buffer = null;
      this.$generation = (this.$generation ?? 0) + 1;
      // An asynchronous stream says so on a later frame; a synchronous one says nothing.
      if (this.$async) {
        const generation = this.$generation;
        s.loads.deferHostEvent(() => {
          if (this.$generation === generation) {
            dispatchEvent(s, this as unknown as AsObject, s.event("close"));
          }
        });
      }
    }

    truncate(): void {
      write(this);
    }

    get position(): number {
      return avm2.bytesOf(s.rt, opened(this)).position;
    }

    set position(value: Value) {
      // As ByteArray's setter: a uint32 of its own, not toUint's (see Bytes).
      avm2.bytesOf(s.rt, opened(this)).position = s.rt.toUint(value) >>> 0;
    }

    get bytesAvailable(): number {
      return avm2.bytesOf(s.rt, opened(this)).available;
    }

    get readAhead(): number {
      return this.$readAhead ?? Number.POSITIVE_INFINITY;
    }

    set readAhead(value: Value) {
      this.$readAhead = s.rt.toNumber(value);
    }

    get endian(): Value {
      return this.$buffer
        ? s.rt.getProperty(this.$buffer, s.rt.publicName("endian"))
        : (this.$endian ?? "bigEndian");
    }

    set endian(value: Value) {
      // The buffer's setter checks it; the stream keeps it for the files it opens next.
      if (this.$buffer) {
        s.rt.setProperty(this.$buffer, s.rt.publicName("endian"), value);
      }

      this.$endian = this.$buffer
        ? s.rt.getProperty(this.$buffer, s.rt.publicName("endian"))
        : value;
    }

    get objectEncoding(): Value {
      return this.$buffer
        ? s.rt.getProperty(this.$buffer, s.rt.publicName("objectEncoding"))
        : (this.$objectEncoding ?? 3);
    }

    set objectEncoding(value: Value) {
      if (this.$buffer) {
        s.rt.setProperty(this.$buffer, s.rt.publicName("objectEncoding"), value);
      }

      this.$objectEncoding = this.$buffer
        ? s.rt.getProperty(this.$buffer, s.rt.publicName("objectEncoding"))
        : value;
    }

    readBytes(bytes: Value, offset: Value = 0, length: Value = 0): void {
      read(this, "readBytes", bytes, offset, length);
    }
    readBoolean(): Value {
      return read(this, "readBoolean");
    }
    readByte(): Value {
      return read(this, "readByte");
    }
    readUnsignedByte(): Value {
      return read(this, "readUnsignedByte");
    }
    readShort(): Value {
      return read(this, "readShort");
    }
    readUnsignedShort(): Value {
      return read(this, "readUnsignedShort");
    }
    readInt(): Value {
      return read(this, "readInt");
    }
    readUnsignedInt(): Value {
      return read(this, "readUnsignedInt");
    }
    readFloat(): Value {
      return read(this, "readFloat");
    }
    readDouble(): Value {
      return read(this, "readDouble");
    }
    readUTF(): Value {
      return read(this, "readUTF");
    }
    readUTFBytes(length: Value): Value {
      return read(this, "readUTFBytes", length);
    }
    readMultiByte(length: Value, charset: Value): Value {
      return read(this, "readMultiByte", length, charset);
    }
    readObject(): Value {
      return read(this, "readObject");
    }

    writeBoolean(): void {
      write(this);
    }
    writeByte(): void {
      write(this);
    }
    writeBytes(): void {
      write(this);
    }
    writeDouble(): void {
      write(this);
    }
    writeFloat(): void {
      write(this);
    }
    writeInt(): void {
      write(this);
    }
    writeMultiByte(): void {
      write(this);
    }
    writeObject(): void {
      write(this);
    }
    writeShort(): void {
      write(this);
    }
    writeUnsignedInt(): void {
      write(this);
    }
    writeUTF(): void {
      write(this);
    }
    writeUTFBytes(): void {
      write(this);
    }
  }

  avm2.registerNativeClass(natives, "flash.filesystem::FileStream", FileStreamNatives);
  return natives;
}
