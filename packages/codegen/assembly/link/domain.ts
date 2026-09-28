// A domain: the ABCs loaded together, the names their scripts define, and
// their classes, linked to their base classes and interfaces. Strings and
// namespaces are interned across ABCs, so a name is a pair of ids however
// many ABCs spell it.
//
// Classes link as in avmplus' AbcParser::parseInstanceInfos: while an ABC
// loads, a type name resolves to a class some earlier ABC's script defines,
// or else to an earlier class of the same ABC. Once the ABC has linked, the
// classes its scripts define become visible to later ABCs.
//
// Namespaces follow avmplus' AbcParser: two are the same if their kind and
// URI are; a private namespace is only ever equal to itself. A URI may end
// in an API version mark (U+E294 + version), which builtin ABCs use to say
// which player version introduced a name. The mark is stripped from the URI
// and kept as the namespace's version. Versions come in two interleaved
// series, Flash Player's and AIR's; a binding gets the earliest version of
// its namespaces in the domain's series, where AIR-only versions are
// VM-internal. It is visible to a lookup whose namespace has an equal or
// later version. User ABCs' public namespaces get the domain's version, so
// they cannot see VM-internal names.
import { Abc } from "../abc/abc";
import * as C from "../abc/constants";
import { readAbc } from "../abc/parse";
import { hashBytes, hashPair, IdTable } from "./table";
import {
  BIND_None,
  BKIND_Var,
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Int,
  BUILTIN_Namespace,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_Other,
  BUILTIN_String,
  BUILTIN_Uint,
  BUILTIN_Void,
  isDefaultKind,
  legalDefault,
  Scope,
  TRAITS_Activation,
  TRAITS_Catch,
  TRAITS_Class,
  TRAITS_Instance,
  TRAITS_Null,
  TRAITS_Script,
  TRAITS_Void,
  TraitsTable,
  TYPE_Any,
} from "./traits";
import { getOwnBinding } from "./types";

export const NS_Public: u8 = 0;
export const NS_PackageInternal: u8 = 1;
export const NS_Protected: u8 = 2;
export const NS_Explicit: u8 = 3;
export const NS_StaticProtected: u8 = 4;
export const NS_Private: u8 = 5;

/** avmplus' ApiVersion values that swf2es needs; see core/api-versions.h. */
export const API_AllVersions: u8 = 0;
export const API_FP_10_0: u8 = 2;
/** kApiVersionLatest for Flash Player (SWF_31), avmshell's default. */
export const API_LatestFP: u8 = 50;
export const API_Internal: u8 = 52;
const API_Count: u32 = 53;
const API_MinMark: u32 = 0xe294;

/** The URI of a namespace written with string index 0. */
export const URI_None: u32 = 0xffffffff;

@final
export class Domain {
  /** The version of user ABCs' public namespaces. */
  apiVersion: u8 = API_LatestFP;
  /** Whether the domain runs AIR's series of API versions rather than Flash Player's. */
  air: bool = false;

  abcs: Abc[] = [];
  /** Where each ABC's bytes start. */
  abcBase: usize[] = [];
  /**
   * The bytes of every ABC ever added, followed by PADDING, including those
   * rejected while linking: interned strings may point into any of them.
   */
  buffers: StaticArray<u8>[] = [];
  /** Per ABC, the interned id of each pool string, and of each namespace and its version. */
  abcString: StaticArray<u32>[] = [];
  abcNs: StaticArray<u32>[] = [];
  abcNsVersion: StaticArray<u8>[] = [];

  stringPtr: usize[] = [];
  stringLength: u32[] = [];
  strings: IdTable = new IdTable();
  /** URIs a builtin ABC marks with a version: their unmarked public names are VM-internal. */
  versioned: u8[] = [];

  nsType: u8[] = [];
  nsUri: u32[] = [];
  namespaces: IdTable = new IdTable();

  // Script traits by name, in load order; the first visible one wins.
  bindingNs: u32[] = [];
  bindingName: u32[] = [];
  bindingVersion: u8[] = [];
  bindingAbc: u32[] = [];
  bindingScript: u32[] = [];
  /** Index of the trait in its ABC's trait tables. */
  bindingTrait: u32[] = [];
  bindings: IdTable = new IdTable();

  // Classes by domain-wide id; ABC a's instance i is classStart[a] + i.
  classStart: u32[] = [];
  classAbc: u32[] = [];
  classInstance: u32[] = [];
  /** The base class's id, or -1. */
  classBase: i32[] = [];
  classFlags: u8[] = [];
  /** The traits of the class's instances, and of the class object; -1 for void. */
  classTraits: i32[] = [];
  classStatic: i32[] = [];

  traits: TraitsTable = new TraitsTable();
  /** Each ABC's first method id; the ABC of each method id. */
  methodStart: u32[] = [];
  methodAbcIndex: u32[] = [];
  /** The error of the last resolveTypeId that failed. */
  typeError: i32 = 0;
  /** Per ABC, each script's traits, and each body's activation traits or -1. */
  scriptTraits: StaticArray<u32>[] = [];
  bodyTraits: StaticArray<i32>[] = [];

  /**
   * Class names. Those a script defines are visible to every ABC (owner -1);
   * while an ABC links, its own classes are visible to it by instance name
   * (owner: its load number, which a rejected ABC never gives to another).
   */
  typeNs: u32[] = [];
  typeName: u32[] = [];
  typeVersion: u8[] = [];
  typeClass: u32[] = [];
  typeOwner: i32[] = [];
  types: IdTable = new IdTable();
  loads: i32 = 0;
  /** Each ABC's load number, the owner of its own class names. */
  abcOwner: i32[] = [];
  /** Strings interned from text rather than an ABC, kept for their bytes. */
  texts: ArrayBuffer[] = [];

