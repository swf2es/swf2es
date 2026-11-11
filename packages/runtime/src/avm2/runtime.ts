// The AVM2 runtime generated modules call as `rt`: the object model, name
// lookup, classes and scripts, as avmplus implements them.
//
// Objects are JavaScript objects made from their traits' prototype, which
// holds their methods as $m<dispatch id>, their traits as $traits, and $p,
// the AS3 prototype object their dynamic lookups continue on. Slots are own
// fields $<slot id>, and dynamic properties are kept apart from both, in $d.
// A class object is made the same way from its static traits, and holds its
// instances' traits in $it.
//
// Layouts come from the module, computed by the compiler: the runtime never
// derives one (docs/architecture/compiler.md, "Modules and the bootstrap").

import { API_VERSION, checkApiVersion } from "@swf2es/format";
import { AmfClasses } from "./amf-classes.js";
import { ArrayConversion } from "./array-conversion.js";
import { fillCache } from "./cache-fill.js";
import { newClass, specializeVector, withId } from "./classes.js";
import { classNamed, classNamedByCode, definingAbc, definitionNamed } from "./definitions.js";
import {
  type Abc,
  type AbcDesc,
  type AsObject,
  type ClassDesc,
  type CompileUnit,
  type Factory,
  type Method,
  NOT_FOUND,
  type Scope,
  type TraitsDesc,
  type TypeRef,
  type Value,
} from "./descriptors.js";
import { type DictionaryKeys, NAMED } from "./dictionary-keys.js";
import { compileUnit, Domain, definitionNames, findScript, type Script } from "./domain.js";
import { isViewRangeError, SharedMemoryView } from "./domain-memory.js";
import {
  continues,
  dictionaryAt,
  type Enumeration,
  elementsAt,
  enumerated,
  INT_ATOM_LIMIT,
  nextIndex,
  ownNames,
  pairIndex,
  pairOf,
  walkless,
} from "./enumeration.js";
import { AsError, describe, errorMessage, stackOf } from "./errors.js";
import { FloatValue, floatValue } from "./float.js";
import { type ClassHook, hookedBinding, type NativesProvider, type PropertyHook } from "./hooks.js";
import {
  type CountedMethod,
  installMethod,
  nativeFactory,
  noBodyFactory,
  unverifiedFactory,
  verifyErrorFactory,
} from "./method-factories.js";
import { Modules } from "./modules.js";
import {
  arrayIndex,
  CONSTANT_Multiname,
  CONSTANT_MultinameA,
  CONSTANT_MultinameL,
  CONSTANT_MultinameLA,
  CONSTANT_Qname,
  CONSTANT_RTQname,
  CONSTANT_RTQnameA,
  CONSTANT_RTQnameL,
  CONSTANT_RTQnameLA,
  Multiname,
  Namespace,
  NS_Private,
  NS_Public,
  namespace,
  prefixedNamespace,
  prefixOf,
  publicNs,
  publicQname,
  qname,
  TypeName,
} from "./names.js";
import { FloatVector, setFloatElement } from "./natives/float-vector.js";
import type { SyncInit } from "./natives/sync.js";
import {
  type ElementStore,
  storeDouble,
  storeInt,
  storeObject,
} from "./natives/vector-elements.js";
import { escapeAttributeValue, escapeElementValue } from "./natives/xml/escape.js";
import { numberToString, stringToNumber } from "./number-strings.js";
import {
  defaultPrint,
  memoryFiles,
  type RuntimeOptions,
  type ShellFiles,
  type ShellWorkerHost,
  type ShellWorkerInit,
} from "./options.js";
import {
  cached,
  epoch,
  IC_Call,
  IC_Const,
  IC_Dynamic,
  IC_Get,
  IC_GetSet,
  IC_Method,
  IC_Set,
  IC_Slot,
  invalidate,
  NO_CACHE,
  REPLACEMENTS,
  UNFILLED,
} from "./property-cache.js";
import {
  BIND_Const,
  BIND_Get,
  BIND_GetSet,
  BIND_Method,
  BIND_Set,
  BIND_Var,
  boundKey,
  ClassRef,
  methodKey,
  slotKey,
  Traits,
  untypedSetKey,
  VectorRef,
} from "./traits.js";

export { NOT_FOUND } from "./descriptors.js";

/**
 * A sealed Array subclass's elements from SWF 13, as avmplus' ArrayObject
 * keeps none for one: never any. Shared and frozen; what writes elements
 * checks for it, and fails as a sealed object does.
 */
export const SEALED_ELEMENTS: Value[] = Object.freeze([]) as unknown as Value[];

/** The value of `o`'s dynamic property `name`, or NOT_FOUND. */
function dynamicValue(o: AsObject, name: string): Value {
  const d: Map<string, Value> | null | undefined = o.$d;
  if (!d) {
    return NOT_FOUND;
  }

  const value = d.get(name);
  return value !== undefined || d.has(name) ? value : NOT_FOUND;
}

export class Runtime {
  readonly print: (line: string) => void;
  readonly debugger: boolean;
  readonly compileAbc:
    | ((abc: Uint8Array, unit: CompileUnit) => ((rt: Runtime) => Abc) | number)
    | null;
  readonly files: ShellFiles;
  /** See RuntimeOptions.workers and worker. */
  readonly workerHost: ShellWorkerHost | null;
  readonly workerInit: ShellWorkerInit | null;
  /** See RuntimeOptions.sync. */
  readonly syncInit: SyncInit | null;
  /** See RuntimeOptions.swfVersion. */
  swfVersion: number;
  /** See RuntimeOptions.apiVersion. */
  readonly apiVersion: number;
  /** The versions of a name user code makes from a string (publicQname): the one list, made once. */
  readonly userVersions: readonly number[];
  /** JSON.stringify's toJSON, at user code's version, made once. */
  readonly toJSONName: Multiname;
  /**
   * What [[DefaultValue]] calls, in each hint's order: toString and valueOf
   * at user code's version, made once, so that their caches keep the
   * methods of the traits converted most, as a Dictionary's object keys.
   */
  private readonly stringPrimitiveOrder: readonly Multiname[];
  private readonly numberPrimitiveOrder: readonly Multiname[];
  readonly natives: Record<string, (rt: Runtime) => Method>;
  /** The root application domain, the builtins' and the main SWF's; and the one modules load into now. */
  readonly root = new Domain(null, 0);
  private loading: Domain = this.root;
  /** The modules loaded, and the domains of their code. */
  private readonly modules = new Modules();
  private loadingBuiltin = false;
  /** Whether a domain other than the root exists. */
  children = false;
  /** Vector.<T>'s references, by T's. */
  private readonly vectorRefs = new Map<TypeRef, VectorRef>();
  /**
   * The domain memory the domain memory instructions use: the ByteArray set
   * as it, or, as avmplus' DomainEnv, 1024 bytes of scratch memory.
   */
  readonly scratchMemory = new DataView(new ArrayBuffer(1024));
  /** The domain memory, and its length kept with it for mops: fields, not an accessor and DataView's getter. */
  private memoryView: DataView = this.scratchMemory;
  memoryLength: number = this.scratchMemory.byteLength;
  /**
   * What generated code loads and stores in place through, at an int or
   * uint address: the domain memory itself, whose own range check throws
   * the RangeError memoryError makes avmplus'. Or, where another worker
   * shares the memory, a view that reads its length again before it
   * rejects an address, as mops does.
   */
  view: DataView | SharedMemoryView = this.scratchMemory;
  memoryProvider: AsObject | null = null;
  private refresh: (() => void) | null = null;
  /** ByteArray.defaultObjectEncoding: AMF3 until set. */
  defaultObjectEncoding = 3;
  /** ObjectEncoding.dynamicPropertyWriter: what writes a dynamic object's own properties in AMF3, if anything. */
  dynamicPropertyWriter: AsObject | null = null;
  /** Class aliases and the classes AMF makes. */
  private readonly amfClasses = new AmfClasses(this);
  /** The builtin classes' traits, made before their classes so the bootstrap can refer to them. */
  readonly objectTraits: Traits;
  readonly classTraits: Traits;
  readonly functionTraits: Traits;
  /**
   * Method closures, by receiver and method, so that o.f === o.f; by the
   * method, not its dispatch id, which an override shares with the method
   * super.f names, a closure of its own.
   */
  private readonly closures = new WeakMap<object, Map<Method, AsObject>>();
  private readonly builtinTraitsByName = new Map<string, Traits>();
  /** The primitives' traits, once a lookup has needed them, for the caches (receiverTraits). */
  private stringTraits: Traits | undefined = undefined;
  private numberTraits: Traits | undefined = undefined;
  private booleanTraits: Traits | undefined = undefined;
  /** The names for-ins go through, per object (see Enumeration). */
  private readonly enumerating = new WeakMap<object, Enumeration>();
  /** Where hasNextIn leaves the object and the index a for-in goes on from. */
  enumObject: Value = null;
  enumIndex = 0;
  /** Special traits: an activation's or a catch scope's, by descriptor. */
  private readonly scopeTraits = new WeakMap<object, Traits>();
  readonly specialized = new Map<AsObject, AsObject>();
  readonly empty: Scope = Object.assign([], { w: 0 });

  /**
   * `natives` are the natives by name, or a provider that makes them for
   * this runtime, so that a natives module can close over its runtime (as a
   * class of natives does, see natives/define.ts). The provider runs once,
   * when the runtime is made; what it returns is read when modules bind.
   */
  constructor(
    natives: NativesProvider,
    readonly classHooks: Record<string, ClassHook>,
    options: RuntimeOptions = {},
  ) {
    this.print = options.print ?? defaultPrint;
    this.debugger = options.debugger ?? false;
    this.compileAbc = options.compileAbc ?? null;
    this.files = options.files ?? memoryFiles();
    this.workerHost = options.workers ?? null;
    this.workerInit = options.worker ?? null;
    this.syncInit = options.sync ?? null;
    this.swfVersion = options.swfVersion ?? 31;
    this.apiVersion = checkApiVersion(options.apiVersion ?? API_VERSION);
    this.userVersions = [this.apiVersion];
    this.toJSONName = publicQname("toJSON", this.userVersions);
    const toStringName = publicQname("toString", this.userVersions);
    const valueOfName = publicQname("valueOf", this.userVersions);
    toStringName.cache = UNFILLED;
    valueOfName.cache = UNFILLED;
    this.stringPrimitiveOrder = [toStringName, valueOfName];
    this.numberPrimitiveOrder = [valueOfName, toStringName];
    this.objectTraits = new Traits("Object", null);
    this.objectTraits.dynamic = true;
    this.objectTraits.testsValues = true;
    this.classTraits = new Traits("Class", this.objectTraits);
    this.functionTraits = new Traits("Function", this.objectTraits);
    this.functionTraits.dynamic = true;
    this.natives = typeof natives === "function" ? natives(this) : natives;
  }

  /** Empty the inline caches, so that they keep no traits or code of what is being let go of. */
  forgetCaches(): void {
    invalidate();
  }

  // Names.

  ns(kind: number, uri: string | null): Namespace {
    return namespace(kind, uri);
  }

  privateNs(uri: string | null): Namespace {
    return new Namespace(5, uri);
  }

  name(
    N: Namespace[],
    V: number[],
    kind: number,
    indices: number[],
    name: string | null,
  ): Multiname {
    const attribute =
      kind === 0x0d || kind === 0x10 || kind === 0x12 || kind === 0x0e || kind === 0x1c;
    const mn = new Multiname(
      kind,
      indices.map((i) => N[i]),
      indices.map((i) => V[i]),
      name,
      attribute,
    );
    mn.domain = this.loading === this.root ? null : this.loading;
    mn.cache = UNFILLED;
    return mn;
  }

  /** A domain whose definitions are looked up after `parent`'s, as `new ApplicationDomain(parent)`. */
  childDomain(parent: Domain = this.root): Domain {
    this.children = true;
    return this.modules.newDomain(parent);
  }

  /**
   * The domain of the innermost code on the stack that a module defines,
   * as avmplus' AvmCore::codeContext; the root without one (see
   * Modules.domainOf). The stack is taken here, so that it has as many of
   * the caller's frames as the engine keeps.
   */
  codeDomain(): Domain {
    if (!this.children) {
      return this.root;
    }

    return this.modules.domainOf(new Error().stack) ?? this.root;
  }

