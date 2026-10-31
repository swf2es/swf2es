// The instructions of the object model, as the method emitter writes them:
// scopes, names, slots and properties, calls, and creating objects,
// functions and classes; domain memory, and XML's. And what each notes of
// the default XML namespace, which a method that can see it checks on entry
// (see MethodEmitter.checkEntry).

import * as C from "../abc/constants";
import * as ops from "../abc/opcodes";
import { opcodeNames } from "../abc/opcodes";
import {
  IR_CallGetter,
  IR_CallInterface,
  IR_CallSetter,
  IR_ConstructSlot,
  IR_FindPropGlobal,
  IR_FindPropGlobalStrict,
  IR_GetGlobalScope,
  IR_Nip,
} from "../ir/ir";
import {
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Float,
  BUILTIN_Int,
  BUILTIN_Namespace,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_String,
  BUILTIN_Uint,
} from "../link/traits";
import { NONE } from "./copies";
import { inRange, isAddress, viewMethod } from "./memory";
import { MethodEmitter } from "./method";
import { poolString, typeRef } from "./refs";
import { call2, isNumber, isNumeric } from "./values";

/** Whether register r may hold XML or an XMLList: untyped, Object, or either. */
function mayBeXml(em: MethodEmitter, r: i32): bool {
  const type = em.regType[r];
  const bt = em.domain.builtin(type);
  return (
    bt === BUILTIN_Any ||
    bt === BUILTIN_Object ||
    type === em.domain.xmlType ||
    type === em.domain.xmlListType
  );
}

/**
 * Note whether instruction i, `op` on register `src`, can see the default
 * XML namespace. A call or construction the linker did not bind may reach
 * XML's, XMLList's or QName's class through any name, as a class held in
 * a variable, so each counts; a call of a value, when the value may be a
 * class.
 */
function notesDxns(em: MethodEmitter, op: u16, src: i32): void {
  switch (op) {
    case ops.OP_getproperty:
    case ops.OP_setproperty:
    case ops.OP_initproperty:
    case ops.OP_deleteproperty:
    case ops.OP_getdescendants:
      if (mayBeXml(em, src)) {
        em.seesDxns = true;
      }

      break;
    case ops.OP_in:
      if (mayBeXml(em, src + 1)) {
        em.seesDxns = true;
      }

      break;
    case ops.OP_call:
      if (mayBeXml(em, src) || em.regType[src] === em.domain.classType) {
        em.seesDxns = true;
      }

      break;
    case ops.OP_callproperty:
    case ops.OP_callproplex:
    case ops.OP_callpropvoid:
    case ops.OP_constructprop:
    case IR_ConstructSlot:
    case ops.OP_construct:
    case ops.OP_newfunction:
    case ops.OP_newclass:
    case ops.OP_pushwith:
    case ops.OP_dxns:
    case ops.OP_dxnslate:
      em.seesDxns = true;
      break;
  }
}

/**
 * The instructions of the object model: scopes, names, properties, calls,
 * and creating objects, functions and classes; false for one it does not
 * know, which then calls rt.unsupported.
 */
