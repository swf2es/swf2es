// flash.net.Socket: DataInput/DataOutput over a host-provided TCP transport.
import { avm2 } from "@swf2es/runtime";
import type { Scripting, SocketTransport } from "../../../scripting.js";
import { dispatchEvent } from "../events/EventDispatcher.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

interface Connection {
  input: AsObject;
  output: AsObject;
  transport: SocketTransport | null;
  generation: number;
  connected: boolean;
  connecting: boolean;
  failed: boolean;
}

export function socketNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const connections = new WeakMap<AsObject, Connection>();
  const byteArray = () => s.rt.classNamed("flash.utils::ByteArray");
  const connection = (o: AsObject): Connection => {
    let c = connections.get(o);
    if (!c) {
      c = {
        input: s.rt.construct(byteArray()),
        output: s.rt.construct(byteArray()),
        transport: null,
        generation: 0,
        connected: false,
        connecting: false,
        failed: false,
      };
      connections.set(o, c);
    }

    return c;
  };
  // The runtime's message, which is the debugger player's text or the release player's number alone.
  const invalid = (): never => {
    throw s.rt.error("flash.errors::IOError", 2002);
  };
  const active = (o: AsObject): Connection => {
    const c = connection(o);
    if (!c.connected) {
      invalid();
    }

    return c;
  };
  const input = (o: AsObject, method: string, ...args: Value[]): Value =>
    s.rt.callProperty(active(o).input, s.rt.publicName(method), ...args);
  const output = (o: AsObject, method: string, ...args: Value[]): Value =>
    s.rt.callProperty(active(o).output, s.rt.publicName(method), ...args);
  const event = (o: AsObject, type: string): void => {
    dispatchEvent(s, o, s.event(type));
  };

  class SocketNatives {
    "flash.net:Socket::internalGetSecurityErrorMessage"(host: Value, port: Value): string {
      return `Error #2048: Security sandbox violation: ${String(host)}:${Number(port)}`;
    }

    "flash.net:Socket::internalConnect"(host: Value, port: Value): void {
      const c = connection(this);
      c.transport?.close();
      c.generation++;
      c.transport = null;
      c.connected = false;
      c.connecting = true;
      c.failed = false;
      avm2.bytesOf(s.rt, c.input).clear();
      avm2.bytesOf(s.rt, c.output).clear();
      const generation = c.generation;
      const current = () => c.generation === generation;
      const fail = (message: string) => {
        if (!current()) {
          return;
        }

        c.generation++;
        c.connecting = false;
        c.connected = false;
        c.transport?.close();
        c.transport = null;
        c.failed = true;
        dispatchEvent(
          s,
          this,
          s.rt.construct(
            s.rt.classNamed("flash.events::IOErrorEvent"),
            "ioError",
            false,
            false,
            message,
          ),
        );
      };
      if (!s.socket) {
        s.deferHostEvent(() => fail("Error #2031: Socket Error."));
        return;
      }

      try {
        c.transport = s.socket.connect(
          host === null ? "localhost" : s.rt.toString(host),
          s.rt.toInt(port),
          {
            open: () =>
              s.deferHostEvent(() => {
                if (!current()) {
                  return;
                }

                c.connecting = false;
                c.connected = true;
                event(this, "connect");
              }),
            data: (bytes) => {
              const copy = bytes.slice();
              s.deferHostEvent(() => {
                if (!current() || !c.connected) {
                  return;
                }

                const buffer = avm2.bytesOf(s.rt, c.input);
                if (buffer.position >= 65536 && buffer.position * 2 >= buffer.length) {
                  const unread = buffer.available;
                  buffer.buffer.copyWithin(0, buffer.position, buffer.length);
                  buffer.setLength(unread);
                  buffer.position = 0;
                }

                const position = buffer.position;
                buffer.position = buffer.length;
                buffer.write(copy);
                buffer.position = position;
                dispatchEvent(
                  s,
                  this,
                  s.rt.construct(
                    s.rt.classNamed("flash.events::ProgressEvent"),
                    "socketData",
                    false,
                    false,
                    copy.length,
                    0,
                  ),
                );
              });
            },
            close: () =>
              s.deferHostEvent(() => {
                if (!current()) {
                  return;
                }

                if (c.connecting) {
                  fail("Error #2031: Socket Error.");
                  return;
                }

                c.connected = false;
                c.connecting = false;
                c.transport = null;
                event(this, "close");
              }),
            error: (message) => s.deferHostEvent(() => fail(message)),
          },
        );
      } catch (e) {
        s.deferHostEvent(() => fail(String(e)));
      }
    }

    "flash.net:Socket::didFailureOccur"(): boolean {
      return connection(this).failed;
    }

    "flash.net:Socket::internalClose"(): void {
      const c = connection(this);
      if (!c.connected && !c.connecting) {
        invalid();
      }

      c.generation++;
      c.transport?.close();
      c.transport = null;
      c.connected = false;
      c.connecting = false;
    }

    "flash.net:Socket::OnError"(): void {}

    "flash.net:Socket::wasCalledByAppContent"(): boolean {
      return false;
    }

    get connected(): boolean {
      return connection(this).connected;
    }

    get bytesAvailable(): number {
      return avm2.bytesOf(s.rt, connection(this).input).available;
    }

    get bytesPending(): number {
      return avm2.bytesOf(s.rt, connection(this).output).length;
    }

    flush(): void {
      const c = active(this);
      const bytes = avm2.bytesOf(s.rt, c.output);
      if (bytes.length !== 0) {
        c.transport?.send(bytes.buffer.slice(0, bytes.length));
        bytes.setLength(0);
        bytes.position = 0;
      }
    }

    readBytes(bytes: Value, offset: Value, length: Value): void {
      input(this, "readBytes", bytes, offset, length);
    }
    readBoolean(): Value {
      return input(this, "readBoolean");
    }
    readByte(): Value {
      return input(this, "readByte");
    }
    readUnsignedByte(): Value {
      return input(this, "readUnsignedByte");
    }
    readShort(): Value {
      return input(this, "readShort");
    }
    readUnsignedShort(): Value {
      return input(this, "readUnsignedShort");
    }
    readInt(): Value {
      return input(this, "readInt");
    }
    readUnsignedInt(): Value {
      return input(this, "readUnsignedInt");
    }
    readFloat(): Value {
      return input(this, "readFloat");
    }
    readDouble(): Value {
      return input(this, "readDouble");
    }
    readUTF(): Value {
      return input(this, "readUTF");
    }
    readUTFBytes(length: Value): Value {
      return input(this, "readUTFBytes", length);
    }
    readMultiByte(length: Value, charset: Value): Value {
      return input(this, "readMultiByte", length, charset);
    }
    readObject(): Value {
      return input(this, "readObject");
    }

    writeBytes(bytes: Value, offset: Value, length: Value): void {
      output(this, "writeBytes", bytes, offset, length);
    }
    writeBoolean(value: Value): void {
      output(this, "writeBoolean", value);
    }
    writeByte(value: Value): void {
      output(this, "writeByte", value);
    }
    writeShort(value: Value): void {
      output(this, "writeShort", value);
    }
    writeInt(value: Value): void {
      output(this, "writeInt", value);
    }
    writeUnsignedInt(value: Value): void {
      output(this, "writeUnsignedInt", value);
    }
    writeFloat(value: Value): void {
      output(this, "writeFloat", value);
    }
    writeDouble(value: Value): void {
      output(this, "writeDouble", value);
    }
    writeMultiByte(value: Value, charset: Value): void {
      output(this, "writeMultiByte", value, charset);
    }
    writeUTF(value: Value): void {
      output(this, "writeUTF", value);
    }
    writeUTFBytes(value: Value): void {
      output(this, "writeUTFBytes", value);
    }
    writeObject(value: Value): void {
      output(this, "writeObject", value);
    }

    get objectEncoding(): Value {
      return s.rt.getProperty(connection(this).input, s.rt.publicName("objectEncoding"));
    }

    set objectEncoding(value: Value) {
      const c = connection(this);
      s.rt.setProperty(c.input, s.rt.publicName("objectEncoding"), value);
      s.rt.setProperty(c.output, s.rt.publicName("objectEncoding"), value);
    }

    get endian(): Value {
      return s.rt.getProperty(connection(this).input, s.rt.publicName("endian"));
    }

    set endian(value: Value) {
      const c = connection(this);
      s.rt.setProperty(c.input, s.rt.publicName("endian"), value);
      s.rt.setProperty(c.output, s.rt.publicName("endian"), value);
    }
  }

  avm2.registerNativeClass(natives, "flash.net::Socket", SocketNatives);
  return natives;
}
