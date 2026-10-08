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
// derives one (docs/architecture.md, "Modules and the bootstrap").

import { newClass, withId } from "./classes.js";
import type {
  Abc,
  AbcDesc,
  AsObject,
  ClassDesc,
  CompileUnit,
  Factory,
  Method,
  Scope,
  TraitsDesc,
  TypeRef,
  Value,
} from "./descriptors.js";
import {
  add,
  compileUnit,
  Domain,
  definedInChain,
  definitionNames,
  findScript,
  frameScripts,
  type Script,
  stackFrames,
} from "./domain.js";
import {
  type Enumeration,
  enumerated,
  INT_ATOM_LIMIT,
  nextIndex,
  ownNames,
  pairIndex,
  pairOf,
} from "./enumeration.js";
import type { ClassHook, NativesProvider, PropertyHook } from "./hooks.js";
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
  formatClassName,
  Multiname,
  Namespace,
  NS_Private,
  NS_Public,
  namespace,
  prefixedNamespace,
  prefixOf,
  publicNs,
  qname,
  TypeName,
} from "./names.js";
import { escapeAttributeValue, escapeElementValue } from "./natives/xml/escape.js";
import { convertDoubleToString } from "./numbers.js";
import { defaultPrint, memoryFiles, type RuntimeOptions, type ShellFiles } from "./options.js";
import { errorMessages } from "./player-messages.js";
import {
  cached,
  entryFor,
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
  PropertyCache,
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
  ClassRef,
  methodKey,
  slotKey,
  Traits,
  VectorRef,
} from "./traits.js";

/** A native with argument counts to check, when it has any, and its declared parameter count (see Runtime.native). */
type CountedMethod = Method & { $min?: number; $max?: number; $length?: number };

/**
 * A sealed Array subclass's elements from SWF 13, as avmplus' ArrayObject
 * keeps none for one: never any. Shared and frozen; what writes elements
 * checks for it, and fails as a sealed object does.
 */
export const SEALED_ELEMENTS: Value[] = Object.freeze([]) as unknown as Value[];

/** Thrown for an AS3 exception that is an Error the runtime made, before its class existed. */
export class AsError extends Error {}