  // The builtin classes linking treats specially, found when the first
  // builtin ABC links; -1 if it has none.
  hasBuiltins: bool = false;
  objectClass: i32 = -1;
  classClass: i32 = -1;
  functionClass: i32 = -1;
  /** avmplus registers void as a class, which nothing may extend. */
  voidClass: i32 = -1;
  // Builtin types by traits id, for the rules that treat them specially.
  voidType: i32 = -1;
  nullType: i32 = -1;
  numberType: i32 = -1;
  intType: i32 = -1;
  uintType: i32 = -1;
  booleanType: i32 = -1;
  stringType: i32 = -1;
  namespaceType: i32 = -1;
  vectorClass: i32 = -1;
  vectorObjectType: i32 = -1;
  vectorIntType: i32 = -1;
  vectorUintType: i32 = -1;
  vectorDoubleType: i32 = -1;
  arrayType: i32 = -1;
  functionType: i32 = -1;
  /** The traits of the Math class object, whose methods have faster variants. */
  mathStatic: i32 = -1;
  /** The builtin ABC whose global's Math and Number slots are never null. */
  builtinAbc: i32 = -1;
  /** Catch scope traits, by the ABC's handler index. */
  catchScopes: Map<u64, i32> = new Map<u64, i32>();
  /** Vector.<T> for other element types T, by T. */
  vectorOf: Map<i32, i32> = new Map<i32, i32>();

  /**
   * Parse and add the ABC in `buffer`, whose first `length` bytes are the ABC
   * and the rest PADDING. Returns the ABC; check its `error`.
   */
  add(buffer: StaticArray<u8>, length: u32, builtin: bool): Abc {
    const base = changetype<usize>(buffer);
    const abc = readAbc(base, length, builtin);
    if (abc.error) {
      return abc;
    }

    const index = <u32>this.abcs.length;
    this.abcs.push(abc);
    this.abcBase.push(base);
    this.buffers.push(buffer);
    this.loads++;
    this.abcOwner.push(this.loads);
    const methodCount = <u32>this.traits.methodTraits.length;
    this.methodStart.push(methodCount);
    this.traits.addMethods(abc.methodCount);
    for (let m: u32 = 0; m < abc.methodCount; m++) {
      this.methodAbcIndex.push(index);
    }

    const pool = abc.pool;
    const strings = new StaticArray<u32>(pool.stringCount);
    for (let i: u32 = 1; i < pool.stringCount; i++) {
      const ptr = base + pool.stringStart[i];
      strings[i] = this.internString(ptr, pool.stringLength[i]);
    }

    this.abcString.push(strings);
    this.addNamespaces(abc, base, strings);
    const traitsCount = <u32>this.traits.kind.length;
    if (!this.link(index)) {
      this.abcs.pop();
      this.abcBase.pop();
      this.abcString.pop();
      this.abcNs.pop();
      this.abcNsVersion.pop();
      this.classStart.pop();
      this.scriptTraits.length = index;
      this.bodyTraits.length = index;
      this.abcOwner.length = index;
      this.methodStart.length = index;
      this.methodAbcIndex.length = methodCount;
      this.traits.truncate(traitsCount);
      this.traits.truncateMethods(methodCount);
      return abc;
    }

    this.addClassNames(index);
    this.addBindings(index);
    return abc;
  }

  /** Link ABC `index`'s classes to their bases and interfaces; false after recording the error. */
  link(index: u32): bool {
    const abc = this.abcs[index];
    const first = <u32>this.classAbc.length;
    this.classStart.push(first);
    for (let i: u32 = 0; i < abc.classCount; i++) {
      this.classAbc.push(index);
      this.classInstance.push(i);
      this.classBase.push(-1);
      this.classFlags.push(abc.instanceFlags[i]);
      this.classTraits.push(-1);
      this.classStatic.push(-1);
    }

    const ids = this.abcNs[index];

    for (let i: u32 = 0; i < abc.classCount; i++) {
      const id = first + i;
      const flags = abc.instanceFlags[i];
      const baseName = abc.instanceSuper[i];
      if (baseName) {
        const base = this.resolveType(index, baseName);
        if (base < 0) {
          return abc.fail(-base);
        }

        if (
          this.classFlags[base] & C.INSTANCE_Final ||
          base === this.classClass ||
          (base === this.functionClass && !abc.builtin)
        ) {
          return abc.fail(C.kCannotExtendFinalClass);
        }

        if (this.classFlags[base] & C.INSTANCE_Interface) {
          return abc.fail(C.kCannotExtendError);
        }

        this.classBase[id] = base;
      }

      const interfaces = <u32>this.traits.interfaceList.length;
      const last = abc.instanceInterfaceStart[i + 1];
      for (let j = abc.instanceInterfaceStart[i]; j < last; j++) {
        const t = this.resolveType(index, abc.interfaces[j]);
        if (t < 0) {
          this.traits.interfaceList.length = interfaces;
          return abc.fail(-t);
        }

        if (!(this.classFlags[t] & C.INSTANCE_Interface)) {
          this.traits.interfaceList.length = interfaces;
          return abc.fail(C.kCannotImplementError);
        }

        this.traits.interfaceList.push(<u32>this.classTraits[t]);
      }

      if (flags & C.INSTANCE_Interface && baseName) {
        return abc.fail(C.kCannotExtendError);
      }

      // As avmplus' AvmCore: the first builtin class without a base is Object.
      if (!baseName && abc.builtin && !this.hasBuiltins && this.objectClass < 0) {
        this.objectClass = <i32>id;
      }

      const base = this.classBase[id];
      const protectedNs =
        flags & C.INSTANCE_ProtectedNs ? <i32>ids[abc.instanceProtectedNs[i]] : -1;
      const t = this.traits.create(
        TRAITS_Instance,
        index,
        i,
        base >= 0 ? this.classTraits[base] : -1,
        protectedNs,
        abc.instanceTraitStart[i],
        abc.instanceTraitStart[i + 1],
      );
      this.traits.isInterface[t] = flags & C.INSTANCE_Interface ? 1 : 0;
      this.traits.interfaceStart[t] = interfaces;
      this.traits.interfaceEnd[t] = this.traits.interfaceList.length;
      this.classTraits[id] = t;
      const error = this.traits.layout(this, t);
      if (error) {
        return abc.fail(error);
      }

      this.bindMethods(t, abc.instanceInit[i], (flags & C.INSTANCE_Final) !== 0);

      this.nameInstance(index, i);
    }

    // As AvmCore's first builtin pool: its classes include the special ones.
    if (abc.builtin && !this.hasBuiltins) {
      this.hasBuiltins = true;
      this.classClass = this.findBuiltin("Class");
      this.functionClass = this.findBuiltin("Function");
      this.voidClass = <i32>this.classAbc.length;
      this.classAbc.push(index);
      this.classInstance.push(0xffffffff);
      this.classBase.push(-1);
      this.classFlags.push(C.INSTANCE_Final);
      this.voidType = <i32>this.traits.create(TRAITS_Void, index, 0, -1, -1, 0, 0);
      this.nullType = <i32>this.traits.create(TRAITS_Null, index, 0, -1, -1, 0, 0);
      this.classTraits.push(this.voidType);
      this.classStatic.push(-1);
      this.findBuiltinTypes();
      const empty = this.internNamespace(NS_Public, this.internText(""));
      this.nameType(empty, this.internText("void"), API_AllVersions, this.voidClass, -1);
    }

    return this.layoutStatics(index) && this.layoutScripts(index) && this.layoutActivations(index);
  }

