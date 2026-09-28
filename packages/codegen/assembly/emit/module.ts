// Writes an ABC as one ES module: its names, a factory per method, the
// layouts of its traits as the compiler computed them, its classes and its
// scripts. The runtime builds its objects from these and never derives a
// layout itself (see docs/architecture.md, "Modules and the bootstrap").
// Those layouts depend on the ABCs loaded before this one, so the module
// names them by hash, and the runtime refuses it after any others.
//
//   export default function (rt) {
//     const N = [...namespaces], S = [...namespace sets], M = [...multinames];
//     const F = [...method factories, (scope, sup) => function (...) {...}];
//     const A = rt.abc({ hash, linked, names: M, classes, scripts, activations });
//     return A;
//   }
//
// A factory makes a method's function once its scope chain is known: `scope`
// is the chain it captured, and `sup` the base class of the class it is a
// method of, for the super instructions. Methods reach the module's own
// descriptors, such as the class a newclass creates, through A. A method
// that refers to classes or Vectors has them in a table of its own, T,
// made as the module loads:
//
//     ((...T) => (scope, sup) => function (...) {... T[0] ...})(rt.cls(...))
//
// numbered as the method first refers to each, so that its code does not
// depend on the module's other methods: compiled alone, as lazy JIT will
// compile it, it comes out as it is in the module.
import { BodyDecoder, verifyMethods } from "../abc/code";
import * as C from "../abc/constants";
import { Domain, NS_Private } from "../link/domain";
import { TRAITS_Class, TRAITS_Instance } from "../link/traits";
import { MethodEmitter } from "./method";
import { Output } from "./output";

@final
export class ModuleEmitter {
  methods: MethodEmitter;
  out: Output;
  /** Each compiled method's entry in F: its body, and where it starts and ends in the module. */
  entryBody: u32[] = [];
  entryStart: u32[] = [];
  entryEnd: u32[] = [];
  domain: Domain;
  index: u32;

  constructor(domain: Domain, index: u32) {
    const methods = new MethodEmitter(domain, index);
    this.domain = domain;
    this.index = index;
    this.methods = methods;
    this.out = methods.out;
  }

  /**
   * Write the whole module; the result is in `out`. `hashes` are the
   * hashes of the domain's ABCs, in load order, up to and including this
   * one, as the host computes them for the cache key.
   */
  module(hashes: string[]): void {
    const out = this.out;
    out.reset();
    this.methods.map.reset();
    out.text("export default function (rt) {\n");
    this.names();
    this.functions();
    out.text("  const A = rt.abc({\n    hash: ");
    this.text(this.index < <u32>hashes.length ? hashes[this.index] : "");
    out.text(",\n    linked: [");
    for (let i: u32 = 0; i < this.index; i++) {
      if (i) {
        out.text(", ");
      }

      this.text(i < <u32>hashes.length ? hashes[i] : "");
    }

    out.text("],\n    names: M,\n    classes: [");
    this.classes();
    out.text("],\n    scripts: [");
    this.scripts();
    out.text("],\n    activations: [");
    this.activations();
    out.text("],\n  });\n  return A;\n}\n");
  }

  /** The source map of the module just written, as JSON, into `map`. */
  sourceMap(map: Output): void {
    const methods = this.methods;
    methods.map.write(map, this.out, this.domain.abcs[this.index].pool, methods.base);
  }

  /** N: the pool's namespaces; S: its namespace sets; M: its multinames. */
  names(): void {
    const out = this.out;
    const domain = this.domain;
    const pool = domain.abcs[this.index].pool;
    const ids = domain.abcNs[this.index];
    const versions = domain.abcNsVersion[this.index];
    out.text("  const N = [null");
    for (let i: u32 = 1; i < pool.nsCount; i++) {
      out.text(", ");
      const id = ids[i];
      if (domain.nsType[id] === NS_Private) {
        out.text("rt.privateNs(");
        this.methods.uri(domain.nsUri[id]);
        out.text(")");
      } else {
        this.methods.namespace(id);
      }
    }

    out.text("];\n  const V = [0");
    for (let i: u32 = 1; i < pool.nsCount; i++) {
      out.text(", ");
      out.uint(versions[i]);
    }

    out.text("];\n  const S = [null");
    for (let i: u32 = 1; i < pool.nsSetCount; i++) {
      out.text(", [");
      for (let j = pool.nsSetStart[i]; j < pool.nsSetStart[i + 1]; j++) {
        if (j > pool.nsSetStart[i]) {
          out.text(", ");
        }

        out.uint(pool.nsSetMembers[j]);
      }

      out.text("]");
    }

    out.text("];\n  const M = [null");
    for (let i: u32 = 1; i < pool.multinameCount; i++) {
      out.text(",\n    ");
      this.multiname(i);
    }

    out.text("];\n");
  }

