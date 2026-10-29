// The classes AMF reads and writes objects by: the class aliases
// registerClassAlias sets, both ways, and ByteArray, Dictionary and Vector,
// which AMF makes for each value it reads, resolved once.

import type { AsObject } from "./descriptors.js";
import { NS_Public, namespace } from "./names.js";
import type { Runtime } from "./runtime.js";
import type { Traits } from "./traits.js";

export class AmfClasses {
  /** Class aliases, as registerClassAlias sets them, both ways. */
  private readonly aliases = new Map<string, AsObject>();
  private readonly aliasByTraits = new Map<Traits, string>();
  private byteArrayCls: AsObject | null = null;
  private dictionaryCls: AsObject | null = null;
  private vectorCls: AsObject | null = null;

  /** As Toplevel::registerClassAlias: a class by a name, replacing what the name had. */
  registerClassAlias(name: string, cls: AsObject): void {
    const previous = this.aliases.get(name);
    if (previous) {
      this.aliasByTraits.delete(previous.$it);
    }

    this.aliases.set(name, cls);
    this.aliasByTraits.set(cls.$it, name);
  }

  /** The alias of a class's instances' traits, or "". */
  aliasOf(traits: Traits): string {
    return this.aliasByTraits.get(traits) ?? "";
  }

  /** The class of an alias: as getClassByAlias, ReferenceError 1014 if none, or Object if `orObject`. */
  classByAlias(rt: Runtime, name: string, orObject: boolean): AsObject {
    const cls = this.aliases.get(name);
    if (cls) {
      return cls;
    }

    if (orObject) {
      return rt.builtinClass("Object");
    }

    throw rt.error("ReferenceError", 1014, name);
  }

  byteArrayClass(rt: Runtime): AsObject {
    this.byteArrayCls ??= rt.resolve(rt.cls(namespace(NS_Public, "flash.utils"), "ByteArray"));
    return this.byteArrayCls;
  }

  dictionaryClass(rt: Runtime): AsObject {
    this.dictionaryCls ??= rt.resolve(rt.cls(namespace(NS_Public, "flash.utils"), "Dictionary"));
    return this.dictionaryCls;
  }

  /** Vector.<T>, for a class T or null for *. */
  vectorClass(rt: Runtime, param: AsObject | null): AsObject {
    const specialized = rt.vectorClasses.get(param);
    if (specialized) {
      return specialized;
    }

    this.vectorCls ??= rt.resolve(rt.cls(namespace(NS_Public, "__AS3__.vec"), "Vector"));
    return rt.applyType(this.vectorCls, [param]);
  }
}
