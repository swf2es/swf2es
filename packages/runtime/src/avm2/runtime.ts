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
import { messages } from "./messages.js";
import {
  CONSTANT_Qname,
  CONSTANT_RTQname,
  CONSTANT_RTQnameA,
  CONSTANT_RTQnameL,
  CONSTANT_RTQnameLA,
  Multiname,
  Namespace,
  NS_Public,
  namespace,
  publicNs,
  qname,
  TypeName,
} from "./names.js";
import { convertDoubleToString } from "./numbers.js";

// biome-ignore lint/suspicious/noExplicitAny: AS3 values are untyped
export type Value = any;
// biome-ignore lint/suspicious/noExplicitAny: AS3 objects are untyped
export type AsObject = any;
// biome-ignore lint/complexity/noBannedTypes: methods take their receiver as this
export type Method = Function;

/** A scope chain: its objects, outermost first, and a bit per with scope in w. */
export type Scope = Value[] & { w: number };

/** A method factory: the method's function, once its scope chain is known. */
export type Factory = (scope: Scope, sup: AsObject | null) => Method;

/** A reference to a type: null for *, a builtin's name, or a class by name. */
export type TypeRef = null | string | ClassRef | VectorRef;

export interface TraitsDesc {
  /** The VerifyError resolving the traits gave, if they did not resolve. */
  error?: number;
  slots: number;
  defaults: [number, Value, TypeRef][];
  bindings: [Namespace, number, string, number][];
  methods: [number, Factory][];
}

export interface ClassDesc {
  name: number;
  base: number;
  interfaces: number[];
  final: boolean;
  interface: boolean;
  sealed: boolean;
  protectedNs: number;
  instance: TraitsDesc;
  static: TraitsDesc;
  init: Factory;
  cinit: Factory;
  /** The module, set when it loads. */
  abc?: Abc;
}

export interface ScriptDesc {
  traits: TraitsDesc;
  init: Factory;
}

export interface AbcDesc {
  /** The hash of the module's ABC, and of the ABCs loaded before it, in order, that it was compiled against. */
  hash: string;
  linked: string[];
  names: (Multiname | TypeName | null)[];
  classes: ClassDesc[];
  scripts: ScriptDesc[];
  activations: (TraitsDesc | null)[];
}

/** A loaded module: what `rt.abc` returns, and methods reach as A. */
export interface Abc extends AbcDesc {
  scriptStates: Script[];
}

// Binding kinds, as the compiler encodes them: kind | id << 3.
const BIND_Method = 1;
const BIND_Var = 2;
const BIND_Const = 3;
const BIND_Get = 5;
const BIND_Set = 6;
const BIND_GetSet = 7;

interface Binding {
  ns: Namespace;
  version: number;
  value: number;
}

/**
 * The traits of an object: its own bindings by local name, and its own
 * slots' types and initial values; lookups continue in the base's, as
 * avmplus' do, so a base described after its subclass was made (Object,
 * Class and Function, during the bootstrap) is still seen.
 */
export class Traits {
  bindings = new Map<string, Binding[]>();
  slotTypes: TypeRef[] = [];
  own: [string, Value][] = [];
  /** Every slot field and its initial value, the base's first, once an instance is made. */
  private allDefaults: [string, Value][] | null = null;
  /** The JavaScript prototype of objects with these traits. */
  proto: AsObject;
  /** The class whose instances these are the traits of, once it exists. */
  cls: AsObject | null = null;
  interfaces = new Set<Traits>();
  dynamic = false;
  /** How to allocate an instance, for classes whose instances hold native state. */
  create: ((traits: Traits) => AsObject) | null;
  getIndex?: IndexHook["getIndex"];
  setIndex?: IndexHook["setIndex"];
  hasIndex?: IndexHook["hasIndex"];

  constructor(
    readonly name: string,
    readonly base: Traits | null,
    proto?: AsObject,
  ) {
    this.proto = proto ?? Object.create(base ? base.proto : null);
    this.proto.$traits = this;
    this.create = base ? base.create : null;
    this.getIndex = base?.getIndex;
    this.setIndex = base?.setIndex;
    this.hasIndex = base?.hasIndex;
    if (base) {
      for (const i of base.interfaces) {
        this.interfaces.add(i);
      }
    }
  }

  /** Add a traits' own bindings and slots from its descriptor. */
  describe(desc: TraitsDesc): void {
    for (const [ns, version, name, value] of desc.bindings) {
      let list = this.bindings.get(name);
      if (!list) {
        list = [];
        this.bindings.set(name, list);
      }

      list.push({ ns, version, value });
    }

    for (const [slot, value, type] of desc.defaults) {
      this.slotTypes[slot] = type;
      this.own.push([`$${slot}`, value]);
    }

    this.allDefaults = null;
  }