  /**
   * Multiname i as rt.name(kind, namespace indices, name): kinds as the ABC
   * numbers them, namespaces as indices into N (and their versions into V),
   * a null name for any name; TypeNames as rt.typeName(base, parameter).
   */
  multiname(i: u32): void {
    const out = this.out;
    const pool = this.domain.abcs[this.index].pool;
    const kind = pool.mnKind[i];
    if (kind === C.CONSTANT_TypeName) {
      out.text("rt.typeName(N, V, S, ");
      out.uint(pool.mnA[i]);
      out.text(", ");
      out.uint(pool.mnB[i]);
      out.text(")");
      return;
    }

    out.text("rt.name(N, V, ");
    out.uint(kind);
    out.text(", ");
    switch (kind) {
      case C.CONSTANT_Qname:
      case C.CONSTANT_QnameA:
        out.text("[");
        out.uint(pool.mnA[i]);
        out.text("]");
        break;
      case C.CONSTANT_Multiname:
      case C.CONSTANT_MultinameA:
      case C.CONSTANT_MultinameL:
      case C.CONSTANT_MultinameLA:
        out.text("S[");
        out.uint(pool.mnA[i]);
        out.text("]");
        break;
      default:
        out.text("[]");
        break;
    }

    out.text(", ");
    const hasName =
      kind === C.CONSTANT_Qname ||
      kind === C.CONSTANT_QnameA ||
      kind === C.CONSTANT_RTQname ||
      kind === C.CONSTANT_RTQnameA ||
      kind === C.CONSTANT_Multiname ||
      kind === C.CONSTANT_MultinameA;
    const name = hasName ? pool.mnB[i] : 0;
    if (name) {
      this.methods.string(name);
    } else {
      out.text("null");
    }

    out.text(")");
  }

  /**
   * F: a factory per method, `(scope, sup) => function`, from its verified IR;
   * a native binds by name, and a method that failed verification throws
   * its VerifyError when called, as avmplus verifies on the first call.
   */
  functions(): void {
    const out = this.out;
    const domain = this.domain;
    const abc = domain.abcs[this.index];
    const results = verifyMethods(domain, this.index);
    const decoder = new BodyDecoder(abc, domain.abcBase[this.index], domain, this.index);
    const start = domain.methodStart[this.index];
    out.text("  const F = [");
    for (let m: u32 = 0; m < abc.methodCount; m++) {
      out.text(m ? ",\n    " : "\n    ");
      const global = start + m;
      const body = abc.methodBody[m];
      if (abc.methodFlags[m] & C.METHOD_Native) {
        out.text("rt.native(");
        this.nativeName(global);
        out.text(")");
        continue;
      }

      if (body < 0) {
        out.text("rt.noBody");
        continue;
      }

      const result = results[body];
      if (result < 0) {
        out.text("rt.unverified");
        continue;
      }

      if (result > 0) {
        out.text("rt.verifyError(");
        out.uint(result);
        out.text(")");
        continue;
      }

      decoder.decode(<u32>body, domain.traits.scopeOf(global));
      this.entryBody.push(<u32>body);
      this.entryStart.push(out.length);
      this.factory(m, global, decoder);
      this.entryEnd.push(out.length);
    }

    out.text("];\n");
  }

  /**
   * Method m's entry in F, from its IR in `decoder`: `(scope, sup) =>
   * function`, and if it refers to classes or Vectors, inside a function
   * of its table of them. The same whether the module is being written or
   * the method compiled alone.
   */
  factory(m: u32, global: u32, decoder: BodyDecoder): void {
    const out = this.out;
    const methods = this.methods;
    methods.types.length = 0;
    methods.typeIndex.clear();
    const at = out.length;
    const marks = methods.map.count;
    out.text("(scope, sup) => ");
    methods.functionName = this.functionName(global);
    methods.method(m, global, decoder.ir);
    methods.functionName = "";
    const types = methods.types;
    if (types.length === 0) {
      return;
    }

    // The table's function goes before the method, which it now knows the types of.
    const head = "((...T) => ";
    out.insert(at, head);
    methods.map.shift(marks, <u32>head.length);
    out.text(")(");
    for (let k = 0; k < types.length; k++) {
      out.text(k ? ", " : "");
      methods.typeExpr(types[k]);
    }

    out.text(")");
  }

