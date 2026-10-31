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
// ABCs load into application domains, as avmplus' DomainMgr keeps them: a
// tree whose root is domain 0. An ABC sees what its own domain and its
// ancestors define: what one of them has found before, as the runtime
// reports it (see addFound), else the first definition from the root down.
// A domain the runtime let go of is dropped with its descendants, and one
// the host has no more use for now evicted, until it gives its ABCs again:
// nothing sees what their ABCs define, and once enough of them are let go
// of, the live ABCs are linked again into a new Domain, which leaves the
// others' tables, names included, to the collector (see rebuilt in lifetime.ts).
//
// Namespaces follow avmplus' AbcParser: two are the same if their kind and
// URI are; a private namespace is only ever equal to itself. A URI may end
// in an API version mark (U+E294 + version), which builtin ABCs use to say
// which player version introduced a name. The mark is stripped from the URI
// and kept as the namespace's version. Versions come in two interleaved
// series, Flash Player's and AIR's, and the domain's version says which it
// runs; every namespace's version moves into that series, where for Flash
// Player AIR-only versions are VM-internal. A binding gets the earliest
// version of its namespaces, and is visible to a lookup whose namespace has
// an equal or later version. User ABCs' public namespaces get the domain's
// version, so they cannot see VM-internal names.
import { Abc } from "../abc/abc";
import * as C from "../abc/constants";
import { readAbc } from "../abc/parse";
import { link } from "./classes";
import { hashBytes, hashPair, IdTable } from "./table";
import {
  BIND_None,
  BKIND_Var,
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Float,
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
  TRAITS_Activation,
  TRAITS_Catch,
  TRAITS_Class,
  TRAITS_Instance,
  TraitsTable,
  TYPE_Any,
} from "./traits";
import { addClassNames, parameterized, resolveType } from "./typenames";
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
/**
 * VM_INTERNAL is the last mark of the table an ABC was built with: 42 in
 * the AIR 15 SDK's, which the oracle's playerglobal has, 52 in
 * core/api-versions.h, which the submodule's builtin has. A builtin ABC's
 * highest mark, from 42 up, is its internal one.
 */
const API_FirstInternalMark: i32 = 42;
const API_Count: u32 = 53;
const API_MinMark: u32 = 0xe294;

/** The URI of a namespace written with string index 0. */
export const URI_None: u32 = 0xffffffff;

/**
 * An application domain's state: live; evicted, let go of until the host
 * gives its ABCs again (see evict in lifetime.ts); or dropped for good.
 */
export const DOMAIN_Live: u8 = 0;
export const DOMAIN_Evicted: u8 = 1;
export const DOMAIN_Dropped: u8 = 2;

/** The kinds of the log's entries (see Domain.logKind). */
export const LOG_None: u8 = 0;
/** A finding, by its index in the found tables. */
export const LOG_Found: u8 = 1;
/** Traits resolved, by their kind and owner in their ABC. */
export const LOG_Resolve: u8 = 2;
/** A method signed, by its index in its ABC. */
export const LOG_Sign: u8 = 3;
/** An ABC verified for the first time, or finding scopes for the first time. */
export const LOG_Verify: u8 = 4;

@final
export class Domain {
  /** The version of user ABCs' public namespaces, whose series is the domain's. */
  apiVersion: u8 = API_LatestFP;

  abcs: Abc[] = [];
  /** Where each ABC's bytes start. */
  abcBase: usize[] = [];
  /**
   * The bytes of every ABC ever added, followed by PADDING, including those
   * rejected while linking: interned strings may point into any of them.
   */
  buffers: StaticArray<u8>[] = [];
  /** Each ABC's bytes, by index, to link it again (see rebuilt in lifetime.ts). */
  abcBuffer: StaticArray<u8>[] = [];
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
  /**
   * getBinding's answers, by type, ABC and multiname: a type's members do
   * not change once its ABC links, and a link that fails, which reuses its
   * traits' and its ABC's ids, clears them.
   */
  bindingMemo: IdTable = new IdTable();
  memoType: i32[] = [];
  memoAbc: u32[] = [];
  memoName: u32[] = [];
  memoBinding: u32[] = [];