  /** Lay out each class object's traits, whose base is Class. */
  layoutStatics(index: u32): bool {
    const abc = this.abcs[index];
    const first = this.classStart[index];
    const classTraits = this.classClass >= 0 ? this.classTraits[this.classClass] : -1;
    for (let i: u32 = 0; i < abc.classCount; i++) {
      const t = this.traits.create(
        TRAITS_Class,
        index,
        i,
        classTraits,
        this.traits.protectedNs[this.classTraits[first + i]],
        abc.classTraitStart[i],
        abc.classTraitStart[i + 1],
      );
      this.classStatic[first + i] = t;
      const error = this.traits.layout(this, t);
      if (error) {
        return abc.fail(error);
      }

      this.bindMethods(t, abc.classInit[i], false);
    }

    return true;
  }

  /** Lay out each script's global object traits, whose base is Object. */
  layoutScripts(index: u32): bool {
    const abc = this.abcs[index];
    const objectTraits = this.objectClass >= 0 ? this.classTraits[this.objectClass] : -1;
    const scripts = new StaticArray<u32>(abc.scriptCount);
    this.scriptTraits.push(scripts);
    for (let s: u32 = 0; s < abc.scriptCount; s++) {
      const t = this.traits.create(
        TRAITS_Script,
        index,
        s,
        objectTraits,
        -1,
        abc.scriptTraitStart[s],
        abc.scriptTraitStart[s + 1],
      );
      scripts[s] = t;
      this.traits.scope[t] = new Scope();
      const error = this.traits.layout(this, t);
      if (error) {
        return abc.fail(error);
      }

      this.bindMethods(t, abc.scriptInit[s], false);
    }

    return true;
  }

  /** Lay out activation traits, for bodies that need an activation or declare traits. */
  layoutActivations(index: u32): bool {
    const abc = this.abcs[index];
    const bodies = new StaticArray<i32>(abc.bodyCount);
    for (let b: u32 = 0; b < abc.bodyCount; b++) {
      const first = abc.bodyTraitStart[b];
      const end = abc.bodyTraitStart[b + 1];
      const flags = abc.methodFlags[abc.bodyMethod[b]];
      bodies[b] = -1;
      if (flags & C.METHOD_NeedActivation || end > first) {
        const t = this.traits.create(TRAITS_Activation, index, b, -1, -1, first, end);
        bodies[b] = t;
        const error = this.traits.layout(this, t);
        if (error) {
          return abc.fail(error);
        }

        this.bindMethods(t, -1, false);
      }
    }

    this.bodyTraits.push(bodies);
    return true;
  }

