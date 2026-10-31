// Linking an ABC's classes, as avmplus' AbcParser::parseInstanceInfos: each
// to its base class and interfaces, and the traits of its instances, class
// objects, scripts and activations laid out, their methods bound to them;
// with the first builtin ABC, the classes and types the rules treat
// specially.

import * as C from "../abc/constants";
import { layout } from "./bindings";
import { API_AllVersions, Domain, NS_Public } from "./domain";
import {
  Scope,
  TRAITS_Activation,
  TRAITS_Class,
  TRAITS_Instance,
  TRAITS_Null,
  TRAITS_Script,
  TRAITS_Void,
} from "./traits";

/** Link ABC `index`'s classes to their bases and interfaces; false after recording the error. */
export function link(dom: Domain, index: u32): bool {
  const abc = dom.abcs[index];
  const first = <u32>dom.classAbc.length;
  dom.classStart.push(first);
  for (let i: u32 = 0; i < abc.classCount; i++) {
    dom.classAbc.push(index);
    dom.classInstance.push(i);
    dom.classBase.push(-1);
    dom.classFlags.push(abc.instanceFlags[i]);
    dom.classTraits.push(-1);
    dom.classStatic.push(-1);
  }

  const ids = dom.abcNs[index];

  for (let i: u32 = 0; i < abc.classCount; i++) {
    const id = first + i;
    const flags = abc.instanceFlags[i];
    const baseName = abc.instanceSuper[i];
    if (baseName) {
      const base = dom.resolveType(index, baseName);
      if (base < 0) {
        return abc.fail(-base);
      }

      if (
        dom.classFlags[base] & C.INSTANCE_Final ||
        base === dom.classClass ||
        (base === dom.functionClass && !abc.builtin)
      ) {
        return abc.fail(C.kCannotExtendFinalClass);
      }

      if (dom.classFlags[base] & C.INSTANCE_Interface) {
        return abc.fail(C.kCannotExtendError);
      }

      dom.classBase[id] = base;
    }

    const interfaces = <u32>dom.traits.interfaceList.length;
    const last = abc.instanceInterfaceStart[i + 1];
    for (let j = abc.instanceInterfaceStart[i]; j < last; j++) {
      const t = dom.resolveType(index, abc.interfaces[j]);
      if (t < 0) {
        dom.traits.interfaceList.length = interfaces;
        return abc.fail(-t);
      }

      if (!(dom.classFlags[t] & C.INSTANCE_Interface)) {
        dom.traits.interfaceList.length = interfaces;
        return abc.fail(C.kCannotImplementError);
      }

      dom.traits.interfaceList.push(<u32>dom.classTraits[t]);
    }

    if (flags & C.INSTANCE_Interface && baseName) {
      return abc.fail(C.kCannotExtendError);
    }

    // As avmplus' AvmCore: the first builtin class without a base is Object.
    if (!baseName && abc.builtin && !dom.hasBuiltins && dom.objectClass < 0) {
      dom.objectClass = <i32>id;
    }

    const base = dom.classBase[id];
    const protectedNs = flags & C.INSTANCE_ProtectedNs ? <i32>ids[abc.instanceProtectedNs[i]] : -1;
    const t = dom.traits.create(
      TRAITS_Instance,
      index,
      i,
      base >= 0 ? dom.classTraits[base] : -1,
      protectedNs,
      abc.instanceTraitStart[i],
      abc.instanceTraitStart[i + 1],
    );
    dom.traits.isInterface[t] = flags & C.INSTANCE_Interface ? 1 : 0;
    dom.traits.interfaceStart[t] = interfaces;
    dom.traits.interfaceEnd[t] = dom.traits.interfaceList.length;
    dom.classTraits[id] = t;
    const error = layout(dom.traits, dom, t);
    if (error) {
      return abc.fail(error);
    }

    bindMethods(dom, t, abc.instanceInit[i], (flags & C.INSTANCE_Final) !== 0);

    dom.nameInstance(index, i);
  }

  if (abc.builtin) {
    const floatType = dom.builtinType("float");
    if (floatType >= 0) {
      dom.floatType = floatType;
    }
  }

  // As AvmCore's first builtin pool: its classes include the special ones.
  if (abc.builtin && !dom.hasBuiltins) {
    dom.hasBuiltins = true;
    dom.classClass = dom.findBuiltin("Class");
    dom.functionClass = dom.findBuiltin("Function");
    dom.voidClass = <i32>dom.classAbc.length;
    dom.classAbc.push(index);
    dom.classInstance.push(0xffffffff);
    dom.classBase.push(-1);
    dom.classFlags.push(C.INSTANCE_Final);
    dom.voidType = <i32>dom.traits.create(TRAITS_Void, index, 0, -1, -1, 0, 0);
    dom.nullType = <i32>dom.traits.create(TRAITS_Null, index, 0, -1, -1, 0, 0);
    dom.classTraits.push(dom.voidType);
    dom.classStatic.push(-1);
    findBuiltinTypes(dom);
    const empty = dom.internNamespace(NS_Public, dom.internText(""));
    dom.nameType(empty, dom.internText("void"), API_AllVersions, dom.voidClass, -1, 0);
    dom.transientName = dom.internText("Transient");
    dom.versionName = dom.internText("Version");
    dom.nativeName = dom.internText("native");
    dom.apiName = dom.internText("API");
  }

  return layoutStatics(dom, index) && layoutScripts(dom, index) && layoutActivations(dom, index);
}