export function object(em: MethodEmitter, i: u32, op: u16): bool {
  const out = em.out;
  const ir = em.ir;
  const a = ir.a[i];
  const src = ir.src[i];
  if (!em.seesDxns) {
    notesDxns(em, op, src);
  }
  switch (op) {
    case ops.OP_pushscope:
    case ops.OP_pushwith:
      em.scopeWith[em.scopeDepth++] = op === ops.OP_pushwith ? 1 : 0;
      if (em.copies(i, src)) {
        return true;
      }

      em.assign(i);
      em.reg(src);
      return true;
    case ops.OP_popscope:
      em.scopeDepth--;
      em.reset(src);
      return true;
    case ops.OP_getscopeobject:
      if (em.copies(i, src)) {
        return true;
      }

      em.assign(i);
      em.reg(src);
      return true;
    case ops.OP_getouterscope:
      em.assign(i);
      out.text("scope[");
      em.usesScope = true;
      out.uint(a);
      out.text("]");
      return true;
    case ops.OP_getglobalscope:
    case IR_GetGlobalScope:
      if (em.ir.outerSize === 0 && em.copies(i, <i32>em.ir.localCount)) {
        return true;
      }

      em.assign(i);
      globalScope(em);
      return true;
    case ops.OP_finddef:
      // The name keeps its script's global object once found, so a static
      // read in a loop costs a load and no call.
      em.assign(i);
      out.text("M[");
      out.uint(a);
      out.text("].global ?? rt.findDef(M[");
      out.uint(a);
      out.text("])");
      return true;
    case IR_FindPropGlobal:
    case IR_FindPropGlobalStrict:
      em.assign(i);
      // Not found statically: a script's name, or else the global object's.
      out.text("M[");
      out.uint(a);
      out.text("].global ?? ");
      out.text(op === IR_FindPropGlobalStrict ? "rt.findGlobalStrict(M[" : "rt.findGlobal(M[");
      out.uint(a);
      out.text("], ");
      globalScope(em);
      out.text(")");
      return true;
    case ops.OP_findproperty:
    case ops.OP_findpropstrict:
      em.assign(i);
      out.text(op === ops.OP_findpropstrict ? "rt.findPropertyStrict(" : "rt.findProperty(");
      name(em, a, src);
      out.text(", scope, ");
      em.usesScope = true;
      localScopes(em);
      out.text(")");
      return true;
    case ops.OP_getslot:
      em.assign(i);
      em.member(src);
      out.text(".$");
      out.uint(a);
      return true;
    case ops.OP_setslot:
      em.member(src);
      out.text(".$");
      out.uint(a);
      out.text(" = ");
      em.reg(src + 1);
      return true;
    case ops.OP_getglobalslot:
      em.assign(i);
      globalScope(em);
      out.text(".$");
      out.uint(a);
      return true;
    case ops.OP_setglobalslot:
      globalScope(em);
      out.text(".$");
      out.uint(a);
      out.text(" = ");
      em.reg(src);
      return true;
    case IR_CallGetter:
      em.assign(i);
      virtual(em, a, src, 0);
      return true;
    case IR_CallSetter:
      virtual(em, a, src, 1);
      return true;
    case ops.OP_callmethod:
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      virtual(em, a, src, ir.b[i]);
      return true;
    case IR_CallInterface:
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      // By the interface's dispatch id, which its layout maps to a name.
      out.text("rt.callInterface(");
      typeRef(em, em.regType[src]);
      out.text(", ");
      out.uint(a);
      out.text(", ");
      em.reg(src);
      args(em, src + 1, ir.b[i]);
      out.text(")");
      return true;
    case IR_Nip:
      if (em.copies(i, src + <i32>ir.srcCount[i] - 1)) {
        return true;
      }

      em.assign(i);
      em.reg(src + <i32>ir.srcCount[i] - 1);
      return true;
    case ops.OP_getproperty:
      if (indexed(em, a, src + 1)) {
        // As avmplus' getUintProperty: an element by its number, of a
        // Vector by the kind of its elements where the IR knows it.
        const kind = vectorKind(em, em.regType[src]);
        const float = kind === "Float";
        em.assign(i, float);
        const box = float && !em.unboxedTarget(i);
        if (box) {
          out.text("rt.float(");
        }

        // An Array's element read in place, so that each site keeps its own
        // feedback in the engine: a hole, a number that is no index, null
        // and undefined read none, and getIndexed finds them as before.
        if (arrayElements(em, a, src)) {
          receiver(em, src);
          out.text(".$a[");
          em.reg(src + 1);
          out.text("] ?? ");
        }

        out.text(kind.length ? "rt.vectorGet" : "rt.getIndexed(");
        if (kind.length) {
          out.text(kind);
          out.text("(");
        }

        em.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("], ");
        em.reg(src + 1);
        out.text(")");
        if (box) {
          out.text(")");
        }

        return true;
      }

      em.assign(i);
      out.text("rt.getProperty(");
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      out.text(")");
      return true;
    case ops.OP_setproperty:
      if (indexed(em, a, src + 1)) {
        const kind = vectorKind(em, em.regType[src]);
        // An Array's element below its length written in place, as
        // setIndexed writes it; the receiver read first, as the call
        // reads it first. Anything else goes to setIndexed.
        if (arrayElements(em, a, src)) {
          const index = em.builtinOf(src + 1);
          out.text("if (");
          receiver(em, src);
          out.text(".$a.length > ");
          em.reg(src + 1);
          if (index === BUILTIN_Int) {
            out.text(" && ");
            em.reg(src + 1);
            out.text(" >= 0");
          } else if (index !== BUILTIN_Uint) {
            out.text(" && ");
            em.reg(src + 1);
            out.text(" >>> 0 === ");
            em.reg(src + 1);
          }

          out.text(") ");
          em.reg(src);
          out.text(".$a[");
          em.reg(src + 1);
          out.text("] = ");
          em.reg(src + 2);
          out.text("; else ");
        }

        out.text(kind.length ? "rt.vectorSet" : "rt.setIndexed(");
        if (kind.length) {
          out.text(kind);
          out.text("(");
        }

        em.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("], ");
        em.reg(src + 1);
        out.text(", ");
        if (kind === "Float") {
          em.numberReg(src + 2);
        } else {
          em.reg(src + 2);
        }

        out.text(")");
        return true;
      }

      out.text("rt.setProperty(");
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      out.text(", ");
      em.reg(src + <i32>ir.srcCount[i] - 1);
      out.text(")");
      return true;
    case ops.OP_initproperty: {
      out.text(op === ops.OP_initproperty ? "rt.initProperty(" : "rt.setProperty(");
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      out.text(", ");
      em.reg(src + <i32>ir.srcCount[i] - 1);
      out.text(")");
      return true;
    }
    case ops.OP_deleteproperty:
      em.assign(i);
      out.text("rt.deleteProperty(");
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      out.text(")");
      return true;
    case ops.OP_in:
      em.assign(i);
      // `name in object`.
      call2(em, "rt.in(", i);
      return true;
    case ops.OP_callproperty:
    case ops.OP_callproplex:
    case ops.OP_callpropvoid:
    case ops.OP_constructprop: {
      const argc = ir.b[i];
      const parts = ir.srcCount[i] - 1 - argc;
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      out.text(
        op === ops.OP_constructprop
          ? "rt.constructProperty("
          : op === ops.OP_callproplex
            ? "rt.callPropLex("
            : "rt.callProperty(",
      );
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      args(em, src + 1 + <i32>parts, argc);
      out.text(")");
      return true;
    }
    case ops.OP_callsuper:
    case ops.OP_callsupervoid:
    case ops.OP_getsuper:
    case ops.OP_setsuper: {
      const argc = op === ops.OP_getsuper ? 0 : op === ops.OP_setsuper ? 1 : ir.b[i];
      const parts = ir.srcCount[i] - 1 - argc;
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      out.text(
        op === ops.OP_getsuper
          ? "rt.getSuper(sup, "
          : op === ops.OP_setsuper
            ? "rt.setSuper(sup, "
            : "rt.callSuper(sup, ",
      );
      em.usesSup = true;
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      args(em, src + 1 + <i32>parts, argc);
      out.text(")");
      return true;
    }
    case ops.OP_constructsuper:
      out.text("rt.constructSuper(sup, ");
      em.usesSup = true;
      em.reg(src);
      args(em, src + 1, a);
      out.text(")");
      return true;
    case ops.OP_construct:
      em.assign(i);
      out.text("rt.construct(");
      em.reg(src);
      args(em, src + 1, a);
      out.text(")");
      return true;
    case IR_ConstructSlot:
      em.assign(i);
      out.text("rt.construct(");
      em.member(src);
      out.text(".$");
      out.uint(a);
      args(em, src + 1, ir.b[i]);
      out.text(")");
      return true;
    case ops.OP_call:
      em.assign(i);
      out.text("rt.call(");
      em.reg(src);
      out.text(", ");
      em.reg(src + 1);
      args(em, src + 2, a);
      out.text(")");
      return true;
    case ops.OP_callstatic:
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      out.text("rt.callStatic(A, ");
      out.uint(a);
      out.text(", ");
      em.reg(src);
      args(em, src + 1, ir.b[i]);
      out.text(")");
      return true;
    case ops.OP_newfunction:
      em.assign(i);
      out.text("rt.newFunction(F[");
      out.uint(a);
      out.text("], ");
      scopeHere(em);
      // Its method's id, as avmplus writes a function as [object Function-id].
      out.text(", ");
      out.uint(a);
      out.text(")");
      return true;
    case ops.OP_newclass:
      em.assign(i);
      out.text("rt.newClass(A.classes[");
      out.uint(a);
      out.text("], ");
      em.reg(src);
      out.text(", ");
      scopeHere(em);
      out.text(")");
      return true;
    case ops.OP_newactivation:
      em.assign(i);
      out.text("rt.newActivation(A.activations[");
      out.int(em.body);
      out.text("])");
      return true;
    case ops.OP_newcatch: {
      const abc = em.abc;
      const h = abc.bodyExceptionStart[em.body] + a;
      em.assign(i);
      out.text("rt.newCatch(M[");
      out.uint(abc.exceptionName[h]);
      out.text("])");
      return true;
    }
    case ops.OP_newobject:
      em.assign(i);
      out.text("rt.newObject([");
      list(em, src, ir.srcCount[i]);
      out.text("])");
      return true;
    case ops.OP_newarray:
      em.assign(i);
      out.text("rt.newArray([");
      list(em, src, ir.srcCount[i]);
      out.text("])");
      return true;
    case ops.OP_applytype:
      em.assign(i);
      out.text("rt.applyType(");
      em.reg(src);
      out.text(", [");
      list(em, src + 1, a);
      out.text("])");
      return true;
    case ops.OP_hasnext:
      em.assign(i);
      call2(em, "rt.hasNext(", i);
      return true;
    case ops.OP_hasnext2: {
      // hasnext2 updates its two locals: the object and the index.
      const b = ir.b[i];
      out.text("[");
      em.regName(ir.dst[i]);
      out.text(", ");
      em.regName(<i32>a);
      out.text(", ");
      em.regName(<i32>b);
      out.text("] = rt.hasNext2(");
      em.reg(<i32>a);
      out.text(", ");
      em.reg(<i32>b);
      out.text(")");
      return true;
    }
    case ops.OP_nextname:
      em.assign(i);
      call2(em, "rt.nextName(", i);
      return true;
    case ops.OP_nextvalue:
      em.assign(i);
      call2(em, "rt.nextValue(", i);
      return true;
    case ops.OP_instanceof:
      em.assign(i);
      call2(em, "rt.instanceOf(", i);
      return true;
    case ops.OP_istypelate:
      em.assign(i);
      call2(em, "rt.isTypeLate(", i);
      return true;
    case ops.OP_astypelate:
      em.assign(i);
      call2(em, "rt.asTypeLate(", i);
      return true;
    case ops.OP_istype:
    case ops.OP_astype:
      em.assign(i);
      out.text(op === ops.OP_istype ? "rt.isType(" : "rt.asType(");
      em.reg(src);
      out.text(", M[");
      out.uint(a);
      out.text("])");
      return true;
    // Domain memory: in place at an int address, else through the
    // runtime, which checks the range and converts the address; also
    // what the code in place calls for an address out of range, so that
    // the runtime rejects it as avmplus does. Sign extensions in plain
    // JavaScript.
    case ops.OP_li8:
    case ops.OP_li16:
    case ops.OP_li32:
    case ops.OP_lf32:
    case ops.OP_lf64:
      em.assign(i);
      if (isAddress(em, src)) {
        out.text("(");
        inRange(em, src, op);
        out.text(" ? rt.view.");
        out.text(viewMethod(op));
        out.text("(");
        em.reg(src);
        out.text(op === ops.OP_li8 ? ")" : ", true)");
        out.text(" : ");
      }

      out.text("rt.");
      out.text(opcodeNames[op]);
      out.text("(");
      em.reg(src);
      out.text(")");
      if (isAddress(em, src)) {
        out.text(")");
      }

      return true;
    case ops.OP_si8:
    case ops.OP_si16:
    case ops.OP_si32:
    case ops.OP_sf32:
    case ops.OP_sf64:
      // The value's conversion is DataView's own for a number or Boolean.
      if (isAddress(em, src + 1) && isNumeric(em, src)) {
        out.text("if (");
        inRange(em, src + 1, op);
        out.text(") rt.view.");
        out.text(viewMethod(op));
        out.text("(");
        em.reg(src + 1);
        out.text(", ");
        em.reg(src);
        out.text(op === ops.OP_si8 ? "); else " : ", true); else ");
      }

      out.text("rt.");
      out.text(opcodeNames[op]);
      out.text("(");
      em.reg(src);
      out.text(", ");
      em.reg(src + 1);
      out.text(")");
      return true;
    case ops.OP_sxi1:
    case ops.OP_sxi8:
    case ops.OP_sxi16:
      em.assign(i);
      out.text("(");
      em.reg(src);
      out.text(
        op === ops.OP_sxi1
          ? " << 31) >> 31"
          : op === ops.OP_sxi8
            ? " << 24) >> 24"
            : " << 16) >> 16",
      );
      return true;
    case ops.OP_getdescendants:
      em.assign(i);
      out.text("rt.getDescendants(");
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      out.text(")");
      return true;
    case ops.OP_dxns:
      out.text("rt.setDefaultXmlNamespace(");
      poolString(em, a);
      out.text(")");
      return true;
    case ops.OP_dxnslate:
      out.text("rt.setDefaultXmlNamespace(");
      em.reg(src);
      out.text(")");
      return true;
    case ops.OP_checkfilter:
      out.text("rt.checkFilter(");
      em.reg(src);
      out.text(")");
      return true;
    case ops.OP_esc_xelem:
    case ops.OP_esc_xattr:
      em.assign(i);
      out.text(op === ops.OP_esc_xelem ? "rt.escapeElement(" : "rt.escapeAttribute(");
      em.reg(src);
      out.text(")");
      return true;
    default:
      return false;
  }
}