  /**
   * A native method's name, as avmplus binds its C++ ones: "Class.name" for
   * a class's static method, "Class#name" for an instance method, and the
   * qualified name alone for a script's function; getters and setters as
   * "get:" and "set:" names, and names outside the public namespace with
   * their namespace's URI, "uri::name".
   */
  nativeName(m: u32): void {
    const bytes = String.UTF8.encode(this.methodName(m));
    this.out.string(changetype<usize>(bytes), bytes.byteLength);
  }

  /**
   * Method m's name as a JavaScript identifier for its function: its name
   * as nativeName gives it, each character outside [A-Za-z0-9_] as `_`, and
   * `$` before, which no name the generated code binds starts with; a
   * method no trait binds, such as a closure, as `$f` and its index.
   */
  functionName(m: u32): string {
    const text = this.methodName(m);
    if (text.length === 0) {
      return `$f${m - this.domain.methodStart[this.index]}`;
    }

    // Into one buffer, made once: a string grown a character at a time is
    // copied each time, which the minimal runtime collects only between calls.
    const units = new StaticArray<u16>(text.length + 1);
    units[0] = 0x24; // $
    for (let i = 0; i < text.length; i++) {
      const c = <u16>text.charCodeAt(i);
      const word =
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
      units[i + 1] = word ? c : 0x5f; // _
    }

    return String.UTF16.decodeUnsafe(changetype<usize>(units), units.length << 1);
  }

  /** Method m's name: "Class.name", "Class#name", or a script's qualified name, "" if no trait binds it. */
  methodName(m: u32): string {
    const domain = this.domain;
    const traits = domain.traits;
    const t = traits.methodTraits[m];
    const abc = domain.abcs[this.index];
    const local = m - domain.methodStart[this.index];
    let text = "";
    if (t >= 0) {
      const kind = traits.kind[t];
      if (kind === TRAITS_Instance || kind === TRAITS_Class) {
        text = this.methods.className(traits, <u32>t);
        text += kind === TRAITS_Class ? "." : "#";
      }

      // The trait that binds the method names it.
      for (let i = traits.first[t]; i < traits.end[t]; i++) {
        const tk = abc.traitTag[i] & 0x0f;
        if (
          (tk === C.TRAIT_Method || tk === C.TRAIT_Getter || tk === C.TRAIT_Setter) &&
          abc.traitIndex[i] === local
        ) {
          if (tk === C.TRAIT_Getter) {
            text += "get:";
          } else if (tk === C.TRAIT_Setter) {
            text += "set:";
          }

          traits.readName(domain, this.index, i);
          text += this.methods.qualified(traits.nameNs, traits.nameId);
          return text;
        }
      }
    }

    return "";
  }

  /**
   * Traits t as { slots, defaults, types, bindings, methods }: the slot
   * count with the base's, its own slots' initial values and types, its own
   * bindings as [namespace, version, name, binding], and its own methods by
   * dispatch id. Traits lay out when they resolve, which verifying the
   * methods may not have needed, so they resolve here; if they cannot, the
   * descriptor holds the VerifyError, which the runtime throws when the
   * class is created or the script run, as avmplus does.
   */
  traits(t: u32): void {
    const out = this.out;
    const domain = this.domain;
    const traits = domain.traits;
    const abc = domain.abcs[this.index];
    const error = traits.resolve(domain, t);
    if (error) {
      out.text("{ error: ");
      out.uint(<u32>error);
      out.text(", slots: 0, defaults: [], bindings: [], methods: [] }");
      return;
    }

    out.text("{ slots: ");
    out.uint(traits.slotCount[t]);
    out.text(", defaults: [");
    let first = true;
    const slotStart = traits.slotStart[t];
    const base = traits.base[t];
    for (let i = traits.first[t]; i < traits.end[t]; i++) {
      const kind = abc.traitTag[i] & 0x0f;
      if (kind !== C.TRAIT_Slot && kind !== C.TRAIT_Const && kind !== C.TRAIT_Class) {
        continue;
      }

      traits.readName(domain, this.index, i);
      const b = traits.own(t, traits.nameNs, traits.nameId, traits.nameNsVersion);
      const slot = b >> 3;
      out.text(first ? "[" : ", [");
      first = false;
      out.uint(slot);
      out.text(", ");
      const type = traits.slotType[slotStart + slot];
      if (kind === C.TRAIT_Class) {
        out.text("null");
      } else {
        this.methods.constant(abc.traitValue[i], abc.traitValueKind[i], type);
      }

      out.text(", ");
      this.methods.typeExpr(type);
      out.text("]");
    }

    out.text("], bindings: [");
    first = true;
    for (let m = traits.memberStart[t]; m < traits.memberEnd[t]; m++) {
      out.text(first ? "[" : ", [");
      first = false;
      const ns = traits.memberNs[m];
      if (domain.nsType[ns] === NS_Private) {
        out.text("N[");
        out.uint(this.poolIndexOf(ns));
        out.text("]");
      } else {
        this.methods.namespace(ns);
      }

      out.text(", ");
      out.uint(traits.memberVersion[m]);
      out.text(", ");
      const name = traits.memberName[m];
      out.string(domain.stringPtr[name], domain.stringLength[name]);
      out.text(", ");
      out.uint(traits.memberBinding[m]);
      out.text("]");
    }

    out.text("], methods: [");
    first = true;
    const dispatch = traits.dispatchStart[t];
    const baseDispatch = base >= 0 ? traits.dispatchStart[base] : 0;
    const baseMethods: u32 = base >= 0 ? traits.methodCount[base] : 0;
    const start = domain.methodStart[this.index];
    for (let d: u32 = 0; d < traits.methodCount[t]; d++) {
      const m = traits.dispatch[dispatch + d];
      if (m < 0 || (d < baseMethods && traits.dispatch[baseDispatch + d] === m)) {
        continue;
      }

      out.text(first ? "[" : ", [");
      first = false;
      out.uint(d);
      out.text(", F[");
      out.uint(<u32>m - start);
      out.text("]]");
    }

    out.text("] }");
  }

