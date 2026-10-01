// flash.system.ApplicationDomain: one domain for now, the current one,
// whose definitions are the runtime's; child domains come with the
// compiler's domain forked and the runtime resolving names by domain.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { qualify } from "../../toplevel.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function applicationDomainNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ApplicationDomainNatives {
    declare $parent: AsObject | null;

    static get currentDomain(): Value {
      return s.applicationDomain();
    }

    "flash.system:ApplicationDomain::ctor"(parent: Value): void {
      this.$parent = parent ?? null;
    }

    get parentDomain(): Value {
      return this.$parent;
    }

    getDefinition(name: Value): Value {
      return s.rt.classNamed(qualify(String(name)));
    }

    hasDefinition(name: Value): boolean {
      try {
        s.rt.classNamed(qualify(String(name)));
        return true;
      } catch {
        return false;
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.system::ApplicationDomain", ApplicationDomainNatives);
  return natives;
}