  /** Forget getBinding's answers. */
  clearBindingMemo(): void {
    this.bindingMemo = new IdTable();
    this.memoType.length = 0;
    this.memoAbc.length = 0;
    this.memoName.length = 0;
    this.memoBinding.length = 0;
  }

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
  /** Each domain's parent, -1 for the root, and its depth. */
  domainParent: i32[] = [-1];
  domainDepth: u32[] = [0];
  /** Each domain's DOMAIN_ state: nothing sees what the ABCs of one not live define. */
  domainState: u8[] = [DOMAIN_Live];
  /** The domain of each ABC, and of each class name. */
  abcDomain: u32[] = [];
  typeDomain: u32[] = [];
  /**
   * What a domain finds, as the runtime reports it where that is not the
   * first definition from the root down: a script's binding, found by
   * name, or a class, found as a type (avmplus' cached scripts and traits).
   * The runtime reports all a domain finds so, its ancestors' included.
   */
  cachedDomain: u32[] = [];
  cachedNs: u32[] = [];
  cachedName: u32[] = [];
  cachedBinding: i32[] = [];
  cachedClass: i32[] = [];
  cached: IdTable = new IdTable();
  /** Each finding addFound recorded, as the runtime reported it (see LOG_Found). */
  foundDomain: u32[] = [];
  foundKind: u8[] = [];
  foundUri: string[] = [];
  foundName: string[] = [];
  foundAbc: u32[] = [];
  foundAsType: u8[] = [];
  /**
   * What the domain's tables hold that depends on when it happened, in the
   * order it happened, and how many ABCs there were then, for a rebuild to
   * do again at that point: a finding recorded, and the first answers
   * cached of what resolves lazily, a traits' types, a method's signature
   * and an ABC's verified scopes, which see the ABCs there are when they
   * are first asked for. A LOG_ kind, the ABC it is of, and two numbers
   * by kind (see logged).
   */
  logKind: u8[] = [];
  logAt: u32[] = [];
  logAbc: u32[] = [];
  logA: u32[] = [];
  logB: u32[] = [];
  /** Scopes, function scopes and catch scopes found first, for verifyMethods to tell whether it found any. */
  captures: u32 = 0;
  /** Each ABC verified at least once, by index. */
  abcVerified: u8[] = [];
  /**
   * How much each ABC holds of the domain's memory, roughly, by index: its
   * bytes, and the rows of the tables it added (see weigh in lifetime.ts).
   */
  abcWeight: u32[] = [];
  /** How many rebuilds the domain is from the one reset made; each domain's when it was evicted. */
  generation: u32 = 0;
  domainEvicted: u32[] = [0];
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
  /** The interned id of "Transient", the metadata AMF and JSON leave a member out for. */
  transientName: u32 = 0;
  /** The metadata names of the builtins' own that describeType leaves out, as avmplus does. */
  versionName: u32 = 0;
  nativeName: u32 = 0;
  apiName: u32 = 0;
  // Builtin types by traits id, for the rules that treat them specially.
  voidType: i32 = -1;
  nullType: i32 = -1;
  numberType: i32 = -1;
  floatType: i32 = -1;
  intType: i32 = -1;
  uintType: i32 = -1;
  booleanType: i32 = -1;
  stringType: i32 = -1;
  namespaceType: i32 = -1;
  /** XML's and XMLList's traits. */
  xmlType: i32 = -1;
  xmlListType: i32 = -1;
  /** QName's traits, whose == compares names as XML's compares content. */
  qnameType: i32 = -1;
  /** Class's traits, the type of a value that is a class. */
  classType: i32 = -1;
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
  add(buffer: StaticArray<u8>, length: u32, builtin: bool, domain: u32 = 0): Abc {
    const abc = readAbc(changetype<usize>(buffer), length, builtin);
    if (abc.error) {
      return abc;
    }

    this.buffers.push(buffer);
    this.attach(abc, buffer, domain);
    return abc;
  }

