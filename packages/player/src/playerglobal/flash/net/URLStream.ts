// flash.net.URLStream: bytes fetched by the host, read through ByteArray's
// DataInput implementation and delivered to scripts on a later frame.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { dispatchEvent } from "../events/EventDispatcher.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function urlStreamNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const bufferOf = (stream: AsObject): AsObject =>
    (stream.$buffer ??= s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject);
  const read = (stream: AsObject, method: string, ...args: Value[]): Value =>
    s.rt.callProperty(bufferOf(stream), s.rt.publicName(method), ...args);

  class URLStreamNatives {
    declare $buffer: AsObject | undefined;
    declare $generation: number | undefined;
    declare $abort: AbortController | null | undefined;
    declare $connected: boolean | undefined;

    load(request: Value): void {
      if (request === null || request === undefined) {
        throw s.rt.error("TypeError", 2007, "request");
      }

      this.$abort?.abort();
      const generation = (this.$generation ?? 0) + 1;
      this.$generation = generation;
      this.$connected = false;
      this.$buffer = undefined;
      const abort = new AbortController();
      this.$abort = abort;
      const url = s.rt.toString(s.rt.getProperty(request, s.rt.publicName("url")));
      s.requestBytes(url, abort.signal, (bytes) => {
        if (this.$generation !== generation) {
          return;
        }

        this.$abort = null;
        if (bytes === null) {
          this.$connected = false;
          dispatchEvent(
            s,
            this,
            s.rt.construct(
              s.rt.classNamed("flash.events::IOErrorEvent"),
              "ioError",
              false,
              false,
              "Error #2032: Stream Error",
            ) as AsObject,
          );
          return;
        }

        this.$connected = true;
        dispatchEvent(s, this, s.event("open"));
        if (this.$generation !== generation) {
          return;
        }

        const buffer = avm2.bytesOf(s.rt, bufferOf(this));
        buffer.write(bytes);
        buffer.position = 0;
        dispatchEvent(
          s,
          this,
          s.rt.construct(
            s.rt.classNamed("flash.events::ProgressEvent"),
            "progress",
            false,
            false,
            bytes.length,
            bytes.length,
          ) as AsObject,
        );
        if (this.$generation !== generation) {
          return;
        }

        dispatchEvent(s, this, s.event("complete"));
      });
    }

    get connected(): boolean {
      return this.$connected ?? false;
    }

    get bytesAvailable(): number {
      return avm2.bytesOf(s.rt, bufferOf(this)).available;
    }

    close(): void {
      this.$generation = (this.$generation ?? 0) + 1;
      this.$abort?.abort();
      this.$abort = null;
      this.$connected = false;
    }

    stop(): void {
      this.close();
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

    get objectEncoding(): Value {
      return s.rt.getProperty(bufferOf(this), s.rt.publicName("objectEncoding"));
    }

    set objectEncoding(value: Value) {
      s.rt.setProperty(bufferOf(this), s.rt.publicName("objectEncoding"), value);
    }

    get endian(): Value {
      return s.rt.getProperty(bufferOf(this), s.rt.publicName("endian"));
    }

    set endian(value: Value) {
      s.rt.setProperty(bufferOf(this), s.rt.publicName("endian"), value);
    }

    get diskCacheEnabled(): boolean {
      return false;
    }

    get position(): number {
      return avm2.bytesOf(s.rt, bufferOf(this)).position;
    }

    set position(value: Value) {
      avm2.bytesOf(s.rt, bufferOf(this)).position = s.rt.toUint(value);
    }

    get length(): number {
      return avm2.bytesOf(s.rt, bufferOf(this)).length;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::URLStream", URLStreamNatives);
  return natives;
}
