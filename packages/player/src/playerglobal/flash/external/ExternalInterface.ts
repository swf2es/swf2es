// playerglobal's private ExternalInterface natives use the optional host
// given to Scripting. Without one, available is false and calls throw #2067.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function externalInterfaceNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ExternalInterfaceNatives {
    static get available(): boolean {
      return s.externalInterface !== null;
    }

    static get objectID(): Value {
      return s.externalInterface?.objectID ?? null;
    }

    static "flash.external:ExternalInterface::_initJS"(): void {
      // The host supplies the bridge; playerglobal's JavaScript shim needs no installation.
    }

    static "flash.external:ExternalInterface::_getPropNames"(object: Value): Value {
      const names: Value[] = [];
      let index = s.rt.hasNext(object, 0);
      while (index !== 0) {
        names.push(s.rt.nextName(object, index));
        index = s.rt.hasNext(object, index);
      }

      return s.rt.array(names);
    }

    static get "flash.external:ExternalInterface::activeX"(): boolean {
      return false;
    }

    static "flash.external:ExternalInterface::_addCallback"(
      name: Value,
      closure: Value,
      remove: Value,
    ): void {
      const host = s.externalInterface;
      if (!host) {
        throw s.rt.error("Error", 2067);
      }

      host.addCallback(
        s.rt.toString(name),
        remove || closure === null || closure === undefined
          ? null
          : (request, args) => {
              s.hostCalls++;
              return s.rt.callValue(closure, null, [request, s.rt.array(args)], null);
            },
      );
    }

    static "flash.external:ExternalInterface::_evalJS"(source: Value): Value {
      const host = s.externalInterface;
      if (!host) {
        throw s.rt.error("Error", 2067);
      }

      return host.evalJS(s.rt.toString(source));
    }

    static "flash.external:ExternalInterface::_callOut"(request: Value): Value {
      const host = s.externalInterface;
      if (!host) {
        throw s.rt.error("Error", 2067);
      }

      return host.callOut(s.rt.toString(request));
    }
  }

  avm2.registerNativeClass(natives, "flash.external::ExternalInterface", ExternalInterfaceNatives);
  return natives;
}
