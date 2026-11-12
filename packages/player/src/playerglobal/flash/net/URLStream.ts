// flash.net.URLStream: bytes fetched by the host, read through ByteArray's
// DataInput implementation and delivered to scripts on a later frame.
import { avm2 } from "@swf2es/runtime";
import type { As3, As3Classes } from "../../../as3/types.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;
type ByteArray = As3<"flash.utils::ByteArray">;
type ByteArrayMethod = avm2.MethodName<As3Classes["flash.utils::ByteArray"]>;

export function urlStreamNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const bufferOf = (stream: AsObject): AsObject =>
    (stream.$buffer ??= s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject);
  // The arguments go to the buffer's method as the stream's were given, which it checks.
  const read = (stream: AsObject, method: ByteArrayMethod, ...args: Value[]): Value =>
    s.rt.callProp(bufferOf(stream) as ByteArray, method, ...(args as never));
  const stop = (stream: AsObject): void => {
    stream.$generation = (stream.$generation ?? 0) + 1;
    stream.$abort?.abort();
    stream.$abort = null;
    stream.$connected = false;
  };

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
      const source = request as AsObject;
      s.loads.requestBytes(source, abort.signal, (result, url) => {
        if (this.$generation !== generation) {
          return;
        }

        const { bytes, status, local } = result;
        const redirected = result.url !== undefined;
        // AIR's, as the response's headers come: before the bytes and Flash Player's status.
        const response = s.httpResponseStatus(result, url);
        this.$abort = null;
        if (bytes === null) {
          this.$connected = false;
          if (response) {
            dispatchEvent(s, this, response);
            if (this.$generation !== generation) {
              return;
            }
          }

          dispatchEvent(s, this, s.httpStatus(status, redirected));
          if (this.$generation !== generation) {
            return;
          }

          dispatchEvent(
            s,
            this,
            s.rt.construct(
              s.rt.classNamed("flash.events::IOErrorEvent"),
              "ioError",
              false,
              false,
              s.loads.streamError(url, local),
              2032,
            ) as AsObject,
          );
          return;
        }

        this.$connected = true;
        dispatchEvent(s, this, s.event("open"));
        if (this.$generation !== generation) {
          return;
        }

        if (response) {
          dispatchEvent(s, this, response);
          if (this.$generation !== generation) {
            return;
          }
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

        dispatchEvent(s, this, s.httpStatus(status, redirected));
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
      if (!this.$abort && !this.$connected) {
        throw s.rt.error("flash.errors::IOError", 2029);
      }

      stop(this);
    }

    stop(): void {
      stop(this);
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
      return s.rt.prop(bufferOf(this) as ByteArray, "objectEncoding");
    }

    set objectEncoding(value: Value) {
      s.rt.setProp(bufferOf(this) as ByteArray, "objectEncoding", value);
    }

    get endian(): Value {
      return s.rt.prop(bufferOf(this) as ByteArray, "endian");
    }

    set endian(value: Value) {
      s.rt.setProp(bufferOf(this) as ByteArray, "endian", value);
    }

    get diskCacheEnabled(): boolean {
      return false;
    }

    get position(): number {
      return avm2.bytesOf(s.rt, bufferOf(this)).position;
    }

    set position(value: Value) {
      // As ByteArray's setter: a uint32 of its own, not toUint's (see Bytes).
      avm2.bytesOf(s.rt, bufferOf(this)).position = s.rt.toUint(value) >>> 0;
    }

    get length(): number {
      return avm2.bytesOf(s.rt, bufferOf(this)).length;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::URLStream", URLStreamNatives);
  return natives;
}
