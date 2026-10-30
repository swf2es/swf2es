// Classes as OP_newclass makes them: a class object and its instances'
// traits from the module's descriptor, with its hooks, its prototype
// object and its methods bound to the scope chain it is made in; and the
// Vector.<T> classes applying Vector to a type makes.

import type { Abc, AsObject, ClassDesc, Method, Scope, Value } from "./descriptors.js";
import { firstDefinition } from "./domain.js";
import { installMethod } from "./method-factories.js";
import { formatClassName, type Multiname, NS_Public, qualifiedName } from "./names.js";
import { invalidate } from "./property-cache.js";
import type { Runtime } from "./runtime.js";
import { BIND_Set, methodKey, Traits, VALUE_TESTS } from "./traits.js";

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

  // A builtin or a player's class, whose hook and type tests are its own,
  // is the first definition of its name, as avmplus' natives belong to
  // their ABC; a top-level one is public. A class only named as one, as a
  // file's own internal Boolean is, is a class like any other.
  const ns = name.namespaces[0];
  const own =
    (ns?.kind === NS_Public || !!ns?.uri) &&
    firstDefinition(name.domain ?? rt.root, name)?.abc === abc;
  const baseTraits: Traits | null = base ? base.$it : null;
  let itraits: Traits;
  if (own && qualified === "Object") {
    itraits = rt.objectTraits;
  } else if (own && qualified === "Class") {
    itraits = rt.classTraits;
  } else if (own && qualified === "Function") {
    itraits = rt.functionTraits;
  } else {
    itraits = new Traits(qualified, baseTraits);
    itraits.testsValues = own && VALUE_TESTS.has(qualified);
  }

  itraits.describe(desc.instance);
  const hooks = own ? rt.classHooks[qualified] : undefined;
  itraits.hooks = hooks ?? null;
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
  for (const [d, factory, id, , params] of desc.static.methods) {
    installMethod(rt, straits.proto, d, withId(factory(scope, base), id), factory, params);
  }

  for (const [d, factory, id, , params] of desc.instance.methods) {
    installMethod(rt, itraits.proto, d, withId(factory(iscope, base), id), factory, params);
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
  itraits.proto.$init = desc.init(iscope, base);
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

/**
 * Vector.<T> for a T other than int, uint and Number: Vector$object's
 * class, typed, whose name names T as avmplus does, a builtin Vector as
 * Vector.<int>, and whose superclass is Vector.<*>, Vector$object.
 */
export function specializeVector(rt: Runtime, base: AsObject, param: AsObject): AsObject {
  const itraits = new Traits(`__AS3__.vec::Vector.<${formatClassName(param.$it.name)}>`, base.$it);
  itraits.dynamic = base.$it.dynamic;
  itraits.refusesNames = base.$it.refusesNames;
  itraits.hooks = base.$it.hooks;
  const cls = Object.create(Object.getPrototypeOf(base));
  cls.$d = null;
  cls.$it = itraits;
  cls.$desc = base.$desc;
  cls.$base = base;
  cls.$prototype = base.$prototype;
  cls.$param = rt.refOf(param);
  itraits.cls = cls;
  return cls;
}

/** `f`, a method, with its method id, which a closure of it keeps. */
export function withId(f: Method, id: number): Method {
  (f as Method & { $id?: number }).$id = id;
  return f;
}