  /**
   * As MethodInfo::makeMethodOf, after t's members bind: its methods,
   * getters, setters and `init` (-1 for none) become t's; `final` for a
   * final class, whose methods are all final.
   */
  bindMethods(t: u32, init: i32, final: bool): void {
    const traits = this.traits;
    const index = traits.abc[t];
    const abc = this.abcs[index];
    const methods = this.methodStart[index];
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
  findBuiltinTypes(): void {
    this.numberType = this.builtinType("Number");
    this.intType = this.builtinType("int");
    this.uintType = this.builtinType("uint");
    this.booleanType = this.builtinType("Boolean");
    this.stringType = this.builtinType("String");
    this.namespaceType = this.builtinType("Namespace");
    this.vectorClass = this.findBuiltin("Vector");
    this.vectorObjectType = this.builtinType("Vector$object");
    this.vectorIntType = this.builtinType("Vector$int");
    this.vectorUintType = this.builtinType("Vector$uint");
    this.vectorDoubleType = this.builtinType("Vector$double");
    this.arrayType = this.builtinType("Array");
    this.functionType = this.builtinType("Function");
    const math = this.findBuiltin("Math");
    this.mathStatic = math < 0 ? -1 : this.classStatic[math];
    this.builtinAbc = <i32>(this.abcs.length - 1);
  }

  /** Whether the machine type always holds a value: int, uint, Number and Boolean. */
  typeNotNull(type: i32): bool {
    const bt = this.builtin(type);
    return (
      bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Number || bt === BUILTIN_Boolean
    );
  }

  /** The traits of Class's instances, which class objects are. */
  classInstanceType(): i32 {
    return this.classClass < 0 ? TYPE_Any : this.classTraits[this.classClass];
  }

  /** The class object traits of class `i` of ABC `index`. */
  staticTraitsOf(index: u32, i: u32): i32 {
    return this.classStatic[this.classStart[index] + i];
  }

  /** As Traits::itraits: for a class object's traits, its instances'; else *. */
  instanceTraitsOf(type: i32): i32 {
    const traits = this.traits;
    if (type < 0 || traits.kind[type] !== TRAITS_Class) {
      return TYPE_Any;
    }

    return this.classTraits[this.classStart[traits.abc[type]] + traits.owner[type]];
  }

  /**
   * As Verifier::checkTypeName: the type multiname `mn` of ABC `index` names,
   * void included, and Vector.<T>, or * for another parameterized type;
   * below TYPE_Any on failure, with typeError set.
   */
  checkTypeName(index: u32, mn: u32): i32 {
    const pool = this.abcs[index].pool;
    const isTypeName = pool.mnKind[mn] === C.CONSTANT_TypeName;
    const c = this.resolveType(index, isTypeName ? pool.mnA[mn] : mn);
    if (c < 0 && c !== -C.kIllegalVoidError) {
      this.typeError = -c;
      return -2;
    }

    const type = c < 0 ? this.voidType : this.classTraits[c];
    if (!isTypeName) {
      return type;
    }

    const paramName = pool.mnB[mn];
    const param = paramName ? this.checkTypeName(index, paramName) : TYPE_Any;
    if (param < TYPE_Any) {
      return param;
    }

    const t = c >= 0 ? this.parameterized(c, param) : -1;
    return t < 0 ? TYPE_Any : t;
  }

  /**
   * Whether method m takes any number of extra arguments: into a rest or
   * arguments array, or as a function avmplus lets ignore them (see
   * TraitsTable.sign).
   */
  allowsExtraArgs(m: u32): bool {
    const index = this.methodAbc(m);
    const abc = this.abcs[index];
    const local = m - this.methodStart[index];
    const flags = abc.methodFlags[local];
    if (flags & (C.METHOD_NeedRest | C.METHOD_NeedArguments)) {
      return true;
    }

    return this.traits.ignoresRest[m] !== 0;
  }

  /** Add to `out` the methods bound to traits t: its initializer, methods, getters and setters. */
  methodsOf(t: u32, out: u32[]): void {
    const traits = this.traits;
    const index = traits.abc[t];
    const abc = this.abcs[index];
    const methods = this.methodStart[index];
    const init = traits.init[t];
    if (init >= 0) {
      out.push(<u32>init);
    }

    for (let i = traits.first[t]; i < traits.end[t]; i++) {
      const kind = abc.traitTag[i] & 0x0f;
      if (kind === C.TRAIT_Method || kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
        out.push(methods + abc.traitIndex[i]);
      }
    }
  }

  /** Whether method m is a method, getter or setter of some traits, which callstatic may call. */
  isVirtual(m: u32): bool {
    return this.traits.methodVirtual[m] !== 0;
  }

  /**
   * As DomainMgr::findScriptInPoolByMultiname: the global object traits of
   * the one script that defines multiname `mn` of ABC `index`, or -1 for
   * none or several.
   */
  findScript(index: u32, mn: u32): i32 {
    const pool = this.abcs[index].pool;
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    const ids = this.abcNs[index];
    const versions = this.abcNsVersion[index];
    const name = this.abcString[index][pool.mnB[mn]];
    if (pool.mnKind[mn] === C.CONSTANT_Qname) {
      const ns = pool.mnA[mn];
      return this.scriptOf(this.find(ids[ns], name, versions[ns]));
    }

    const set = pool.mnA[mn];
    let found = -1;
    for (let m = pool.nsSetStart[set]; m < pool.nsSetStart[set + 1]; m++) {
      const ns = pool.nsSetMembers[m];
      const script = this.scriptOf(this.find(ids[ns], name, versions[ns]));
      if (script >= 0) {
        if (found >= 0 && found !== script) {
          return -1;
        }

        found = script;
      }
    }

    return found;
  }

  /** The global object traits of the script binding b is in, or -1. */
  scriptOf(b: i32): i32 {
    if (b < 0) {
      return -1;
    }

    const index = this.bindingAbc[b];
    return <i32>this.scriptTraits[index][this.bindingScript[b]];
  }

  /** The interned id of multiname `mn`'s name with a leading underscore, or -1 if no ABC has it. */
  underscored(index: u32, mn: u32): i32 {
    const name = this.nameOf(index, mn);
    const text = String.UTF8.decodeUnsafe(this.stringPtr[name], this.stringLength[name]);
    return this.findText(`_${text}`);
  }

  /** Whether multiname `mn` of ABC `index` is named Math or Number. */
  isMathOrNumber(index: u32, mn: u32): bool {
    const pool = this.abcs[index].pool;
    const name = this.abcString[index][pool.mnB[mn]];
    return name === <u32>this.findText("Math") || name === <u32>this.findText("Number");
  }

  /** As Multiname::containsAnyPublicNamespace, for a multiname with a namespace set. */
  hasPublicNamespace(index: u32, mn: u32): bool {
    const pool = this.abcs[index].pool;
    const kind = pool.mnKind[mn];
    if (
      kind !== C.CONSTANT_Multiname &&
      kind !== C.CONSTANT_MultinameL &&
      kind !== C.CONSTANT_MultinameLA
    ) {
      return false;
    }

    const set = pool.mnA[mn];
    for (let m = pool.nsSetStart[set]; m < pool.nsSetStart[set + 1]; m++) {
      // As Namespace::isPublic: of the public kind, and with an empty URI.
      const ns = this.abcNs[index][pool.nsSetMembers[m]];
      const uri = this.nsUri[ns];
      if (this.nsType[ns] === NS_Public && (uri === URI_None || this.stringLength[uri] === 0)) {
        return true;
      }
    }

    return false;
  }

  /**
   * As TraitsBindings::findBindingAndDeclarer: the initializer of the traits
   * that declares what multiname `mn` of ABC `index` binds to on `type`, a
   * protected member belonging to the first base that has it; -1 if none.
   */
  initOfDeclarer(type: i32, index: u32, mn: u32): i32 {
    const traits = this.traits;
    for (let t = type; t >= 0; t = traits.base[t]) {
      const b = getOwnBinding(this, index, <u32>t, mn);
      if (b === BIND_None) {
        continue;
      }

      let declarer = t;
      let ns = this.foundNs;
      while (ns === traits.protectedNs[declarer]) {
        const parent = traits.base[declarer];
        if (parent < 0 || traits.protectedNs[parent] < 0) {
          break;
        }

        const parentNs = <u32>traits.protectedNs[parent];
        const name = this.nameOf(index, mn);
        if (traits.find(parent, parentNs, name, API_Internal) !== b) {
          break;
        }

        declarer = parent;
        ns = <i32>parentNs;
      }

      return traits.init[declarer];
    }

    return -1;
  }

  /** The interned name of multiname `mn` of ABC `index`. */
  nameOf(index: u32, mn: u32): u32 {
    const pool = this.abcs[index].pool;
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    return this.abcString[index][pool.mnB[mn]];
  }

  /** The namespace the last getOwnBinding found its binding in. */
  foundNs: i32 = -1;

  /**
   * As Verifier::emitCallpropertySlot: what calling a class slot of type
   * `slotType` with one argument does to it: the builtin conversions give
   * int, uint, Number, Boolean or String, a user class coerces to it, and
   * anything else is a call (-2).
   */
  conversionOf(slotType: i32): i32 {
    if (slotType < 0) {
      return -2;
    }

    for (let k = 0; k < 5; k++) {
      const type =
        k === 0
          ? this.intType
          : k === 1
            ? this.uintType
            : k === 2
              ? this.numberType
              : k === 3
                ? this.booleanType
                : this.stringType;
      if (type >= 0 && slotType === this.staticOf(type)) {
        return type;
      }
    }

    const traits = this.traits;
    if (
      traits.kind[slotType] === TRAITS_Class &&
      traits.base[slotType] === this.classInstanceType() &&
      !this.abcs[traits.abc[slotType]].builtin
    ) {
      return this.instanceTraitsOf(slotType);
    }

    return -2;
  }

  /** Whether calling class slot `slotType` converts to a builtin primitive, never null. */
  isConversion(slotType: i32): bool {
    const converted = this.conversionOf(slotType);
    return (
      converted >= 0 &&
      (converted === this.intType ||
        converted === this.uintType ||
        converted === this.numberType ||
        converted === this.booleanType ||
        converted === this.stringType)
    );
  }

  /** The class object traits of instance traits `type`. */
  staticOf(type: i32): i32 {
    const traits = this.traits;
    const index = traits.abc[type];
    return this.classStatic[this.classStart[index] + traits.owner[type]];
  }

  /**
   * The catch scope of handler `h` of ABC `index`, as Traits::newCatchTraits:
   * one slot, named `name`, of the handler's exception type.
   */
  catchTraits(index: u32, h: u32, name: u32, type: i32): i32 {
    const key = ((<u64>index) << 32) | h;
    if (this.catchScopes.has(key)) {
      return this.catchScopes.get(key);
    }

    const pool = this.abcs[index].pool;
    let mn = name;
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    const traits = this.traits;
    const t = traits.create(TRAITS_Catch, index, h, -1, -1, 0, 0);
    const start = <u32>traits.memberTraits.length;
    traits.memberStart[t] = start;
    traits.memberEnd[t] = start;
    let ns = pool.mnA[mn];
    if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
      ns = pool.nsSetMembers[pool.nsSetStart[ns]];
    }

    const nsId = this.abcNs[index][ns];
    const version = this.activeVersion(this.abcNsVersion[index][ns]);
    traits.add(t, nsId, this.nameOf(index, name), version, BKIND_Var);
    traits.slotCount[t] = 1;
    traits.slotStart[t] = traits.slotType.length;
    traits.slotType.push(type);
    traits.slotSet.push(1);
    traits.dispatchStart[t] = traits.dispatch.length;
    traits.resolved[t] = 1;
    this.catchScopes.set(key, <i32>t);
    return <i32>t;
  }