  /**
   * `f`, which loads modules, with what it loads going into `domain`;
   * `builtin` for a player's own, whose code is not a domain's to
   * codeDomain, as avmplus skips builtin frames for the code context.
   */
  loadInto<T>(domain: Domain, f: () => T, builtin = false): T {
    const previous = this.loading;
    const wasBuiltin = this.loadingBuiltin;
    this.loading = domain;
    this.loadingBuiltin = builtin;
    try {
      return f();
    } finally {
      this.loading = previous;
      this.loadingBuiltin = wasBuiltin;
      if (this.children) {
        this.modules.locate();
      }
    }
  }

  typeName(_N: Namespace[], _V: number[], _S: number[][], base: number, param: number): TypeName {
    return new TypeName(base, [param]);
  }

  /** A multiname with its runtime namespace and name, from the stack. */
  runtimeName(mn: Multiname, ...parts: Value[]): Multiname {
    let namespaces: readonly (Namespace | null)[] = mn.namespaces;
    let versions = mn.versions;
    let k = 0;
    if (mn.runtimeNs) {
      const ns = parts[k++];
      namespaces = [this.namespaceOf(ns)];
      versions = [255];
    }

    const kind =
      mn.kind === CONSTANT_RTQname ||
      mn.kind === CONSTANT_RTQnameA ||
      mn.kind === CONSTANT_RTQnameL ||
      mn.kind === CONSTANT_RTQnameLA
        ? CONSTANT_Qname
        : mn.kind;
    let name = mn.name;
    if (mn.runtimeName) {
      const part = parts[k];
      if (part?.$local !== undefined && !(part instanceof Namespace)) {
        // A Proxy's QName of a multiname names its namespaces still.
        if (part.$mn) {
          return part.$mn;
        }

        // A QName names its own namespace, null for any, and local name,
        // null for any, and may be an attribute's.
        // Bindings compare interned namespaces: an XML name's has a prefix.
        const qualified = new Multiname(
          CONSTANT_Qname,
          [part.$ns ? part.$ns.interned : null],
          [255],
          part.$local,
          mn.attribute || part.$attr === true,
        );
        qualified.domain = mn.domain;
        return qualified;
      } else if (typeof part === "object" && part !== null && !(part instanceof FloatValue)) {
        // Its string only once a lookup needs it: a Dictionary does not.
        const keyed = Multiname.keyed(kind, namespaces, versions, part, mn.attribute, this.keyName);
        keyed.domain = mn.domain;
        return keyed;
      } else {
        name = typeof part === "string" ? part : this.toString(part);
      }
    }

    const named = new Multiname(kind, namespaces, versions, name, mn.attribute);
    named.domain = mn.domain;
    return named;
  }

  /** An object's string, as the name of an object that is not a Dictionary. */
  private readonly keyName = (key: unknown): string => this.toString(key as Value);

  /** The runtime namespace a Namespace value stands for. */
  namespaceOf(value: Value): Namespace {
    if (value instanceof Namespace) {
      return value.interned;
    }

    if (value && value.$ns instanceof Namespace) {
      return value.$ns.interned;
    }

    throw this.error("TypeError", 1034, this.describe(value), "Namespace");
  }

  /** A Namespace constant, as the AS3 Namespace object it is. */
  namespace(ns: Namespace): Value {
    return ns;
  }

  cls(ns: Namespace, name: string): ClassRef {
    const domain = this.loading;
    let byName = domain.classRefs.get(ns);
    if (!byName) {
      byName = new Map();
      domain.classRefs.set(ns, byName);
    }

    let ref = byName.get(name);
    if (!ref) {
      ref = new ClassRef(ns, name, domain);
      byName.set(name, ref);
    }

    return ref;
  }

  vector(param: TypeRef): VectorRef {
    let ref = this.vectorRefs.get(param);
    if (!ref) {
      ref = new VectorRef(param);
      this.vectorRefs.set(param, ref);
    }

    return ref;
  }

  // Modules and scripts.

  /** Load a module: its scripts' names become visible; the entry script of a non-builtin module runs. */
  abc(desc: AbcDesc): Abc {
    // The stack taken here has this frame first and the module's factory second.
    return this.modules.load(desc, this.loading, this.loadingBuiltin ? null : new Error());
  }

  /**
   * A creator of contested function `m` of `abc` claims it as it first runs,
   * by its scope chain's index among those the function is created in (the
   * codegen's captureFunction): the first claim stands, as avmplus' first
   * verified creator gives the function its scope chain, and a creator in
   * another fails as avmplus fails it, with VerifyError 1107, each time it is
   * called. Called by compiled code.
   */
  claim(abc: Abc, m: number, scope: number): void {
    let claims = abc.claims;
    if (!claims) {
      claims = new Map();
      abc.claims = claims;
    }

    const claimed = claims.get(m);
    if (claimed === undefined) {
      claims.set(m, scope);
    } else if (claimed !== scope) {
      throw this.error("VerifyError", 1107);
    }
  }

  /** Run a module's entry point, its last script, as avmshell does. */
  run(abc: Abc): void {
    const scripts = abc.scriptStates;
    this.initScript(scripts[scripts.length - 1]);
  }

  /** The global object of a script, made the first time it is needed. */
  globalOf(script: Script): AsObject {
    if (!script.global) {
      if (script.desc.traits.error) {
        throw this.error("VerifyError", script.desc.traits.error);
      }

      const traits = new Traits("global", this.objectTraits);
      traits.dynamic = true;
      traits.isGlobal = true;
      traits.describe(script.desc.traits);
      const g = traits.instance();
      // As the script's initializer, its methods run in an empty scope chain,
      // as avmplus' script traits' declaring scope is, and as the compiler
      // indexes the scopes their closures capture: the global object is
      // only what they push.
      for (const [d, factory, id, , params] of script.desc.traits.methods) {
        installMethod(
          this,
          traits.methodHome(3),
          d,
          withId(factory(this.empty, null), id),
          factory,
          params,
        );
      }

      // Caches keep the methods.
      invalidate();

      script.global = g;
    }

    return script.global;
  }

  /** Run a script's initializer, once. */
  initScript(script: Script, retry = false): AsObject {
    // As avmplus' Toplevel, which is made from the script defining Object
    // before any other runs: builtin scripts refer to each other, as the
    // one defining Object makes XML while XML's needs Object.
    if (!this.toplevelReady) {
      this.toplevelReady = true;
      const toplevel = this.findScript(publicQname("Object", this.userVersions));
      this.toplevel = toplevel;
      if (toplevel && toplevel !== script) {
        this.initScript(toplevel);
      }
    }

    const g = this.globalOf(script);
    if (script.state === 0 || (retry && script.state === 3)) {
      script.state = 1;
      try {
        script.desc.init(this.empty, null).call(g);
      } catch (e) {
        script.state = 3;
        throw e;
      }

      script.state = 2;
      if (script === this.toplevel) {
        this.arrayConversion.noteConversions();
      }
    }

    return g;
  }

  private toplevelReady = false;
  private toplevel: Script | null = null;

  /**
   * The script that defines `mn`, kept on the multiname once found: the
   * first definition of a name wins, so later modules cannot change it.
   */
  private definingScript(mn: Multiname): Script | null {
    const known = mn.script;
    if (known) {
      return known;
    }

    const script = this.findScript(mn);
    mn.script = script;
    return script;
  }

  /** The script that defines `mn` in its domain, or null (see findScript in domain.ts). */
  findScript(mn: Multiname, asType = false): Script | null {
    return findScript(mn.domain ?? this.root, mn, asType);
  }

  /** What an ABC loaded into `domain` now compiles in. */
  compileUnit(domain: Domain): CompileUnit {
    return compileUnit(domain);
  }

  // Scopes and name lookup.

  /** The scope chain a function or class made here runs in: the chain captured, then the method's own scopes. */
  scope(outer: Scope, locals: Value[], withs: number): Scope {
    const chain = outer.concat(locals) as Scope;
    chain.w = outer.w | (withs << outer.length);
    return chain;
  }

  /**
   * The global object of the script that defines `mn`, run first if it has
   * not run. A module reads `mn.global` before calling this: once set it
   * stays right, as the defining script never changes and initScript
   * returns its global object without running it again.
   */
  findDef(mn: Multiname): AsObject {
    const script = this.definingScript(mn);
    if (!script) {
      throw this.error("ReferenceError", 1065, mn.toString());
    }

    const g = this.initScript(script);
    mn.global = g;
    return g;
  }

  /**
   * As MethodEnv::findproperty: the scope that has `mn`, from the innermost,
   * a with scope by any property and another by its traits; then a script
   * that defines it; then the global object's own properties.
   */
  findProperty(
    mn: Multiname,
    outer: Scope,
    locals: Value[],
    withs: number,
    strict = false,
  ): AsObject {
    for (let i = locals.length - 1; i >= 0; i--) {
      if (this.scopeHas(locals[i], mn, (withs >> i) & 1)) {
        return locals[i];
      }
    }

    for (let i = outer.length - 1; i >= 0; i--) {
      if (this.scopeHas(outer[i], mn, (outer.w >> i) & 1)) {
        return outer[i];
      }
    }

    return this.global(mn, outer.length ? outer[0] : locals[0], strict);
  }

  findPropertyStrict(mn: Multiname, outer: Scope, locals: Value[], withs: number): AsObject {
    return this.findProperty(mn, outer, locals, withs, true);
  }

  findGlobal(mn: Multiname, global: AsObject): AsObject {
    return this.global(mn, global, false);
  }

  findGlobalStrict(mn: Multiname, global: AsObject): AsObject {
    return this.global(mn, global, true);
  }

  private global(mn: Multiname, global: AsObject, strict: boolean): AsObject {
    const script = this.definingScript(mn);
    if (script) {
      const g = this.initScript(script);
      mn.global = g;
      return g;
    }

    if (global != null && this.hasProperty(global, mn)) {
      return global;
    }

    if (strict) {
      throw this.error("ReferenceError", 1065, mn.toString());
    }

    return global;
  }

  private scopeHas(o: AsObject, mn: Multiname, isWith: number): boolean {
    if (isWith) {
      return this.withHas(o, mn);
    }

    return this.traitsOf(o).find(mn) !== 0;
  }