/** The method's global object: its scope chain's first, else its own first scope. */
function globalScope(em: MethodEmitter): void {
  if (em.ir.outerSize > 0) {
    em.out.text("scope[0]");
    em.usesScope = true;
  } else {
    em.reg(<i32>em.ir.localCount);
  }
}

/** The scopes pushed so far, innermost last: [sc0, ...], with their with flags. */
function localScopes(em: MethodEmitter): void {
  const out = em.out;
  out.text("[");
  let withs: u32 = 0;
  for (let d: u32 = 0; d < em.scopeDepth; d++) {
    if (d) {
      out.text(", ");
    }

    em.reg(<i32>(em.ir.localCount + d));
    withs |= (<u32>em.scopeWith[d]) << d;
  }

  out.text("], ");
  out.uint(withs);
}

/** The scope chain a function or class created here runs in. */
function scopeHere(em: MethodEmitter): void {
  em.out.text("rt.scope(scope, ");
  em.usesScope = true;
  localScopes(em);
  em.out.text(")");
}

/**
 * Multiname `a`: M[a], or with its runtime namespace and
 * name taken from the registers from `from`.
 */
function name(em: MethodEmitter, a: u32, from: i32): void {
  const out = em.out;
  const kind = em.abc.pool.mnKind[a];
  const parts =
    kind === C.CONSTANT_RTQnameL || kind === C.CONSTANT_RTQnameLA
      ? 2
      : kind === C.CONSTANT_RTQname ||
          kind === C.CONSTANT_RTQnameA ||
          kind === C.CONSTANT_MultinameL ||
          kind === C.CONSTANT_MultinameLA
        ? 1
        : 0;
  if (parts === 0) {
    out.text("M[");
    out.uint(a);
    out.text("]");
    return;
  }

  out.text("rt.runtimeName(M[");
  out.uint(a);
  out.text("]");
  for (let k: i32 = 0; k < parts; k++) {
    out.text(", ");
    em.reg(from + k);
  }

  out.text(")");
}