  builtinType(name: string): i32 {
    const c = this.findBuiltin(name);
    return c < 0 ? -1 : this.classTraits[c];
  }

  /**
   * As DomainMgr::findBuiltinTraitsByName: the first class of the ABC being
   * linked named `name` in any namespace, or -1.
   */
  findBuiltin(name: string): i32 {
    const text = this.findText(name);
    for (let id = 0; text >= 0 && id < this.typeName.length; id++) {
      if (this.typeName[id] === <u32>text && this.typeOwner[id] === this.loads) {
        return <i32>this.typeClass[id];
      }
    }

    return -1;
  }

  objectType(): i32 {
    return this.objectClass < 0 ? TYPE_Any : this.classTraits[this.objectClass];
  }

  /** As Traits::getBuiltinType. */
  builtin(type: i32): u8 {
    if (type === TYPE_Any) {
      return BUILTIN_Any;
    }

    if (type === this.objectType()) {
      return BUILTIN_Object;
    }

    if (type === this.voidType) {
      return BUILTIN_Void;
    }

    if (type === this.booleanType) {
      return BUILTIN_Boolean;
    }

    if (type === this.intType) {
      return BUILTIN_Int;
    }

    if (type === this.uintType) {
      return BUILTIN_Uint;
    }

    if (type === this.numberType) {
      return BUILTIN_Number;
    }

    if (type === this.stringType) {
      return BUILTIN_String;
    }

    return type === this.namespaceType ? BUILTIN_Namespace : BUILTIN_Other;
  }

  /** As Traits::isMachineType: Object, void, Boolean, int, uint and Number. */
  isMachineType(type: i32): bool {
    const bt = this.builtin(type);
    return bt >= BUILTIN_Object && bt <= BUILTIN_Number;
  }

  /** As Traits::isMachineCompatible: whether a and b have the same representation. */
  machineCompatible(a: i32, b: i32): bool {
    if (a === b) {
      return true;
    }

    if (isAtom(this.builtin(a)) && isAtom(this.builtin(b))) {
      return true;
    }

    return a !== TYPE_Any && b !== TYPE_Any && !this.isMachineType(a) && !this.isMachineType(b);
  }

  methodAbc(m: u32): u32 {
    return this.methodAbcIndex[m];
  }

  /** The namespace id of the public namespace, or -1 if no ABC has one. */
  publicNamespace(): i32 {
    const empty = this.findText("");
    return empty < 0 ? -1 : this.findNamespace(NS_Public, <u32>empty);
  }