  /** The type of slot `id`, declared here or by a base. */
  slotType(id: number): TypeRef {
    for (let t: Traits | null = this; t; t = t.base) {
      if (id in t.slotTypes) {
        return t.slotTypes[id];
      }
    }

    return null;
  }

  /** The binding `mn` names, or 0: the first of its namespaces that binds it at its version. */
  find(mn: Multiname): number {
    const name = mn.name;
    if (name === null) {
      return 0;
    }

    const namespaces = mn.namespaces;
    for (let t: Traits | null = this; t; t = t.base) {
      const list = t.bindings.get(name);
      if (!list) {
        continue;
      }

      for (let i = 0; i < namespaces.length; i++) {
        const ns = namespaces[i];
        for (const b of list) {
          if (b.ns === ns && b.version <= mn.versions[i]) {
            return b.value;
          }
        }
      }
    }

    return 0;
  }

  /** A new object with these traits, its slots at their initial values. */
  instance(): AsObject {
    const o = this.create ? this.create(this) : Object.create(this.proto);
    o.$d = this.dynamic ? new Map() : null;
    if (!this.allDefaults) {
      this.allDefaults = this.base ? [...this.base.defaultsOf(), ...this.own] : this.own.slice();
    }

    for (const [field, value] of this.allDefaults) {
      o[field] = value;
    }

    return o;
  }

  defaultsOf(): [string, Value][] {
    return this.allDefaults ?? (this.base ? [...this.base.defaultsOf(), ...this.own] : this.own);
  }

  isSubtypeOf(t: Traits): boolean {
    for (let c: Traits | null = this; c; c = c.base) {
      if (c === t) {
        return true;
      }
    }

    return this.interfaces.has(t);
  }
}

/** A class named in a module, resolved the first time it is needed. */
export class ClassRef {
  cls: AsObject | null = null;

  constructor(
    readonly ns: Namespace,
    readonly name: string,
  ) {}
}

/** Vector.<T>, resolved the first time it is needed. */
export class VectorRef {
  cls: AsObject | null = null;

  constructor(readonly param: TypeRef) {}
}

/** A script: its descriptor, its global object once made, and whether it has run. */
interface Script {
  desc: ScriptDesc;
  abc: Abc;
  global: AsObject | null;
  state: 0 | 1 | 2;
}

interface GlobalName {
  ns: Namespace;
  version: number;
  script: Script;
}

export interface RuntimeOptions {
  /** Where trace and print write a line. */
  print?: (line: string) => void;
  /**
   * Behave as the debugger player: error messages carry avmplus' text
   * ("Error #1009: Cannot access ..."), and System.isDebugger is true. By
   * default they are the release player's and avmshell's, "Error #1009".
   */
  debugger?: boolean;
}

/** Thrown for an AS3 exception that is an Error the runtime made, before its class existed. */
export class AsError extends Error {}

export class Runtime {
  readonly print: (line: string) => void;
  readonly debugger: boolean;
  readonly natives: Record<string, (rt: Runtime) => Method>;
  /** Names the scripts define, by local name: the first definition wins. */
  private readonly globals = new Map<string, GlobalName[]>();
  private readonly classRefs = new Map<string, ClassRef>();
  private readonly vectorRefs = new Map<TypeRef, VectorRef>();
  /**
   * The domain memory the domain memory instructions use: the ByteArray set
   * as it, or, as avmplus' DomainEnv, 1024 bytes of scratch memory.
   */
  readonly scratchMemory = new DataView(new ArrayBuffer(1024));
  memory: DataView = this.scratchMemory;
  memoryProvider: AsObject | null = null;
  /** ByteArray.defaultObjectEncoding: AMF3 until set. */
  defaultObjectEncoding = 3;
  private domain: AsObject | null = null;
  /** Class aliases, as registerClassAlias sets them, both ways. */
  private readonly aliases = new Map<string, AsObject>();
  private readonly aliasByTraits = new Map<Traits, string>();
  /** The hashes of the modules loaded, in order. */
  private readonly loaded: string[] = [];
  /** The builtin classes' traits, made before their classes so the bootstrap can refer to them. */
  readonly objectTraits: Traits;
  readonly classTraits: Traits;
  readonly functionTraits: Traits;
  /** Method closures, by receiver, so that o.f === o.f. */
  private readonly closures = new WeakMap<object, Map<number, AsObject>>();
  private readonly builtinTraitsByName = new Map<string, Traits>();
  /** The names a for-in is going through, per object, taken when it starts. */
  private readonly enumerating = new WeakMap<object, string[]>();
  /** Special traits: an activation's or a catch scope's, by descriptor. */
  private readonly scopeTraits = new WeakMap<object, Traits>();
  readonly specialized = new Map<AsObject, AsObject>();
  readonly empty: Scope = Object.assign([], { w: 0 });