  /**
   * Link `abc`, parsed from `buffer`, into application domain `domain`, as
   * the next ABC; false after recording the error, and then it is not added.
   */
  attach(abc: Abc, buffer: StaticArray<u8>, domain: u32): bool {
    const base = changetype<usize>(buffer);
    const index = <u32>this.abcs.length;
    const rows = this.rows();
    this.abcs.push(abc);
    this.abcDomain.push(domain);
    this.abcBase.push(base);
    this.abcBuffer.push(buffer);
    this.abcVerified.push(0);
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
    if (!link(this, index)) {
      this.abcs.pop();
      this.abcBase.pop();
      this.abcBuffer.pop();
      this.abcVerified.pop();
      this.abcString.pop();
      this.abcNs.pop();
      this.abcNsVersion.pop();
      this.classStart.pop();
      this.scriptTraits.length = index;
      this.bodyTraits.length = index;
      this.abcOwner.length = index;
      this.abcDomain.length = index;
      this.methodStart.length = index;
      this.methodAbcIndex.length = methodCount;
      this.traits.truncate(traitsCount);
      this.traits.truncateMethods(methodCount);
      this.clearBindingMemo();
      return false;
    }

    addClassNames(this, index);
    this.addBindings(index);
    // The bytes three times: a copy, and the tables parsing made of them.
    this.abcWeight.push(<u32>min<u64>(3 * <u64>abc.length + this.rows() - rows, 0xffffffff));
    return true;
  }

  /**
   * Roughly the bytes the domain's tables hold, by their rows, for
   * weighing ABCs: what an ABC's link or compile adds is its own. Within a
   * fifth or so of what a walk of the heap found, for the libraries, a
   * large application and the small SWFs it loads.
   */
  rows(): u64 {
    const t = this.traits;
    return (
      <u64>t.kind.length * 144 +
      <u64>t.methodTraits.length * 72 +
      <u64>t.memberTraits.length * 60 +
      <u64>(t.slotType.length + t.dispatch.length + t.paramType.length + t.interfaceList.length) *
        9 +
      <u64>this.memoType.length * 60 +
      <u64>this.stringPtr.length * 36 +
      <u64>this.nsType.length * 24 +
      <u64>(this.bindingNs.length + this.typeNs.length + this.classAbc.length) * 48 +
      <u64>this.logKind.length * 36
    );
  }

  /** Whether ABC `index` is of a live application domain, one neither evicted nor dropped. */
  isLive(index: u32): bool {
    return this.domainState[this.abcDomain[index]] === DOMAIN_Live;
  }

  /** The live ABCs' weight and the others' still in the tables, as addWeights last added them up. */
  liveWeight: u64 = 0;
  deadWeight: u64 = 0;
  /** The weight of the log entries kept for evicted domains, which no rebuild frees. */
  keptWeight: u64 = 0;

  /** Append entry `kind` of ABC `abc` to the log. */
  logged(kind: u8, abc: u32, a: u32, b: u32): void {
    this.logKind.push(kind);
    this.logAt.push(<u32>this.abcs.length);
    this.logAbc.push(abc);
    this.logA.push(a);
    this.logB.push(b);
  }

  /** Log that traits t resolved, unless they are made on demand, which no lookup decides. */
  loggedResolve(t: u32): void {
    const traits = this.traits;
    const kind = traits.kind[t];
    if (kind >= TRAITS_Instance && kind <= TRAITS_Activation && traits.param[t] === TYPE_Any) {
      this.logged(LOG_Resolve, traits.abc[t], kind, traits.owner[t]);
    }
  }

