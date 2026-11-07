// flash.filesystem.FileStream over the host's FileSystemHost (hosts.ts),
// as adl (AIR 51.3, Windows) has it. A stream holds its file's bytes in a
// ByteArray, whose DataInput and DataOutput it reads and writes with, as
// URLStream's does. READ reads the file; WRITE empties it or makes it;
// APPEND writes only at its end, whose position cannot be set; UPDATE
// reads and writes it, from its start. WRITE and APPEND read nothing, nor
// tell bytesAvailable (IOError 2029, as a stream not open, and READ's
// writes and truncate). The modes that write make the file, and the
// directories it is in. What is written reaches the file as adl's does,
// at the end of the frame and at close, and a write to a file of the
// app: URL is a SecurityError. open does all this at once and throws its
// errors; openAsync does it on the next frame and reports them as an
// ioError event, then hands a file being read over a 40960-byte chunk a
// frame, each with a progress event, and complete (READ and UPDATE), and
// tells what it wrote with outputProgress, as adl's do. A missing file is
// IOError 3003 to read, a directory 3006, and a directory a file in the
// way 3003 to write. Windows' AIR also refuses to open a file another
// stream has open to write (IOError 3013), which macOS' does not; nor
// does this.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { fileLocation } from "./File.js";
import { ioErrorEvent, openRefusal, refuseApp, writeFile } from "./writes.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** How much of an asynchronously opened file a frame hands over, as adl's reads do. */
const CHUNK = 40960;

type Mode = "read" | "write" | "append" | "update";

const MODES: readonly string[] = ["read", "write", "append", "update"];

const EMPTY = new Uint8Array(0);