/**
 * Whether multiname `a` is a runtime name alone, not an attribute, whose
 * name in register r is a number: an element's index, which the runtime
 * reads and writes without making the name.
 */
/** The kind of a Vector's elements, as the runtime's vectorGet and vectorSet name it, for type t; "" if not a Vector's. */
function vectorKind(em: MethodEmitter, t: i32): string {
  const domain = em.domain;
  if (t < 0) {
    return "";
  }

  if (t === domain.vectorIntType) {
    return "Int";
  }

  if (t === domain.vectorUintType) {
    return "Uint";
  }

  if (t === domain.vectorDoubleType) {
    return "Double";
  }

  if (domain.floatType >= 0 && domain.traits.param[t] === domain.floatType) {
    return "Float";
  }

  return domain.vectorObjectType >= 0 &&
    domain.traits.subtypeOf(<u32>t, <u32>domain.vectorObjectType)
    ? "Object"
    : "";
}

function indexed(em: MethodEmitter, a: u32, r: i32): bool {
  return em.abc.pool.mnKind[a] === C.CONSTANT_MultinameL && isNumber(em, r);
}

/**
 * Whether the indexed access by multiname `a` on register r reads an
 * Array's elements, as getIndexed and setIndexed do: r an Array, or of a
 * class that extends it, and a public namespace in the set.
 */