export class Runtime {
  readonly print: (line: string) => void;
  readonly debugger: boolean;
  readonly compileAbc:
    | ((abc: Uint8Array, unit: CompileUnit) => ((rt: Runtime) => Abc) | number)
    | null;
  readonly files: ShellFiles;
  /** See RuntimeOptions.swfVersion. */
  swfVersion: number;
  readonly natives: Record<string, (rt: Runtime) => Method>;
  /** The root application domain, the builtins' and the main SWF's; and the one modules load into now. */
  readonly root = new Domain(null, 0);
  private domainCount = 1;
  private loads = 0;
  private loading: Domain = this.root;
  /**
   * The domain of each loaded module's code, by the script a stack's frame
   * names it with (see codeDomain); found from the stacks its loads took,
   * which wait in `unlocated` until a domain other than the root exists.
   * Weakly: a module's code keeps its domain, through its Abc, for as long
   * as it can run, and a domain no code is left of is let go, an entry
   * dropped with it.
   */
  private readonly moduleDomains = new Map<string, WeakRef<Domain>>();
  private readonly moduleDomainGone = new FinalizationRegistry<string>((at) => {
    if (!this.moduleDomains.get(at)?.deref()) {
      this.moduleDomains.delete(at);
    }
  });
  private readonly unlocated: [Error, Domain][] = [];
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
  /**
   * The domain memory, and its length kept with it for mops: fields, not an
   * accessor and DataView's getter. Generated code reads both for the loads
   * and stores it writes in place, and calls li8 and the others only for an
   * address out of range, which they reject.
   */
  view: DataView = this.scratchMemory;
  memoryLength: number = this.scratchMemory.byteLength;
  memoryProvider: AsObject | null = null;
  /** ByteArray.defaultObjectEncoding: AMF3 until set. */
  defaultObjectEncoding = 3;
  /** ObjectEncoding.dynamicPropertyWriter: what writes a dynamic object's own properties in AMF3, if anything. */
  dynamicPropertyWriter: AsObject | null = null;
  /** Class aliases, as registerClassAlias sets them, both ways. */
  private readonly aliases = new Map<string, AsObject>();
  private readonly aliasByTraits = new Map<Traits, string>();
  /** The builtin classes' traits, made before their classes so the bootstrap can refer to them. */
  readonly objectTraits: Traits;
  readonly classTraits: Traits;
  readonly functionTraits: Traits;
  /** Method closures, by receiver, so that o.f === o.f. */
  private readonly closures = new WeakMap<object, Map<number, AsObject>>();
  private readonly builtinTraitsByName = new Map<string, Traits>();
  /** The primitives' traits, once a lookup has needed them, for the caches (receiverTraits). */
  private stringTraits: Traits | undefined = undefined;
  private numberTraits: Traits | undefined = undefined;
  private booleanTraits: Traits | undefined = undefined;
  /** The names for-ins go through, per object (see Enumeration). */
  private readonly enumerating = new WeakMap<object, Enumeration>();
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
    this.swfVersion = options.swfVersion ?? 31;
    this.objectTraits = new Traits("Object", null);
    this.objectTraits.dynamic = true;
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
    return new Domain(parent, this.domainCount++);
  }

  /**
   * The domain of the innermost code on the stack that a module defines,
   * as avmplus' AvmCore::codeContext; the root without one. A frame is a
   * module's by its script, so a host gives each module a script of its
   * own: its URL, or a sourceURL comment for code it evaluates.
   */
  codeDomain(): Domain {
    if (!this.children) {
      return this.root;
    }

    this.locate();
    for (const at of frameScripts(new Error().stack)) {
      const domain = this.moduleDomains.get(at)?.deref();
      if (domain) {
        return domain;
      }
    }

    return this.root;
  }

  /**
   * The scripts of the modules loaded since last asked, by the stacks their
   * loads took. Their stacks reach the modules' code, so they are not kept
   * past the load once there are domains to tell apart.
   */
  private locate(): void {
    for (const [error, domain] of this.unlocated) {
      // Its first frame is abc's own, its second the module's factory. An
      // engine may name no script for the factory's frame (JavaScriptCore,
      // for code a Function made), and the next frame that names one is
      // the host's, which must not stand for the module.
      const at = stackFrames(error.stack)[1];
      if (at) {
        this.moduleDomains.set(at, new WeakRef(domain));
        this.moduleDomainGone.register(domain, at);
      }
    }

    this.unlocated.length = 0;
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
        this.locate();
      }
    }
  }

  typeName(_N: Namespace[], _V: number[], _S: number[][], base: number, param: number): TypeName {
    return new TypeName(base, [param]);
  }

  /** A multiname with its runtime namespace and name, from the stack. */
  runtimeName(mn: Multiname, ...parts: Value[]): Multiname {
    let namespaces: (Namespace | null)[] = mn.namespaces;
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
      } else if (typeof part === "object" && part !== null) {
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
    // Its layouts are those of its ABC after exactly these ABCs; the
    // root's, which a player loads thousands into, are not copied.
    const domain = this.loading;
    const loaded = domain.parent ? domain.chain() : domain.own;
    const linked = desc.linked;
    if (linked.length !== loaded.length || linked.some((h, i) => h !== loaded[i])) {
      throw new Error(
        `swf2es: a module compiled after [${linked.join(", ")}] cannot load after [${loaded.join(", ")}]`,
      );
    }

    const abc = desc as Abc;
    abc.domain = domain;
    abc.index = domain.own.length;
    domain.own.push(desc.hash);
    domain.ownOrder.push(this.loads++);
    if (!this.loadingBuiltin) {
      this.unlocated.push([new Error(), domain]);
    }
    for (const name of abc.names) {
      if (name instanceof TypeName) {
        name.names = abc.names;
      }
    }

    for (const cls of abc.classes) {
      cls.abc = abc;
    }

    abc.scriptStates = abc.scripts.map((s) => ({ desc: s, abc, global: null, state: 0 }));
    // As DomainMgr::addNamedScript: a name the domain's chain defines
    // already, cached or loaded, is unreachable, and not added.
    for (const script of abc.scriptStates) {
      for (const [ns, version, name] of script.desc.traits.bindings) {
        if (!definedInChain(domain, name, ns)) {
          add(domain.globals, { ns, version, script }, name);
        }
      }
    }

    return abc;
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
      const scope = Object.assign([g], { w: 0 });
      for (const [d, factory, id] of script.desc.traits.methods) {
        traits.proto[methodKey(d)] = withId(factory(scope, null), id);
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
      const toplevel = this.findScript(qname(publicNs, "Object"));
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
    }

    return g;
  }

  private toplevelReady = false;

  /**
   * The script that defines `mn`, kept on the multiname once found: the
   * first definition of a name wins, so later modules cannot change it.
   */
  private definingScript(mn: Multiname): Script | null {
    const known = (mn as Multiname & { $script?: Script }).$script;
    if (known) {
      return known;
    }

    const script = this.findScript(mn);
    if (script) {
      (mn as Multiname & { $script?: Script }).$script = script;
    }

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

  findDef(mn: Multiname): AsObject {
    const script = this.definingScript(mn);
    if (!script) {
      throw this.error("ReferenceError", 1065, mn.toString());
    }

    return this.initScript(script);
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
      return this.initScript(script);
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
      return this.hasProperty(o, mn);
    }

    return this.traitsOf(o).find(mn) !== 0;
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

        return v instanceof Namespace ? this.builtinTraits("Namespace") : v.$traits;
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
        return v === null ? undefined : v.$traits;
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
      if (name === "String") {
        this.stringTraits = traits;
      } else if (name === "Number") {
        this.numberTraits = traits;
      } else if (name === "Boolean") {
        this.booleanTraits = traits;
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

  prototypeOf(ref: TypeRef): AsObject {
    return this.classOf(ref).$it.proto;
  }

  getProperty(o: Value, mn: Multiname): Value {
    const e = cached(this.receiverTraits(o), mn);
    if (e !== null) {
      switch (e.kind) {
        case IC_Slot:
        case IC_Const:
          return o[e.key];
        case IC_Get:
        case IC_GetSet:
          return (e.get as Method).call(o);
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
        }
      }
    }

    // A Dictionary's object key, before its traits, as DictionaryObject's.
    if (mn.key !== undefined && o?.$keys !== undefined) {
      return o.$keys.get(mn.key);
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
   * changes them, into the elements the Vector has then.
   */
  setElement(o: AsObject, i: number, x: Value): void {
    const a: Value[] = o.$a;
    if (i > a.length || (i === a.length && o.$fixed)) {
      throw this.error("RangeError", 1125, i, a.length);
    }

    a[i] = x;
  }

  // obj[i] for a Vector the code was compiled against, by the kind of its
  // elements: a function for each, so that each sees one kind of array. As
  // the Vector's getIndex and setIndex hooks, with getIndexed's checks, a
  // set converting the value before it checks the index (setElement); for
  // anything else, such as a null Vector, getIndexed and setIndexed.

  vectorGetInt(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >= a.length) {
        throw this.error("RangeError", 1125, i, a.length);
      }

      return a[i];
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetInt(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      this.setElement(o, i, this.toInt(v));
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  vectorGetUint(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >= a.length) {
        throw this.error("RangeError", 1125, i, a.length);
      }

      return a[i];
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetUint(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      this.setElement(o, i, this.toUint(v));
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  vectorGetDouble(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >= a.length) {
        throw this.error("RangeError", 1125, i, a.length);
      }

      return a[i];
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetDouble(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      this.setElement(o, i, this.toNumber(v));
      return;
    }

    this.setIndexed(o, mn, i, v);
  }

  vectorGetObject(o: Value, mn: Multiname, i: number): Value {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      const a: Value[] = o.$a;
      if (i >= a.length) {
        throw this.error("RangeError", 1125, i, a.length);
      }

      return a[i];
    }

    return this.getIndexed(o, mn, i);
  }

  vectorSetObject(o: Value, mn: Multiname, i: number, v: Value): void {
    if (o !== null && o !== undefined && i >>> 0 === i && i !== 0xffffffff && mn.elementName) {
      this.setElement(o, i, o.$traits.cls.$convert(this, o.$traits.cls, v));
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
    const id = b >> 3;
    switch (b & 7) {
      case BIND_Var:
      case BIND_Const:
        return o[slotKey(id)];
      case BIND_Get:
      case BIND_GetSet:
        return traits.proto[methodKey(id)].call(o);
      case BIND_Method:
        return this.methodClosure(o, traits, id);
      case BIND_Set: {
        const slot = this.classHooks[traits.name]?.setOnlySlots?.[mn.name ?? ""];
        if (slot !== undefined) {
          return o[slot];
        }

        throw this.error("ReferenceError", 1077, mn.name ?? "*", traits.name);
      }
      default:
        throw this.error("ReferenceError", 1077, mn.name ?? "*", traits.name);
    }
  }

  /**
   * Keep what `mn` found on `traits`, `o`'s, for the next lookup on an
   * object with them: a binding, as getProperty, setProperty and
   * callProperty use it, or a dynamic property's name. Not where the name
   * resolves otherwise: through a property hook (a Proxy's, XML's), an
   * index (a Vector's, an Array's element), or a Dictionary's key; nor on
   * a primitive's dynamic property, which its prototypes have.
   */
  private fill(o: Value, traits: Traits, b: number, mn: Multiname): void {
    let head = mn.cache;
    if (
      head === NO_CACHE ||
      (head.replaced === REPLACEMENTS && head.epoch === epoch()) ||
      this.receiverTraits(o) !== traits
    ) {
      return;
    }

    const hook = traits.properties;
    const id = b >> 3;
    let kind: number;
    let key = "";
    let get: Method | null = null;
    let set: Method | null = null;
    let type: TypeRef = null;
    if (b === 0) {
      const name = mn.dynamicName();
      if (
        name === null ||
        (typeof o !== "object" && typeof o !== "function") ||
        hook !== null ||
        !traits.dynamic ||
        traits.refusesNames ||
        traits.getIndex !== undefined ||
        traits.index !== undefined ||
        arrayIndex(name) >= 0
      ) {
        return;
      }

      kind = IC_Dynamic;
      key = name;
    } else {
      const hooked = hook !== null && hookedBinding(b, mn, hook);
      switch (b & 7) {
        case BIND_Method:
          kind = hooked ? IC_Call : IC_Method;
          get = traits.proto[methodKey(id)];
          break;
        case BIND_Var:
        case BIND_Const:
          kind = (b & 7) === BIND_Var ? IC_Slot : IC_Const;
          key = slotKey(id);
          type = traits.slotType(id);
          break;
        case BIND_Get:
          kind = IC_Get;
          get = traits.proto[methodKey(id)];
          break;
        case BIND_Set:
          kind = IC_Set;
          set = traits.proto[methodKey(id + 1)];
          break;
        case BIND_GetSet:
          kind = IC_GetSet;
          get = traits.proto[methodKey(id)];
          set = traits.proto[methodKey(id + 1)];
          break;
        default:
          return;
      }

      if (hooked && kind !== IC_Call) {
        return;
      }
    }

    if (head === UNFILLED) {
      head = new PropertyCache();
      mn.cache = head;
    }

    const e = entryFor(head, traits);
    if (e === null) {
      return;
    }

    e.traits = traits;
    e.kind = kind;
    e.key = key;
    e.get = get;
    e.set = set;
    e.type = type;
    e.id = id;
  }

  /** Method `id` of `o` bound to it, the same function each time. */
  methodClosure(o: Value, traits: Traits, id: number): AsObject {
    const key = typeof o === "object" ? o : traits.proto;
    let byId = this.closures.get(key);
    if (!byId) {
      byId = new Map();
      this.closures.set(key, byId);
    }

    let f = typeof o === "object" ? byId.get(id) : undefined;
    if (!f) {
      const method: Method = traits.proto[methodKey(id)];
      f = this.newFunctionObject(
        (method as CountedMethod).$min === undefined
          ? (...args: Value[]) => method.apply(o, args)
          : (...args: Value[]) => this.callBound(method, o, args),
        null,
      );
      // Its length is the method's declared parameters, not the wrapper's: a
      // native's from its ABC, a compiled method's from the parameters it declares.
      f.$length = (method as CountedMethod).$length ?? method.length;
      f.$id = (method as Method & { $id?: number }).$id ?? 0;
      f.$closure = true;
      if (typeof o === "object") {
        byId.set(id, f);
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
      o.$keys.set(mn.key, v);
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
          traits.proto[methodKey(id + 1)].call(o, v);
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
      o.$keys.delete(mn.key);
      return true;
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

  /** The `in` operator: whether `o` has the public property `name`. */
  in(name: Value, o: Value): boolean {
    if (
      typeof name === "object" &&
      name !== null &&
      name.$local === undefined &&
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

    return this.hasProperty(o, this.publicName(name));
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
   * the key itself, then, made a string, on its prototype chain.
   */
  private dictionaryHas(o: AsObject, key: object): boolean {
    if (o.$keys.has(key)) {
      return true;
    }

    const name = this.toString(key);
    for (let p = this.protoOf(o); p; p = p.$p) {
      if (this.protoOwn(p, name) !== NOT_FOUND) {
        return true;
      }
    }

    return false;
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

    // An index a class indexes itself is there only within its length.
    const traits: Traits | undefined = typeof o === "object" && o !== null ? o.$traits : undefined;
    if (traits?.hasIndex) {
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
    if (typeof o === "object" && o !== null && !(o instanceof Namespace)) {
      return o.$p;
    }

    return this.traitsOf(o).proto.$p;
  }

  publicName(name: Value): Multiname {
    return qname(publicNs, typeof name === "string" ? name : this.toString(name));
  }

  // Calls.

  callProperty(o: Value, mn: Multiname, ...args: Value[]): Value {
    const e = cached(this.receiverTraits(o), mn);
    if (e !== null) {
      switch (e.kind) {
        case IC_Method:
        case IC_Call:
          return this.callBound(e.get as CountedMethod, o, args);
        case IC_Slot:
        case IC_Const:
          return this.callValue(o[e.key], o, args, mn);
        case IC_Get:
        case IC_GetSet:
          return this.callValue((e.get as Method).call(o), o, args, mn);
        case IC_Dynamic: {
          const d: Map<string, Value> | null = o.$d;
          if (d) {
            const v = d.get(e.key);
            if (v !== undefined || d.has(e.key)) {
              return this.callValue(v, o, args, mn);
            }
          }
        }
      }
    }

    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    this.fill(o, traits, b, mn);
    if ((b & 7) === BIND_Method) {
      return this.callBound(traits.proto[methodKey(b >> 3)], o, args);
    }

    return this.callValue(this.callee(o, traits, b, mn), o, args, mn);
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
    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      return this.callBound(traits.proto[methodKey(b >> 3)], o, args);
    }

    return this.callValue(this.callee(o, traits, b, mn), null, args, mn);
  }

  call(f: Value, receiver: Value, ...args: Value[]): Value {
    return this.callValue(f, receiver, args, null);
  }

  callValue(f: Value, receiver: Value, args: Value[], mn: Multiname | null): Value {
    if (f !== null && typeof f === "object") {
      if (f.$f) {
        return f.$f.apply(receiver ?? f.$global ?? null, args);
      }

      if (f.$it) {
        return this.callClass(f, args);
      }

      // A RegExp called is its exec of the argument's string, as RegExpObject::call has it.
      if (f.$re !== undefined) {
        this.execName ??= qname(namespace(NS_Public, "http://adobe.com/AS3/2006/builtin"), "exec");
        return this.callProperty(f, this.execName, args.length ? this.toString(args[0]) : "");
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
    if (args.length < required || (max >= 0 && args.length > max)) {
      throw this.argumentCountError(required, args.length);
    }

    return this.callInDxns(dxns, f, receiver, args);
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
    const cls = this.classOf(iface);
    // The interface's layout names the method; the receiver binds that name.
    const desc = cls.$desc as ClassDesc;
    for (const [ns, , name, b] of desc.instance.bindings) {
      if (b >> 3 === disp && (b & 7) === BIND_Method) {
        return this.callProperty(o, qname(ns, name), ...args);
      }
    }

    throw this.error("TypeError", 1006, "method");
  }

  callStatic(_abc: Abc, m: number, ..._args: Value[]): Value {
    throw this.unsupported(`callstatic ${m}`);
  }

  // The super operations, as MethodEnv's: by the base class's traits
  // alone, a name they do not bind a ReferenceError, not a dynamic property.

  callSuper(sup: AsObject, o: Value, mn: Multiname, ...args: Value[]): Value {
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      return this.callBound(traits.proto[methodKey(b >> 3)], o, args);
    }

    if (b === 0) {
      throw this.error("ReferenceError", 1070, mn.name ?? "*", traits.name);
    }

    return this.callValue(this.getBound(o, traits, b, mn), o, args, mn);
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
        traits.proto[methodKey(id + 1)].call(o, v);
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
    if (f !== null && typeof f === "object") {
      // A method closure is not a constructor, as MethodClosure's construct has it.
      if (f.$closure) {
        throw this.error("TypeError", 1064, "function");
      }

      if (f.$it) {
        return this.constructClass(f, args);
      }

      if (f.$f) {
        // A function as a constructor: a new Object whose prototype is the
        // function's. One whose prototype a script cleared gets Object's own
        // prototype object back at its first new, as avmplus reinitializes
        // it, so from then on every object is an instance of the function.
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
    }

    throw this.error("TypeError", 1007);
  }

  constructProperty(o: Value, mn: Multiname, ...args: Value[]): Value {
    // As avmplus' constructprop: a primitive's, a Namespace's among them,
    // from its prototype, where a missing name is undefined.
    const primitive =
      (o !== null && o !== undefined && typeof o !== "object") || o instanceof Namespace;
    return this.construct(this.getProperty(primitive ? this.protoOf(o) : o, mn), ...args);
  }

  constructClass(cls: AsObject, args: Value[]): Value {
    const hook = this.hookOf(cls, "construct");
    if (hook) {
      return hook(this, cls, args);
    }

    const o = this.allocate(cls) as AsObject;
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
    // Looked up by name once, then kept on the class.
    const key = kind === "construct" ? "$constructHook" : "$callHook";
    let hook = cls[key];
    if (hook === undefined) {
      hook = this.classHooks[cls.$hook ?? cls.$it.name]?.[kind] ?? null;
      cls[key] = hook;
    }

    return hook;
  }

  /**
   * Vector.<T> for a T other than int, uint and Number: Vector$object's
   * class, typed, whose name names T as avmplus does, a builtin Vector as
   * Vector.<int>, and whose superclass is Vector.<*>, Vector$object.
   */
  specializeVector(base: AsObject, param: AsObject): AsObject {
    const itraits = new Traits(
      `__AS3__.vec::Vector.<${formatClassName(param.$it.name)}>`,
      base.$it,
    );
    itraits.dynamic = base.$it.dynamic;
    itraits.refusesNames = base.$it.refusesNames;
    const cls = Object.create(Object.getPrototypeOf(base));
    cls.$d = null;
    cls.$it = itraits;
    cls.$desc = base.$desc;
    cls.$base = base;
    cls.$prototype = base.$prototype;
    cls.$param = this.refOf(param);
    cls.$hook = base.$it.name;
    itraits.cls = cls;
    return cls;
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
    const hook = this.classHooks[factory.$it.name]?.apply;
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

  /**
   * The class `qualified` names, "pkg::Name" or "Name", its defining script
   * run; a ReferenceError if no script defines it. What a SWF's SymbolClass
   * and a player's lookups by name go through.
   */
  classNamed(qualified: string, domain: Domain | null = null): AsObject {
    const named = (domain ?? this.root).named;
    const known = named.get(qualified);
    if (known) {
      return known;
    }

    const mn = this.qualifiedNameIn(qualified, domain);
    const cls = this.resolveName(mn);
    // A script still running its initializer may not have made the class yet.
    if (cls) {
      named.set(qualified, cls);
    }

    return cls;
  }

  /**
   * The names `domain`'s own modules define, private ones left out, as
   * Flash's ApplicationDomain.getQualifiedDefinitionNames lists them:
   * "pkg::Name", or the name alone in the top-level package.
   */
  definitionNames(domain: Domain): string[] {
    return definitionNames(domain);
  }

  /**
   * What `qualified` names in `domain`, as Flash's
   * ApplicationDomain.getDefinition finds it: a name no script defines is
   * refused by its local name, and a script whose initializer threw runs
   * again, its error coming through each time, where a name's lookup by
   * code keeps it as run, as avmplus does.
   */
  definitionNamed(qualified: string, domain: Domain): Value {
    const mn = this.qualifiedNameIn(qualified, domain);
    const script = this.findScript(mn);
    if (!script) {
      throw this.error("ReferenceError", 1065, mn.name);
    }

    return this.getProperty(this.initScript(script, true), mn);
  }

  /** The module whose script defines `qualified` for `domain`, or null: by it a player keys what SymbolClass binds. */
  definingAbc(qualified: string, domain: Domain): Abc | null {
    return this.findScript(this.qualifiedNameIn(qualified, domain))?.abc ?? null;
  }

  /** The public name "pkg::Name" or "Name" stands for, looked up in `domain`. */
  private qualifiedNameIn(qualified: string, domain: Domain | null): Multiname {
    const i = qualified.lastIndexOf("::");
    const ns = i < 0 ? publicNs : namespace(NS_Public, qualified.slice(0, i));
    const mn = qname(ns, i < 0 ? qualified : qualified.slice(i + 2));
    mn.domain = domain === this.root ? null : domain;
    return mn;
  }

  /** The class a multiname or TypeName names. */
  resolveName(mn: Multiname | TypeName): AsObject {
    if (mn instanceof TypeName) {
      const base = this.resolveName(mn.baseName);
      const param = mn.param(0);
      return this.applyType(base, [param ? this.resolveName(param) : null]);
    }

    const cached = (mn as Multiname & { $cls?: AsObject }).$cls;
    if (cached) {
      return cached;
    }

    const cls = this.getProperty(this.findDef(mn), mn);
    (mn as Multiname & { $cls?: AsObject }).$cls = cls;
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
    switch (traits.name) {
      case "Object":
        return v !== null && v !== undefined;
      case "Number":
        return typeof v === "number";
      case "int":
        return typeof v === "number" && (v | 0) === v && !Object.is(v, -0);
      case "uint":
        return typeof v === "number" && v >>> 0 === v && !Object.is(v, -0);
      case "String":
        return typeof v === "string";
      case "Boolean":
        return typeof v === "boolean";
      default:
        if (v === null || v === undefined) {
          return false;
        }

        return this.traitsOf(v).isSubtypeOf(traits);
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
      case "Number":
        return this.toNumber(v);
      case "Boolean":
        return !!v;
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
    // As Toplevel::toClassITraits: what is not an object, a Namespace
    // among them, as a null or undefined one is; an object not a class 1041.
    if (cls === null || typeof cls !== "object" || cls instanceof Namespace) {
      throw this.error("TypeError", cls === undefined ? 1010 : 1009);
    }

    if (!cls.$it) {
      throw this.error("TypeError", 1041);
    }

    return this.isInstance(v, cls);
  }

  asTypeLate(v: Value, cls: Value): Value {
    return this.isTypeLate(v, cls) ? v : null;
  }

  instanceOf(v: Value, f: Value): boolean {
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

        return v.$f
          ? "function"
          : v.$traits?.name === "XML" || v.$traits?.name === "XMLList"
            ? "xml"
            : "object";
    }
  }

  // Conversions.

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
        return v === null ? 0 : this.toNumber(this.toPrimitive(v, "number"));
    }
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
        return v === null ? "null" : this.toString(this.toPrimitive(v, "string"));
    }
  }

  /** As [[DefaultValue]]: valueOf and toString, in the hint's order. */
  toPrimitive(o: AsObject, hint: "number" | "string"): Value {
    // XML's is its string, as XMLObject::toString gives it.
    const properties: PropertyHook | null | undefined = o.$traits?.properties;
    if (properties) {
      return properties.toString(this, o);
    }

    // As ScriptObject::defaultValue: each called as a property, so one
    // that is not a function is TypeError 1006; a Namespace is a primitive.
    const order = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
    for (const name of order) {
      const v = this.callProperty(o, qname(publicNs, name));
      if (v === null || typeof v !== "object" || v instanceof Namespace) {
        return v;
      }
    }

    throw this.error("TypeError", 1050, o.$traits.name);
  }

  add(a: Value, b: Value): Value {
    if (typeof a === "number" && typeof b === "number") {
      return a + b;
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

    return this.toNumber(pa) + this.toNumber(pb);
  }

  private addend(v: Value): Value {
    if (v === null || typeof v !== "object" || v instanceof Namespace) {
      return v;
    }

    return this.toPrimitive(v, this.hintOf(v));
  }

  private hintOf(o: AsObject): "number" | "string" {
    return this.traitsOf(o).name === "Date" ? "string" : "number";
  }

  equals(a: Value, b: Value): boolean {
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

    if (typeof a === "object") {
      return this.equals(this.toPrimitive(a, this.hintOf(a)), b);
    }

    if (typeof b === "object") {
      return this.equals(a, this.toPrimitive(b, this.hintOf(b)));
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

  hasNext2(o: Value, index: number): [boolean, Value, number] {
    let obj = o;
    let i = index;
    while (obj !== null && obj !== undefined) {
      const properties: PropertyHook | null | undefined =
        typeof obj === "object" ? obj.$traits?.properties : null;
      const next =
        typeof obj !== "object"
          ? 0
          : properties
            ? properties.nextIndex(this, obj, i)
            : pairOf(obj)
              ? pairIndex(i)
              : nextIndex(this.enumerating, obj, i);
      if (next) {
        return [true, obj, next];
      }

      obj = this.protoOf(obj);
      i = 0;
    }

    return [false, null, 0];
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
    const properties: PropertyHook | null | undefined = o?.$traits?.properties;
    if (properties) {
      return properties.nextName(this, o, index);
    }

    const pair = pairOf(o);
    if (pair) {
      return index === 1 ? "uri" : index === 2 ? pair : null;
    }

    const name = enumerated(this.enumerating, o, index);
    if (typeof name !== "string") {
      return name;
    }

    const i = arrayIndex(name);
    return i >= 0 && i < INT_ATOM_LIMIT ? i : name;
  }

  nextValue(o: Value, index: number): Value {
    const properties: PropertyHook | null | undefined = o?.$traits?.properties;
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

    const name = enumerated(this.enumerating, o, index);
    if (typeof name !== "string") {
      return o.$keys.get(name);
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

  /**
   * Where an AS3 error was made, as JavaScript stack lines from the first
   * compiled method's (their names begin with `$`), the runtime's and the
   * player's frames before it left out, those between kept; every line if
   * no compiled method made it, and null for anything but an AS3 error.
   */
  stackOf(error: Value): string | null {
    const made = (error as { $jsError?: Error } | null)?.$jsError;
    if (!(made instanceof Error) || !made.stack) {
      return null;
    }

    // V8 heads its stack with the error's own line; other engines give frames alone, `name@url`.
    const frames = made.stack.split("\n").filter((line) => !/^Error\b/.test(line));
    const first = frames.findIndex((line) => /^(?:\s*at (?:[\w$]+\.)?)?\$[\w$]/.test(line));
    return frames.slice(Math.max(0, first)).join("\n");
  }

  /**
   * Error `id`'s message as AS3 sees it: its number, as the release player
   * and avmshell give it, or with its text and arguments in debugger mode.
   */
  errorMessage(id: number, args: Value[] = []): string {
    if (!this.debugger) {
      return `Error #${id}`;
    }

    const template = errorMessages[id] ?? "";
    const text = template.replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1] ?? ""));
    return `Error #${id}: ${text}`;
  }

  /** As MethodEnv::argcError: ArgumentError 1063, with the count required and the count given. */
  argumentCountError(required: number, given: number): Value {
    return this.error("ArgumentError", 1063, "function", required, given);
  }

  nullError(v: Value): Value {
    return this.error("TypeError", v === undefined ? 1010 : 1009);
  }

  /** A value as avmplus names it in an error message. */
  describe(v: Value): string {
    if (v === null || typeof v !== "object") {
      return this.toString(v);
    }

    const name: string = v.$traits.name;
    return `${name.slice(name.lastIndexOf("::") + (name.includes("::") ? 2 : 0))}@0`;
  }

  /** An exception as AS3 catches it: a stack overflow is an AS3 Error; the runtime's own errors are not caught. */
  caught(e: unknown): Value {
    if (e instanceof RangeError && /call stack/.test(e.message)) {
      return this.error("Error", 1023);
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

  // Class aliases, for AMF.

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
  classByAlias(name: string, orObject = false): AsObject {
    const cls = this.aliases.get(name);
    if (cls) {
      return cls;
    }

    if (orObject) {
      return this.builtinClass("Object");
    }

    throw this.error("ReferenceError", 1014, name);
  }

  // ByteArray, Dictionary and Vector, as AMF makes them for each value it reads: resolved once.
  private byteArrayCls: AsObject | null = null;
  private dictionaryCls: AsObject | null = null;
  private vectorCls: AsObject | null = null;

  byteArrayClass(): AsObject {
    this.byteArrayCls ??= this.resolve(this.cls(namespace(NS_Public, "flash.utils"), "ByteArray"));
    return this.byteArrayCls;
  }

  dictionaryClass(): AsObject {
    this.dictionaryCls ??= this.resolve(
      this.cls(namespace(NS_Public, "flash.utils"), "Dictionary"),
    );
    return this.dictionaryCls;
  }

  /** Vector.<T>, for a class T or null for *. */
  vectorClass(param: AsObject | null): AsObject {
    const specialized = this.vectorClasses.get(param);
    if (specialized) {
      return specialized;
    }

    this.vectorCls ??= this.resolve(this.cls(namespace(NS_Public, "__AS3__.vec"), "Vector"));
    return this.applyType(this.vectorCls, [param]);
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
    return this.view;
  }

  set memory(view: DataView) {
    this.view = view;
    this.memoryLength = view.byteLength;
  }

  /** `address` as an int, once checked that the domain memory holds `size` bytes there. */
  private mops(address: Value, size: number): number {
    const a = this.toInt(address);
    if (a < 0 || a + size > this.memoryLength) {
      throw this.error("RangeError", 1506);
    }

    return a;
  }

  li8(address: Value): number {
    const at = this.mops(address, 1);
    return this.view.getUint8(at);
  }

  li16(address: Value): number {
    const at = this.mops(address, 2);
    return this.view.getUint16(at, true);
  }

  li32(address: Value): number {
    const at = this.mops(address, 4);
    return this.view.getInt32(at, true);
  }

  lf32(address: Value): number {
    const at = this.mops(address, 4);
    return this.view.getFloat32(at, true);
  }

  lf64(address: Value): number {
    const at = this.mops(address, 8);
    return this.view.getFloat64(at, true);
  }

  si8(value: Value, address: Value): void {
    const at = this.mops(address, 1);
    this.view.setUint8(at, this.toInt(value));
  }

  si16(value: Value, address: Value): void {
    const at = this.mops(address, 2);
    this.view.setUint16(at, this.toInt(value), true);
  }

  si32(value: Value, address: Value): void {
    const at = this.mops(address, 4);
    this.view.setInt32(at, this.toInt(value), true);
  }

  sf32(value: Value, address: Value): void {
    const at = this.mops(address, 4);
    this.view.setFloat32(at, this.toNumber(value), true);
  }

  sf64(value: Value, address: Value): void {
    const at = this.mops(address, 8);
    this.view.setFloat64(at, this.toNumber(value), true);
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
    const make = this.natives[name];
    if (!make) {
      return () => () => {
        throw this.unsupported(`native ${name}`);
      };
    }

    let f: Method | null = null;
    return () => {
      if (!f) {
        f = make(this);
        // Checked where a call was not bound (callBound, methodClosure): the
        // verifier binds only a call its argument count fits.
        if (required > 0 || max >= 0) {
          (f as CountedMethod).$min = required;
          (f as CountedMethod).$max = max;
        }

        // Its Function.length is the ABC's parameter count, as avmplus'
        // (FunctionClass.cpp), not what the JavaScript declares: a native
        // with optional parameters gives them defaults, which length skips.
        if (max >= 0) {
          (f as CountedMethod).$length = max;
        }
      }

      return f;
    };
  }

  /**
   * A bound method called with arguments the verifier did not see: a
   * native's count checked, as MethodEnv's argcOk does. A compiled method
   * checks its own.
   */
  callBound(f: CountedMethod, o: Value, args: Value[]): Value {
    const min = f.$min;
    const max = f.$max as number;
    if (min !== undefined && (args.length < min || (max >= 0 && args.length > max))) {
      throw this.argumentCountError(min, args.length);
    }

    return f.apply(o, args);
  }

  get noBody(): Factory {
    return () => () => {
      throw this.error("VerifyError", 1001, "method");
    };
  }

  get unverified(): Factory {
    return () => () => {
      throw this.unsupported("a method the compiler did not verify");
    };
  }

  verifyError(id: number): Factory {
    return () => () => {
      throw this.error("VerifyError", id);
    };
  }

  isPrimitive(v: Value): boolean {
    return v === null || (typeof v !== "object" && typeof v !== "function");
  }
}

/**
 * Whether a hooked class's hook resolves `mn`, bound to `b`: a name its
 * traits do not bind, an attribute's, or a public name of a method, as a
 * child or attribute of XML hides the methods of its names (as avmplus'
 * getproperty does for XML and XMLList).
 */
function hookedBinding(b: number, mn: Multiname, hook: PropertyHook): boolean {
  if (b === 0 || mn.attribute) {
    return true;
  }

  return (
    hook.hidesMethods &&
    (b & 7) === BIND_Method &&
    mn.namespaces.some((ns) => ns?.kind === NS_Public && ns.uri === "")
  );
}

const BUILTIN_REFS = new Set(["int", "uint", "Number", "String", "Boolean", "Object"]);

/** Not a property: distinct from undefined, which a property can hold. */
export const NOT_FOUND = Symbol("not found");

/**
 * As avmplus' String to Number: JavaScript's, without its binary and octal
 * prefixes. JavaScript skips the whitespace trim() does, so a number it
 * reads is avmplus' unless it came from such a prefix; only that, or one it
 * cannot read, needs avmplus' own rules.
 */
export function stringToNumber(s: string): number {
  const n = Number(s);
  if (!Number.isNaN(n)) {
    return binaryOrOctal(s) ? Number.NaN : n;
  }

  return unreadNumber(s);
}

/** Whether `s`, which JavaScript read as a number, starts with a binary or octal prefix. */
function binaryOrOctal(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && (c < 0x09 || c > 0x0d)) {
      break;
    }

    i++;
  }

  // Whitespace past ASCII is rare: trimStart knows all of it.
  if (s.charCodeAt(i) > 0x7f) {
    return /^0[bBoO]/.test(s.trimStart());
  }

  const next = s.charCodeAt(i + 1) | 0x20;
  return s.charCodeAt(i) === 0x30 && (next === 0x62 || next === 0x6f);
}

/**
 * A string JavaScript reads as NaN, as avmplus reads it: a sign before a hex
 * number, a NUL that ends the number, an exponent with no digits; anything
 * else, a binary or octal prefix among it, is NaN.
 */
function unreadNumber(s: string): number {
  const t = s.trim();
  if (/^[-+]0[xX]/.test(t)) {
    const n = Number(t.slice(1));
    return t[0] === "-" ? -n : n;
  }

  // As avmplus, a NUL ends the number, and one before any is none.
  const nul = s.indexOf("\0");
  if (nul > 0 && s.slice(0, nul).trim() !== "") {
    return stringToNumber(s.slice(0, nul));
  }

  // "4e" or "4e+": the exponent is left off.
  const bare = /^([-+]?(?:\d+\.?\d*|\.\d+))[eE]\+?$/.exec(t);
  return bare ? Number(bare[1]) : Number.NaN;
}

/**
 * A number as AS3 writes it: avmplus' own formatting, not JavaScript's,
 * though the two agree, and JavaScript's is some ten times faster, for an
 * int, and for a number from 1e-6 up to 1e15 that JavaScript writes with 15
 * significant digits or fewer. Both write the shortest digits that read
 * back as the number, and no two decimals of 15 digits read back as one
 * double; past 15 they can part on the last digit, which avmplus rounds up
 * (209.14077758789063 where JavaScript has ...062), and from 1e15 up every
 * number takes 16 or more (tests/unit/runtime/numbers.test.ts).
 */
export function numberToString(n: number): string {
  if ((n | 0) === n) {
    return String(n);
  }

  const magnitude = n < 0 ? -n : n;
  if (magnitude >= 1e-6 && magnitude < 1e15) {
    const text = String(n);
    if (significantDigits(text) <= 15) {
      return text;
    }
  }

  return convertDoubleToString(n);
}

/** The significant digits in a number JavaScript wrote in plain decimals: all but its leading zeros. */
function significantDigits(text: string): number {
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x30 && c <= 0x39) {
      digits++;
    } else if (c === 0x30 && digits > 0) {
      digits++;
    }
  }

  return digits;
}