  /**
   * As MethodEnv::findWithProperty: a with scope has `mn` if it, or an
   * object on its prototype chain, binds it in its traits or has it itself.
   * An E4X filter asks this of every item, and finds XML's methods on
   * XML.prototype.
   */
  private withHas(o: Value, mn: Multiname): boolean {
    if (this.delegateHas(o, mn, true)) {
      return true;
    }

    // An activation or a catch scope has no prototype.
    for (let p = this.protoOf(o); p; p = p.$p) {
      if (this.delegateHas(p, mn, false)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether `d` binds `mn` in its traits, which no attribute is, or has it
   * itself, as hasMultinameProperty: the scope object a key of a
   * Dictionary, what a hooked class says (an XML's children and
   * attributes, a Proxy's hasProperty), an element or a dynamic property;
   * a prototype on its chain an element or a property of its own.
   */
  private delegateHas(d: Value, mn: Multiname, scope: boolean): boolean {
    const traits = this.traitsOf(d);
    if (!mn.attribute && traits.find(mn) !== 0) {
      return true;
    }

    if (!scope) {
      const name = mn.dynamicName();
      return name !== null && this.protoOwn(d, name) !== NOT_FOUND;
    }

    if (mn.key !== undefined && d?.$keys !== undefined) {
      if (d.$keys.has(mn.key)) {
        return true;
      }

      const named = this.namespaceKeyName(mn);
      return named !== null && this.delegateHas(d, named, scope);
    }

    if (traits.properties !== null) {
      return traits.properties.has(this, d, mn);
    }

    const name = mn.dynamicName();
    if (name === null) {
      return false;
    }

    return this.indexHas(d, name) ?? this.getOwn(d, name) !== NOT_FOUND;
  }

  // Properties.

  /** The traits of any value: a primitive's are its class's. */
  traitsOf(v: Value): Traits {
    switch (typeof v) {
      case "object":
      case "function":
        if (v === null) {
          throw this.error("TypeError", 1009);
        }

        return v instanceof FloatValue
          ? this.builtinTraits("float")
          : v instanceof Namespace
            ? this.builtinTraits("Namespace")
            : v.$traits;
      // As avmplus' toVTable: every number is a Number at run time, int or
      // not; int's and uint's traits only bind early, from static types.
      case "number":
        return this.builtinTraits("Number");
      case "string":
        return this.builtinTraits("String");
      case "boolean":
        return this.builtinTraits("Boolean");
      default:
        throw this.error("TypeError", 1010);
    }
  }

  /**
   * The traits a cache knows `v` by, as traitsOf's, without a lookup:
   * undefined for null, undefined, a Namespace (whose traits are not its
   * own) and a primitive before its class's traits are known.
   */
  private receiverTraits(v: Value): Traits | undefined {
    switch (typeof v) {
      case "object":
      case "function":
        return v instanceof FloatValue
          ? this.builtinTraits("float")
          : v === null
            ? undefined
            : v.$traits;
      case "string":
        return this.stringTraits;
      case "number":
        return this.numberTraits;
      case "boolean":
        return this.booleanTraits;
      default:
        return undefined;
    }
  }

  /** A builtin class's instance traits, by name, resolved once. */
  private builtinTraits(name: string): Traits {
    let traits = this.builtinTraitsByName.get(name);
    if (!traits) {
      traits = this.builtinClass(name).$it as Traits;
      this.builtinTraitsByName.set(name, traits);
      switch (name) {
        case "String":
          this.stringTraits = traits;
          break;
        case "Number":
          this.numberTraits = traits;
          break;
        case "Boolean":
          this.booleanTraits = traits;
          break;
      }
    }

    return traits;
  }

  /** A public class of the builtins, by name, kept once resolved. */
  builtinClass(name: string): AsObject {
    let cls = this.builtinClasses.get(name);
    if (!cls) {
      cls = this.resolve(this.cls(publicNs, name));
      this.builtinClasses.set(name, cls);
    }

    return cls;
  }

  private readonly builtinClasses = new Map<string, AsObject>();

  /** What Number(array) runs unless a script replaced it. */
  private readonly arrayConversion = new ArrayConversion();

  /** The builtin Array class's instance traits, once its static initializer has run. */
  private arrayTraits: Traits | null = null;

  /** Notes the builtin Array class, once its static initializer has run. */
  noteArrayClass(cls: AsObject): void {
    this.arrayTraits = cls.$it;
    this.arrayConversion.noteArrayClass(cls);
  }

  prototypeOf(ref: TypeRef): AsObject {
    return this.classOf(ref).$it.proto;
  }

  // Where the runtime calls a function for a SWF's code, a getter, a
  // method or a function value, or calls on to the runtime's own function
  // that does, it never returns the call directly but through a variable
  // assigned apart (`let r; r = f(); return r;`). JavaScriptCore makes a
  // strict `return f()` a proper tail call, which drops the caller's frame,
  // so that the stack a security check reads would lose the runtime's
  // frames between a SWF's code and the function it called through them;
  // minifiers fold `const r = f(); return r;` back into `return f()`,
  // but keep this form (as `return r = f(), r`).
  getProperty(o: Value, mn: Multiname): Value {
    let r: Value;
    const e = cached(this.receiverTraits(o), mn);
    if (e !== null) {
      switch (e.kind) {
        case IC_Slot:
        case IC_Const:
          return o[e.key];
        case IC_Get:
        case IC_GetSet:
          r = (e.get as Method).call(o);
          return r;
        case IC_Method:
          return this.methodClosure(o, e.traits as Traits, e.id);
        case IC_Dynamic: {
          const d: Map<string, Value> | null = o.$d;
          if (d) {
            const v = d.get(e.key);
            if (v !== undefined || d.has(e.key)) {
              return v;
            }
          }

          // Not its own: its prototypes', as a method on Array.prototype.
          if (mn.key === undefined) {
            const v = this.protoValue(o, e.key);
            if (v !== NOT_FOUND) {
              return v;
            }
          }
        }
      }
    }

    // A Dictionary's object key, before its traits, as DictionaryObject's.
    if (mn.key !== undefined && o?.$keys !== undefined) {
      const v = o.$keys.get(mn.key);
      if (v !== undefined) {
        return v;
      }

      const named = this.namespaceKeyName(mn);
      return named === null ? undefined : this.getProperty(o, named);
    }

    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    this.fill(o, traits, b, mn);
    if (traits.properties !== null && hookedBinding(b, mn, traits.properties)) {
      return traits.properties.get(this, o, mn);
    }

    if (b !== 0) {
      return this.getBound(o, traits, b, mn);
    }

    const name = mn.dynamicName();
    if (name !== null) {
      const own = this.getOwn(o, name);
      if (own !== NOT_FOUND) {
        return own;
      }

      for (let p = this.protoOf(o); p; p = p.$p) {
        const v = this.protoOwn(p, name);
        if (v !== NOT_FOUND) {
          return v;
        }
      }
    }

    // A dynamic object has any dynamic name, but no other: obj.ns::x throws.
    if (traits.dynamic && !traits.refusesNames && name !== null) {
      return undefined;
    }

    // As ScriptObject::getMultinameProperty: an object's namespace set that
    // is no dynamic name has an error of its own; a primitive's has not.
    const object = typeof o === "object" && o !== null && !(o instanceof Namespace);
    const nsset =
      object &&
      (mn.kind === CONSTANT_Multiname ||
        mn.kind === CONSTANT_MultinameA ||
        mn.kind === CONSTANT_MultinameL ||
        mn.kind === CONSTANT_MultinameLA);
    throw this.error(
      "ReferenceError",
      name === null && nsset ? 1081 : 1069,
      mn.name ?? "*",
      traits.name,
    );
  }

  /**
   * obj[i] for a number i, as avmplus' getUintProperty: a Vector's,
   * ByteArray's or Array's element directly; anything else, or a hole, by
   * the name the number makes.
   */
  getIndexed(o: Value, mn: Multiname, i: number): Value {
    if (
      typeof o === "object" &&
      o !== null &&
      i >>> 0 === i &&
      i !== 0xffffffff &&
      mn.elementName
    ) {
      const traits: Traits | undefined = o.$traits;
      if (traits?.getIndex) {
        return traits.getIndex(o, i, this);
      }

      const a: Value[] | undefined = o.$a;
      if (a !== undefined && i in a) {
        return a[i];
      }
    }

    return this.getProperty(o, this.runtimeName(mn, i));
  }

  /** obj[i] = v for a number i, as avmplus' setUintProperty. */
  setIndexed(o: Value, mn: Multiname, i: number, v: Value): void {
    if (typeof o === "object" && o !== null && i >>> 0 === i && mn.elementName) {
      // The JIT hands a typed index to setUintProperty even at 2^32-1, which is no
      // property name: a ByteArray fails to grow to it, a Vector is out of range.
      const traits: Traits | undefined = o.$traits;
      if (traits?.setIndex) {
        traits.setIndex(o, i, v, this);
        return;
      }

      if (o.$a !== undefined && o.$a !== SEALED_ELEMENTS && i !== 0xffffffff) {
        o.$a[i] = v;
        return;
      }
    }

    this.setProperty(o, this.runtimeName(mn, i), v);
  }

  /**
   * Element i of Vector o set to x, already converted, as
   * VectorBaseObject::setUintProperty checks it: against the length and
   * fixedness as they are after the conversion, which can run AS3 that
   * changes them, into the elements the Vector has then, through its
   * kind's store (see vector-elements.ts). A number that is no index, as
   * NaN, is out of range too, as _setDoubleProperty finds it.
   */
  setElement(o: AsObject, i: number, x: Value, store: ElementStore): void {
    const a: Value[] = o.$a;
    if (i >>> 0 !== i || i > a.length || (i === a.length && o.$fixed)) {
      throw this.error("RangeError", 1125, i, a.length);
    }

    store(a, i, x);
  }

  // obj[i] for a Vector the code was compiled against, by the kind of its
  // elements: a function for each, so that each sees one kind of array. As
  // TypedVectorObject's _getDoubleProperty and _setDoubleProperty: an index
  // past the end, or a number that is no index, NaN among them, is a
  // RangeError, a set's after it converts the value (setElement); for
  // anything else, such as a null Vector, getIndexed and setIndexed.

  vectorGetInt(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >>> 0 === i && i < a.length) {
        return a[i];
      }

      throw this.error("RangeError", 1125, i, a.length);
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetInt(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && mn.elementName) {
      this.setElement(o, i, this.toInt(v), storeInt);
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  vectorGetUint(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >>> 0 === i && i < a.length) {
        return a[i];
      }

      throw this.error("RangeError", 1125, i, a.length);
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetUint(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && mn.elementName) {
      this.setElement(o, i, this.toUint(v), storeDouble);
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  vectorGetDouble(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >>> 0 === i && i < a.length) {
        return a[i];
      }

      throw this.error("RangeError", 1125, i, a.length);
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetDouble(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && mn.elementName) {
      this.setElement(o, i, this.toNumber(v), storeDouble);
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  vectorGetObject(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >>> 0 === i && i < a.length) {
        return a instanceof FloatVector ? this.float(a.data[i]) : a[i];
      }

      throw this.error("RangeError", 1125, i, a.length);
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetObject(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && mn.elementName) {
      const value = o.$traits.cls.$convert(this, o.$traits.cls, v);
      if (o.$a instanceof FloatVector) {
        setFloatElement(this, o, i, value);
      } else {
        this.setElement(o, i, value, storeObject);
      }

      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  /** Unboxed access for code compiled against Vector.<float>; dynamic access uses its hooks. */
  vectorGetFloat(o: Value, mn: Multiname, i: number): number {
    if (o !== null && o !== undefined && mn.elementName) {
      const a: FloatVector = o.$a;
      if (i >>> 0 === i && i < a.length) {
        return a.data[i];
      }

      throw this.error("RangeError", 1125, i, a.length);
    }

    return this.toNumber(this.getIndexed(o, mn, i));
  }

  vectorSetFloat(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && mn.elementName) {
      setFloatElement(this, o, i, this.toNumber(v));
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  /** An object's own dynamic or indexed property, or NOT_FOUND. */
  getOwn(o: Value, name: string): Value {
    if (typeof o !== "object" || o === null) {
      return NOT_FOUND;
    }

    // Elements: a class's own indexing (a Vector's, a ByteArray's), else an Array's.
    const traits: Traits | undefined = o.$traits;
    if (traits?.getIndex || o.$a !== undefined) {
      const i = traits?.index ? traits.index(o, name, this) : arrayIndex(name);
      if (i >= 0) {
        return traits?.getIndex ? traits.getIndex(o, i, this) : i in o.$a ? o.$a[i] : NOT_FOUND;
      }
    }

    const d: Map<string, Value> | null = o.$d;
    if (d?.has(name)) {
      return d.get(name);
    }

    return NOT_FOUND;
  }

  /**
   * A prototype's own dynamic property `name`, or NOT_FOUND: an element
   * too for one with elements, as Array.prototype, an Array, has them.
   */
  /**
   * Dynamic property `name` of a prototype of `o`, an object of dynamic
   * traits with no binding of it, or NOT_FOUND: as the full lookup goes on
   * from `o` to its prototypes.
   */
  private protoValue(o: AsObject, name: string): Value {
    for (let p = typeof o === "object" ? o.$p : this.protoOf(o); p; p = p.$p) {
      const v = this.protoOwn(p, name);
      if (v !== NOT_FOUND) {
        return v;
      }
    }

    return NOT_FOUND;
  }

  private protoOwn(p: AsObject, name: string): Value {
    const a: Value[] | undefined = p.$a;
    if (a !== undefined) {
      const c = name.charCodeAt(0);
      if (c >= 0x30 && c <= 0x39) {
        const i = arrayIndex(name);
        if (i >= 0) {
          return i in a ? a[i] : NOT_FOUND;
        }
      }
    }

    const d: Map<string, Value> | null | undefined = p.$d;
    if (d) {
      const v = d.get(name);
      if (v !== undefined || d.has(name)) {
        return v;
      }
    }

    return NOT_FOUND;
  }

  private getBound(o: Value, traits: Traits, b: number, mn: Multiname): Value {
    let r: Value;
    const id = b >> 3;
    switch (b & 7) {
      case BIND_Var:
      case BIND_Const:
        return o[slotKey(id)];
      case BIND_Get:
      case BIND_GetSet:
        r = traits.proto[methodKey(id)].call(o);
        return r;
      case BIND_Method:
        return this.methodClosure(o, traits, id);
      case BIND_Set: {
        const slot = traits.hooks?.setOnlySlots?.[mn.name ?? ""];
        if (slot !== undefined) {
          return o[slot];
        }

        throw this.error("ReferenceError", 1077, mn.name ?? "*", traits.name);
      }
      default:
        throw this.error("ReferenceError", 1077, mn.name ?? "*", traits.name);
    }
  }

  /** fillCache (cache-fill.ts), for a name that caches on traits a cache knows `o` by. */
  private fill(o: Value, traits: Traits, b: number, mn: Multiname): void {
    const head = mn.cache;
    if (
      head === NO_CACHE ||
      (head.replaced === REPLACEMENTS && head.epoch === epoch()) ||
      this.receiverTraits(o) !== traits
    ) {
      return;
    }

    fillCache(head, o, traits, b, mn);
  }

  /** Method `id` of `o` bound to it, the same function each time. */
  methodClosure(o: Value, traits: Traits, id: number): AsObject {
    const method: Method = traits.proto[methodKey(id)];
    const key = typeof o === "object" ? o : traits.proto;
    let byMethod = this.closures.get(key);
    if (!byMethod) {
      byMethod = new Map();
      this.closures.set(key, byMethod);
    }

    let f = typeof o === "object" ? byMethod.get(method) : undefined;
    if (!f) {
      f = this.newFunctionObject(
        (method as CountedMethod).$min === undefined
          ? (...args: Value[]) => {
              // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
              let r: Value;
              r = method.apply(o, args);
              return r;
            }
          : (...args: Value[]) => this.callBound(method, o, args),
        null,
      );
      // Its length is the method's declared parameters, not the wrapper's: a
      // native's from its ABC, a compiled method's from the parameters it declares.
      f.$length = (method as CountedMethod).$length ?? method.length;
      f.$id = (method as Method & { $id?: number }).$id ?? 0;
      f.$closure = true;
      if (typeof o === "object") {
        byMethod.set(method, f);
      }
    }

    return f;
  }

  setProperty(o: Value, mn: Multiname, v: Value, init = false): void {
    const e = cached(this.receiverTraits(o), mn);
    if (e !== null) {
      switch (e.kind) {
        case IC_Slot:
          o[e.key] = e.type === null ? v : this.coerce(v, e.type);
          return;
        case IC_Set:
        case IC_GetSet:
          (e.set as Method).call(o, v);
          return;
        case IC_Dynamic: {
          const d: Map<string, Value> | null = o.$d;
          if (d) {
            d.set(e.key, v);
            return;
          }
        }
      }
    }

    if (mn.key !== undefined && o?.$keys !== undefined) {
      const keys: DictionaryKeys = o.$keys;
      if (keys.replace(mn.key as object, v)) {
        return;
      }

      const named = this.namespaceKeyName(mn);
      if (named === null) {
        keys.add(mn.key as object, v);
      } else {
        this.setProperty(o, named, v, init);
      }

      return;
    }

    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    this.fill(o, traits, b, mn);
    if (traits.properties !== null && hookedBinding(b, mn, traits.properties)) {
      traits.properties.set(this, o, mn, v);
      return;
    }

    if (b !== 0) {
      const id = b >> 3;
      switch (b & 7) {
        case BIND_Const:
          if (!init) {
            throw this.error("ReferenceError", 1074, mn.name ?? "*", traits.name);
          }
          o[slotKey(id)] = this.coerce(v, traits.slotType(id));
          return;
        case BIND_Var:
          o[slotKey(id)] = this.coerce(v, traits.slotType(id));
          return;
        case BIND_Set:
        case BIND_GetSet:
          (traits.proto[untypedSetKey(id + 1)] ?? traits.proto[methodKey(id + 1)]).call(o, v);
          return;
        case BIND_Method:
          throw this.error("ReferenceError", 1037, mn.name ?? "*", traits.name);
        default:
          throw this.error("ReferenceError", 1074, mn.name ?? "*", traits.name);
      }
    }

    const name = mn.dynamicName();
    if (name !== null && typeof o === "object") {
      if (traits.setIndex || (o.$a !== undefined && o.$a !== SEALED_ELEMENTS)) {
        const i = traits.index ? traits.index(o, name, this) : arrayIndex(name);
        if (i >= 0) {
          if (traits.setIndex) {
            traits.setIndex(o, i, v, this);
          } else {
            o.$a[i] = v;
          }

          return;
        }
      }

      if (o.$d && !traits.refusesNames) {
        o.$d.set(name, v);
        return;
      }
    }

    throw this.error("ReferenceError", 1056, mn.name ?? "*", traits.name);
  }

  initProperty(o: Value, mn: Multiname, v: Value): void {
    this.setProperty(o, mn, v, true);
  }

  deleteProperty(o: Value, mn: Multiname): boolean {
    if (mn.key !== undefined && o?.$keys !== undefined) {
      if (o.$keys.delete(mn.key)) {
        return true;
      }

      const named = this.namespaceKeyName(mn);
      return named === null || this.deleteProperty(o, named);
    }

    // A primitive's property cannot be deleted, as MethodEnv's delproperty has it.
    if (typeof o !== "object" || o instanceof Namespace) {
      throw this.error("ReferenceError", 1120, mn.name ?? "*", this.traitsOf(o).name);
    }

    // E4X 11.3.1: delete x[list] is a TypeError, as in delete x.a.(b == 1).
    if ((mn.key as Value)?.$nodes !== undefined) {
      throw this.error("TypeError", 1119, "XMLList");
    }

    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    if (traits.properties !== null && hookedBinding(b, mn, traits.properties)) {
      return traits.properties.delete(this, o, mn);
    }

    if (b !== 0) {
      return false;
    }

    const name = mn.dynamicName();
    if (name !== null && typeof o === "object") {
      if (o.$a !== undefined && o.$a !== SEALED_ELEMENTS) {
        const i = arrayIndex(name);
        if (i >= 0) {
          return delete o.$a[i];
        }
      }

      // A name deleted is enumerable again when set anew, as avmplus has it.
      o.$dontEnum?.delete(name);
      return o.$d ? o.$d.delete(name) || true : false;
    }

    return false;
  }

  /**
   * The name a Dictionary's key stands for when it is a Namespace, else
   * null. avmplus keys a Dictionary by an object only (isDictionaryLookup),
   * and a Namespace is none: it names its uri, as AvmCore::intern has it.
   * Asked only once the key is not there, as a Namespace never is, so that
   * a key found pays nothing for it.
   */
  private namespaceKeyName(mn: Multiname): Multiname | null {
    if (!(mn.key instanceof Namespace)) {
      return null;
    }

    const named = new Multiname(mn.kind, mn.namespaces, mn.versions, mn.name, mn.attribute);
    named.domain = mn.domain;
    return named;
  }

  /** The `in` operator: whether `o` has the public property `name`. */
  in(name: Value, o: Value): boolean {
    // As isDictionaryLookup: a Dictionary looks for any object itself, a
    // QName too. A Namespace is no object to avmplus: on a miss,
    // dictionaryHas looks for its uri as a name.
    if (
      typeof name === "object" &&
      name !== null &&
      !(name instanceof FloatValue) &&
      o?.$keys !== undefined
    ) {
      return this.dictionaryHas(o, name);
    }

    // As in_operator: a uint names an element the object itself has, or
    // for a primitive its prototype, as hasUintProperty finds it, not one
    // up the prototype chain.
    if (typeof name === "number" && name >>> 0 === name && name !== 0xffffffff) {
      return this.hasOwnIndex(
        typeof o === "object" && o !== null ? o : (this.protoOf(o) as AsObject),
        name,
      );
    }

    return this.hasProperty(o, publicQname(this.nameString(name), this.userVersions));
  }

  /** Whether `o` itself has element `i`: its class's indexing, an Array's, or a dynamic property. */
  private hasOwnIndex(o: AsObject, i: number): boolean {
    if (o instanceof Namespace) {
      return false;
    }

    const traits: Traits | undefined = o.$traits;
    if (traits?.properties) {
      return traits.properties.has(this, o, this.publicName(i));
    }

    if (traits?.hasIndex) {
      return traits.hasIndex(o, i);
    }

    if (o.$a !== undefined) {
      return i in o.$a;
    }

    return o.$d?.has(String(i)) ?? false;
  }

  /**
   * Whether Dictionary `o` has object key `key`, as in_operator finds it:
   * the key itself, then, made a string, on its prototype chain. A
   * Namespace names its uri, the Dictionary's own or its prototypes'.
   */
  private dictionaryHas(o: AsObject, key: object): boolean {
    return o.$keys.has(key) || this.dictionaryHasName(o, key);
  }

  /**
   * dictionaryHas once `key` is not there, apart so that the lookup of one
   * that is stays small enough to inline.
   */
  private dictionaryHasName(o: AsObject, key: object): boolean {
    if (key instanceof Namespace) {
      return this.hasProperty(o, publicQname(this.nameString(key), this.userVersions));
    }

    const name = this.toString(key);
    for (let p = this.protoOf(o); p; p = p.$p) {
      if (this.protoOwn(p, name) !== NOT_FOUND) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether a class that indexes itself (a Vector) has the element `name`,
   * which is there only within its length: undefined for a name that is
   * no number, or for another class.
   */
  private indexHas(o: Value, name: string): boolean | undefined {
    const traits: Traits | undefined = typeof o === "object" && o !== null ? o.$traits : undefined;
    if (!traits?.hasIndex) {
      return undefined;
    }

    const i = arrayIndex(name);
    if (i >= 0) {
      return traits.hasIndex(o, i);
    }

    // Another number, negative or fractional, is no index it has, as
    // VectorBaseObject::hasAtomProperty has it, where a get throws.
    const c = name.charCodeAt(0);
    if (((c >= 0x30 && c <= 0x39) || c === 0x2d) && !Number.isNaN(Number(name))) {
      return false;
    }

    return undefined;
  }

  /** Whether `o` has `mn`: bound, dynamic, or on its prototype chain. */
  hasProperty(o: Value, mn: Multiname): boolean {
    if (mn.key !== undefined && o?.$keys !== undefined) {
      return this.dictionaryHas(o, mn.key as object);
    }

    const own = this.traitsOf(o);
    const b = own.find(mn);
    if (own.properties !== null && hookedBinding(b, mn, own.properties)) {
      return own.properties.has(this, o, mn);
    }

    if (b !== 0) {
      return true;
    }

    const name = mn.dynamicName();
    if (name === null) {
      return false;
    }

    const indexed = this.indexHas(o, name);
    if (indexed !== undefined) {
      return indexed;
    }

    if (this.getOwn(o, name) !== NOT_FOUND) {
      return true;
    }

    for (let p = this.protoOf(o); p; p = p.$p) {
      if (this.protoOwn(p, name) !== NOT_FOUND) {
        return true;
      }
    }

    return false;
  }

  /** A value's AS3 prototype object: its class's prototype, or its own link for a prototype object. */
  protoOf(o: Value): AsObject | null {
    // A namespace is the runtime's own object: its prototype is its class's.
    if (
      typeof o === "object" &&
      o !== null &&
      !(o instanceof Namespace) &&
      !(o instanceof FloatValue)
    ) {
      return o.$p;
    }

    return this.traitsOf(o).proto.$p;
  }

  /**
   * A public name seen at every version, as the host and the natives reach
   * members, slots and all; what AS3 itself looks up by a string goes by
   * publicQname, at user code's version.
   */
  publicName(name: Value): Multiname {
    return qname(publicNs, this.nameString(name));
  }

  /** A property name as a string, as ToString makes one. */
  private nameString(name: Value): string {
    return typeof name === "string" ? name : this.toString(name);
  }

  // Calls.

  callProperty(o: Value, mn: Multiname, ...args: Value[]): Value {
    let r: Value;
    const e = cached(this.receiverTraits(o), mn);
    if (e !== null) {
      switch (e.kind) {
        case IC_Method:
        case IC_Call:
          r = this.callBound(e.get as CountedMethod, o, args);
          return r;
        case IC_Slot:
        case IC_Const:
          r = this.callValue(o[e.key], o, args, mn);
          return r;
        case IC_Get:
        case IC_GetSet:
          r = this.callValue((e.get as Method).call(o), o, args, mn);
          return r;
        case IC_Dynamic: {
          const d: Map<string, Value> | null = o.$d;
          if (d) {
            const v = d.get(e.key);
            if (v !== undefined || d.has(e.key)) {
              r = this.callValue(v, o, args, mn);
              return r;
            }
          }

          // Not its own: its prototypes', as a method on Array.prototype.
          if (mn.key === undefined) {
            const v = this.protoValue(o, e.key);
            if (v !== NOT_FOUND) {
              r = this.callValue(v, o, args, mn);
              return r;
            }
          }
        }
      }
    }

    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    this.fill(o, traits, b, mn);
    if ((b & 7) === BIND_Method) {
      r = this.callBound(traits.proto[methodKey(b >> 3)], o, args);
      return r;
    }

    r = this.callValue(this.callee(o, traits, b, mn), o, args, mn);
    return r;
  }

  /**
   * What callproperty calls, for a binding other than a method: its value,
   * else the property. As avmplus' callproperty, on a primitive a name its
   * class does not have is its prototype's, undefined if none has it, so
   * that calling it is a TypeError, where getting it is a ReferenceError.
   */
  private callee(o: Value, traits: Traits, b: number, mn: Multiname): Value {
    if (b !== 0) {
      return this.getBound(o, traits, b, mn);
    }

    if (traits.properties !== null) {
      return traits.properties.callee(this, o, mn);
    }

    // A name no dynamic property has, such as ns::x, fails as a get does.
    const name = mn.dynamicName();
    if (typeof o === "object" || name === null) {
      return this.getProperty(o, mn);
    }

    for (let p = this.protoOf(o); p; p = p.$p) {
      const v = this.protoOwn(p, name);
      if (v !== NOT_FOUND) {
        return v;
      }
    }

    return undefined;
  }

  /** callproplex: as callproperty, with no receiver. */
  callPropLex(o: Value, mn: Multiname, ...args: Value[]): Value {
    let r: Value;
    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      r = this.callBound(traits.proto[methodKey(b >> 3)], o, args);
      return r;
    }

    r = this.callValue(this.callee(o, traits, b, mn), null, args, mn);
    return r;
  }

  call(f: Value, receiver: Value, ...args: Value[]): Value {
    // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
    let r: Value;
    r = this.callValue(f, receiver, args, null);
    return r;
  }

  callValue(f: Value, receiver: Value, args: Value[], mn: Multiname | null): Value {
    let r: Value;
    if (f !== null && typeof f === "object") {
      if (f.$f) {
        r = f.$f.apply(receiver ?? f.$global ?? null, args);
        return r;
      }

      if (f.$it) {
        r = this.callClass(f, args);
        return r;
      }

      // A RegExp called is its exec of the argument's string, as RegExpObject::call has it.
      if (f.$re !== undefined) {
        this.execName ??= qname(namespace(NS_Public, "http://adobe.com/AS3/2006/builtin"), "exec");
        r = this.callProperty(f, this.execName, args.length ? this.toString(args[0]) : "");
        return r;
      }
    }

    throw this.error("TypeError", 1006, mn ? mn.name : "value");
  }

  /**
   * A method that failed its one test on entry: given fewer arguments than
   * `required` or more than `max` (-1 for any), else called where the
   * default XML namespace is not its own (callInDxns).
   */
  enter(
    dxns: Namespace,
    f: Method,
    receiver: Value,
    args: ArrayLike<Value>,
    required: number,
    max: number,
  ): Value {
    // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
    let r: Value;
    if (args.length < required || (max >= 0 && args.length > max)) {
      throw this.argumentCountError(required, args.length);
    }

    r = this.callInDxns(dxns, f, receiver, args);
    return r;
  }

  /**
   * A method called where the default XML namespace is not the one of the
   * scope it was made in, `dxns`: called again with it, and the caller's
   * back after.
   */
  callInDxns(dxns: Namespace, f: Method, receiver: Value, args: ArrayLike<Value>): Value {
    const caller = this.defaultXmlNamespace;
    this.defaultXmlNamespace = dxns;
    try {
      return f.apply(receiver, args as Value[]);
    } finally {
      this.defaultXmlNamespace = caller;
    }
  }

  private execName: Multiname | null = null;

  callInterface(iface: TypeRef, disp: number, o: Value, ...args: Value[]): Value {
    let r: Value;
    const cls = this.classOf(iface);
    // The interface's layout names the method; the receiver binds that name.
    const desc = cls.$desc as ClassDesc;
    for (const [ns, , name, b] of desc.instance.bindings) {
      if (b >> 3 === disp && (b & 7) === BIND_Method) {
        r = this.callProperty(o, qname(ns, name), ...args);
        return r;
      }
    }

    throw this.error("TypeError", 1006, "method");
  }

  /**
   * The key of the method an interface's method, dispatch id `disp` in
   * the interface's layout, is on `o`, an object of a class that
   * implements it: its entry for bound calls, as a call through the
   * interface coerces its arguments to the interface's signature, which
   * the class's method has too (checkInterfaces), and passes a count the
   * method takes. Generated code calls `o[key](...)` itself, so that each
   * site keeps its own feedback in the engine. Found by name once for
   * each class and interface, and kept on the class's traits. Only for a
   * member in a private namespace, which has no alias every implementing
   * class shares (see the codegen's interfaceCall).
   */
  interfaceKey(iface: TypeRef, disp: number, o: Value): string {
    const traits: Traits | undefined = o.$traits;
    const cls: AsObject = (iface as ClassRef).cls ?? this.classOf(iface);
    if (traits !== undefined && traits.lastInterface === cls.$it) {
      const key = traits.lastInterfaceKeys[disp];
      if (key !== undefined) {
        return key;
      }
    }

    return this.findInterfaceKey(cls, disp, o);
  }

  private findInterfaceKey(cls: AsObject, disp: number, o: Value): string {
    const it: Traits = cls.$it;
    const traits = this.traitsOf(o);
    traits.interfaceKeys ??= new Map();
    let keys = traits.interfaceKeys.get(it);
    if (!keys) {
      keys = [];
      traits.interfaceKeys.set(it, keys);
    }

    traits.lastInterface = it;
    traits.lastInterfaceKeys = keys;
    let key = keys[disp];
    if (key === undefined) {
      const desc = cls.$desc as ClassDesc;
      for (const [ns, , name, b] of desc.instance.bindings) {
        if (b >> 3 === disp && (b & 7) === BIND_Method) {
          // A class that implements the interface binds its name to a
          // method (checkInterfaces); anything else is not a function.
          const own = traits.find(qname(ns, name));
          if ((own & 7) !== BIND_Method) {
            throw this.error("TypeError", 1006, name);
          }

          key = boundKey(own >> 3);
          keys[disp] = key;
          return key;
        }
      }

      throw this.error("TypeError", 1006, "method");
    }

    return key;
  }

  callStatic(_abc: Abc, m: number, ..._args: Value[]): Value {
    throw this.unsupported(`callstatic ${m}`);
  }

  // The super operations, as MethodEnv's: by the base class's traits
  // alone, a name they do not bind a ReferenceError, not a dynamic property.

  callSuper(sup: AsObject, o: Value, mn: Multiname, ...args: Value[]): Value {
    let r: Value;
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      r = this.callBound(traits.proto[methodKey(b >> 3)], o, args);
      return r;
    }

    if (b === 0) {
      throw this.error("ReferenceError", 1070, mn.name ?? "*", traits.name);
    }

    r = this.callValue(this.getBound(o, traits, b, mn), o, args, mn);
    return r;
  }

  getSuper(sup: AsObject, o: Value, mn: Multiname): Value {
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    if (b === 0) {
      throw this.error("ReferenceError", 1069, mn.name ?? "*", traits.name);
    }

    return this.getBound(o, traits, b, mn);
  }

  setSuper(sup: AsObject, o: Value, mn: Multiname, v: Value): void {
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    const id = b >> 3;
    switch (b & 7) {
      case BIND_Set:
      case BIND_GetSet:
        (traits.proto[untypedSetKey(id + 1)] ?? traits.proto[methodKey(id + 1)]).call(o, v);
        return;
      case BIND_Var:
        o[slotKey(id)] = this.coerce(v, traits.slotType(id));
        return;
      case BIND_Method:
        throw this.error("ReferenceError", 1037, mn.name ?? "*", traits.name);
      case 0:
        throw this.error("ReferenceError", 1056, mn.name ?? "*", traits.name);
      default:
        throw this.error("ReferenceError", 1074, mn.name ?? "*", traits.name);
    }
  }

  constructSuper(sup: AsObject, o: Value, ...args: Value[]): void {
    sup.$it.proto.$init.apply(o, args);
  }

  construct(f: Value, ...args: Value[]): Value {
    return this.constructWith(f, args);
  }

  /** construct, its arguments as an array: constructProperty passes its own on, unspread. */
  constructWith(f: Value, args: Value[]): Value {
    if (f !== null && typeof f === "object") {
      // A method closure is not a constructor, as MethodClosure's construct has it.
      if (f.$closure) {
        throw this.error("TypeError", 1064, "function");
      }

      if (f.$it) {
        return this.constructClass(f, args);
      }

      if (f.$f) {
        return this.constructFunction(f, args);
      }
    }

    throw this.error("TypeError", 1007);
  }

  /**
   * A function as a constructor: a new Object whose prototype is the
   * function's. One whose prototype a script cleared gets Object's own
   * prototype object back at its first new, as avmplus reinitializes it,
   * so from then on every object is an instance of the function.
   */
  private constructFunction(f: AsObject, args: Value[]): Value {
    const o = this.objectTraits.instance();
    let p = this.functionPrototype(f);
    if (p === undefined) {
      p = this.builtinClass("Object").$prototype;
      f.$prototype = p;
      f.$noPrototype = false;
    }

    o.$p = p;
    const result = f.$f.apply(o, args);
    return result !== null && typeof result === "object" ? result : o;
  }

  constructProperty(o: Value, mn: Multiname, ...args: Value[]): Value {
    // As avmplus' constructprop: a primitive's, a Namespace's among them,
    // from its prototype, where a missing name is undefined.
    const primitive =
      (o !== null && o !== undefined && typeof o !== "object") || o instanceof Namespace;
    return this.constructWith(this.getProperty(primitive ? this.protoOf(o) : o, mn), args);
  }

  constructClass(cls: AsObject, args: Value[]): Value {
    const hook = this.hookOf(cls, "construct");
    if (hook) {
      return hook(this, cls, args);
    }

    const o = this.instantiate(cls);
    cls.$it.proto.$init.apply(o, args);
    return o;
  }

  /**
   * The first half of `new`: an instance of `cls` whose constructor has
   * yet to run, which constructSuper runs; null for a class a hook
   * constructs whole. A host that has to name an object before its
   * constructor runs, as Flash does a timeline's button, makes it so.
   */
  allocate(cls: AsObject): AsObject | null {
    if (this.hookOf(cls, "construct")) {
      return null;
    }

    return this.instantiate(cls);
  }

  /** allocate for a class with no construct hook, which constructClass has looked up already. */
  private instantiate(cls: AsObject): AsObject {
    // An interface's constructor is a method nothing implements, as avmplus words it.
    if (cls.$desc?.interface) {
      throw this.error("VerifyError", 1001, `${cls.$it.name}()`);
    }

    if (cls.$it.uninstantiable) {
      throw this.error("ArgumentError", 2012, cls.$it.name);
    }

    return cls.$it.instance();
  }

  /** A class called as a function: a conversion for the builtins, else a coercion. */
  callClass(cls: AsObject, args: Value[]): Value {
    const hook = this.hookOf(cls, "call");
    if (hook) {
      return hook(this, cls, args);
    }

    if (args.length !== 1) {
      throw this.error("ArgumentError", 1112, args.length);
    }

    return this.coerce(args[0], this.refOf(cls));
  }

  /** A builtin class's hook; hooks are not inherited, but a specialized Vector has its base's. */
  private hookOf(cls: AsObject, kind: "construct" | "call"): ClassHook["construct"] | null {
    // Looked up once, then kept on the class.
    const key = kind === "construct" ? "$constructHook" : "$callHook";
    let hook = cls[key];
    if (hook === undefined) {
      hook = (cls.$it as Traits).hooks?.[kind] ?? null;
      cls[key] = hook;
    }

    return hook;
  }

  /** See specializeVector in classes.ts. */
  specializeVector(base: AsObject, param: AsObject): AsObject {
    return specializeVector(this, base, param);
  }

  // Objects, functions and classes.

  newObject(pairs: Value[]): AsObject {
    const o = this.objectTraits.instance();
    for (let i = 0; i < pairs.length; i += 2) {
      o.$d.set(this.toString(pairs[i]), pairs[i + 1]);
    }

    return o;
  }

  newArray(values: Value[]): AsObject {
    return this.array(values);
  }

  /** An Array holding `values`. */
  array(values: Value[]): AsObject {
    const o = this.builtinTraits("Array").instance();
    o.$a = values;
    return o;
  }

  /**
   * A method's `arguments`: every argument it was called with, declared or
   * not, and as `callee`, not enumerable, the method's Function object,
   * the one a newfunction made for it, so that `arguments.callee === f`,
   * else one made for it once, as avmplus' MethodClosure is.
   */
  arguments(args: IArguments, callee: Method): AsObject {
    const o = this.array(Array.prototype.slice.call(args));
    let f = this.functionObjects.get(callee);
    if (!f) {
      f = this.newFunctionObject(callee, null);
      this.functionObjects.set(callee, f);
    }

    o.$d.set("callee", f);
    o.$dontEnum = new Set(["callee"]);
    return o;
  }

  /** Each method's Function object, by the method, for arguments.callee. */
  private readonly functionObjects = new WeakMap<Method, AsObject>();

  newFunction(factory: Factory, scope: Scope, id = 0): AsObject {
    const method = factory(scope, null);
    const f = this.newFunctionObject(method, scope.length ? scope[0] : null);
    f.$id = id;
    this.functionObjects.set(method, f);
    return f;
  }

  /** A Function object calling `f`, with `global` as its receiver when it has none. */
  newFunctionObject(f: Method, global: AsObject | null): AsObject {
    const o = this.functionTraits.instance();
    o.$f = f;
    o.$global = global;
    o.$id = 0;
    return o;
  }

  /** A function's prototype, made when first asked for; undefined once a script has cleared it. */
  functionPrototype(f: AsObject): AsObject | undefined {
    if (!f.$prototype && !f.$noPrototype) {
      const p = this.objectTraits.instance();
      p.$d.set("constructor", f);
      p.$dontEnum = new Set(["constructor"]);
      f.$prototype = p;
    }

    return f.$prototype;
  }

  newActivation(desc: TraitsDesc): AsObject {
    let traits = this.scopeTraits.get(desc);
    if (!traits) {
      traits = new Traits("activation", null);
      traits.describe(desc);
      this.scopeTraits.set(desc, traits);
    }

    return traits.instance();
  }

  newCatch(mn: Multiname | null): AsObject {
    const key = mn ?? this;
    let traits = this.scopeTraits.get(key);
    if (!traits) {
      traits = new Traits("catch", null);
      if (mn?.name) {
        traits.describe({
          slots: 1,
          defaults: [[0, undefined, null]],
          bindings: [[mn.namespaces[0] as Namespace, 0, mn.name, BIND_Var]],
          methods: [],
        });
      }

      this.scopeTraits.set(key, traits);
    }

    return traits.instance();
  }

  /**
   * As OP_newclass: a class from its module's descriptor, extending `base`,
   * its methods bound to the scope chain here (see newClass in classes.ts).
   */
  newClass(desc: ClassDesc, base: AsObject | null, scope: Scope): AsObject {
    return newClass(this, desc, base, scope);
  }

  /** The classes whose static initializers are running, by qualified name. */
  readonly defining = new Map<string, AsObject>();

  applyType(factory: AsObject, params: Value[]): AsObject {
    const hook = (factory.$it as Traits).hooks?.apply;
    if (!hook) {
      throw this.error("TypeError", 1127);
    }

    return hook(this, factory, params);
  }

  // Types.

  /** The class a type reference names, resolved and kept the first time. */
  classOf(ref: TypeRef): AsObject {
    if (typeof ref === "string") {
      return this.builtinClass(ref);
    }

    if (ref === null) {
      return this.builtinClass("Object");
    }

    return this.resolve(ref);
  }

  resolve(ref: ClassRef | VectorRef): AsObject {
    if (ref.cls) {
      return ref.cls;
    }

    if (ref instanceof VectorRef) {
      const vector = this.resolve(this.cls(namespace(NS_Public, "__AS3__.vec"), "Vector"));
      ref.cls = this.applyType(vector, [ref.param === null ? null : this.classOf(ref.param)]);
      return ref.cls;
    }

    const mn = qname(ref.ns, ref.name);
    mn.domain = ref.domain === this.root ? null : ref.domain;
    let cls = this.typeNamed(mn);
    if (cls === null || cls === undefined || !cls.$it) {
      cls = this.defining.get(ref.ns.uri ? `${ref.ns.uri}::${ref.name}` : ref.name);
      if (!cls) {
        throw this.error("ReferenceError", 1065, ref.name);
      }

      // Not kept: the class is not yet where its name will find it.
      return cls;
    }

    ref.cls = cls;
    return cls;
  }

  /** See classNamed in definitions.ts. */
  classNamed(qualified: string, domain: Domain | null = null): AsObject {
    return classNamed(this, qualified, domain);
  }

  /** See classNamedByCode in definitions.ts. */
  classNamedByCode(qualified: string, domain: Domain): AsObject {
    return classNamedByCode(this, qualified, domain);
  }

  /**
   * The names `domain`'s own modules define, private ones left out, as
   * Flash's ApplicationDomain.getQualifiedDefinitionNames lists them:
   * "pkg::Name", or the name alone in the top-level package.
   */
  definitionNames(domain: Domain): string[] {
    return definitionNames(domain);
  }

  /** See definitionNamed in definitions.ts. */
  definitionNamed(qualified: string, domain: Domain): Value {
    return definitionNamed(this, qualified, domain);
  }

  /** See definingAbc in definitions.ts. */
  definingAbc(qualified: string, domain: Domain): Abc | null {
    return definingAbc(this, qualified, domain);
  }

  /** The class a multiname or TypeName names. */
  resolveName(mn: Multiname | TypeName): AsObject {
    if (mn instanceof TypeName) {
      const base = this.resolveName(mn.baseName);
      const param = mn.param(0);
      return this.applyType(base, [param ? this.resolveName(param) : null]);
    }

    const cached = mn.cls;
    if (cached) {
      return cached;
    }

    const cls = this.getProperty(this.findDef(mn), mn);
    mn.cls = cls;
    return cls;
  }

  /** The class `mn` names as a type, as avmplus finds traits (see findScript). */
  private typeNamed(mn: Multiname): Value {
    const script = this.findScript(mn, true);
    if (!script) {
      throw this.error("ReferenceError", 1065, mn.toString());
    }

    return this.getProperty(this.initScript(script), mn);
  }

  refOf(cls: AsObject): TypeRef {
    const name: string = cls.$it.name;
    // The builtins a coercion converts to go by name, as a module names them.
    if (BUILTIN_REFS.has(name)) {
      return name;
    }

    // The class's own reference: one by its name could find another class,
    // as in a domain that defines the name again.
    if (cls.$ref?.cls !== cls) {
      const i = name.lastIndexOf("::");
      const ns = i < 0 ? publicNs : namespace(NS_Public, name.slice(0, i));
      const abc = cls.$it.abc as Abc | null;
      cls.$ref = new ClassRef(ns, i < 0 ? name : name.slice(i + 2), abc?.domain ?? this.root);
      cls.$ref.cls = cls;
    }

    return cls.$ref;
  }

  /**
   * The instance traits a type reference names. Object's, Class's and
   * Function's exist before their classes, so a coercion to them works
   * while the builtins make them, as avmplus' does.
   */
  traitsOfType(type: TypeRef): Traits {
    if (type instanceof ClassRef && !type.cls && type.ns === publicNs) {
      switch (type.name) {
        case "Object":
          return this.objectTraits;
        case "Class":
          return this.classTraits;
        case "Function":
          return this.functionTraits;
      }
    }

    return this.classOf(type).$it;
  }

  isInstance(v: Value, cls: AsObject): boolean {
    return this.isInstanceOf(v, cls.$it);
  }

  isInstanceOf(v: Value, traits: Traits): boolean {
    if (!traits.testsValues) {
      if (v === null || v === undefined) {
        return false;
      }

      // An object's own traits, mostly: traitsOf's instanceof checks walk its prototypes.
      const own: Traits | undefined = v.$traits;
      return own === traits || (own ?? this.traitsOf(v)).isSubtypeOf(traits);
    }

    switch (traits.name) {
      case "float":
        return v instanceof FloatValue;
      case "Number":
        return typeof v === "number" || v instanceof FloatValue;
      case "int":
        return typeof v === "number" && (v | 0) === v;
      case "uint":
        return typeof v === "number" && v >>> 0 === v;
      case "String":
        return typeof v === "string";
      case "Boolean":
        return typeof v === "boolean";
      default:
        // Object, whose instances are any value but null and undefined.
        return v !== null && v !== undefined;
    }
  }

  coerce(v: Value, type: TypeRef): Value {
    switch (type) {
      case null:
        return v;
      case "int":
        return this.toInt(v);
      case "uint":
        return this.toUint(v);
      case "float":
        return this.float(v);
      case "Number":
        return this.toNumber(v);
      case "Boolean":
        return this.toBoolean(v);
      case "String":
        return this.coerceString(v);
      case "Object":
        return this.coerceObject(v);
      case "void":
        return undefined;
      default: {
        if (v === null || v === undefined) {
          return null;
        }

        // An instance of the class itself, most often, then any subtype.
        const traits = this.traitsOfType(type);
        if (v.$traits === traits || this.isInstanceOf(v, traits)) {
          return v;
        }

        throw this.error("TypeError", 1034, this.describe(v), traits.name);
      }
    }
  }

  /**
   * coerce, to a class's instances: what code compiled against the type
   * calls, with no builtin to look for, and the class's traits kept on the
   * reference once resolved, as it always resolves to the same class.
   */
  coerceTo(v: Value, type: ClassRef | VectorRef): Value {
    if (v === null || v === undefined) {
      return null;
    }

    let traits = type.traits;
    if (traits === null) {
      traits = this.traitsOfType(type);
      type.traits = traits;
    }

    if (v.$traits === traits || this.isInstanceOf(v, traits)) {
      return v;
    }

    throw this.error("TypeError", 1034, this.describe(v), traits.name);
  }

  coerceString(v: Value): string | null {
    return v === null || v === undefined ? null : typeof v === "string" ? v : this.toString(v);
  }

  coerceObject(v: Value): Value {
    return v === undefined ? null : v;
  }

  toObject(v: Value): Value {
    if (v === null) {
      throw this.error("TypeError", 1009);
    }

    if (v === undefined) {
      throw this.error("TypeError", 1010);
    }

    return v;
  }

  isType(v: Value, mn: Multiname | TypeName): boolean {
    return this.isInstance(v, this.resolveName(mn));
  }

  asType(v: Value, mn: Multiname | TypeName): Value {
    return this.isInstance(v, this.resolveName(mn)) ? v : null;
  }

  isTypeLate(v: Value, cls: Value): boolean {
    // A class, which only class objects have instance traits for.
    if (cls !== null && typeof cls === "object") {
      const traits: Traits | undefined = cls.$it;
      if (traits) {
        return this.isInstanceOf(v, traits);
      }
    }

    // As Toplevel::toClassITraits: what is not an object, a Namespace
    // among them, as a null or undefined one is; an object not a class 1041.
    if (cls === null || typeof cls !== "object" || cls instanceof Namespace) {
      throw this.error("TypeError", cls === undefined ? 1010 : 1009);
    }

    throw this.error("TypeError", 1041);
  }

  asTypeLate(v: Value, cls: Value): Value {
    return this.isTypeLate(v, cls) ? v : null;
  }

  instanceOf(v: Value, f: Value): boolean {
    if (v instanceof FloatValue) {
      v = v.value;
    }

    if (f === null || typeof f !== "object" || !(f.$it || f.$f)) {
      throw this.error("TypeError", 1040);
    }

    const target = f.$it ? f.$prototype : this.functionPrototype(f);
    for (let p = v === null || v === undefined ? null : this.protoOf(v); p; p = p.$p) {
      if (p === target) {
        return true;
      }
    }

    return false;
  }

  typeOf(v: Value): string {
    switch (typeof v) {
      case "number":
      case "string":
      case "boolean":
      case "undefined":
        return typeof v;
      default:
        if (v === null) {
          return "object";
        }

        if (v instanceof FloatValue) {
          return "number";
        }

        return v.$f
          ? "function"
          : v.$traits?.name === "XML" || v.$traits?.name === "XMLList"
            ? "xml"
            : "object";
    }
  }

  // Conversions.

  float(v: Value): FloatValue {
    return v instanceof FloatValue ? v : floatValue(this.toNumber(v));
  }

  toNumeric(v: Value): number | FloatValue {
    if (v !== null && typeof v === "object" && !(v instanceof FloatValue)) {
      const n = this.arrayConversion.arrayToNumber(v);
      if (n !== undefined) {
        return n;
      }
    }

    const primitive =
      v !== null && typeof v === "object" && !(v instanceof FloatValue)
        ? this.toPrimitive(v, "number")
        : v;
    return primitive instanceof FloatValue ? primitive : this.toNumber(primitive);
  }

  toBoolean(v: Value): boolean {
    return v instanceof FloatValue ? !!v.value : !!v;
  }

  subtract(a: Value, b: Value): Value {
    const x = this.toNumeric(a);
    const y = this.toNumeric(b);
    return x instanceof FloatValue && y instanceof FloatValue
      ? floatValue(x.value - y.value)
      : +x - +y;
  }

  multiply(a: Value, b: Value): Value {
    const x = this.toNumeric(a);
    const y = this.toNumeric(b);
    return x instanceof FloatValue && y instanceof FloatValue
      ? floatValue(x.value * y.value)
      : +x * +y;
  }

  divide(a: Value, b: Value): Value {
    const x = this.toNumeric(a);
    const y = this.toNumeric(b);
    return x instanceof FloatValue && y instanceof FloatValue
      ? floatValue(x.value / y.value)
      : +x / +y;
  }

  modulo(a: Value, b: Value): Value {
    const x = this.toNumeric(a);
    const y = this.toNumeric(b);
    return x instanceof FloatValue && y instanceof FloatValue
      ? floatValue(x.value % y.value)
      : +x % +y;
  }

  negate(v: Value): Value {
    const value = this.toNumeric(v);
    return value instanceof FloatValue ? floatValue(-value.value) : -value;
  }

  increment(v: Value): Value {
    const value = this.toNumeric(v);
    return value instanceof FloatValue ? floatValue(value.value + 1) : value + 1;
  }

  decrement(v: Value): Value {
    const value = this.toNumeric(v);
    return value instanceof FloatValue ? floatValue(value.value - 1) : value - 1;
  }

  toNumber(v: Value): number {
    switch (typeof v) {
      case "number":
        return v;
      case "string":
        return stringToNumber(v);
      case "boolean":
        return v ? 1 : 0;
      case "undefined":
        return Number.NaN;
      default:
        return v instanceof FloatValue ? v.value : v === null ? 0 : this.objectToNumber(v);
    }
  }

  private objectToNumber(o: AsObject): number {
    const n = this.arrayConversion.arrayToNumber(o);
    return n !== undefined ? n : this.toNumber(this.toPrimitive(o, "number"));
  }

  toInt(v: Value): number {
    return typeof v === "number" ? v | 0 : this.toNumber(v) | 0;
  }

  toUint(v: Value): number {
    return typeof v === "number" ? v >>> 0 : this.toNumber(v) >>> 0;
  }

  toString(v: Value): string {
    switch (typeof v) {
      case "string":
        return v;
      case "number":
        return numberToString(v);
      case "boolean":
      case "undefined":
        return String(v);
      default:
        return v instanceof FloatValue
          ? numberToString(v.value)
          : v === null
            ? "null"
            : this.toString(this.toPrimitive(v, "string"));
    }
  }

  /** As [[DefaultValue]]: valueOf and toString, in the hint's order. */
  toPrimitive(o: AsObject, hint: "number" | "string"): Value {
    if (o instanceof FloatValue) {
      return o;
    }

    // XML's is its string, as XMLObject::toString gives it.
    const properties: PropertyHook | null | undefined = o.$traits?.properties;
    if (properties) {
      return properties.toString(this, o);
    }

    // As ScriptObject::defaultValue: each called as a property, so one
    // that is not a function is TypeError 1006; a Namespace is a primitive.
    const order = hint === "string" ? this.stringPrimitiveOrder : this.numberPrimitiveOrder;
    for (let i = 0; i < order.length; i++) {
      const v = this.callProperty(o, order[i]);
      if (
        v === null ||
        typeof v !== "object" ||
        v instanceof Namespace ||
        v instanceof FloatValue
      ) {
        return v;
      }
    }

    throw this.error("TypeError", 1050, o.$traits.name);
  }

  add(a: Value, b: Value): Value {
    if (typeof a === "number" && typeof b === "number") {
      return a + b;
    }

    if (a instanceof FloatValue && b instanceof FloatValue) {
      return floatValue(a.value + b.value);
    }

    // As op_add: a String or a Date beside anything concatenates both as
    // strings, so an object there is converted with the hint String
    // (toString first), not without a hint as below.
    if (typeof a === "string" || typeof b === "string" || this.isDate(a) || this.isDate(b)) {
      return this.toString(a) + this.toString(b);
    }

    if (typeof a === "object" && typeof b === "object" && a?.$traits?.properties) {
      const sum = a.$traits.properties.add(this, a, b);
      if (sum !== undefined) {
        return sum;
      }
    }

    // A Namespace is a primitive atom to avmplus' op_add: it concatenates only beside a
    // string, and otherwise adds as NaN.
    const pa = this.addend(a);
    const pb = this.addend(b);
    if (typeof pa === "string" || typeof pb === "string") {
      return this.toString(pa) + this.toString(pb);
    }

    return pa instanceof FloatValue && pb instanceof FloatValue
      ? floatValue(pa.value + pb.value)
      : this.toNumber(pa) + this.toNumber(pb);
  }

  private addend(v: Value): Value {
    if (v === null || typeof v !== "object" || v instanceof Namespace || v instanceof FloatValue) {
      return v;
    }

    // No hint: a Date, whose hint is String, concatenated above.
    return this.toPrimitive(v, "number");
  }

  private isDate(v: Value): boolean {
    return typeof v === "object" && v !== null && v.$traits?.name === "Date";
  }

  equals(a: Value, b: Value): boolean {
    if (a instanceof FloatValue) {
      a = a.value;
    }

    if (b instanceof FloatValue) {
      b = b.value;
    }

    if (typeof a === "object" || typeof b === "object") {
      const e = this.objectEquals(a, b);
      if (e !== undefined) {
        return e;
      }
    }

    if (typeof a === typeof b) {
      return a === b;
    }

    if (a == null && b == null) {
      return true;
    }

    if (a == null || b == null) {
      return false;
    }

    // Without a hint, which is valueOf first, a Date's too: AvmCore::equals
    // compares a Date with a String by its time, unlike ECMAScript.
    if (typeof a === "object") {
      return this.equals(this.toPrimitive(a, "number"), b);
    }

    if (typeof b === "object") {
      return this.equals(a, this.toPrimitive(b, "number"));
    }

    return this.toNumber(a) === this.toNumber(b);
  }

  /**
   * == where either side is an object, as E4X has it (11.5.1): XML and
   * XMLList by their hook, QNames by URI and local name, Namespaces by URI.
   */
  private objectEquals(a: Value, b: Value): boolean | undefined {
    if (a === b) {
      return true;
    }

    const properties: PropertyHook | null | undefined =
      a?.$traits?.properties ?? b?.$traits?.properties;
    if (properties) {
      return properties.equals(this, a, b);
    }

    if (a instanceof Namespace && b instanceof Namespace) {
      return a.kind !== NS_Private && a.kind === b.kind && a.uri === b.uri;
    }

    if (a?.$local !== undefined && b?.$local !== undefined) {
      return (a.$ns?.uri ?? null) === (b.$ns?.uri ?? null) && a.$local === b.$local;
    }

    return undefined;
  }

  strictEquals(a: Value, b: Value): boolean {
    if (a instanceof FloatValue || b instanceof FloatValue) {
      return a instanceof FloatValue && b instanceof FloatValue && a.value === b.value;
    }

    return a === b;
  }

  private compare(a: Value, b: Value): number | undefined {
    const pa = a !== null && typeof a === "object" ? this.toPrimitive(a, "number") : a;
    const pb = b !== null && typeof b === "object" ? this.toPrimitive(b, "number") : b;
    if (typeof pa === "string" && typeof pb === "string") {
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    }

    const x = this.toNumber(pa);
    const y = this.toNumber(pb);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return undefined;
    }

    return x < y ? -1 : x > y ? 1 : 0;
  }

  lessThan(a: Value, b: Value): boolean {
    const c = this.compare(a, b);
    return c !== undefined && c < 0;
  }

  lessEquals(a: Value, b: Value): boolean {
    const c = this.compare(a, b);
    return c !== undefined && c <= 0;
  }

  greaterThan(a: Value, b: Value): boolean {
    const c = this.compare(a, b);
    return c !== undefined && c > 0;
  }

  greaterEquals(a: Value, b: Value): boolean {
    const c = this.compare(a, b);
    return c !== undefined && c >= 0;
  }

  // Iteration: an index counts through an object's own names, then its
  // prototypes'. As avmplus' hashtable slots, it counts every name, hidden
  // or not, so hiding one during a for-in (as _dontEnumPrototype does) does
  // not move the others.

  /**
   * hasnext2: whether `o` or an object on its prototype chain has a name
   * past `index`, the object and the index then in enumObject and
   * enumIndex, which compiled code reads back rather than taking them apart
   * from an array at every step.
   */
  hasNextIn(o: Value, index: number): boolean {
    let obj = o;
    let i = index;
    while (obj !== null && obj !== undefined) {
      // A step that goes on from the last is over an ordinary object: no hook, no QName.
      const next = continues(obj, i) ? nextIndex(this.enumerating, obj, i) : this.hasNext(obj, i);
      if (next) {
        this.enumObject = obj;
        this.enumIndex = next;
        return true;
      }

      // Then the prototypes, most of which have nothing to go through.
      obj = this.protoOf(obj);
      while (obj !== null && obj !== undefined && walkless(obj)) {
        obj = obj.$p;
      }

      i = 0;
    }

    this.enumObject = null;
    this.enumIndex = 0;
    return false;
  }

  /** hasNextIn's results as one array, as modules compiled before it take them. */
  hasNext2(o: Value, index: number): [boolean, Value, number] {
    const has = this.hasNextIn(o, index);
    return [has, this.enumObject, this.enumIndex];
  }

  hasNext(o: Value, index: number): number {
    if (typeof o !== "object" || o === null) {
      return 0;
    }

    const properties: PropertyHook | null | undefined = o.$traits?.properties;
    if (properties) {
      return properties.nextIndex(this, o, index);
    }

    return pairOf(o) ? pairIndex(index) : nextIndex(this.enumerating, o, index);
  }

  /** As avmplus gives a for-in's name: an index as a number while an int atom holds it, a Dictionary's object key as itself. */
  nextName(o: Value, index: number): Value {
    // The step the last hasNextIn took is over an ordinary object: no hook, no QName.
    if (!continues(o, index)) {
      const properties: PropertyHook | null | undefined = o?.$traits?.properties;
      if (properties) {
        return properties.nextName(this, o, index);
      }

      const pair = pairOf(o);
      if (pair) {
        return index === 1 ? "uri" : index === 2 ? pair : null;
      }
    }

    // As avmplus' ArrayObject and TypedVectorObject: the elements, then the other names.
    const length = elementsAt(o, index);
    if (index > 0 && index <= length) {
      const element = index - 1;
      return element < INT_ATOM_LIMIT ? element : String(element);
    }

    const keys = dictionaryAt(o, index);
    const name = keys !== null ? keys.nameAt(index - length) : enumerated(o, index - length, index);
    if (typeof name !== "string") {
      return name;
    }

    const i = arrayIndex(name);
    return i >= 0 && i < INT_ATOM_LIMIT ? i : name;
  }

  nextValue(o: Value, index: number): Value {
    const traits: Traits | undefined = o?.$traits;
    if (!continues(o, index)) {
      const properties = traits?.properties;
      if (properties) {
        return properties.nextValue(this, o, index);
      }

      // As avmplus: a QName's values come localName first, though its names come uri first.
      const pair = pairOf(o);
      if (pair === "prefix") {
        return index === 1 ? o.uri : index === 2 ? prefixOf(o) : undefined;
      }

      if (pair === "localName") {
        const uri = o.$ns ? o.$ns.uri : null;
        const local = o.$local ?? "*";
        return index === 1 ? local : index === 2 ? uri : null;
      }
    }

    const length = elementsAt(o, index);
    if (index > 0 && index <= length) {
      const element = index - 1;
      if (traits?.getIndex) {
        return traits.getIndex(o, element, this);
      }

      if (traits === this.arrayTraits) {
        // A hole reads undefined too: only then is `in` asked.
        const value = o.$a[element];
        if (value !== undefined || element in o.$a) {
          return value;
        }
      }
    }

    // A Dictionary's key gives its value from its slot, without looking it up.
    const keys = dictionaryAt(o, index);
    const value = keys?.valueAt(index - length);
    if (keys !== null && value !== NAMED) {
      return value;
    }

    // Else a Dictionary's slot holds a dynamic property's name.
    const name =
      keys !== null
        ? (keys.nameAt(index - length) as string)
        : index <= length
          ? String(index - 1)
          : enumerated(o, index - length, index);

    // A dynamic property's value, as avmplus' nextValue reads its slot's:
    // no binding has its name, which setting it would have gone to.
    const dynamic = dynamicValue(o, name);
    if (dynamic !== NOT_FOUND) {
      return dynamic;
    }

    // These builtins have no bindings over their enumerated own properties.
    // A missing value still needs the full lookup, including the prototype.
    if (traits === this.arrayTraits || traits === this.objectTraits) {
      const own = this.getOwn(o, name);
      if (own !== NOT_FOUND) {
        return own;
      }
    }

    return this.getProperty(o, this.publicName(name));
  }

  // Errors.

  /** A new AS3 error of builtin class `name`, number `id`, with its message's arguments. */
  error(name: string, id: number, ...args: Value[]): Value {
    const message = this.errorMessage(id, args);
    let cls: AsObject;
    try {
      // A class outside the unnamed package goes by its qualified name.
      const at = name.lastIndexOf("::");
      cls =
        at < 0
          ? this.builtinClass(name)
          : this.resolve(this.cls(namespace(NS_Public, name.slice(0, at)), name.slice(at + 2)));
    } catch {
      return new AsError(`${name}: ${message}`);
    }

    return this.constructClass(cls, [message, id]);
  }

  /** See stackOf in errors.ts. */
  stackOf(error: Value): string | null {
    return stackOf(error);
  }

  /** See errorMessage in errors.ts. */
  errorMessage(id: number, args: Value[] = []): string {
    return errorMessage(this.debugger, id, args);
  }

  /** As MethodEnv::argcError: ArgumentError 1063, with the count required and the count given. */
  argumentCountError(required: number, given: number): Value {
    return this.error("ArgumentError", 1063, "function", required, given);
  }

  nullError(v: Value): Value {
    return this.error("TypeError", v === undefined ? 1010 : 1009);
  }

  /** See describe in errors.ts. */
  describe(v: Value): string {
    return describe(this, v);
  }

  /** An exception as AS3 catches it: a stack overflow is an AS3 Error; the runtime's own errors are not caught. */
  caught(e: unknown): Value {
    if (e instanceof RangeError && /call stack/.test(e.message)) {
      return this.error("Error", 1023);
    }

    // Domain memory's, in the handler's own method (see memoryError).
    if (isViewRangeError(e)) {
      return this.error("RangeError", 1506);
    }

    if (e instanceof Error && !(e instanceof AsError)) {
      throw e;
    }

    return e;
  }

  catches(e: Value, type: TypeRef): boolean {
    return this.isInstanceOf(e, this.traitsOfType(type));
  }

  unreachable(): Error {
    return new Error("swf2es: a dispatcher reached no block");
  }

  unsupported(what: string): Error {
    return new Error(`swf2es: ${what} is not supported yet`);
  }

  // Class aliases and the classes AMF makes (amf-classes.ts).

  registerClassAlias(name: string, cls: AsObject): void {
    this.amfClasses.registerClassAlias(name, cls);
  }

  aliasOf(traits: Traits): string {
    return this.amfClasses.aliasOf(traits);
  }

  classByAlias(name: string, orObject = false): AsObject {
    return this.amfClasses.classByAlias(name, orObject);
  }

  byteArrayClass(): AsObject {
    return this.amfClasses.byteArrayClass();
  }

  dictionaryClass(): AsObject {
    return this.amfClasses.dictionaryClass();
  }

  vectorClass(param: AsObject | null): AsObject {
    return this.amfClasses.vectorClass(param);
  }

  /** Each Vector class made, by its element class (null for *), kept by Vector's apply. */
  readonly vectorClasses = new Map<AsObject | null, AsObject>();

  /** An object's own names a for-in visits, in its order: its string names, not a Dictionary's object keys. */
  enumerableNames(o: AsObject): string[] {
    return ownNames(o).filter((n): n is string => typeof n === "string" && !o.$dontEnum?.has(n));
  }

  /**
   * avmshell's avmplus.Domain.currentDomain, as DomainClass::get_currentDomain:
   * a new instance of Domain, without running its constructor, for the
   * calling code's domain.
   */
  currentDomain(): AsObject {
    const domain = this.resolve(this.cls(namespace(NS_Public, "avmplus"), "Domain")).$it.instance();
    domain.$domain = this.codeDomain();
    return domain;
  }

  // Domain memory, as avmplus' MOPS: little-endian, an address outside the
  // memory a RangeError.

  /** The domain memory: where li8 and the other opcodes read and write, with its length. */
  get memory(): DataView {
    return this.memoryView;
  }

  set memory(view: DataView) {
    this.memoryView = view;
    this.memoryLength = view.byteLength;
    if (!this.refresh) {
      this.view = view;
    }
  }

  /**
   * For domain memory another worker shares: its length read again, which
   * that worker may have changed, before an address past it is rejected.
   */
  get refreshMemory(): (() => void) | null {
    return this.refresh;
  }

  set refreshMemory(refresh: (() => void) | null) {
    this.refresh = refresh;
    this.view = refresh ? new SharedMemoryView(this) : this.memoryView;
  }

  /**
   * An exception thrown in a method that loads or stores domain memory in
   * place, as its callers see it: the view's RangeError for an address out
   * of range made avmplus', anything else as it is.
   */
  memoryError(e: unknown): unknown {
    return isViewRangeError(e) ? this.error("RangeError", 1506) : e;
  }

  /** `address` as an int, once checked that the domain memory holds `size` bytes there. */
  private mops(address: Value, size: number): number {
    const a = this.toInt(address);
    if (a < 0 || a + size > this.memoryLength) {
      this.refreshMemory?.();
      if (a < 0 || a + size > this.memoryLength) {
        throw this.error("RangeError", 1506);
      }
    }

    return a;
  }

  li8(address: Value): number {
    const at = this.mops(address, 1);
    return this.memoryView.getUint8(at);
  }

  li16(address: Value): number {
    const at = this.mops(address, 2);
    return this.memoryView.getUint16(at, true);
  }

  li32(address: Value): number {
    const at = this.mops(address, 4);
    return this.memoryView.getInt32(at, true);
  }

  lf32(address: Value): number {
    const at = this.mops(address, 4);
    return this.memoryView.getFloat32(at, true);
  }

  lf64(address: Value): number {
    const at = this.mops(address, 8);
    return this.memoryView.getFloat64(at, true);
  }

  si8(value: Value, address: Value): void {
    const at = this.mops(address, 1);
    this.memoryView.setUint8(at, this.toInt(value));
  }

  si16(value: Value, address: Value): void {
    const at = this.mops(address, 2);
    this.memoryView.setUint16(at, this.toInt(value), true);
  }

  si32(value: Value, address: Value): void {
    const at = this.mops(address, 4);
    this.memoryView.setInt32(at, this.toInt(value), true);
  }

  sf32(value: Value, address: Value): void {
    const at = this.mops(address, 4);
    this.memoryView.setFloat32(at, this.toNumber(value), true);
  }

  sf64(value: Value, address: Value): void {
    const at = this.mops(address, 8);
    this.memoryView.setFloat64(at, this.toNumber(value), true);
  }

  // E4X.

  /** getdescendants: x..name, on XML or XMLList; anything else, as avmplus, TypeError 1016. */
  getDescendants(o: Value, mn: Multiname): Value {
    const properties: PropertyHook | null | undefined = o?.$traits?.properties;
    if (!properties) {
      throw this.error("TypeError", 1016, this.describe(o));
    }

    return properties.descendants(this, o, mn);
  }

  /**
   * The default XML namespace, as dxns and dxnslate set it. avmplus keeps
   * it for each frame: one a method set, else the one of the scope the
   * method was made in. Here the runtime has the current one: each
   * method's factory captures it, and the method runs with that one
   * (callInDxns); one that sets it gives its caller's back.
   */
  defaultXmlNamespace: Namespace = publicNs;

  /** On entering a method that sets the default XML namespace: the one to give back on leaving it. */
  enterDxns(): Namespace {
    return this.defaultXmlNamespace;
  }

  setDefaultXmlNamespace(ns: Value): void {
    if (ns instanceof Namespace) {
      this.defaultXmlNamespace = ns;
    } else {
      const uri = this.toString(ns);
      this.defaultXmlNamespace = prefixedNamespace(uri === "" ? "" : undefined, uri);
    }
  }

  /** checkfilter: x.(...) filters XML and XMLList only, else TypeError 1123. */
  checkFilter(v: Value): void {
    if (!v?.$traits?.properties) {
      throw this.error("TypeError", 1123, this.describe(v));
    }
  }

  /** esc_xelem, as AvmCore::ToXMLString: XML's own XML, else a string escaped and trimmed. */
  escapeElement(v: Value): string {
    if (typeof v === "string") {
      return escapeElementValue(v, true);
    }

    if (typeof v !== "object" || v === null) {
      return this.toString(v);
    }

    const properties: PropertyHook | null | undefined = v.$traits?.properties;
    if (properties) {
      return properties.toXMLString(this, v);
    }

    return escapeElementValue(this.toString(v), true);
  }

  escapeAttribute(v: Value): string {
    return escapeAttributeValue(this.toString(v));
  }

  // Methods whose bodies are not generated.

  /** A native method, bound by its name; one the runtime lacks throws when called. */
  native(name: string, required = 0, max = -1): Factory {
    return nativeFactory(this, name, required, max);
  }

  /**
   * A bound method called with arguments the verifier did not see: a
   * native's count checked, as MethodEnv's argcOk does. A compiled method
   * checks its own.
   */
  callBound(f: CountedMethod, o: Value, args: Value[]): Value {
    // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
    let r: Value;
    const min = f.$min;
    if (min !== undefined) {
      const max = f.$max as number;
      if (args.length < min || (max >= 0 && args.length > max)) {
        throw this.argumentCountError(min, args.length);
      }

      // A native's primitive and Object parameters, coerced as avmplus coerces them on entry.
      const types = f.$coerce;
      if (types !== undefined) {
        for (let i = 0; i < args.length && i < types.length; i++) {
          const type = types[i];
          if (type !== null) {
            args[i] = this.coerce(args[i], type);
          }
        }
      }
    }

    r = f.apply(o, args);
    return r;
  }

  get noBody(): Factory {
    return noBodyFactory(this);
  }

  get unverified(): Factory {
    return unverifiedFactory(this);
  }

  verifyError(id: number): Factory {
    return verifyErrorFactory(this, id);
  }

  isPrimitive(v: Value): boolean {
    return (
      v instanceof FloatValue || v === null || (typeof v !== "object" && typeof v !== "function")
    );
  }
}

const BUILTIN_REFS = new Set(["int", "uint", "Number", "float", "String", "Boolean", "Object"]);
