// AS2's LocalConnection. Argument copies use the player's AMF0 codec;
// names, status ordering and argument validation are checked against adl.
import { avm1 } from "@swf2es/runtime";
import {
  LOCAL_MESSAGE_LIMIT,
  type LocalEndpoint,
  localDomain,
  localMethodAllowed,
} from "../../localconnection.js";
import { Reader, Writer } from "../amf.js";
import type { Avm1 } from "../avm1.js";
import type { XmlNodes } from "./XMLNode.js";
import { serialize } from "./XMLNode.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

export function localConnectionClass(
  movie: Avm1,
  xml: avm1.Avm1Function,
  nodes: XmlNodes,
): avm1.Avm1Function {
  const realm = movie.realm;
  const states = new WeakMap<Obj, LocalEndpoint>();
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => {
      const origin = localDomain(movie.currentSwf().url);
      const endpoint: LocalEndpoint = {
        owner: movie,
        ...origin,
        key: null,
        alive: () => !movie.halted && !movie.fileLifetime.signal.aborted,
        allows: (sender) => {
          const v = movie.version;
          const insecure = endpoint.secure && !sender.secure && v >= 7;
          const name = insecure ? "allowInsecureDomain" : "allowDomain";
          return avm1.toBoolean(
            movie.localInvoke(
              self,
              name,
              [sender.domain],
              !insecure && endpoint.domain === sender.domain,
            ),
            v,
          );
        },
        defer: (deliver) => movie.net.defer(deliver),
        status: (success) => {
          const info = realm.newObject(movie.version);
          info.define("level", success ? "status" : "error", 0);
          movie.localInvoke(self, "onStatus", [info]);
        },
        receive: (method, message) => {
          const bytes = message.encoding === 0 ? message.bytes : message.legacy();
          const v = movie.version;
          const values = new Reader(bytes, realm, v, false, undefined, (text) =>
            realm.construct(xml, [text], v),
          ).value();
          const args: Value[] = [];
          if (values instanceof avm1.Avm1Object) {
            const count = avm1.toNumber(avm1.get(values, "length", v), v) >>> 0;
            for (let i = 0; i < count; i++) {
              args.push(avm1.get(values, String(i), v));
            }
          }

          movie.localInvoke(self, method, args);
        },
      };
      states.set(self, endpoint);
      return self;
    },
    () => undefined,
  );
  const method = (name: string, native: avm1.Native) =>
    proto.define(name, realm.method(native), avm1.DONT_ENUM | avm1.DONT_DELETE);
  method("connect", (self, args) => {
    const state = states.get(self);
    return typeof args[0] !== "string"
      ? false
      : state === undefined
        ? undefined
        : movie.localConnections.connect(state, args[0]);
  });
  method("close", (self) => {
    const state = states.get(self);
    return state !== undefined && movie.localConnections.close(state);
  });
  method("domain", () => localDomain(movie.currentSwf().url).domain);
  method("send", (self, args, v) => {
    const name = args[0],
      target = args[1],
      state = states.get(self);
    if (
      typeof name !== "string" ||
      name === "" ||
      typeof target !== "string" ||
      !localMethodAllowed(target) ||
      !state
    ) {
      return false;
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const writer = new Writer(
        (c) => movie.registeredName(c),
        v,
        null,
        {
          first: 1,
          xmlText: (o) => {
            const node = nodes.nodeOf(o);
            return node === null ? null : serialize(node, v);
          },
        },
        LOCAL_MESSAGE_LIMIT,
      );
      writer.arguments(args.slice(2));
      bytes = new Uint8Array(writer.size);
      let at = 0;
      for (const chunk of writer.chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        return false;
      }

      throw error;
    }

    movie.localConnections.send(state, name, target, { encoding: 0, bytes });

    return true;
  });

  return constr;
}
