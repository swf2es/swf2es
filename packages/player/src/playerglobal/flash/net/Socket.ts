// flash.net.Socket: DataInput/DataOutput over a host-provided TCP transport.
import { avm2 } from "@swf2es/runtime";
import type { As3, As3Classes } from "../../../as3/types.js";
import type { Scripting } from "../../../scripting.js";
import type { SocketConnections } from "./socket-connections.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;
type ByteArray = As3<"flash.utils::ByteArray">;
type ByteArrayMethod = avm2.MethodName<As3Classes["flash.utils::ByteArray"]>;

export function socketNatives(s: Scripting, sockets: SocketConnections): avm2.Natives {
  const natives: avm2.Natives = {};
  const connection = (o: AsObject) => sockets.get(o);
  // The runtime's message, which is the debugger player's text or the release player's number alone.
  const invalid = (): never => {
    throw s.rt.error("flash.errors::IOError", 2002);
  };
  const active = (o: AsObject) => {
    const c = connection(o);
    if (!c.connected) {
      invalid();
    }

    return c;
  };
  // The arguments go to the buffer's method as the socket's were given, which it checks.
  const input = (o: AsObject, method: ByteArrayMethod, ...args: Value[]): Value =>
    s.rt.callProp(active(o).input as ByteArray, method, ...(args as never));
  const output = (o: AsObject, method: ByteArrayMethod, ...args: Value[]): Value =>
    s.rt.callProp(active(o).output as ByteArray, method, ...(args as never));
  class SocketNatives {
    "flash.net:Socket::internalGetSecurityErrorMessage"(host: Value, port: Value): string {
      return `Error #2048: Security sandbox violation: ${String(host)}:${Number(port)}`;
    }

    "flash.net:Socket::internalConnect"(host: Value, port: Value): void {
      const hostname = host === null ? "localhost" : s.rt.toString(host);
      const targetPort = s.rt.toInt(port);
      const transport = s.socket;
      sockets.connect(
        this,
        transport
          ? (events, options) => transport.connect(hostname, targetPort, events, options)
          : undefined,
      );
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
      c.endpoints = null;
      c.closed?.();
    }

    "flash.net:Socket::OnError"(): void {}

    "flash.net:Socket::wasCalledByAppContent"(): boolean {
      return false;
    }

    /**
     * AIR's, as adl reads them: null and 0 before a connection and after
     * close(), "" and 0 while one opens or after it fails, and the ends,
     * resolved, once open, kept after the peer closes.
     */
    get localAddress(): string | null {
      return connection(this).endpoints?.localAddress ?? null;
    }

    get localPort(): number {
      return connection(this).endpoints?.localPort ?? 0;
    }

    get remoteAddress(): string | null {
      return connection(this).endpoints?.remoteAddress ?? null;
    }

    get remotePort(): number {
      return connection(this).endpoints?.remotePort ?? 0;
    }

    get connected(): boolean {
      return connection(this).connected;
    }

    /**
     * Harman's AIR's, as adl has it: false until set, then what was set, at
     * any time and never refused; a connection takes it as connect() is
     * called, so a set after that waits for the next connect.
     */
    get tcpNoDelay(): boolean {
      return connection(this).noDelay ?? false;
    }

    set tcpNoDelay(value: Value) {
      connection(this).noDelay = Boolean(value);
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
      return s.rt.prop(connection(this).input as ByteArray, "objectEncoding");
    }

    set objectEncoding(value: Value) {
      const c = connection(this);
      s.rt.setProp(c.input as ByteArray, "objectEncoding", value);
      s.rt.setProp(c.output as ByteArray, "objectEncoding", value);
    }

    get endian(): Value {
      return s.rt.prop(connection(this).input as ByteArray, "endian");
    }

    set endian(value: Value) {
      const c = connection(this);
      s.rt.setProp(c.input as ByteArray, "endian", value);
      s.rt.setProp(c.output as ByteArray, "endian", value);
    }
  }

  avm2.registerNativeClass(natives, "flash.net::Socket", SocketNatives);
  return natives;
}