  constructor(
    natives: Record<string, (rt: Runtime) => Method>,
    readonly classHooks: Record<string, ClassHook>,
    options: RuntimeOptions = {},
  ) {
    this.natives = natives;
    this.print = options.print ?? defaultPrint;
    this.debugger = options.debugger ?? false;
    this.objectTraits = new Traits("Object", null);
    this.objectTraits.dynamic = true;
    this.classTraits = new Traits("Class", this.objectTraits);
    this.functionTraits = new Traits("Function", this.objectTraits);
    this.functionTraits.dynamic = true;
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
    return new Multiname(
      kind,
      indices.map((i) => N[i]),
      indices.map((i) => V[i]),
      name,
      attribute,
    );
  }

  typeName(_N: Namespace[], _V: number[], _S: number[][], base: number, param: number): TypeName {
    return new TypeName(base, [param]);
  }

  /** A multiname with its runtime namespace and name, from the stack. */
  runtimeName(mn: Multiname, ...parts: Value[]): Multiname {
    let namespaces = mn.namespaces;
    let versions = mn.versions;
    let k = 0;
    if (mn.runtimeNs) {
      const ns = parts[k++];
      namespaces = [this.namespaceOf(ns)];
      versions = [255];
    }

    let name = mn.name;
    if (mn.runtimeName) {
      const part = parts[k];
      if (part?.$local !== undefined) {
        // A QName names its own namespace and local name.
        namespaces = [part.$ns ?? publicNs];
        versions = [255];
        name = part.$local;
      } else {
        name = typeof part === "string" ? part : this.toString(part);
      }
    }

    const kind =
      mn.kind === CONSTANT_RTQname ||
      mn.kind === CONSTANT_RTQnameA ||
      mn.kind === CONSTANT_RTQnameL ||
      mn.kind === CONSTANT_RTQnameLA
        ? CONSTANT_Qname
        : mn.kind;
    return new Multiname(kind, namespaces, versions, name, mn.attribute);
  }

  /** The runtime namespace a Namespace value stands for. */
  namespaceOf(value: Value): Namespace {
    if (value instanceof Namespace) {
      return value;
    }

    if (value && value.$ns instanceof Namespace) {
      return value.$ns;
    }

    throw this.error("TypeError", 1034, this.describe(value), "Namespace");
  }

  /** A Namespace constant, as the AS3 Namespace object it is. */
  namespace(ns: Namespace): Value {
    return ns;
  }