  /** The version of ABC `index`'s public namespace, as AvmCore::getPublicNamespace(pool). */
  publicVersion(index: u32): u8 {
    return this.abcs[index].builtin ? API_Internal : this.apiVersion;
  }

  /**
   * As PoolObject::resolveTypeName for a slot or parameter type: TYPE_Any
   * for index 0, or the type; below TYPE_Any on failure, with typeError set.
   */
  resolveTypeId(index: u32, mn: u32, allowVoid: bool): i32 {
    if (mn === 0) {
      return TYPE_Any;
    }

    const pool = this.abcs[index].pool;
    if (mn >= pool.multinameCount) {
      this.typeError = C.kCpoolIndexRangeError;
      return -2;
    }

    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      const base = this.resolveType(index, pool.mnA[mn]);
      if (base === -C.kAmbiguousBindingError) {
        this.typeError = C.kAmbiguousBindingError;
        return -2;
      }

      const param = this.resolveTypeId(index, pool.mnB[mn], false);
      if (param < TYPE_Any) {
        return param;
      }

      const t = base >= 0 ? this.parameterized(base, param) : -1;
      if (t < 0) {
        this.typeError = C.kClassNotFoundError;
        return -2;
      }

      return t;
    }

    const c = this.resolveType(index, mn);
    if (c === -C.kIllegalVoidError) {
      if (allowVoid) {
        return this.voidType;
      }

      this.typeError = C.kIllegalVoidError;
      return -2;
    }

    if (c < 0) {
      this.typeError = -c;
      return -2;
    }

