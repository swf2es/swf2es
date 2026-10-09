// Classes as OP_newclass makes them: a class object and its instances'
// traits from the module's descriptor, with its hooks, its prototype
// object and its methods bound to the scope chain it is made in.

import type { Abc, AsObject, ClassDesc, Method, Scope, TraitsDesc, Value } from "./descriptors.js";
import { type Multiname, qualifiedName } from "./names.js";
import { invalidate } from "./property-cache.js";
import type { Runtime } from "./runtime.js";
import { BIND_Get, BIND_GetSet, BIND_Method, BIND_Set, methodKey, Traits } from "./traits.js";

/**
 * As OP_newclass: a class from its module's descriptor, extending `base`,
 * its methods bound to the scope chain here. Object, Class and Function
 * use the traits the runtime made for them before they existed.
 */
export function newClass(
  rt: Runtime,
  desc: ClassDesc,
  base: AsObject | null,
  scope: Scope,
): AsObject {
  const error = desc.instance.error ?? desc.static.error;
  if (error) {
    throw rt.error("VerifyError", error);
  }

  const abc = desc.abc as Abc;
  const name = abc.names[desc.name] as Multiname;
  const qualified = qualifiedName(name);
  // As MethodEnv::newclass: a class with a base needs one (#1009), and
  // one whose traits are the base's it linked to, which avmplus finds as
  // a type (#1108). Compared by definition, as avmplus compares traits: a
  // class made twice is one class. Where the base is the class its name
  // finds by name, but not the one it finds as a type, as for a child's
  // class it found by name after its parent defined the name too,
  // avmshell rejects the class sooner, as corrupt (#1107). Only a class
  // that exists is compared: the check runs no script.
  if (desc.base && (base === null || base === undefined)) {
    throw rt.error("TypeError", 1009);
  }

  if (rt.children && base) {
    const baseName = abc.names[desc.base] as Multiname;
    const script = rt.findScript(baseName, true);
    const expected = script?.global ? rt.getProperty(script.global, baseName) : undefined;
    if (expected?.$it && expected.$desc !== base.$desc) {
      const byName = rt.findScript(baseName);
      const named = byName?.global ? rt.getProperty(byName.global, baseName) : undefined;
      throw rt.error("VerifyError", named === base ? 1107 : 1108);
    }
  }

  const baseTraits: Traits | null = base ? base.$it : null;
  let itraits: Traits;
  if (qualified === "Object") {
    itraits = rt.objectTraits;
  } else if (qualified === "Class") {
    itraits = rt.classTraits;
  } else if (qualified === "Function") {
    itraits = rt.functionTraits;
  } else {
    itraits = new Traits(qualified, baseTraits);
  }

  itraits.describe(desc.instance);
  const hooks = rt.classHooks[qualified];
  itraits.dynamic = !desc.sealed;
  itraits.final = desc.final;
  itraits.isInterface = desc.interface;
  itraits.ctor = desc.ctor ?? null;
  itraits.metadata = desc.meta ?? null;
  itraits.refusesNames = !!hooks?.refusesNames;
  // As ClassClosure::checkForRestrictedInheritance.
  itraits.restricted = !!hooks?.restricted;
  itraits.uninstantiable =
    !!baseTraits &&
    (baseTraits.uninstantiable || (baseTraits.restricted && baseTraits.abc !== abc));
  itraits.abc = abc;

  // A class's allocation, bound to the runtime; its subclasses inherit it.
  const create = hooks?.create;
  if (create) {
    itraits.create = (traits) => create(traits, rt);
  }

  if (hooks?.properties) {
    itraits.properties = hooks.properties;
  }

  if (hooks?.getIndex) {
    itraits.getIndex = hooks.getIndex;
    itraits.setIndex = hooks.setIndex;
    itraits.hasIndex = hooks.hasIndex;
    itraits.index = hooks.index;
  }

  for (const i of desc.interfaces) {
    const mn = abc.names[i] as Multiname;
    const iface = rt.resolveName(mn);
    if (iface) {
      itraits.interfaces.add(iface.$it);
      for (const t of iface.$it.interfaces) {
        itraits.interfaces.add(t);
      }
    } else {
      // Its script is the one running, and has not made it yet.
      if (!itraits.pendingInterfaces) {
        itraits.pendingInterfaces = [];
      }

      itraits.pendingInterfaces.push(() => rt.resolveName(mn)?.$it ?? null);
    }
  }

  // The class object: Class's instance, with its own statics.
  // Class is dynamic, so its instances are: String.fromCharCode = ... is legal.
  const straits = new Traits(`${qualified}$`, rt.classTraits);
  straits.dynamic = true;
  straits.final = true;
  straits.describe(desc.static);
  const cls = straits.instance();
  cls.$it = itraits;
  cls.$desc = desc;
  cls.$base = base;
  itraits.cls = cls;
  straits.cls = cls;

  // Its prototype object: an Object whose prototype is the base class's.
  // A class object's own $p comes from Class's instance prototype, which
  // it inherits: class objects made before Class see it once Class exists.
  // Date's, RegExp's and Array's are instances of their own class, as avmplus has them.
  const prototype = hooks?.prototype ? hooks.prototype(rt, cls) : rt.objectTraits.instance();
  prototype.$p = base ? base.$prototype : null;
  cls.$prototype = prototype;
  itraits.proto.$p = prototype;
  prototype.$d.set("constructor", cls);
  prototype.$dontEnum = new Set(["constructor"]);

  const iscope = rt.scope(scope, [cls], 0);
  const natives = rt.hasNatives(qualified);
  const statics = natives ? memberNames(desc.static) : null;
  const instance = natives ? memberNames(desc.instance) : null;
  for (const [d, factory, id] of desc.static.methods) {
    const native = statics?.has(d) ? rt.override(`${qualified}.${statics.get(d)}`) : null;
    straits.proto[methodKey(d)] = withId((native ?? factory)(scope, base), id);
  }

  for (const [d, factory, id] of desc.instance.methods) {
    const native = instance?.has(d) ? rt.override(`${qualified}#${instance.get(d)}`) : null;
    itraits.proto[methodKey(d)] = withId((native ?? factory)(iscope, base), id);
  }

  // Playerglobal can declare an accessor whose setter has no ABC body.
  // Install it here so both direct bound calls and dynamic property writes reach it.
  if (hooks?.setOnlySlots) {
    for (const [name, slot] of Object.entries(hooks.setOnlySlots)) {
      const binding = itraits.find(rt.publicName(name));
      if ((binding & 7) === BIND_Set) {
        itraits.proto[methodKey((binding >> 3) + 1)] ??= function (this: AsObject, value: Value) {
          this[slot] = value;
        };
      }
    }
  }

  // Caches keep the methods and what the hooks decide.
  invalidate();
  const init = (natives ? rt.override(`${qualified}()`) : null) ?? desc.init;
  itraits.proto.$init = init(iscope, base);
  // Its static initializer may name the class as a type, as avmplus
  // resolves from traits, before initproperty has stored it anywhere.
  rt.defining.set(qualified, cls);
  try {
    desc.cinit(scope, base).call(cls);
  } finally {
    rt.defining.delete(qualified);
  }

  hooks?.created?.(rt, cls);
  return cls;
}

/** `f`, a method, with its method id, which a closure of it keeps. */
export function withId(f: Method, id: number): Method {
  (f as Method & { $id?: number }).$id = id;
  return f;
}

/**
 * Each method's name by dispatch id, as the compiler names a native:
 * "uri::name", or "name" in a namespace whose URI is empty, with "get:" or
 * "set:" before an accessor's.
 */
function memberNames(desc: TraitsDesc): Map<number, string> {
  const names = new Map<number, string>();
  for (const [ns, , name, b] of desc.bindings) {
    const uri = ns.uri ?? "";
    const q = uri ? `${uri}::${name}` : name;
    const id = b >> 3;
    switch (b & 7) {
      case BIND_Method:
        names.set(id, q);
        break;
      case BIND_Get:
        names.set(id, `get:${q}`);
        break;
      case BIND_Set:
        names.set(id + 1, `set:${q}`);
        break;
      case BIND_GetSet:
        names.set(id, `get:${q}`);
        names.set(id + 1, `set:${q}`);
        break;
    }
  }

  return names;
}