  /** Whether the machine type always holds a value: int, uint, Number and Boolean. */
  typeNotNull(type: i32): bool {
    const bt = this.builtin(type);
    return (
      bt === BUILTIN_Int ||
      bt === BUILTIN_Uint ||
      bt === BUILTIN_Number ||
      bt === BUILTIN_Boolean ||
      bt === BUILTIN_Float
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
    const c = resolveType(this, index, isTypeName ? pool.mnA[mn] : mn);
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

    const t = c >= 0 ? parameterized(this, c, param) : -1;
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
      return this.scriptOf(this.find(ids[ns], name, versions[ns], this.abcDomain[index]));
    }

    const set = pool.mnA[mn];
    let found = -1;
    for (let m = pool.nsSetStart[set]; m < pool.nsSetStart[set + 1]; m++) {
      const ns = pool.nsSetMembers[m];
      const script = this.scriptOf(this.find(ids[ns], name, versions[ns], this.abcDomain[index]));
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

    if (this.floatType >= 0 && slotType === this.staticOf(this.floatType)) {
      return this.floatType;
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
        converted === this.floatType ||
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
    const version = this.abcNsVersion[index][ns];
    traits.add(t, nsId, this.nameOf(index, name), version, BKIND_Var);
    traits.slotCount[t] = 1;
    traits.slotStart[t] = traits.slotType.length;
    traits.slotType.push(type);
    traits.slotSet.push(1);
    traits.dispatchStart[t] = traits.dispatch.length;
    traits.resolved[t] = 1;
    this.catchScopes.set(key, <i32>t);
    this.captures++;
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

    if (type >= 0 && type === this.floatType) {
      return BUILTIN_Float;
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
    return (bt >= BUILTIN_Object && bt <= BUILTIN_Number) || bt === BUILTIN_Float;
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
   * As PoolObject::getLegalDefaultValue: whether constant `value` of `kind`
   * of ABC `index` may be the default of a slot or parameter of `type`; 0,
   * or the VerifyError.
   */
  checkDefault(index: u32, value: u32, kind: u8, type: i32): i32 {
    // Legacy ABCs ignore the kind at index zero; AIR's float entry zero is NaN.
    const hasFloats = this.abcs[index].hasFloatSupport;
    if (value === 0 && (kind !== C.CONSTANT_Float || !hasFloats)) {
      return 0;
    }

    if (kind === C.CONSTANT_Float && !hasFloats) {
      return type === TYPE_Any ? C.kCorruptABCError : C.kIllegalDefaultValue;
    }

    if (!isDefaultKind(kind)) {
      return type === TYPE_Any ? C.kCorruptABCError : C.kIllegalDefaultValue;
    }

    const pool = this.abcs[index].pool;
    let number: f64 = 0;
    let count: u32 = 0xffffffff;
    switch (kind) {
      case C.CONSTANT_Int:
        count = pool.ints.length;
        number = value < count ? pool.ints[value] : 0;
        break;
      case C.CONSTANT_UInt:
        count = pool.uints.length;
        number = value < count ? pool.uints[value] : 0;
        break;
      case C.CONSTANT_Float:
        count = pool.floats.length;
        number = value < count ? pool.floats[value] : 0;
        break;
      case C.CONSTANT_Double:
        count = pool.doubles.length;
        number = value < count ? pool.doubles[value] : 0;
        break;
      case C.CONSTANT_Utf8:
        count = pool.stringCount;
        break;
      case C.CONSTANT_True:
      case C.CONSTANT_False:
      case C.CONSTANT_Null:
        // The value is the kind; its index is not read.
        break;
      default:
        // A namespace's kinds.
        count = pool.nsCount;
        break;
    }

    if (value >= count) {
      return C.kCpoolIndexRangeError;
    }

    return legalDefault(this.builtin(type), kind, number) ? 0 : C.kIllegalDefaultValue;
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
   * The binding of `name` in namespace `ns` visible at `version` from
   * `domain`, or -1: the first one loaded, as a domain keeps the first
   * definition of a name.
   */
  find(ns: u32, name: u32, version: u8, domain: u32 = 0): i32 {
    if (this.domainParent.length > 1) {
      return this.findIn(ns, name, version, domain);
    }

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
    let highestMark: i32 = -1;
    for (let i: u32 = 1; i < count; i++) {
      const index = pool.nsName[i];
      const mark = index
        ? versionMark(base, pool.stringStart[index], pool.stringLength[index])
        : -1;
      marks[i] = mark;
      if (mark > highestMark) {
        highestMark = mark;
      }

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
        if (
          (mark < 0 && type === NS_Public && this.versioned[uri]) ||
          (mark >= API_FirstInternalMark && mark === highestMark)
        ) {
          version = API_Internal;
        }
      } else if (index && type === NS_Public) {
        version = this.apiVersion;
      }

      ids[i] = this.internNamespace(type, uri);
      // As AvmCore::newNamespace: in the domain's series, so that a lookup
      // compares versions of the series its bindings have.
      versions[i] = this.activeVersion(version);
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
        let version = versions[first];
        if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
          const set = pool.mnA[mn];
          const last = pool.nsSetStart[set + 1];
          first = pool.nsSetMembers[pool.nsSetStart[set]];
          version = API_Internal;
          for (let m = pool.nsSetStart[set]; m < last; m++) {
            const v = versions[pool.nsSetMembers[m]];
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
  private activeVersion(version: u8): u8 {
    const air = this.apiVersion !== API_AllVersions && isAir(this.apiVersion);
    if (version === API_AllVersions || version >= API_Internal || isAir(version) === air) {
      return version;
    }

    if (!air) {
      return API_Internal;
    }

    let v = version + 1;
    while (!isAir(v)) {
      v++;
    }

    return v;
  }

  /** A new domain, a child of `parent`. */
  childDomain(parent: u32): u32 {
    const id = <u32>this.domainParent.length;
    this.domainParent.push(<i32>parent);
    this.domainDepth.push(this.domainDepth[parent] + 1);
    this.domainState.push(DOMAIN_Live);
    this.domainEvicted.push(0);
    return id;
  }

  /** Whether `domain` sees what `other` defines: `other` is it or an ancestor, and live. */
  sees(domain: u32, other: u32): bool {
    if (this.domainState[other] !== DOMAIN_Live) {
      return false;
    }

    let d = <i32>domain;
    while (d >= 0) {
      if (<u32>d === other) {
        return true;
      }

      d = this.domainParent[d];
    }

    return false;
  }

  /**
   * What `domain` has found by `ns` and `name`, as the runtime reports it
   * (see addFound): a binding, or as a type a class; -1 if none.
   */
  findCached(ns: u32, name: u32, version: u8, domain: u32, asType: bool): i32 {
    const table = this.cached;
    let slot = table.start(hashPair(ns, name));
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      const target = asType ? this.cachedClass[id] : this.cachedBinding[id];
      if (
        this.cachedDomain[id] === domain &&
        this.cachedNs[id] === ns &&
        this.cachedName[id] === name &&
        target >= 0
      ) {
        return !asType && this.bindingVersion[target] > version ? -1 : target;
      }

      slot = table.next(slot);
    }
  }

  /** find, from a domain other than the root's only one. */
  findIn(ns: u32, name: u32, version: u8, domain: u32): i32 {
    const cached = this.findCached(ns, name, version, domain, false);
    if (cached >= 0) {
      return cached;
    }

    const table = this.bindings;
    let slot = table.start(hashPair(ns, name));
    let best: i32 = -1;
    let bestDepth: u32 = 0;
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return best;
      }

      const d = this.abcDomain[this.bindingAbc[id]];
      if (
        this.bindingNs[id] === ns &&
        this.bindingName[id] === name &&
        this.bindingVersion[id] <= version &&
        (best < 0 || this.domainDepth[d] < bestDepth) &&
        this.sees(domain, d)
      ) {
        best = id;
        bestDepth = this.domainDepth[d];
      }

      slot = table.next(slot);
    }
  }

  /** findTypeOf for the names scripts define, from a domain other than the root's only one. */
  findTypeIn(ns: u32, name: u32, version: u8, domain: u32): i32 {
    const cached = this.findCached(ns, name, version, domain, true);
    if (cached >= 0) {
      return cached;
    }

    const table = this.types;
    let slot = table.start(hashPair(ns, name));
    let best: i32 = -1;
    let bestDepth: u32 = 0;
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return best;
      }

      const d = this.typeDomain[id];
      if (
        this.typeNs[id] === ns &&
        this.typeName[id] === name &&
        this.typeVersion[id] <= version &&
        this.typeOwner[id] === -1 &&
        (best < 0 || this.domainDepth[d] < bestDepth) &&
        this.sees(domain, d)
      ) {
        best = <i32>this.typeClass[id];
        bestDepth = this.domainDepth[d];
      }

      slot = table.next(slot);
    }
  }

  /**
   * Record that `domain` has found the definition ABC `abc` gives `name`
   * in the namespace of kind `type` and URI `uri`: by name, its script's
   * binding, or as a type, its class. A name no ABC spells is not recorded.
   */
  addFound(domain: u32, type: u8, uri: string, name: string, abc: u32, asType: bool): void {
    if (
      domain >= <u32>this.domainParent.length ||
      this.domainState[domain] !== DOMAIN_Live ||
      abc >= <u32>this.abcs.length ||
      !this.isLive(abc)
    ) {
      return;
    }

    const uriId = this.findText(uri);
    const nameId = this.findText(name);
    const ns = uriId < 0 ? -1 : this.findNamespace(type, <u32>uriId);
    if (nameId < 0 || ns < 0) {
      return;
    }

    let binding: i32 = -1;
    let cls: i32 = -1;
    if (asType) {
      for (let id = 0; id < this.typeNs.length; id++) {
        const c = this.typeClass[id];
        if (
          this.typeNs[id] === <u32>ns &&
          this.typeName[id] === <u32>nameId &&
          <i32>c !== this.voidClass &&
          this.classAbc[c] === abc
        ) {
          cls = <i32>c;
          break;
        }
      }
    } else {
      for (let id = 0; id < this.bindingNs.length; id++) {
        if (
          this.bindingNs[id] === <u32>ns &&
          this.bindingName[id] === <u32>nameId &&
          this.bindingAbc[id] === abc
        ) {
          binding = id;
          break;
        }
      }
    }

    if (binding < 0 && cls < 0) {
      return;
    }

    // A domain's finding never changes, and the runtime reports it again
    // for each ABC the domain loads: one already recorded is left as it is.
    const table = this.cached;
    let slot = table.start(hashPair(<u32>ns, <u32>nameId));
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        break;
      }

      if (
        this.cachedDomain[id] === domain &&
        this.cachedNs[id] === <u32>ns &&
        this.cachedName[id] === <u32>nameId &&
        this.cachedBinding[id] === binding &&
        this.cachedClass[id] === cls
      ) {
        return;
      }

      slot = table.next(slot);
    }

    const id = <u32>this.cachedDomain.length;
    this.cachedDomain.push(domain);
    this.cachedNs.push(<u32>ns);
    this.cachedName.push(<u32>nameId);
    this.cachedBinding.push(binding);
    this.cachedClass.push(cls);
    this.cached.insert(hashPair(<u32>ns, <u32>nameId), id);
    this.clearBindingMemo();
    this.logged(LOG_Found, abc, <u32>this.foundDomain.length, 0);
    this.foundDomain.push(domain);
    this.foundKind.push(type);
    this.foundUri.push(uri);
    this.foundName.push(name);
    this.foundAbc.push(abc);
    this.foundAsType.push(asType ? 1 : 0);
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