    return this.classTraits[c];
  }

  /**
   * As PoolObject::resolveParameterizedType: Vector.<T>, which avmplus has
   * as its own classes for int, uint, Number and *, and otherwise makes as
   * a subclass of Vector.<*>; -1 if `base` is not Vector.
   */
  parameterized(base: i32, param: i32): i32 {
    if (base !== this.vectorClass || base < 0) {
      return -1;
    }

    const bt = this.builtin(param);
    if (bt === BUILTIN_Any) {
      return this.vectorObjectType;
    }

    if (bt === BUILTIN_Int) {
      return this.vectorIntType;
    }

    if (bt === BUILTIN_Uint) {
      return this.vectorUintType;
    }

    if (bt === BUILTIN_Number) {
      return this.vectorDoubleType;
    }

    if (this.vectorOf.has(param)) {
      return this.vectorOf.get(param);
    }

    // As Traits::newParameterizedITraits: a subclass of Vector.<*> with no members of its own.
    const traits = this.traits;
    const objects = <u32>this.vectorObjectType;
    const t = traits.create(
      TRAITS_Instance,
      traits.abc[objects],
      traits.owner[objects],
      <i32>objects,
      -1,
      0,
      0,
    );
    traits.param[t] = param;
    traits.slotCount[t] = traits.slotCount[objects];
    traits.methodCount[t] = traits.methodCount[objects];
    traits.memberStart[t] = traits.memberTraits.length;
    traits.memberEnd[t] = traits.memberTraits.length;
    this.vectorOf.set(param, <i32>t);
    return <i32>t;
  }

  /**
   * As PoolObject::getLegalDefaultValue: whether constant `value` of `kind`
   * of ABC `index` may be the default of a slot or parameter of `type`; 0,
   * or the VerifyError.
   */
  checkDefault(index: u32, value: u32, kind: u8, type: i32): i32 {
    // Without a value, the type's own default is always legal.
    if (value === 0) {
      return 0;
    }

    if (!isDefaultKind(kind)) {
      return type === TYPE_Any ? C.kCorruptABCError : C.kIllegalDefaultValue;
    }

    const pool = this.abcs[index].pool;
    let number: f64 = 0;
    let count: u32 = 0xffffffff;
    if (kind === C.CONSTANT_Int) {
      count = pool.ints.length;
      number = value < count ? pool.ints[value] : 0;
    } else if (kind === C.CONSTANT_UInt) {
      count = pool.uints.length;
      number = value < count ? pool.uints[value] : 0;
    } else if (kind === C.CONSTANT_Double) {
      count = pool.doubles.length;
      number = value < count ? pool.doubles[value] : 0;
    } else if (kind === C.CONSTANT_Utf8) {
      count = pool.stringCount;
    } else if (kind !== C.CONSTANT_True && kind !== C.CONSTANT_False && kind !== C.CONSTANT_Null) {
      count = pool.nsCount;
    }

    if (value >= count) {
      return C.kCpoolIndexRangeError;
    }

    return legalDefault(this.builtin(type), kind, number) ? 0 : C.kIllegalDefaultValue;
  }

  /**
   * As PoolObject::resolveTypeName for a base class or interface: the class
   * id, or minus the error: 1014 if nothing matches, 1008 if two classes do,
   * 1022 for void.
   */
  resolveType(index: u32, mn: u32): i32 {
    const abc = this.abcs[index];
    const pool = abc.pool;
    const kind = pool.mnKind[mn];
    if (kind === C.CONSTANT_TypeName) {
      const base = this.resolveType(index, pool.mnA[mn]);
      const param = pool.mnB[mn];
      if (base >= 0 && param) {
        const t = this.resolveType(index, param);
        if (t < 0) {
          return t;
        }
      }

      return base;
    }

    const strings = this.abcString[index];
    const ids = this.abcNs[index];
    const versions = this.abcNsVersion[index];
    const nameIndex = pool.mnB[mn];
    let found: i32 = -1;
    if (kind === C.CONSTANT_Qname && pool.mnA[mn] !== 0 && nameIndex !== 0) {
      const ns = pool.mnA[mn];
      found = this.findType(index, ids[ns], strings[nameIndex], versions[ns]);
    } else if (kind === C.CONSTANT_Multiname && nameIndex !== 0) {
      const set = pool.mnA[mn];
      const last = pool.nsSetStart[set + 1];
      for (let m = pool.nsSetStart[set]; m < last; m++) {
        const ns = pool.nsSetMembers[m];
        const t = this.findType(index, ids[ns], strings[nameIndex], versions[ns]);
        if (t >= 0 && found >= 0 && t !== found) {
          return -C.kAmbiguousBindingError;
        }

        if (t >= 0) {
          found = t;
        }
      }
    }

    if (found < 0) {
      return -C.kClassNotFoundError;
    }

    return found === this.voidClass ? -C.kIllegalVoidError : found;
  }

  /**
   * As DomainMgr::findTraitsInPoolByNameAndNS for ABC `index`: a class a
   * script defines, else one of the ABC's own; -1 if none.
   */
  findType(index: u32, ns: u32, name: u32, version: u8): i32 {
    const found = this.findTypeOf(ns, name, version, -1);
    return found >= 0 ? found : this.findTypeOf(ns, name, version, this.abcOwner[index]);
  }

  findTypeOf(ns: u32, name: u32, version: u8, owner: i32): i32 {
    const hash = hashPair(ns, name);
    const table = this.types;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (
        this.typeNs[id] === ns &&
        this.typeName[id] === name &&
        this.typeVersion[id] <= version &&
        this.typeOwner[id] === owner
      ) {
        return <i32>this.typeClass[id];
      }

      slot = table.next(slot);
    }
  }

  nameType(ns: u32, name: u32, version: u8, id: i32, owner: i32): void {
    const type = <u32>this.typeNs.length;
    this.typeNs.push(ns);
    this.typeName.push(name);
    this.typeVersion.push(version);
    this.typeClass.push(<u32>id);
    this.typeOwner.push(owner);
    this.types.insert(hashPair(ns, name), type);
  }

  /** As DomainMgr::addNamedInstanceTraits: instance i's name, unless something is already found by it. */
  nameInstance(index: u32, i: u32): void {
    const abc = this.abcs[index];
    const pool = abc.pool;
    let mn = abc.instanceName[i];
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    let ns = pool.mnA[mn];
    if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
      ns = pool.nsSetMembers[pool.nsSetStart[ns]];
    }

    const nsId = this.abcNs[index][ns];
    const version = this.abcNsVersion[index][ns];
    const name = this.abcString[index][pool.mnB[mn]];
    if (this.findType(index, nsId, name, version) < 0) {
      this.nameType(nsId, name, version, <i32>(this.classStart[index] + i), this.abcOwner[index]);
    }
  }

  /**
   * As AbcParser::addNamedTraits: every class a script of ABC `index`
   * defines, visible to all later ABCs unless the domain has the name already.
   */
  addClassNames(index: u32): void {
    const abc = this.abcs[index];
    const pool = abc.pool;
    const ids = this.abcNs[index];
    const versions = this.abcNsVersion[index];
    const strings = this.abcString[index];
    const first = abc.scriptTraitStart[0];
    const end = abc.scriptTraitStart[abc.scriptCount];
    for (let t = first; t < end; t++) {
      if ((abc.traitTag[t] & 0x0f) !== C.TRAIT_Class) {
        continue;
      }

      let mn = abc.traitName[t];
      if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
        mn = pool.mnA[mn];
      }

      let ns = pool.mnA[mn];
      let version = this.activeVersion(versions[ns]);
      if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
        const set = ns;
        const last = pool.nsSetStart[set + 1];
        ns = pool.nsSetMembers[pool.nsSetStart[set]];
        version = API_Internal;
        for (let m = pool.nsSetStart[set]; m < last; m++) {
          const v = this.activeVersion(versions[pool.nsSetMembers[m]]);
          if (v < version) {
            version = v;
          }
        }
      }

      const nsId = ids[ns];
      const name = strings[pool.mnB[mn]];
      if (this.nsType[nsId] !== NS_Private && this.findTypeOf(nsId, name, version, -1) < 0) {
        const id = this.classStart[index] + abc.traitIndex[t];
        this.nameType(nsId, name, version, <i32>id, -1);
      }
    }
  }

  findText(text: string): i32 {
    const bytes = String.UTF8.encode(text);
    return this.findString(changetype<usize>(bytes), bytes.byteLength);
  }

  /** Intern a string that is not in an ABC. */
  internText(text: string): u32 {
    const bytes = String.UTF8.encode(text);
    const found = this.findString(changetype<usize>(bytes), bytes.byteLength);
    if (found >= 0) {
      return <u32>found;
    }

    this.texts.push(bytes);
    return this.internString(changetype<usize>(bytes), bytes.byteLength);
  }

  internString(ptr: usize, length: u32): u32 {
    const found = this.findString(ptr, length);
    if (found >= 0) {
      return <u32>found;
    }

    const id = <u32>this.stringPtr.length;
    this.stringPtr.push(ptr);
    this.stringLength.push(length);
    this.versioned.push(0);
    this.strings.insert(hashBytes(ptr, length), id);
    return id;
  }

  /** The id of a string already interned, or -1. */
  findString(ptr: usize, length: u32): i32 {
    const hash = hashBytes(ptr, length);
    const table = this.strings;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (
        table.hashAt(slot) === hash &&
        this.stringLength[id] === length &&
        memory.compare(this.stringPtr[id], ptr, length) === 0
      ) {
        return id;
      }

      slot = table.next(slot);
    }
  }

  /** The id of a namespace, interning it; private namespaces are always new. */
  internNamespace(type: u8, uri: u32): u32 {
    if (type !== NS_Private) {
      const found = this.findNamespace(type, uri);
      if (found >= 0) {
        return <u32>found;
      }
    }

    const id = <u32>this.nsType.length;
    this.nsType.push(type);
    this.nsUri.push(uri);
    if (type !== NS_Private) {
      this.namespaces.insert(hashPair(type, uri), id);
    }

    return id;
  }

  findNamespace(type: u8, uri: u32): i32 {
    const hash = hashPair(type, uri);
    const table = this.namespaces;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (this.nsType[id] === type && this.nsUri[id] === uri) {
        return id;
      }

      slot = table.next(slot);
    }
  }

  /**
   * The binding of `name` in namespace `ns` visible at `version`, or -1:
   * the first one loaded, as a domain keeps the first definition of a name.
   */
  find(ns: u32, name: u32, version: u8): i32 {
    const hash = hashPair(ns, name);
    const table = this.bindings;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (
        this.bindingNs[id] === ns &&
        this.bindingName[id] === name &&
        this.bindingVersion[id] <= version
      ) {
        return id;
      }

      slot = table.next(slot);
    }
  }

  /** As AbcParser::parseCpool: each namespace's interned id and API version. */
  addNamespaces(abc: Abc, base: usize, strings: StaticArray<u32>): void {
    const pool = abc.pool;
    const count = pool.nsCount;
    const ids = new StaticArray<u32>(count);
    const versions = new StaticArray<u8>(count);
    const marks = new StaticArray<i32>(count);

    // A builtin ABC's marked URIs are versioned before any of its namespaces
    // get a version, as the player registers them before parsing.
    for (let i: u32 = 1; i < count; i++) {
      const index = pool.nsName[i];
      const mark = index
        ? versionMark(base, pool.stringStart[index], pool.stringLength[index])
        : -1;
      marks[i] = mark;
      if (abc.builtin && mark >= 0 && namespaceType(pool.nsKind[i]) === NS_Public) {
        const uri = this.internString(base + pool.stringStart[index], pool.stringLength[index] - 3);
        this.versioned[uri] = 1;
      }
    }

    for (let i: u32 = 1; i < count; i++) {
      const type = namespaceType(pool.nsKind[i]);
      const index = pool.nsName[i];
      const mark = marks[i];
      let uri = index ? strings[index] : URI_None;
      let version = API_AllVersions;
      if (mark >= 0) {
        uri = this.internString(base + pool.stringStart[index], pool.stringLength[index] - 3);
        version = <u8>mark;
      }

      if (type === NS_Private) {
        version = API_AllVersions;
      } else if (index && abc.builtin) {
        if (mark < 0 && type === NS_Public && this.versioned[uri]) {
          version = API_Internal;
        }
      } else if (index && type === NS_Public) {
        version = this.apiVersion;
      }

      ids[i] = this.internNamespace(type, uri);
      versions[i] = version;
    }

    this.abcNs.push(ids);
    this.abcNsVersion.push(versions);
  }

  /**
   * Every script trait of ABC `index`, as AbcParser::addNamedScript binds it:
   * under its name's first namespace, with the earliest of their versions.
   */
  addBindings(index: u32): void {
    const abc = this.abcs[index];
    const pool = abc.pool;
    const strings = this.abcString[index];
    const ids = this.abcNs[index];
    const versions = this.abcNsVersion[index];
    for (let script: u32 = 0; script < abc.scriptCount; script++) {
      const end = abc.scriptTraitStart[script + 1];
      for (let t = abc.scriptTraitStart[script]; t < end; t++) {
        let mn = abc.traitName[t];
        if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
          mn = pool.mnA[mn];
        }

        const name = strings[pool.mnB[mn]];
        let first = pool.mnA[mn];
        let version = this.activeVersion(versions[first]);
        if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
          const set = pool.mnA[mn];
          const last = pool.nsSetStart[set + 1];
          first = pool.nsSetMembers[pool.nsSetStart[set]];
          version = API_Internal;
          for (let m = pool.nsSetStart[set]; m < last; m++) {
            const v = this.activeVersion(versions[pool.nsSetMembers[m]]);
            if (v < version) {
              version = v;
            }
          }
        }

        this.bind(ids[first], name, version, index, script, t);
      }
    }
  }

  /**
   * As kApiVersionSeriesTransfer: a version of the other series becomes the
   * first later one of the domain's, which for Flash Player means AIR-only
   * versions become VM-internal.
   */
  activeVersion(version: u8): u8 {
    if (version === API_AllVersions || version >= API_Internal || isAir(version) === this.air) {
      return version;
    }

    if (!this.air) {
      return API_Internal;
    }

    let v = version + 1;
    while (!isAir(v)) {
      v++;
    }

    return v;
  }

  bind(ns: u32, name: u32, version: u8, abc: u32, script: u32, trait: u32): void {
    const id = <u32>this.bindingNs.length;
    this.bindingNs.push(ns);
    this.bindingName.push(name);
    this.bindingVersion.push(version);
    this.bindingAbc.push(abc);
    this.bindingScript.push(script);
    this.bindingTrait.push(trait);
    this.bindings.insert(hashPair(ns, name), id);
  }
}