function arrayElements(em: MethodEmitter, a: u32, r: i32): bool {
  const domain = em.domain;
  const t = em.regType[r];
  return (
    t >= 0 &&
    domain.arrayType >= 0 &&
    domain.traits.subtypeOf(<u32>t, <u32>domain.arrayType) &&
    domain.hasPublicNamespace(em.index, a)
  );
}

/**
 * Register r read before a `.`, null checked unless it is known not to
 * be null here: `(r ?? nn(r))` or `r`.
 */
function receiver(em: MethodEmitter, r: i32): void {
  const copy = em.copyOf[r];
  const checked = copy === NONE ? r : copy;
  if (r !== em.pendingNull && checked >= 0 && em.checked[checked]) {
    em.read(r);
    return;
  }

  em.out.byte(0x28); // (
  if (r === em.pendingNull) {
    em.reg(r);
  } else {
    em.checkedRead(r);
    if (checked >= 0) {
      em.checked[checked] = 1;
    }
  }

  em.out.byte(0x29); // )
}

/** `, r, r+1, ...` for `count` arguments from register `from`. */
function args(em: MethodEmitter, from: i32, count: u32): void {
  for (let k: u32 = 0; k < count; k++) {
    em.out.text(", ");
    em.reg(from + <i32>k);
  }
}

