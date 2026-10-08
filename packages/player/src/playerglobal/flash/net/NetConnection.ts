// flash.net.NetConnection in its local mode, connect(null), which Flash
// keeps for progressive video, with its properties and status events as
// Flash gives them; an HTTP URI is kept, as Flash Remoting would use it,
// and a call over it is not supported yet. Responder holds its callbacks.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** NetConnection's private invoke codes, as playerglobal's constants have them. */
const CLOSE = 1;
const CALL = 2;
const ADD_HEADER = 3;

const NONCE = "0".repeat(64);

export function netConnectionNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let defaultEncoding = 3;

  const status = (target: AsObject, info: Value[]): void => {
    dispatchEvent(
      s,
      target,
      s.rt.construct(
        s.rt.classNamed("flash.events::NetStatusEvent"),
        "netStatus",
        false,
        false,
        s.rt.newObject(info),
      ) as AsObject,
    );
  };

  /** What a local connection has; ArgumentError 2126 for any other. */
  const connectedOnly = <T>(o: { $connected: boolean | undefined }, value: T): T => {
    if (!o.$connected) {
      throw s.rt.error("ArgumentError", 2126);
    }

    return value;
  };

  class NetConnectionNatives {
    declare $connected: boolean | undefined;
    declare $uri: string | null | undefined;
    declare $client: Value;
    declare $objectEncoding: number | undefined;
    declare $proxyType: string | undefined;
    declare $maxPeers: number | undefined;
    declare $idleTimeout: number | undefined;

    get connected(): boolean {
      return this.$connected ?? false;
    }

    get uri(): Value {
      return this.$uri ?? null;
    }

    /** Null is the local connection, at once and connected; an HTTP URI is only kept. A connection made goes first. */
    connect(command: Value): void {
      const self = this as unknown as AsObject;
      if (this.$connected) {
        this.$connected = false;
        status(self, ["code", "NetConnection.Connect.Closed", "level", "status"]);
      }

      if (command === null || command === undefined || s.rt.toString(command) === "null") {
        this.$uri = "null";
        this.$connected = true;
        status(self, ["code", "NetConnection.Connect.Success", "level", "status"]);
        return;
      }

      this.$uri = s.rt.toString(command);
    }

    "flash.net:NetConnection::invoke"(code: Value): Value {
      if (s.rt.toUint(code) === CLOSE) {
        close(this as unknown as AsObject & NetConnectionNatives);
        return undefined;
      }

      throw s.rt.unsupported(`NetConnection invoke ${s.rt.toUint(code)}`);
    }

    "flash.net:NetConnection::invokeWithArgsArray"(code: Value, _args: Value): Value {
      const which = s.rt.toUint(code);
      if (which === ADD_HEADER) {
        return undefined;
      }

      if (which === CALL) {
        throw s.rt.unsupported("NetConnection.call, Flash Remoting");
      }

      throw s.rt.unsupported(`NetConnection invoke ${which}`);
    }

    get client(): Value {
      return this.$client ?? this;
    }

    set client(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2004);
      }

      this.$client = v;
    }

    get objectEncoding(): number {
      return this.$objectEncoding ?? defaultEncoding;
    }

    set objectEncoding(v: Value) {
      this.$objectEncoding = s.rt.toUint(v);
    }

    get proxyType(): string {
      return this.$proxyType ?? "none";
    }

    set proxyType(v: Value) {
      this.$proxyType = s.rt.toString(v);
    }

    get maxPeerConnections(): number {
      return this.$maxPeers ?? 8;
    }

    set maxPeerConnections(v: Value) {
      this.$maxPeers = s.rt.toUint(v);
    }

    get httpIdleTimeout(): number {
      return this.$idleTimeout ?? 0;
    }

    "flash.net:NetConnection::_SetHTTPIdleTimeout"(v: Value): void {
      this.$idleTimeout = s.rt.toNumber(v);
    }

    get connectedProxyType(): string {
      return connectedOnly(this, "none");
    }

    get usingTLS(): boolean {
      return connectedOnly(this, false);
    }

    get protocol(): string {
      return connectedOnly(this, "rtmp");
    }

    get nearID(): string {
      return connectedOnly(this, "");
    }

    get farID(): string {
      return connectedOnly(this, "");
    }

    get nearNonce(): string {
      return connectedOnly(this, NONCE);
    }

    get farNonce(): string {
      return connectedOnly(this, NONCE);
    }

    get unconnectedPeerStreams(): Value {
      return connectedOnly(this, s.rt.array([]));
    }

    static get defaultObjectEncoding(): number {
      return defaultEncoding;
    }

    static set defaultObjectEncoding(v: Value) {
      defaultEncoding = s.rt.toUint(v);
    }
  }

  /**
   * Closed, as Flash reports it: a local connection's CLOSED; for a kept
   * URI, CLOSED and then a status of empty strings, as the corpus's
   * `netconnection_close` has it; nothing for no connection.
   */
  const close = (o: AsObject & NetConnectionNatives): void => {
    const uri = o.$uri ?? null;
    const wasConnected = o.$connected ?? false;
    o.$connected = false;
    o.$uri = null;
    if (wasConnected) {
      status(o, ["code", "NetConnection.Connect.Closed", "level", "status"]);
    } else if (uri !== null) {
      status(o, ["code", "NetConnection.Connect.Closed", "level", "status"]);
      status(o, ["code", "", "description", "", "details", "", "level", "status"]);
    }
  };

  class ResponderNatives {
    declare $result: Value;
    declare $status: Value;

    "flash.net:Responder::ctor"(result: Value, status: Value): void {
      this.$result = result;
      this.$status = status;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::NetConnection", NetConnectionNatives);
  avm2.registerNativeClass(natives, "flash.net::Responder", ResponderNatives);
  return natives;
}
