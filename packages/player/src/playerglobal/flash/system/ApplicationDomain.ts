// flash.system.ApplicationDomain: one of the runtime's application
// domains (avm2.Domain), kept on the object as $domain: a child's
// definitions after its parent's, its own invisible to its parent and to
// its siblings. The root is Flash's system domain, the player's classes,
// and the main SWF's is its child (Scripting.mainDomain), so `new
// ApplicationDomain(null)` sees none of the main SWF's. Its domain memory
// is the runtime's one, as avmshell's Domain's is.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { qualify } from "../../toplevel.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function applicationDomainNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  const domainOf = (o: AsObject): avm2.Domain => o.$domain ?? s.mainDomain;
  // Not defined, as Flash has it, for a name whose script throws as it
  // runs too: a script that threw runs again, as for getDefinition.
  const has = (o: AsObject, name: Value): boolean => {
    if (name === null || name === undefined) {
      return false;
    }

    try {
      s.rt.definitionNamed(qualify(String(name)), domainOf(o));
      return true;
    } catch {
      return false;
    }
  };

  class ApplicationDomainNatives {
    declare $domain: avm2.Domain | undefined;

    // The domain of the code that asks, as Flash's.
    static get currentDomain(): Value {
      return s.applicationDomainOf(s.codeDomain());
    }

    static get MIN_DOMAIN_MEMORY_LENGTH(): number {
      return avm2.GLOBAL_MEMORY_MIN_SIZE;
    }

    get domainMemory(): Value {
      return s.rt.memoryProvider;
    }

    set domainMemory(v: Value) {
      avm2.setDomainMemory(s.rt, v);
    }

    "flash.system:ApplicationDomain::ctor"(parent: Value): void {
      this.$domain = s.rt.childDomain(parent ? domainOf(parent) : s.rt.root);
    }

    // The system domain, the root, is no script's to see: the main SWF's has no parent.
    get parentDomain(): Value {
      const parent = domainOf(this).parent;
      return parent && parent !== s.rt.root ? s.applicationDomainOf(parent) : null;
    }

    getQualifiedDefinitionNames(): Value {
      const cls = s.rt.resolve(s.rt.vector("String"));
      const names = cls.$it.instance();
      names.$a = s.rt.definitionNames(domainOf(this));
      return names;
    }

    // As Flash's: an initializer's error comes through (Runtime.definitionNamed).
    getDefinition(name: Value): Value {
      return s.rt.definitionNamed(qualify(String(name)), domainOf(this));
    }

    hasDefinition(name: Value): boolean {
      return has(this, name);
    }
  }

  avm2.registerNativeClass(natives, "flash.system::ApplicationDomain", ApplicationDomainNatives);
  return natives;
}