  /** A string of the host's, such as a hash, as a JavaScript string literal. */
  text(s: string): void {
    const bytes = String.UTF8.encode(s);
    this.out.string(changetype<usize>(bytes), bytes.byteLength);
  }

  /** The pool index of this ABC's namespace with interned id `id`. */
  poolIndexOf(id: u32): u32 {
    const ids = this.domain.abcNs[this.index];
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] === id) {
        return i;
      }
    }

    return 0;
  }

  /**
   * Each class as { name, base, interfaces, final, interface, protectedNs,
   * instance, static, init, cinit }, names as indices into M.
   */
  classes(): void {
    const out = this.out;
    const domain = this.domain;
    const abc = domain.abcs[this.index];
    const classStart = domain.classStart[this.index];
    for (let i: u32 = 0; i < abc.classCount; i++) {
      out.text(i ? ",\n    { name: " : "\n    { name: ");
      out.uint(abc.instanceName[i]);
      out.text(", base: ");
      out.uint(abc.instanceSuper[i]);
      out.text(", interfaces: [");
      for (let j = abc.instanceInterfaceStart[i]; j < abc.instanceInterfaceStart[i + 1]; j++) {
        if (j > abc.instanceInterfaceStart[i]) {
          out.text(", ");
        }

        out.uint(abc.interfaces[j]);
      }

      const flags = abc.instanceFlags[i];
      out.text("], final: ");
      out.text(flags & C.INSTANCE_Final ? "true" : "false");
      out.text(", interface: ");
      out.text(flags & C.INSTANCE_Interface ? "true" : "false");
      out.text(", sealed: ");
      out.text(flags & 1 ? "true" : "false");
      out.text(", protectedNs: ");
      out.uint(abc.instanceProtectedNs[i]);
      out.text(",\n      instance: ");
      this.traits(<u32>domain.classTraits[classStart + i]);
      out.text(",\n      static: ");
      this.traits(<u32>domain.classStatic[classStart + i]);
      out.text(",\n      init: F[");
      out.uint(abc.instanceInit[i]);
      out.text("], cinit: F[");
      out.uint(abc.classInit[i]);
      out.text("] }");
    }
  }

  /** Each script as { traits, init }. */
  scripts(): void {
    const out = this.out;
    const domain = this.domain;
    const abc = domain.abcs[this.index];
    const scripts = domain.scriptTraits[this.index];
    for (let s: u32 = 0; s < abc.scriptCount; s++) {
      out.text(s ? ",\n    { traits: " : "\n    { traits: ");
      this.traits(scripts[s]);
      out.text(", init: F[");
      out.uint(abc.scriptInit[s]);
      out.text("] }");
    }
  }

  /** Each body's activation traits, or null. */
  activations(): void {
    const out = this.out;
    const bodies = this.domain.bodyTraits[this.index];
    for (let b = 0; b < bodies.length; b++) {
      out.text(b ? ", " : "");
      if (bodies[b] < 0) {
        out.text("null");
      } else {
        this.traits(<u32>bodies[b]);
      }
    }
  }
}
