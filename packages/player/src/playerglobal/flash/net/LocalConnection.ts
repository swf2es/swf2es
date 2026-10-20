// Both VMs use the player's LocalConnection registry. The AS3 class keeps
// its public API in playerglobal; only transport and VM values live here.
import { avm2 } from "@swf2es/runtime";
import { type LocalEndpoint, localDomain, localMethodAllowed } from "../../../localconnection.js";
import { dispatchEvent, heard } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { readModernValues, writeModernValues } from "./local-modern.js";
import { readLocalValues, writeLocalValues } from "./local-values.js";

export function swfDomain(url: string): string {
  return localDomain(url).domain;
}

interface State extends LocalEndpoint {
  client: avm2.Value;
  locked: boolean;
  perUser: boolean;
  domains: Set<string>;
  insecure: Set<string>;
}

export function localConnectionNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const states = new WeakMap<avm2.AsObject, State>();
  const state = (self: avm2.AsObject) => {
    const found = states.get(self);
    if (found) {
      return found;
    }

    const origins = s.code.securityUrls(3).map(localDomain);
    const origin = origins[0] ?? localDomain(s.url);
    if (origins.some((other) => other.domain !== origin.domain || other.secure !== origin.secure)) {
      // Where the engine cannot identify a caller, do not borrow the main SWF's permissions.
      origin.domain = "";
    }

    const endpoint: State = {
      owner: s,
      ...origin,
      key: null,
      client: self,
      locked: false,
      perUser: false,
      domains: new Set(),
      insecure: new Set(),
      alive: () => !s.destroyed,
      allows: (sender) => {
        const allowed = endpoint.secure && !sender.secure ? endpoint.insecure : endpoint.domains;
        return (
          (!(endpoint.secure && !sender.secure) && sender.domain === endpoint.domain) ||
          allowed.has("*") ||
          allowed.has(sender.domain)
        );
      },
      defer: (deliver) => s.loads.deferHostEvent(deliver),
      status: (success) => {
        if (!heard(self, "status")) {
          return;
        }

        dispatchEvent(
          s,
          self,
          s.rt.construct(
            s.rt.classNamed("flash.events::StatusEvent"),
            "status",
            false,
            false,
            null,
            success ? "status" : "error",
          ),
        );
      },
      receive: (method, message) => {
        try {
          s.rt.callProperty(
            endpoint.client,
            s.rt.publicName(method),
            ...(message.encoding === 0
              ? readLocalValues(s.rt, message.bytes)
              : readModernValues(s.rt, message.bytes)),
          );
        } catch (error) {
          if (error instanceof Error) {
            s.reportUncaught(error);
            return;
          }

          const failure = s.rt.error("Error", 2095, "flash.net.LocalConnection", method);
          if (!heard(self, "asyncError")) {
            s.reportUncaught(failure);
            return;
          }

          dispatchEvent(
            s,
            self,
            s.rt.construct(
              s.rt.classNamed("flash.events::AsyncErrorEvent"),
              "asyncError",
              false,
              false,
              s.rt.getProperty(failure, s.rt.publicName("message")),
              s.rt.isInstance(error, s.rt.classNamed("Error"))
                ? error
                : s.rt.construct(s.rt.classNamed("Error"), s.rt.toString(error)),
            ),
          );
        }
      },
    };
    states.set(self, endpoint);

    return endpoint;
  };
  class LocalConnectionNatives {
    "flash.net:LocalConnection::ctor"(): void {
      state(this as unknown as avm2.AsObject);
    }
    get domain(): string {
      return state(this as unknown as avm2.AsObject).domain;
    }
    connect(name: string): void {
      const endpoint = state(this as unknown as avm2.AsObject);
      endpoint.locked = true;
      if (name === null) {
        throw s.rt.error("TypeError", 2007, "connectionName");
      }

      if (name === "") {
        throw s.rt.error("ArgumentError", 2085, "connectionName");
      }

      if (name.includes(":")) {
        throw s.rt.error("ArgumentError", 2004);
      }

      if (!s.localConnections.connect(endpoint, name)) {
        throw s.rt.error("ArgumentError", 2082);
      }
    }
    close(): void {
      const endpoint = state(this as unknown as avm2.AsObject);
      endpoint.locked = true;
      if (!s.localConnections.close(endpoint)) {
        throw s.rt.error("ArgumentError", 2083);
      }
    }
    send(name: string, method: string, ...args: avm2.Value[]): void {
      const endpoint = state(this as unknown as avm2.AsObject);
      endpoint.locked = true;
      if (name === null || method === null) {
        throw s.rt.error("TypeError", 2007, name === null ? "connectionName" : "methodName");
      }

      if (name === "" || method === "") {
        throw s.rt.error("ArgumentError", 2085, name === "" ? "connectionName" : "methodName");
      }

      if (!localMethodAllowed(method)) {
        throw s.rt.error("ArgumentError", 2004);
      }

      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = writeModernValues(s.rt, args);
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }

        throw s.rt.error("ArgumentError", 2084);
      }

      s.localConnections.send(endpoint, name, method, {
        encoding: 3,
        bytes,
        legacy: () => writeLocalValues(s.rt, readModernValues(s.rt, bytes)),
      });
    }
    get client(): avm2.Value {
      return state(this as unknown as avm2.AsObject).client;
    }
    set client(value: avm2.Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "client");
      }
      state(this as unknown as avm2.AsObject).client = value;
    }
    get isPerUser(): boolean {
      return state(this as unknown as avm2.AsObject).perUser;
    }
    set isPerUser(value: boolean) {
      const endpoint = state(this as unknown as avm2.AsObject);
      if (endpoint.locked) {
        throw s.rt.error("Error", 3316);
      }
      endpoint.perUser = value;
    }
    allowDomain(...domains: string[]): void {
      const endpoint = state(this as unknown as avm2.AsObject);
      for (const domain of domains) {
        endpoint.domains.add(s.rt.toString(domain).toLowerCase());
      }
    }
    allowInsecureDomain(...domains: string[]): void {
      const endpoint = state(this as unknown as avm2.AsObject);
      for (const domain of domains) {
        const name = s.rt.toString(domain).toLowerCase();
        endpoint.insecure.add(name);
        endpoint.domains.add(name);
      }
    }
  }
  avm2.registerNativeClass(natives, "flash.net::LocalConnection", LocalConnectionNatives);
  return natives;
}