function list(em: MethodEmitter, from: i32, count: u32): void {
  for (let k: u32 = 0; k < count; k++) {
    if (k) {
      em.out.text(", ");
    }

    em.reg(from + <i32>k);
  }
}

/**
 * A call by dispatch id `disp` on the receiver in `src`, with `argc`
 * arguments after it: a method of the receiver's prototype, or for a
 * primitive receiver, or a namespace, which the runtime represents
 * itself, of its class's.
 */
function virtual(em: MethodEmitter, disp: u32, src: i32, argc: u32): void {
  const out = em.out;
  const type = em.regType[src];
  // XML's methods look names up in the default XML namespace.
  if (type === em.domain.xmlType || type === em.domain.xmlListType) {
    em.seesDxns = true;
  }

  const bt = em.builtinOf(src);
  const primitive =
    bt === BUILTIN_Int ||
    bt === BUILTIN_Uint ||
    bt === BUILTIN_Number ||
    bt === BUILTIN_Float ||
    bt === BUILTIN_Boolean ||
    bt === BUILTIN_String ||
    bt === BUILTIN_Namespace;
  if (primitive) {
    out.text("rt.prototypeOf(");
    typeRef(em, type);
    out.text(").$m");
    out.uint(disp);
    out.text(".call(");
    em.reg(src);
    args(em, src + 1, argc);
    out.text(")");
    return;
  }

  // An Object may be a primitive, or a Namespace, whose methods are its
  // class prototype's; any other object has its own.
  if (bt === BUILTIN_Object) {
    out.text("(");
    em.member(src);
    out.text(".$m");
    out.uint(disp);
    out.text(" ?? rt.prototypeOf(");
    typeRef(em, type);
    out.text(").$m");
    out.uint(disp);
    out.text(").call(");
    em.reg(src);
    args(em, src + 1, argc);
    out.text(")");
    return;
  }

  em.member(src);
  out.text(".$m");
  out.uint(disp);
  out.text("(");
  list(em, src + 1, argc);
  out.text(")");
}
