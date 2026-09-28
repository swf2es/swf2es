// Writes an ABC as one ES module: its names, a factory per method, the
// layouts of its traits as the compiler computed them, its classes and its
// scripts. The runtime builds its objects from these and never derives a
// layout itself (see docs/architecture.md, "Modules and the bootstrap").
//
//   export default function (rt) {
//     const N = [...namespaces], S = [...namespace sets], M = [...multinames];
//     const F = [...method factories, (scope, sup) => function (...) {...}];
//     const A = rt.abc({ linked, names: M, classes, scripts, activations });
//     return A;
//   }
//
// A factory makes a method's function once its scope chain is known: `scope`
// is the chain it captured, and `sup` the base class of the class it is a
// method of, for the super instructions. Methods reach the module's own
// descriptors, such as the class a newclass creates, through A.
import { BodyDecoder, verifyMethods } from "../abc/code";
import {
  CONSTANT_Multiname,
  CONSTANT_MultinameA,
  CONSTANT_MultinameL,
  CONSTANT_MultinameLA,
  CONSTANT_Qname,
  CONSTANT_QnameA,
  CONSTANT_RTQname,
  CONSTANT_RTQnameA,
  CONSTANT_TypeName,
  INSTANCE_Final,
  INSTANCE_Interface,
  METHOD_Native,
  TRAIT_Class,
  TRAIT_Const,
  TRAIT_Getter,
  TRAIT_Method,
  TRAIT_Setter,
  TRAIT_Slot,
} from "../abc/constants";
import { Domain, NS_Private } from "../link/domain";
import { TRAITS_Class, TRAITS_Instance } from "../link/traits";
import { MethodEmitter } from "./method";
import { Output } from "./output";

@final
export class ModuleEmitter {
  methods: MethodEmitter;
  out: Output;
  domain: Domain;
  index: u32;

  constructor(domain: Domain, index: u32) {
    const methods = new MethodEmitter(domain, index);
    this.domain = domain;
    this.index = index;
    this.methods = methods;
    this.out = methods.out;
  }

  /** Write the whole module; the result is in `out`. */
  module(): void {
    const out = this.out;
    out.reset();
    out.text("export default function (rt) {\n");
    this.names();
    this.functions();
    out.text("  const A = rt.abc({\n    linked: ");
    out.uint(this.index);
    out.text(",\n    names: M,\n    classes: [");
    this.classes();
    out.text("],\n    scripts: [");
    this.scripts();
    out.text("],\n    activations: [");
    this.activations();
    out.text("],\n  });\n  return A;\n}\n");
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
    if (kind === CONSTANT_TypeName) {
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
      case CONSTANT_Qname:
      case CONSTANT_QnameA:
        out.text("[");
        out.uint(pool.mnA[i]);
        out.text("]");
        break;
      case CONSTANT_Multiname:
      case CONSTANT_MultinameA:
      case CONSTANT_MultinameL:
      case CONSTANT_MultinameLA:
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
      kind === CONSTANT_Qname ||
      kind === CONSTANT_QnameA ||
      kind === CONSTANT_RTQname ||
      kind === CONSTANT_RTQnameA ||
      kind === CONSTANT_Multiname ||
      kind === CONSTANT_MultinameA;
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
      if (abc.methodFlags[m] & METHOD_Native) {
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
      out.text("(scope, sup) => ");
      this.methods.method(m, global, decoder.ir);
    }

    out.text("];\n");
  }

  /**
   * A native method's name, as avmplus binds its C++ ones: "Class.name" for
   * a class's static method, "Class#name" for an instance method, and the
   * qualified name alone for a script's function; getters and setters as
   * "get:" and "set:" names, and names outside the public namespace with
   * their namespace's URI, "uri::name".
   */
  nativeName(m: u32): void {
    const out = this.out;
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
          (tk === TRAIT_Method || tk === TRAIT_Getter || tk === TRAIT_Setter) &&
          abc.traitIndex[i] === local
        ) {
          if (tk === TRAIT_Getter) {
            text += "get:";
          } else if (tk === TRAIT_Setter) {
            text += "set:";
          }

          traits.readName(domain, this.index, i);
          text += this.methods.qualified(traits.nameNs, traits.nameId);
          break;
        }
      }
    }

    const bytes = String.UTF8.encode(text);
    out.string(changetype<usize>(bytes), bytes.byteLength);
  }

  /**
   * Traits t as { slots, defaults, types, bindings, methods }: the slot
   * count with the base's, its own slots' initial values and types, its own
   * bindings as [namespace, version, name, binding], and its own methods by
   * dispatch id.
   */
  traits(t: u32): void {
    const out = this.out;
    const domain = this.domain;
    const traits = domain.traits;
    const abc = domain.abcs[this.index];
    out.text("{ slots: ");
    out.uint(traits.slotCount[t]);
    out.text(", defaults: [");
    let first = true;
    const slotStart = traits.slotStart[t];
    const base = traits.base[t];
    for (let i = traits.first[t]; i < traits.end[t]; i++) {
      const kind = abc.traitTag[i] & 0x0f;
      if (kind !== TRAIT_Slot && kind !== TRAIT_Const && kind !== TRAIT_Class) {
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
      if (kind === TRAIT_Class) {
        out.text("null");
      } else {
        this.methods.constant(abc.traitValue[i], abc.traitValueKind[i], type);
      }

      out.text(", ");
      this.methods.typeRef(type);
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
      out.text(flags & INSTANCE_Final ? "true" : "false");
      out.text(", interface: ");
      out.text(flags & INSTANCE_Interface ? "true" : "false");
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