  cls(ns: Namespace, name: string): ClassRef {
    const key = `${ns.kind}:${ns.uri}:${name}`;
    let ref = this.classRefs.get(key);
    if (!ref) {
      ref = new ClassRef(ns, name);
      this.classRefs.set(key, ref);
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
    // Its layouts are those of its ABC after exactly these ABCs.
    const linked = desc.linked;
    if (linked.length !== this.loaded.length || linked.some((h, i) => h !== this.loaded[i])) {
      throw new Error(
        `swf2es: a module compiled after [${linked.join(", ")}] cannot load after [${this.loaded.join(", ")}]`,
      );
    }

    this.loaded.push(desc.hash);
    const abc = desc as Abc;
    for (const name of abc.names) {
      if (name instanceof TypeName) {
        name.names = abc.names;
      }
    }

    for (const cls of abc.classes) {
      cls.abc = abc;
    }

    abc.scriptStates = abc.scripts.map((s) => ({ desc: s, abc, global: null, state: 0 }));
    for (const script of abc.scriptStates) {
      for (const [ns, version, name] of script.desc.traits.bindings) {
        let list = this.globals.get(name);
        if (!list) {
          list = [];
          this.globals.set(name, list);
        }

        if (!list.some((g) => g.ns === ns)) {
          list.push({ ns, version, script });
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
      traits.describe(script.desc.traits);
      const g = traits.instance();
      const scope = Object.assign([g], { w: 0 });
      for (const [d, factory] of script.desc.traits.methods) {
        traits.proto[`$m${d}`] = factory(scope, null);
      }

      script.global = g;
    }

    return script.global;
  }

  /** Run a script's initializer, once. */
  initScript(script: Script): AsObject {
    const g = this.globalOf(script);
    if (script.state === 0) {
      script.state = 1;
      script.desc.init(this.empty, null).call(g);
      script.state = 2;
    }

    return g;
  }

  /** The script that defines `mn`, or null. */
  findScript(mn: Multiname): Script | null {
    if (mn.name === null) {
      return null;
    }

    const list = this.globals.get(mn.name);
    if (!list) {
      return null;
    }

    for (let i = 0; i < mn.namespaces.length; i++) {
      const ns = mn.namespaces[i];
      for (const g of list) {
        if (g.ns === ns && g.version <= mn.versions[i]) {
          return g.script;
        }
      }
    }

    return null;
  }

  // Scopes and name lookup.

  /** The scope chain a function or class made here runs in: the chain captured, then the method's own scopes. */
  scope(outer: Scope, locals: Value[], withs: number): Scope {
    const chain = outer.concat(locals) as Scope;
    chain.w = outer.w | (withs << outer.length);
    return chain;
  }

  findDef(mn: Multiname): AsObject {
    const script = this.findScript(mn);
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
    const script = this.findScript(mn);
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

  /** A builtin class's instance traits, by name, resolved once. */
  private builtinTraits(name: string): Traits {
    let traits = this.builtinTraitsByName.get(name);
    if (!traits) {
      traits = this.builtinClass(name).$it as Traits;
      this.builtinTraitsByName.set(name, traits);
    }

    return traits;
  }

  /** A public class of the builtins, by name. */
  builtinClass(name: string): AsObject {
    return this.resolve(this.cls(publicNs, name));
  }

  prototypeOf(ref: TypeRef): AsObject {
    return this.classOf(ref).$it.proto;
  }

  getProperty(o: Value, mn: Multiname): Value {
    const traits = this.traitsOf(o);
    const b = traits.find(mn);
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
        const v = p.$d?.get(name);
        if (v !== undefined || p.$d?.has(name)) {
          return v;
        }
      }
    }

    // A dynamic object has any dynamic name, but no other: obj.ns::x throws.
    if (traits.dynamic && name !== null) {
      return undefined;
    }

    throw this.error("ReferenceError", 1069, mn.name ?? "*", traits.name);
  }

  /** An object's own dynamic or indexed property, or NOT_FOUND. */
  getOwn(o: Value, name: string): Value {
    if (typeof o !== "object" || o === null) {
      return NOT_FOUND;
    }

    // Elements: a class's own indexing (a Vector's, a ByteArray's), else an Array's.
    const traits: Traits | undefined = o.$traits;
    if (traits?.getIndex || o.$a !== undefined) {
      const i = arrayIndex(name);
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

  private getBound(o: Value, traits: Traits, b: number, mn: Multiname): Value {
    const id = b >> 3;
    switch (b & 7) {
      case BIND_Var:
      case BIND_Const:
        return o[`$${id}`];
      case BIND_Get:
      case BIND_GetSet:
        return traits.proto[`$m${id}`].call(o);
      case BIND_Method:
        return this.methodClosure(o, traits, id);
      default:
        throw this.error("ReferenceError", 1077, mn.name ?? "*", traits.name);
    }
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
      const method: Method = traits.proto[`$m${id}`];
      f = this.newFunctionObject((...args: Value[]) => method.apply(o, args), null);
      f.$closure = true;
      if (typeof o === "object") {
        byId.set(id, f);
      }
    }

    return f;
  }

  setProperty(o: Value, mn: Multiname, v: Value, init = false): void {
    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    if (b !== 0) {
      const id = b >> 3;
      switch (b & 7) {
        case BIND_Const:
          if (!init) {
            throw this.error("ReferenceError", 1074, mn.name ?? "*", traits.name);
          }
          o[`$${id}`] = this.coerce(v, traits.slotType(id));
          return;
        case BIND_Var:
          o[`$${id}`] = this.coerce(v, traits.slotType(id));
          return;
        case BIND_Set:
        case BIND_GetSet:
          traits.proto[`$m${id + 1}`].call(o, v);
          return;
        case BIND_Method:
          throw this.error("ReferenceError", 1037, mn.name ?? "*", traits.name);
        default:
          throw this.error("ReferenceError", 1074, mn.name ?? "*", traits.name);
      }
    }

    const name = mn.dynamicName();
    if (name !== null && typeof o === "object") {
      if (traits.setIndex || o.$a !== undefined) {
        const i = arrayIndex(name);
        if (i >= 0) {
          if (traits.setIndex) {
            traits.setIndex(o, i, v, this);
          } else {
            o.$a[i] = v;
          }

          return;
        }
      }

      if (o.$d) {
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
    const traits = this.traitsOf(o);
    if (traits.find(mn) !== 0) {
      return false;
    }

    const name = mn.dynamicName();
    if (name !== null && typeof o === "object") {
      if (o.$a !== undefined) {
        const i = arrayIndex(name);
        if (i >= 0) {
          return delete o.$a[i];
        }
      }

      return o.$d ? o.$d.delete(name) || true : false;
    }

    return false;
  }

  /** The `in` operator: whether `o` has the public property `name`. */
  in(name: Value, o: Value): boolean {
    return this.hasProperty(o, this.publicName(name));
  }

  /** Whether `o` has `mn`: bound, dynamic, or on its prototype chain. */
  hasProperty(o: Value, mn: Multiname): boolean {
    if (this.traitsOf(o).find(mn) !== 0) {
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
    }

    if (this.getOwn(o, name) !== NOT_FOUND) {
      return true;
    }

    for (let p = this.protoOf(o); p; p = p.$p) {
      if (p.$d?.has(name)) {
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
    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      return traits.proto[`$m${b >> 3}`].apply(o, args);
    }

    const f = b !== 0 ? this.getBound(o, traits, b, mn) : this.getProperty(o, mn);
    return this.callValue(f, o, args, mn);
  }

  /** callproplex: as callproperty, with no receiver. */
  callPropLex(o: Value, mn: Multiname, ...args: Value[]): Value {
    const traits = this.traitsOf(o);
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      return traits.proto[`$m${b >> 3}`].apply(o, args);
    }

    return this.callValue(this.getProperty(o, mn), null, args, mn);
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
    }

    throw this.error("TypeError", 1006, mn ? mn.name : "value");
  }

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

  callSuper(sup: AsObject, o: Value, mn: Multiname, ...args: Value[]): Value {
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    if ((b & 7) === BIND_Method) {
      return traits.proto[`$m${b >> 3}`].apply(o, args);
    }

    return this.callValue(this.getSuper(sup, o, mn), o, args, mn);
  }

  getSuper(sup: AsObject, o: Value, mn: Multiname): Value {
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    if (b === 0) {
      return this.getProperty(o, mn);
    }

    return this.getBound(o, traits, b, mn);
  }

  setSuper(sup: AsObject, o: Value, mn: Multiname, v: Value): void {
    const traits: Traits = sup.$it;
    const b = traits.find(mn);
    if ((b & 7) === BIND_Set || (b & 7) === BIND_GetSet) {
      traits.proto[`$m${(b >> 3) + 1}`].call(o, v);
      return;
    }

    this.setProperty(o, mn, v);
  }

  constructSuper(sup: AsObject, o: Value, ...args: Value[]): void {
    sup.$it.proto.$init.apply(o, args);
  }

  construct(f: Value, ...args: Value[]): Value {
    if (f !== null && typeof f === "object") {
      if (f.$it) {
        return this.constructClass(f, args);
      }

      if (f.$f) {
        // A function as a constructor: a new Object whose prototype is the function's.
        const o = this.objectTraits.instance();
        o.$p = this.functionPrototype(f);
        const result = f.$f.apply(o, args);
        return result !== null && typeof result === "object" ? result : o;
      }
    }

    throw this.error("TypeError", 1007);
  }

  constructProperty(o: Value, mn: Multiname, ...args: Value[]): Value {
    return this.construct(this.getProperty(o, mn), ...args);
  }

  constructClass(cls: AsObject, args: Value[]): Value {
    const hook = this.hookOf(cls, "construct");
    if (hook) {
      return hook(this, cls, args);
    }

    if (cls.$desc?.interface) {
      throw this.error("TypeError", 1007);
    }

    const o = cls.$it.instance();
    cls.$it.proto.$init.apply(o, args);
    return o;
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
    return this.classHooks[cls.$hook ?? cls.$it.name]?.[kind] ?? null;
  }

  /** Vector.<T> for a T other than int, uint and Number: Vector$object's class, typed. */
  specializeVector(base: AsObject, param: AsObject): AsObject {
    const itraits = new Traits(`__AS3__.vec::Vector.<${param.$it.name}>`, base.$it);
    itraits.dynamic = base.$it.dynamic;
    const cls = Object.create(Object.getPrototypeOf(base));
    cls.$d = null;
    cls.$it = itraits;
    cls.$desc = base.$desc;
    cls.$base = base.$base;
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

  /** A method's `arguments`: every argument it was called with, declared or not. */
  arguments(args: IArguments): AsObject {
    return this.array(Array.prototype.slice.call(args));
  }

  newFunction(factory: Factory, scope: Scope): AsObject {
    return this.newFunctionObject(factory(scope, null), scope.length ? scope[0] : null);
  }

  /** A Function object calling `f`, with `global` as its receiver when it has none. */
  newFunctionObject(f: Method, global: AsObject | null): AsObject {
    const o = this.functionTraits.instance();
    o.$f = f;
    o.$global = global;
    return o;
  }

  /** A function's prototype, made when first asked for. */
  functionPrototype(f: AsObject): AsObject {
    if (!f.$prototype) {
      const p = this.objectTraits.instance();
      p.$d.set("constructor", f);
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
          bindings: [[mn.namespaces[0], 0, mn.name, BIND_Var]],
          methods: [],
        });
      }

      this.scopeTraits.set(key, traits);
    }

    return traits.instance();
  }

  /**
   * As OP_newclass: a class from its module's descriptor, extending `base`,
   * its methods bound to the scope chain here. Object, Class and Function
   * use the traits the runtime made for them before they existed.
   */
  newClass(desc: ClassDesc, base: AsObject | null, scope: Scope): AsObject {
    const error = desc.instance.error ?? desc.static.error;
    if (error) {
      throw this.error("VerifyError", error);
    }

    const abc = desc.abc as Abc;
    const name = abc.names[desc.name] as Multiname;
    const qualified = qualifiedName(name);
    const baseTraits: Traits | null = base ? base.$it : null;
    let itraits: Traits;
    if (qualified === "Object") {
      itraits = this.objectTraits;
    } else if (qualified === "Class") {
      itraits = this.classTraits;
    } else if (qualified === "Function") {
      itraits = this.functionTraits;
    } else {
      itraits = new Traits(qualified, baseTraits);
    }

    itraits.describe(desc.instance);
    itraits.dynamic = !desc.sealed;

    const hooks = this.classHooks[qualified];
    // A class's allocation, bound to the runtime; its subclasses inherit it.
    const create = hooks?.create;
    if (create) {
      itraits.create = (traits) => create(traits, this);
    }

    if (hooks?.getIndex) {
      itraits.getIndex = hooks.getIndex;
      itraits.setIndex = hooks.setIndex;
      itraits.hasIndex = hooks.hasIndex;
    }

    for (const i of desc.interfaces) {
      const iface = this.resolveName(abc.names[i] as Multiname);
      itraits.interfaces.add(iface.$it);
      for (const t of iface.$it.interfaces) {
        itraits.interfaces.add(t);
      }
    }

    // The class object: Class's instance, with its own statics.
    // Class is dynamic, so its instances are: String.fromCharCode = ... is legal.
    const straits = new Traits(`${qualified}$`, this.classTraits);
    straits.dynamic = true;
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
    const prototype = this.objectTraits.instance();
    prototype.$p = base ? base.$prototype : null;
    cls.$prototype = prototype;
    itraits.proto.$p = prototype;
    prototype.$d.set("constructor", cls);

    const iscope = this.scope(scope, [cls], 0);
    for (const [d, factory] of desc.static.methods) {
      straits.proto[`$m${d}`] = factory(scope, base);
    }

    for (const [d, factory] of desc.instance.methods) {
      itraits.proto[`$m${d}`] = factory(iscope, base);
    }

    itraits.proto.$init = desc.init(iscope, base);
    desc.cinit(scope, base).call(cls);
    return cls;
  }

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
    const cls = this.getProperty(this.findDef(mn), mn);
    if (cls === null || cls === undefined || !cls.$it) {
      throw this.error("ReferenceError", 1065, ref.name);
    }

    ref.cls = cls;
    return cls;
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

  refOf(cls: AsObject): TypeRef {
    const name: string = cls.$it.name;
    // The builtins a coercion converts to go by name, as a module names them.
    if (BUILTIN_REFS.has(name)) {
      return name;
    }

    const i = name.lastIndexOf("::");
    const ns = i < 0 ? publicNs : namespace(NS_Public, name.slice(0, i));
    const ref = this.cls(ns, i < 0 ? name : name.slice(i + 2));
    ref.cls = cls;
    return ref;
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

        const traits = this.traitsOfType(type);
        if (this.isInstanceOf(v, traits)) {
          return v;
        }

        throw this.error("TypeError", 1034, this.describe(v), traits.name);
      }
    }
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
    if (cls === null || typeof cls !== "object" || !cls.$it) {
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
    const order = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
    for (const name of order) {
      const f = this.getProperty(o, qname(publicNs, name));
      if (f !== null && typeof f === "object" && (f.$f || f.$it)) {
        const v = this.callValue(f, o, [], null);
        if (v === null || typeof v !== "object") {
          return v;
        }
      }
    }

    throw this.error("TypeError", 1050, o.$traits.name);
  }

  add(a: Value, b: Value): Value {
    if (typeof a === "number" && typeof b === "number") {
      return a + b;
    }

    const pa = a !== null && typeof a === "object" ? this.toPrimitive(a, this.hintOf(a)) : a;
    const pb = b !== null && typeof b === "object" ? this.toPrimitive(b, this.hintOf(b)) : b;
    if (typeof pa === "string" || typeof pb === "string") {
      return this.toString(pa) + this.toString(pb);
    }

    return this.toNumber(pa) + this.toNumber(pb);
  }

  private hintOf(o: AsObject): "number" | "string" {
    return o.$traits.name === "Date" ? "string" : "number";
  }

  equals(a: Value, b: Value): boolean {
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

  private names(o: AsObject): string[] {
    const names: string[] = [];
    if (o.$a !== undefined) {
      for (const i of Object.keys(o.$a)) {
        names.push(i);
      }
    }

    if (o.$d) {
      for (const k of o.$d.keys()) {
        names.push(k);
      }
    }

    return names;
  }

  /** The index after `index` of an enumerable name of `o`, or 0. */
  private nextIndex(o: AsObject, index: number): number {
    let names = index === 0 ? undefined : this.enumerating.get(o);
    if (!names) {
      names = this.names(o);
      this.enumerating.set(o, names);
    }

    // A name deleted since the for-in started is skipped.
    for (let i = index; i < names.length; i++) {
      const name = names[i];
      if (!o.$dontEnum?.has(name) && this.stillThere(o, name)) {
        return i + 1;
      }
    }

    return 0;
  }

  private stillThere(o: AsObject, name: string): boolean {
    if (o.$a !== undefined) {
      const i = arrayIndex(name);
      if (i >= 0) {
        return i in o.$a;
      }
    }

    return o.$d?.has(name) ?? false;
  }

  /** The for-in's names of `o`, as nextIndex took them. */
  private enumerated(o: AsObject): string[] {
    let names = this.enumerating.get(o);
    if (!names) {
      names = this.names(o);
      this.enumerating.set(o, names);
    }

    return names;
  }

  hasNext2(o: Value, index: number): [boolean, Value, number] {
    let obj = o;
    let i = index;
    while (obj !== null && obj !== undefined) {
      const next = typeof obj === "object" ? this.nextIndex(obj, i) : 0;
      if (next) {
        return [true, obj, next];
      }

      obj = this.protoOf(obj);
      i = 0;
    }

    return [false, null, 0];
  }

  hasNext(o: Value, index: number): number {
    return typeof o === "object" && o !== null ? this.nextIndex(o, index) : 0;
  }

  nextName(o: Value, index: number): Value {
    const name = this.enumerated(o)[index - 1];
    return o.$a !== undefined && arrayIndex(name) >= 0 ? Number(name) : name;
  }

  nextValue(o: Value, index: number): Value {
    return this.getProperty(o, this.publicName(this.enumerated(o)[index - 1]));
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
   * Error `id`'s message as AS3 sees it: its number, as the release player
   * and avmshell give it, or with its text and arguments in debugger mode.
   */
  errorMessage(id: number, args: Value[] = []): string {
    if (!this.debugger) {
      return `Error #${id}`;
    }

    const template = messages[id] ?? "";
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

  // Domain memory, as avmplus' MOPS: little-endian, an address outside the
  // memory a RangeError.

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

  byteArrayClass(): AsObject {
    return this.resolve(this.cls(namespace(NS_Public, "flash.utils"), "ByteArray"));
  }

  /** Vector.<T>, for a class T or null for *. */
  vectorClass(param: AsObject | null): AsObject {
    return this.applyType(this.resolve(this.cls(namespace(NS_Public, "__AS3__.vec"), "Vector")), [
      param,
    ]);
  }

  /** An object's own names a for-in visits, in its order. */
  enumerableNames(o: AsObject): string[] {
    return this.names(o).filter((n) => !o.$dontEnum?.has(n));
  }

  /** avmshell's avmplus.Domain.currentDomain: an instance of Domain, without running its constructor. */
  currentDomain(): AsObject {
    this.domain ??= this.resolve(
      this.cls(namespace(NS_Public, "avmplus"), "Domain"),
    ).$it.instance();
    return this.domain;
  }

  /** `address` as an int, once checked that the domain memory holds `size` bytes there. */
  private mops(address: Value, size: number): number {
    const a = this.toInt(address);
    if (a < 0 || a + size > this.memory.byteLength) {
      throw this.error("RangeError", 1506);
    }

    return a;
  }

  li8(address: Value): number {
    const at = this.mops(address, 1);
    return this.memory.getUint8(at);
  }

  li16(address: Value): number {
    const at = this.mops(address, 2);
    return this.memory.getUint16(at, true);
  }

  li32(address: Value): number {
    const at = this.mops(address, 4);
    return this.memory.getInt32(at, true);
  }

  lf32(address: Value): number {
    const at = this.mops(address, 4);
    return this.memory.getFloat32(at, true);
  }

  lf64(address: Value): number {
    const at = this.mops(address, 8);
    return this.memory.getFloat64(at, true);
  }

  si8(value: Value, address: Value): void {
    const at = this.mops(address, 1);
    this.memory.setUint8(at, this.toInt(value));
  }

  si16(value: Value, address: Value): void {
    const at = this.mops(address, 2);
    this.memory.setUint16(at, this.toInt(value), true);
  }

  si32(value: Value, address: Value): void {
    const at = this.mops(address, 4);
    this.memory.setInt32(at, this.toInt(value), true);
  }

  sf32(value: Value, address: Value): void {
    const at = this.mops(address, 4);
    this.memory.setFloat32(at, this.toNumber(value), true);
  }

  sf64(value: Value, address: Value): void {
    const at = this.mops(address, 8);
    this.memory.setFloat64(at, this.toNumber(value), true);
  }

  // E4X, not implemented yet.

  getDescendants(_o: Value, _mn: Multiname): Value {
    throw this.unsupported("XML's descendants");
  }

  setDefaultXmlNamespace(_ns: Value): void {
    throw this.unsupported("default xml namespace");
  }

  checkFilter(v: Value): void {
    throw this.error("TypeError", 1123, this.describe(v));
  }

  escapeElement(v: Value): string {
    return this.toString(v).replace(/[&<>]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
    );
  }

  escapeAttribute(v: Value): string {
    return this.toString(v).replace(/[&<"\n\r\t]/g, (c) => XML_ATTRIBUTE[c]);
  }

  // Methods whose bodies are not generated.

  /** A native method, bound by its name; one the runtime lacks throws when called. */
  native(name: string): Factory {
    const make = this.natives[name];
    if (!make) {
      return () => () => {
        throw this.unsupported(`native ${name}`);
      };
    }

    let f: Method | null = null;
    return () => {
      f ??= make(this);
      return f;
    };
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

/** How a class that holds its own elements indexes them. */
export interface IndexHook {
  getIndex: (o: AsObject, i: number, rt: Runtime) => Value;
  setIndex: (o: AsObject, i: number, v: Value, rt: Runtime) => void;
  hasIndex: (o: AsObject, i: number) => boolean;
}

/** How a builtin class differs from others: allocation, index access, calls and construction. */
export interface ClassHook {
  create?: (traits: Traits, rt: Runtime) => AsObject;
  getIndex?: IndexHook["getIndex"];
  setIndex?: IndexHook["setIndex"];
  hasIndex?: IndexHook["hasIndex"];
  construct?: (rt: Runtime, cls: AsObject, args: Value[]) => Value;
  call?: (rt: Runtime, cls: AsObject, args: Value[]) => Value;
  apply?: (rt: Runtime, factory: AsObject, params: Value[]) => AsObject;
}

/** Where output goes by default: the host's console. */
function defaultPrint(line: string): void {
  (globalThis as { console?: { log(line: string): void } }).console?.log(line);
}

const BUILTIN_REFS = new Set(["int", "uint", "Number", "String", "Boolean", "Object"]);

/** Not a property: distinct from undefined, which a property can hold. */
export const NOT_FOUND = Symbol("not found");

const XML_ATTRIBUTE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  '"': "&quot;",
  "\n": "&#xA;",
  "\r": "&#xD;",
  "\t": "&#x9;",
};

/** A name's index as an array element, or -1: a canonical uint below 2^32 - 1. */
export function arrayIndex(name: string): number {
  const c = name.charCodeAt(0);
  if (!(c >= 0x30 && c <= 0x39)) {
    return -1;
  }

  const i = Number(name);
  return i >>> 0 === i && i !== 0xffffffff && String(i) === name ? i : -1;
}

/** The qualified name of a class's name, "uri::name", or the name in the unnamed package. */
export function qualifiedName(mn: Multiname): string {
  const ns = mn.namespaces[0];
  return ns?.uri ? `${ns.uri}::${mn.name}` : (mn.name ?? "*");
}

/** As avmplus' String to Number: JavaScript's, without its binary and octal prefixes. */
export function stringToNumber(s: string): number {
  const t = s.trim();
  if (/^[-+]?0[bBoO]/.test(t)) {
    return Number.NaN;
  }

  if (/^[-+]0[xX]/.test(t)) {
    const n = Number(t.slice(1));
    return t[0] === "-" ? -n : n;
  }

  return Number(t);
}

/** A number as AS3 writes it: avmplus' own formatting, not JavaScript's. */
export function numberToString(n: number): string {
  return convertDoubleToString(n);
}