/** Lay out each class object's traits, whose base is Class. */
function layoutStatics(dom: Domain, index: u32): bool {
  const abc = dom.abcs[index];
  const first = dom.classStart[index];
  const classTraits = dom.classClass >= 0 ? dom.classTraits[dom.classClass] : -1;
  for (let i: u32 = 0; i < abc.classCount; i++) {
    const t = dom.traits.create(
      TRAITS_Class,
      index,
      i,
      classTraits,
      dom.traits.protectedNs[dom.classTraits[first + i]],
      abc.classTraitStart[i],
      abc.classTraitStart[i + 1],
    );
    dom.classStatic[first + i] = t;
    const error = layout(dom.traits, dom, t);
    if (error) {
      return abc.fail(error);
    }

    bindMethods(dom, t, abc.classInit[i], false);
  }

  return true;
}

/** Lay out each script's global object traits, whose base is Object. */
function layoutScripts(dom: Domain, index: u32): bool {
  const abc = dom.abcs[index];
  const objectTraits = dom.objectClass >= 0 ? dom.classTraits[dom.objectClass] : -1;
  const scripts = new StaticArray<u32>(abc.scriptCount);
  dom.scriptTraits.push(scripts);
  for (let s: u32 = 0; s < abc.scriptCount; s++) {
    const t = dom.traits.create(
      TRAITS_Script,
      index,
      s,
      objectTraits,
      -1,
      abc.scriptTraitStart[s],
      abc.scriptTraitStart[s + 1],
    );
    scripts[s] = t;
    dom.traits.scope[t] = new Scope();
    const error = layout(dom.traits, dom, t);
    if (error) {
      return abc.fail(error);
    }

    bindMethods(dom, t, abc.scriptInit[s], false);
  }

  return true;
}

/** Lay out activation traits, for bodies that need an activation or declare traits. */
function layoutActivations(dom: Domain, index: u32): bool {
  const abc = dom.abcs[index];
  const bodies = new StaticArray<i32>(abc.bodyCount);
  for (let b: u32 = 0; b < abc.bodyCount; b++) {
    const first = abc.bodyTraitStart[b];
    const end = abc.bodyTraitStart[b + 1];
    const flags = abc.methodFlags[abc.bodyMethod[b]];
    bodies[b] = -1;
    if (flags & C.METHOD_NeedActivation || end > first) {
      const t = dom.traits.create(TRAITS_Activation, index, b, -1, -1, first, end);
      bodies[b] = t;
      const error = layout(dom.traits, dom, t);
      if (error) {
        return abc.fail(error);
      }

      bindMethods(dom, t, -1, false);
    }
  }

  dom.bodyTraits.push(bodies);
  return true;
}

/**
 * As MethodInfo::makeMethodOf, after t's members bind: its methods,
 * getters, setters and `init` (-1 for none) become t's; `final` for a
 * final class, whose methods are all final.
 */
function bindMethods(dom: Domain, t: u32, init: i32, final: bool): void {
  const traits = dom.traits;
  const index = traits.abc[t];
  const abc = dom.abcs[index];
  const methods = dom.methodStart[index];
  for (let i = traits.first[t]; i < traits.end[t]; i++) {
    const tag = abc.traitTag[i];
    const kind = tag & 0x0f;
    if (kind === C.TRAIT_Method || kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
      const m = methods + abc.traitIndex[i];
      traits.methodTraits[m] = t;
      traits.methodVirtual[m] = 1;
      traits.methodFinal[m] = tag & C.ATTR_Final || final ? 1 : 0;
    }
  }

  if (init >= 0) {
    traits.methodTraits[methods + init] = t;
    traits.init[t] = methods + init;
  }
}

/** The types AvmCore's builtin traits hold, from the first builtin ABC. */
function findBuiltinTypes(dom: Domain): void {
  dom.numberType = dom.builtinType("Number");
  dom.intType = dom.builtinType("int");
  dom.uintType = dom.builtinType("uint");
  dom.booleanType = dom.builtinType("Boolean");
  dom.stringType = dom.builtinType("String");
  dom.namespaceType = dom.builtinType("Namespace");
  dom.xmlType = dom.builtinType("XML");
  dom.xmlListType = dom.builtinType("XMLList");
  dom.qnameType = dom.builtinType("QName");
  dom.classType = dom.builtinType("Class");
  dom.vectorClass = dom.findBuiltin("Vector");
  dom.vectorObjectType = dom.builtinType("Vector$object");
  dom.vectorIntType = dom.builtinType("Vector$int");
  dom.vectorUintType = dom.builtinType("Vector$uint");
  dom.vectorDoubleType = dom.builtinType("Vector$double");
  dom.arrayType = dom.builtinType("Array");
  dom.functionType = dom.builtinType("Function");
  const math = dom.findBuiltin("Math");
  dom.mathStatic = math < 0 ? -1 : dom.classStatic[math];
  dom.builtinAbc = <i32>(dom.abcs.length - 1);
}