/**
 * Whether an API version belongs to AIR's series: versions alternate between
 * the series, FP_10_0, FP_10_0_32 and FP_10_1 aside, from FP_10_2 on.
 */
function isAir(version: u8): bool {
  if (version >= 10) {
    return (version & 1) === 1;
  }

  return version !== API_FP_10_0 && version !== 5 && version !== 7;
}

/** *, Object and void are all represented as atoms. */
function isAtom(bt: u8): bool {
  return bt === BUILTIN_Any || bt === BUILTIN_Object || bt === BUILTIN_Void;
}

function namespaceType(kind: u8): u8 {
  switch (kind) {
    case C.CONSTANT_PackageInternalNs:
      return NS_PackageInternal;
    case C.CONSTANT_ProtectedNamespace:
      return NS_Protected;
    case C.CONSTANT_ExplicitNamespace:
      return NS_Explicit;
    case C.CONSTANT_StaticProtectedNs:
      return NS_StaticProtected;
    case C.CONSTANT_PrivateNs:
      return NS_Private;
    default:
      return NS_Public;
  }
}

/**
 * The API version a string's last character marks, or -1. The marks are
 * U+E294 to U+E2C8, three bytes in UTF-8.
 */
function versionMark(base: usize, start: u32, length: u32): i32 {
  if (length < 3) {
    return -1;
  }

  const p = base + start + length - 3;
  const b0 = <u32>load<u8>(p);
  const b1 = <u32>load<u8>(p + 1);
  const b2 = <u32>load<u8>(p + 2);
  if ((b0 & 0xf0) !== 0xe0 || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
    return -1;
  }

  const c = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
  return c >= API_MinMark && c < API_MinMark + API_Count ? <i32>(c - API_MinMark) : -1;
}