export function fileStreamNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const host = s.fileSystem;
  const notOpen = (): never => {
    throw s.rt.error("flash.errors::IOError", 2029);
  };
  /** The open stream's buffer; IOError 2029 for one not open. */
  const opened = (stream: FileStreamNatives): AsObject => stream.$buffer ?? notOpen();
  /** The buffer of a stream that reads; IOError 2029 for one not open or in WRITE or APPEND mode. */
  const reading = (stream: FileStreamNatives): AsObject => {
    const buffer = opened(stream);
    return stream.$mode === "write" || stream.$mode === "append" ? notOpen() : buffer;
  };
  /** The buffer of a stream that writes; IOError 2029 for one not open or in READ mode. */
  const writing = (stream: FileStreamNatives): AsObject => {
    const buffer = opened(stream);
    return stream.$mode === "read" ? notOpen() : buffer;
  };
  const read = (stream: FileStreamNatives, method: string, ...args: Value[]): Value =>
    s.rt.callProperty(reading(stream), s.rt.publicName(method), ...args);
  const write = (stream: FileStreamNatives, method: string, ...args: Value[]): void => {
    const bytes = avm2.bytesOf(s.rt, writing(stream));
    // A write past the end fills the bytes before it with zeros, which the file gets too.
    const from = Math.min(bytes.position, bytes.length);
    const before = bytes.position;
    s.rt.callProperty(stream.$buffer as AsObject, s.rt.publicName(method), ...args);
    stream.$written = (stream.$written ?? 0) + (bytes.position - before);
    changed(stream, from, bytes.position);
  };
  const event = (stream: FileStreamNatives, e: AsObject) =>
    dispatchEvent(s, stream as unknown as AsObject, e);
  const outputProgress = (stream: FileStreamNatives) =>
    event(
      stream,
      s.rt.construct(
        s.rt.classNamed("flash.events::OutputProgressEvent"),
        "outputProgress",
        false,
        false,
        0,
        stream.$written ?? 0,
      ) as AsObject,
    );

  /** Marks `from` to `to` of `stream`'s bytes, and its length, for the file, at the end of the frame. */
  const changed = (stream: FileStreamNatives, from: number, to: number): void => {
    stream.$from = Math.min(stream.$from ?? from, from);
    stream.$to = Math.max(stream.$to ?? to, to);
    if (stream.$flushing) {
      return;
    }

    stream.$flushing = true;
    const generation = stream.$generation;
    s.loads.deferHostEvent(() => {
      stream.$flushing = false;
      if (stream.$generation === generation && flush(stream) && stream.$async) {
        outputProgress(stream);
      }
    });
  };
  /** What `stream` changed, given to its file: whether there was any. */
  const flush = (stream: FileStreamNatives): boolean => {
    if (stream.$from === undefined || !stream.$buffer || !stream.$made) {
      return false;
    }

    const bytes = avm2.bytesOf(s.rt, stream.$buffer);
    const from = Math.min(stream.$from, bytes.length);
    const to = Math.max(from, Math.min(stream.$to ?? from, bytes.length));
    stream.$from = undefined;
    stream.$to = undefined;
    writeFile(s, stream.$path as string, bytes.buffer.subarray(from, to), from, bytes.length);
    return true;
  };

  /**
   * The native path of `file` and its mode, or why it cannot be opened in
   * it: what open and openAsync throw at once (no File, no path, no such
   * mode, a mode that writes a file of the app: URL).
   */
  const target = (file: Value, mode: Value): { path: string; mode: Mode } => {
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
      refuseApp(s, at);
    }

    return { path: at.path, mode: named as Mode };
  };
  /** What a READ finds at `path`: 3003 for nothing there, 3006 for a directory, or the bytes. */
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
  /**
   * Makes the file at `path` for `mode`, which writes: emptied for WRITE,
   * as it was for the others, there now. The IOError why it cannot be, or
   * what it held before.
   */
  const make = (path: string, mode: Mode): Uint8Array | number => {
    const refusal = openRefusal(s, path);
    if (refusal) {
      return refusal;
    }

    const before = mode === "write" ? EMPTY : (host?.read?.(path) ?? EMPTY);
    return writeFile(s, path, EMPTY, before.length, before.length) ? before : 3001;
  };

  /**
   * A new buffer for `stream`, empty, with its endian and object encoding,
   * open on `path` in `mode`, in place of any open one, which has given its
   * file what it wrote.
   */
  const reopen = (stream: FileStreamNatives, async: boolean, path: string, mode: Mode) => {
    flush(stream);
    stream.$generation = (stream.$generation ?? 0) + 1;
    const buffer = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject;
    s.rt.setProperty(buffer, s.rt.publicName("endian"), stream.$endian ?? "bigEndian");
    s.rt.setProperty(buffer, s.rt.publicName("objectEncoding"), stream.$objectEncoding ?? 3);
    stream.$buffer = buffer;
    stream.$async = async;
    stream.$path = path;
    stream.$mode = mode;
    stream.$made = !async;
    stream.$from = undefined;
    stream.$to = undefined;
    stream.$written = 0;
    return buffer;
  };
  /** Puts `bytes` in the buffer of `stream`, its position at their start, or for APPEND their end. */
  const fill = (stream: FileStreamNatives, bytes: Uint8Array): void => {
    const into = avm2.bytesOf(s.rt, stream.$buffer as AsObject);
    into.write(bytes);
    into.position = stream.$mode === "append" ? into.length : 0;
  };

  /**
   * Hands `bytes` to `stream` a chunk a frame, each appended where its
   * reads have not reached with a progress event, then complete, while
   * the open of `generation` lasts; `done` before complete.
   */
  const deliver = (
    stream: FileStreamNatives,
    bytes: Uint8Array,
    generation: number,
    done: () => void,
  ): void => {
    const current = () => stream.$generation === generation;
    let loaded = 0;
    const next = () => {
      if (!current()) {
        return;
      }

      const into = avm2.bytesOf(s.rt, stream.$buffer as AsObject);
      const position = into.position;
      const end = Math.min(loaded + CHUNK, bytes.length);
      into.position = into.length;
      into.write(bytes.subarray(loaded, end));
      into.position = position;
      loaded = end;
      event(
        stream,
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
        done();
        event(stream, s.event("complete"));
      }
    };
    s.loads.deferHostEvent(next);
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
    declare $path: string | undefined;
    declare $mode: Mode | undefined;
    /**
     * Whether its file is there to take what it writes: an asynchronous
     * open makes it on the next frame, and an UPDATE's once it is read.
     */
    declare $made: boolean | undefined;
    /** What it changed of its bytes and the file has not had yet; undefined for nothing. */
    declare $from: number | undefined;
    declare $to: number | undefined;
    /** Whether the end of the frame gives the file what it changed. */
    declare $flushing: boolean | undefined;
    /** How many bytes it has written since it opened, as outputProgress counts them. */
    declare $written: number | undefined;

    open(file: Value, mode: Value): void {
      const at = target(file, mode);
      const bytes = at.mode === "read" ? contents(at.path) : make(at.path, at.mode);
      if (typeof bytes === "number") {
        flush(this);
        this.$buffer = null;
        throw s.rt.error("flash.errors::IOError", bytes);
      }

      reopen(this, false, at.path, at.mode);
      fill(this, bytes);
    }

    openAsync(file: Value, mode: Value): void {
      const at = target(file, mode);
      reopen(this, true, at.path, at.mode);
      const generation = this.$generation as number;
      const failed = (id: number) => {
        this.$buffer = null;
        event(this, ioErrorEvent(s, id, ` file: ${at.path}`));
      };
      if (at.mode === "read") {
        const bytes = contents(at.path);
        s.loads.deferHostEvent(() => {
          if (this.$generation !== generation) {
            return;
          }

          if (typeof bytes === "number") {
            failed(bytes);
          } else {
            deliver(this, bytes, generation, () => {});
          }
        });
        return;
      }

      // APPEND's position is the file's end at once; WRITE's and APPEND's bytes are not read.
      if (at.mode === "append") {
        fill(this, host?.read?.(at.path) ?? EMPTY);
      }

      s.loads.deferHostEvent(() => {
        if (this.$generation !== generation) {
          return;
        }

        const made = make(at.path, at.mode);
        if (typeof made === "number") {
          failed(made);
        } else if (at.mode === "update") {
          deliver(this, made, generation, () => {
            this.$made = true;
            if (flush(this)) {
              outputProgress(this);
            }
          });
        } else {
          this.$made = true;
          if (flush(this)) {
            outputProgress(this);
          }
        }
      });
    }

    close(): void {
      if (!this.$buffer) {
        return;
      }

      // A file an asynchronous open had yet to make is made now, to take what was written.
      if (!this.$made && this.$mode !== "read" && this.$mode !== "update") {
        this.$made = typeof make(this.$path as string, this.$mode as Mode) !== "number";
      }

      const wrote = flush(this);
      this.$buffer = null;
      this.$generation = (this.$generation ?? 0) + 1;
      // An asynchronous stream says so on a later frame; a synchronous one says nothing.
      if (this.$async) {
        const generation = this.$generation;
        s.loads.deferHostEvent(() => {
          if (this.$generation === generation) {
            if (wrote) {
              outputProgress(this);
            }

            event(this, s.event("close"));
          }
        });
      }
    }

    truncate(): void {
      const buffer = writing(this);
      const bytes = avm2.bytesOf(s.rt, buffer);
      const at = bytes.position;
      s.rt.setProperty(buffer, s.rt.publicName("length"), at);
      changed(this, at, at);
      // The file is cut at once, as adl's is, with what was written before.
      flush(this);
    }

    get position(): number {
      return avm2.bytesOf(s.rt, opened(this)).position;
    }

    set position(value: Value) {
      const bytes = avm2.bytesOf(s.rt, opened(this));
      // APPEND writes at the end alone.
      if (this.$mode === "append") {
        throw s.rt.error("flash.errors::IllegalOperationError", 2037);
      }

      // As ByteArray's setter: a uint32 of its own, not toUint's (see Bytes).
      bytes.position = s.rt.toUint(value) >>> 0;
    }

    get bytesAvailable(): number {
      return avm2.bytesOf(s.rt, reading(this)).available;
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

    writeBoolean(...args: Value[]): void {
      write(this, "writeBoolean", ...args);
    }
    writeByte(...args: Value[]): void {
      write(this, "writeByte", ...args);
    }
    writeBytes(...args: Value[]): void {
      write(this, "writeBytes", ...args);
    }
    writeDouble(...args: Value[]): void {
      write(this, "writeDouble", ...args);
    }
    writeFloat(...args: Value[]): void {
      write(this, "writeFloat", ...args);
    }
    writeInt(...args: Value[]): void {
      write(this, "writeInt", ...args);
    }
    writeMultiByte(...args: Value[]): void {
      write(this, "writeMultiByte", ...args);
    }
    writeObject(...args: Value[]): void {
      write(this, "writeObject", ...args);
    }
    writeShort(...args: Value[]): void {
      write(this, "writeShort", ...args);
    }
    writeUnsignedInt(...args: Value[]): void {
      write(this, "writeUnsignedInt", ...args);
    }
    writeUTF(...args: Value[]): void {
      write(this, "writeUTF", ...args);
    }
    writeUTFBytes(...args: Value[]): void {
      write(this, "writeUTFBytes", ...args);
    }
  }

  avm2.registerNativeClass(natives, "flash.filesystem::FileStream", FileStreamNatives);
  return natives;
}
