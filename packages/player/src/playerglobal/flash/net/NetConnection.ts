// flash.net.NetConnection in its local mode, connect(null), which Flash
// keeps for progressive video, with its properties and status events as
// Flash gives them; and Flash Remoting over an HTTP URI: each call queued,
// and a frame's calls POSTed together at its end as one packet
// (remoting.ts), the connection's headers with them, each answer, /n/
// onResult or /n/onStatus, going to its Responder, as adl does.
// Responder holds its callbacks.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import {
  type RemoteCall,
  type RemoteHeader,
  remoteArguments,
  remoteMessages,
  remotePacket,
  remoteValue,
} from "./remoting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** NetConnection's private invoke codes, as playerglobal's constants have them. */
const CLOSE = 1;
const CALL = 2;
const ADD_HEADER = 3;

const NONCE = "0".repeat(64);

/** A connection to a remoting gateway: its URL, headers, the calls of the frame, and those answered yet. */
interface Remote {
  readonly url: string;
  headers: RemoteHeader[];
  queue: RemoteCall[];
  /** The number the next call answers at: counted from 1 on each connect, as adl counts. */
  next: number;
  readonly responders: Map<number, AsObject | null>;
  /** Whether the frame's end sends the queue. */
  scheduled: boolean;
}

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
    declare $remote: Remote | null | undefined;

    get connected(): boolean {
      return this.$connected ?? false;
    }

    get uri(): Value {
      return this.$uri ?? null;
    }

    /** Null is the local connection, at once and connected; an HTTP URI is only kept. A connection made goes first. */
    connect(command: Value): void {
      const self = this as unknown as AsObject;
      // A gateway connected before is closed as a local one is (the corpus's netconnection_send_remote).
      if (this.$connected || this.$remote) {
        this.$connected = false;
        this.$remote = null;
        status(self, ["code", "NetConnection.Connect.Closed", "level", "status"]);
      }

      if (command === null || command === undefined || s.rt.toString(command) === "null") {
        this.$uri = "null";
        this.$connected = true;
        status(self, ["code", "NetConnection.Connect.Success", "level", "status"]);
        return;
      }

      this.$uri = s.rt.toString(command);
      if (/^https?:\/\//i.test(this.$uri)) {
        this.$remote = {
          url: this.$uri,
          headers: [],
          queue: [],
          next: 1,
          responders: new Map(),
          scheduled: false,
        };
      }
    }

    "flash.net:NetConnection::invoke"(code: Value): Value {
      if (s.rt.toUint(code) === CLOSE) {
        close(this as unknown as AsObject & NetConnectionNatives);
        return undefined;
      }

      throw s.rt.unsupported(`NetConnection invoke ${s.rt.toUint(code)}`);
    }

    "flash.net:NetConnection::invokeWithArgsArray"(code: Value, args: Value): Value {
      const which = s.rt.toUint(code);
      const values = ((args as AsObject | null)?.$a ?? []) as Value[];
      if (which === ADD_HEADER) {
        addHeader(this, values);
        return undefined;
      }

      if (which === CALL) {
        call(this as unknown as AsObject & NetConnectionNatives, values);
        return undefined;
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
    o.$remote = null;
    if (wasConnected) {
      status(o, ["code", "NetConnection.Connect.Closed", "level", "status"]);
    } else if (uri !== null) {
      status(o, ["code", "NetConnection.Connect.Closed", "level", "status"]);
      status(o, ["code", "", "description", "", "details", "", "level", "status"]);
    }
  };

  /**
   * A call queued for the frame's end, numbered on its connection; nothing
   * on a local connection or none, which send nothing, as in adl.
   */
  const call = (o: AsObject & NetConnectionNatives, values: Value[]): void => {
    const remote = o.$remote;
    if (!remote) {
      return;
    }

    const method = s.rt.toString(values[0]);
    const responder = (values[1] ?? null) as AsObject | null;
    const id = remote.next++;
    const encoding = o.$objectEncoding ?? defaultEncoding;
    remote.queue.push({ method, id, body: remoteArguments(s.rt, values.slice(2), encoding) });
    remote.responders.set(id, responder);
    if (!remote.scheduled) {
      remote.scheduled = true;
      s.afterExitFrame.push(() => send(o, remote, encoding));
    }
  };

  /** One header of a name, its case aside: the last set, a value of null its value (corpus). */
  const addHeader = (o: NetConnectionNatives, values: Value[]): void => {
    const remote = o.$remote;
    if (!remote) {
      return;
    }

    const name = s.rt.toString(values[0]);
    const encoding = o.$objectEncoding ?? defaultEncoding;
    const value = remoteValue(s.rt, values[2] ?? null, encoding);
    remote.headers = remote.headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase());
    remote.headers.push({ name, mustUnderstand: s.rt.toBoolean(values[1]), value });
  };

  /** The frame's calls, POSTed as one packet; their answers come in a later frame. */
  const send = (o: AsObject & NetConnectionNatives, remote: Remote, encoding: number): void => {
    remote.scheduled = false;
    const calls = remote.queue;
    remote.queue = [];
    const fetch = s.fetch;
    // A connection closed or replaced since sends nothing.
    if (o.$remote !== remote || calls.length === 0 || !fetch) {
      return;
    }

    const body = remotePacket(encoding, remote.headers, calls);
    const request = fetch(
      {
        url: remote.url,
        method: "POST",
        headers: [["Content-Type", "application/x-amf"]],
        body,
        purpose: "data",
      },
      new AbortController().signal,
    ).then(
      (result) => result,
      () => ({ bytes: null, status: 0, headers: [] }),
    );
    s.loads.trackRequest(
      request.then((result) => {
        s.loads.deferHostEvent(() => {
          try {
            answered(o, remote, result.bytes, result.status);
          } finally {
            // Its calls are done with, answered or not: their responders go.
            for (const call of calls) {
              remote.responders.delete(call.id);
            }
          }
        });
      }),
    );
  };

  /**
   * An answer: each message to the responder of the call it names; an
   * HTTP error or no answer as Call.Failed, one that is no packet as
   * Call.BadVersion, an empty one as nothing, as adl reports them.
   */
  const answered = (
    o: AsObject & NetConnectionNatives,
    remote: Remote,
    bytes: Uint8Array | null,
    httpStatus: number,
  ): void => {
    if (o.$remote !== remote) {
      return;
    }

    if (bytes === null) {
      const description = httpStatus >= 300 ? `HTTP: Status ${httpStatus}` : "HTTP: Failed";
      status(o, [
        "code",
        "NetConnection.Call.Failed",
        "description",
        description,
        "details",
        remote.url,
        "level",
        "error",
      ]);
      return;
    }

    if (bytes.length === 0) {
      return;
    }

    const messages = remoteMessages(s.rt, bytes);
    if (messages === "version") {
      status(o, [
        "code",
        "NetConnection.Call.BadVersion",
        "description",
        "",
        "details",
        "",
        "level",
        "error",
      ]);
      return;
    }

    for (const [target, value] of messages) {
      const m = /^\/(\d+)\/(onResult|onStatus)$/.exec(target);
      if (!m) {
        continue;
      }

      const id = Number(m[1]);
      const responder = remote.responders.get(id);
      remote.responders.delete(id);
      const handler = responder
        ? (responder as AsObject & ResponderNatives)[m[2] === "onResult" ? "$result" : "$status"]
        : null;
      if (typeof handler === "function" || (handler && typeof handler === "object")) {
        try {
          s.rt.call(handler, null, value);
        } catch (error) {
          s.reportUncaught(error, handler);
        }
      }
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
