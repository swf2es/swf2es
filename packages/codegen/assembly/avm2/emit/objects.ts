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
  IR_CallSuper,
  IR_ConstructSlot,
  IR_FindPropGlobal,
  IR_FindPropGlobalStrict,
  IR_GetGlobalScope,
  IR_Nip,
} from "../ir/ir";
import { NS_Public, URI_None } from "../link/domain";
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
import { CONSTANT, NONE } from "./copies";
import { isAddress, viewMethod } from "./memory";
import { hasBoundEntry, MethodEmitter } from "./method";
import { aliasedMember, interfaceAlias, isClassRef, poolString, slotMember, typeRef } from "./refs";
import { CONVERTS, call2, convert, isNumber, isNumeric, keeps } from "./values";

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
      if (ir.c[i] > 0) {
        // The local scopes from c - 1 first, by what each is at run time.
        out.text(op === IR_FindPropGlobalStrict ? "rt.findLocalStrict(M[" : "rt.findLocal(M[");
        out.uint(a);
        out.text("], [");
        for (let d = <u32>ir.c[i] - 1; d < em.scopeDepth; d++) {
          if (d > <u32>ir.c[i] - 1) {
            out.text(", ");
          }

          em.reg(<i32>(em.ir.localCount + d));
        }

        out.text("], ");
        globalScope(em);
        out.text(")");
        return true;
      }

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
      slotMember(out, a);
      return true;
    case ops.OP_setslot:
      em.member(src);
      slotMember(out, a);
      out.text(" = ");
      em.reg(src + 1);
      return true;
    case ops.OP_getglobalslot:
      em.assign(i);
      globalScope(em);
      slotMember(out, a);
      return true;
    case ops.OP_setglobalslot:
      globalScope(em);
      slotMember(out, a);
      out.text(" = ");
      em.reg(src);
      return true;
    case IR_CallGetter:
      em.assign(i);
      if (vectorLength(em, src, ir.c[i])) {
        receiver(em, src);
        out.text(".$a.length");
        return true;
      }

      if (stringLength(em, src, ir.c[i])) {
        receiver(em, src);
        out.text(".length");
        return true;
      }

      virtual(em, a, src, 0, -1);
      return true;
    case IR_CallSetter:
      virtual(em, a, src, 1, ir.c[i]);
      return true;
    case ops.OP_callmethod:
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      virtual(em, a, src, ir.b[i], ir.c[i]);
      return true;
    case IR_CallInterface:
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      if (ir.b[i] <= em.domain.traits.paramCount[ir.c[i]]) {
        interfaceCall(em, a, src, ir.b[i]);
        return true;
      }

      // More arguments than the method declares, which its rest takes:
      // by name, as the class's method, which may have none, counts them.
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
    case ops.OP_getproperty: {
      if (interpretedKey(em, a, src + 1)) {
        em.assign(i);
        out.text("rt.getInterpreted(");
        em.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("], ");
        em.reg(src + 1);
        out.text(")");
        return true;
      }

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
        // and undefined read none, and getIndexed finds them as before. A
        // Vector's too, whose elements are never undefined: null, and what
        // is past its end, go to the helper, which throws the RangeError; a
        // float Vector's elements are elsewhere.
        if (arrayElements(em, a, src) || vectorElements(em, a, kind)) {
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

      const guarded = maybeStringLength(em, a, src);
      if (guarded) {
        // Read twice, so from its register, not from a text held for it.
        const copy = em.copyOf[src];
        const read = copy === NONE ? src : copy;
        if (read >= 0) {
          em.release(read);
        }
      }

      em.assign(i);
      if (keyed(em, a, src + 1)) {
        out.text("rt.getKeyed(");
        em.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("], ");
        em.reg(src + 1);
        out.text(")");
        return true;
      }

      if (guarded) {
        out.text("typeof ");
        em.read(src);
        out.text(' === "string" ? ');
        em.read(src);
        out.text(".length : ");
      }

      out.text("rt.getProperty(");
      em.reg(src);
      out.text(", ");
      name(em, a, src + 1);
      out.text(")");
      return true;
    }
    case ops.OP_setproperty:
      if (interpretedKey(em, a, src + 1)) {
        out.text("rt.setInterpreted(");
        em.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("], ");
        em.reg(src + 1);
        out.text(", ");
        em.reg(src + 2);
        out.text(")");
        return true;
      }

      if (indexed(em, a, src + 1)) {
        const kind = vectorKind(em, em.regType[src]);
        // An Array's element below its length written in place, as
        // setIndexed writes it; the receiver read first, as the call
        // reads it first. Anything else goes to setIndexed. A Vector's
        // too, converted to its element type, where the conversion runs no
        // AS3 and so cannot change the Vector after its length is read:
        // below its length a write needs no check of fixedness; at it and
        // past it, the helper grows the Vector or throws.
        const array = arrayElements(em, a, src);
        const element =
          array || !vectorElements(em, a, kind) ? CONVERTS : storedType(em, kind, src);
        if (array || element !== CONVERTS) {
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
          if (array) {
            em.reg(src + 2);
          } else {
            convert(em, "", src + 2, element, em.regType[src + 2]);
          }

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

      if (keyed(em, a, src + 1)) {
        out.text("rt.setKeyed(");
        em.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("], ");
        em.reg(src + 1);
        out.text(", ");
        em.reg(src + 2);
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
    case IR_CallSuper:
      if (ir.dst[i] >= 0) {
        em.assign(i);
      }

      // The base's method itself, its arguments coerced already: its entry
      // for bound calls, where it has one.
      out.text("sup.$it.proto.");
      out.text(hasBoundEntry(em, ir.c[i]) ? "$b" : "$m");
      out.uint(a);
      out.text(".call(");
      em.usesSup = true;
      em.reg(src);
      args(em, src + 1, ir.b[i]);
      out.text(")");
      return true;
    case ops.OP_constructsuper:
      // As rt.constructSuper, without an array of the arguments to apply;
      // the verifier coerced them to the base's constructor, so they may
      // go to its entry for bound calls.
      out.text(superEntry(em, ir.c[i]));
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
      constructSlot(em, src, a, ir.b[i], ir.c[i]);
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

      // By its factory, which the runtime keeps the first method it made of.
      out.text("rt.callStatic(F[");
      out.uint(a);
      out.text("], ");
      em.reg(src);
      args(em, src + 1, ir.b[i]);
      out.text(")");
      return true;
    case ops.OP_newfunction:
      em.assign(i);
      out.text("rt.newFunction(F[");
      out.uint(a);
      out.text("], ");
      functionScope(em, a);
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
      // hasnext2 updates its two locals: the object and the index, which
      // the runtime leaves in two fields; taking them apart from an array
      // would cost more than the step.
      const b = ir.b[i];
      em.regName(ir.dst[i]);
      out.text(" = rt.hasNextIn(");
      em.reg(<i32>a);
      out.text(", ");
      em.reg(<i32>b);
      out.text("), ");
      em.regName(<i32>a);
      out.text(" = rt.enumObject, ");
      em.regName(<i32>b);
      out.text(" = rt.enumIndex");
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
    // Domain memory: in place at an int or uint address, where the view's
    // own range check rejects what avmplus does, with a RangeError the
    // method's code turns into avmplus' (see inPlaceMemory); else through
    // the runtime, which checks the range and converts the address. Sign
    // extensions in plain JavaScript.
    case ops.OP_li8:
    case ops.OP_li16:
    case ops.OP_li32:
    case ops.OP_lf32:
    case ops.OP_lf64:
      em.assign(i);
      if (isAddress(em, src)) {
        em.inPlaceMemory = true;
        out.text("rt.view.");
        out.text(viewMethod(op));
        out.text("(");
        em.reg(src);
        out.text(op === ops.OP_li8 ? ")" : ", true)");
        return true;
      }

      out.text("rt.");
      out.text(opcodeNames[op]);
      out.text("(");
      em.reg(src);
      out.text(")");
      return true;
    case ops.OP_si8:
    case ops.OP_si16:
    case ops.OP_si32:
    case ops.OP_sf32:
    case ops.OP_sf64:
      // The value's conversion is DataView's own for a number or Boolean,
      // which has no effect to come before the range check.
      if (isAddress(em, src + 1) && isNumeric(em, src)) {
        em.inPlaceMemory = true;
        out.text("rt.view.");
        out.text(viewMethod(op));
        out.text("(");
        em.reg(src + 1);
        out.text(", ");
        em.reg(src);
        out.text(op === ops.OP_si8 ? ")" : ", true)");
        return true;
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

/**
 * The scope chain function `m` of the ABC, created here, runs in: for a
 * contested function whose creators' chains differ in length, this one's
 * past those they share packed into the one entry it was compiled with
 * (Scope.merged).
 */
function functionScope(em: MethodEmitter, m: u32): void {
  const traits = em.domain.traits;
  const g = em.domain.methodStart[em.index] + m;
  const merged = traits.functionContested[g] ? traits.functionMerged[g] : null;
  if (merged === null || merged.pack < 0) {
    scopeHere(em);
    return;
  }

  em.out.text("rt.packScope(");
  scopeHere(em);
  em.out.text(", ");
  em.out.uint(<u32>merged.pack);
  em.out.text(")");
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

  // The name of a string the code holds is the same each time: made once, in T.
  const copy = em.copyOf[from];
  if (
    (kind === C.CONSTANT_MultinameL || kind === C.CONSTANT_MultinameLA) &&
    from !== em.pendingNull &&
    copy <= CONSTANT &&
    em.ir.op[CONSTANT - copy] === ops.OP_pushstring
  ) {
    out.text("T[");
    out.uint(em.literalSlot(a, em.ir.a[CONSTANT - copy]));
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

/**
 * Whether `getter` on register r reads a Vector's length, which is its
 * elements': the Vector classes are final, and of their getters, length
 * alone gives a uint (fixed a Boolean).
 */
function vectorLength(em: MethodEmitter, r: i32, getter: i32): bool {
  return (
    getter >= 0 &&
    vectorKind(em, em.regType[r]).length > 0 &&
    em.domain.traits.returnType[getter] === em.domain.uintType
  );
}

/**
 * Whether `getter` on register r reads a String's length, which is its
 * string's: String is final and has no other getter, and a call of the
 * getter by its class's prototype, which the runtime looks up by name at
 * each call, costs several times the read.
 */
function stringLength(em: MethodEmitter, r: i32, getter: i32): bool {
  return (
    getter >= 0 &&
    em.builtinOf(r) === BUILTIN_String &&
    em.domain.traits.returnType[getter] === em.domain.intType
  );
}

/**
 * Whether the get of multiname `a` on register r may read a string's
 * length: a name `length` that is no attribute's, public or with a public
 * namespace in its set, on a value typed * or Object. A string has that
 * one property, a getter of its class, which nothing can replace or hide,
 * and the string is told from any other value where it is read: through
 * the runtime's lookup, the read costs several times the rest of a loop
 * over an Array of strings.
 */
function maybeStringLength(em: MethodEmitter, a: u32, r: i32): bool {
  const bt = em.builtinOf(r);
  if (bt !== BUILTIN_Any && bt !== BUILTIN_Object) {
    return false;
  }

  const domain = em.domain;
  const pool = em.abc.pool;
  const kind = pool.mnKind[a];
  if (kind === C.CONSTANT_Qname) {
    const ns = domain.abcNs[em.index][pool.mnA[a]];
    const uri = domain.nsUri[ns];
    if (domain.nsType[ns] !== NS_Public || (uri !== URI_None && domain.stringLength[uri] !== 0)) {
      return false;
    }
  } else if (kind !== C.CONSTANT_Multiname || !domain.hasPublicNamespace(em.index, a)) {
    return false;
  }

  return domain.abcString[em.index][pool.mnB[a]] === <u32>domain.findText("length");
}

/**
 * Whether the indexed access by multiname `a` on a Vector of `kind` reads
 * its elements, as the runtime's vectorGet and vectorSet do: a public
 * namespace in the set, and elements in an Array, which a float Vector's
 * are not.
 */
function vectorElements(em: MethodEmitter, a: u32, kind: string): bool {
  return kind.length > 0 && kind !== "Float" && em.domain.hasPublicNamespace(em.index, a);
}

/**
 * The element type the value in register src + 2 converts to when it is
 * written into the Vector of `kind` in register `src`, where the
 * conversion runs no AS3, as valueOf and toString can; else CONVERTS. A
 * Vector.<*> may be a Vector of any type, so has no element type to write.
 */
function storedType(em: MethodEmitter, kind: string, src: i32): i32 {
  const domain = em.domain;
  const t = em.regType[src];
  let type = CONVERTS;
  if (kind === "Int") {
    type = domain.intType;
  } else if (kind === "Uint") {
    type = domain.uintType;
  } else if (kind === "Double") {
    type = domain.numberType;
  } else if (kind === "Object" && t !== domain.vectorObjectType) {
    type = domain.traits.param[t];
  }

  const from = em.regType[src + 2];
  const fromBt = domain.builtin(from);
  if (type === CONVERTS || fromBt === BUILTIN_Float) {
    return CONVERTS;
  }

  const numeric = fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number;
  switch (domain.builtin(type)) {
    case BUILTIN_Int:
    case BUILTIN_Uint:
      return numeric || fromBt === BUILTIN_Boolean ? type : CONVERTS;
    case BUILTIN_Number:
      return numeric ? type : CONVERTS;
    case BUILTIN_Boolean:
    case BUILTIN_Object:
      return type;
    case BUILTIN_String:
      return keeps(em, type, from) ? type : CONVERTS;
    default:
      // A class's instances: an instance check, which throws as the helper would.
      return isClassRef(em, type) ? type : CONVERTS;
  }
}

/**
 * Whether getproperty or setproperty by multiname `a`, a runtime name
 * alone, takes the key in register r as avmplus' interpreter does in a
 * script's or a class's initializer (rt.getInterpreted): an int key of an
 * object is an element there whatever the name's namespaces, where the
 * JIT needs a public one and no attribute. A String is never such a key.
 */
function interpretedKey(em: MethodEmitter, a: u32, r: i32): bool {
  const kind = em.abc.pool.mnKind[a];
  return (
    em.staticInit &&
    (kind === C.CONSTANT_MultinameLA ||
      (kind === C.CONSTANT_MultinameL && !em.domain.hasPublicNamespace(em.index, a))) &&
    em.builtinOf(r) !== BUILTIN_String
  );
}

/**
 * Whether multiname `a` is a runtime name alone, not an attribute, whose
 * name in register r is a number: an element's index, which the runtime
 * reads and writes without making the name.
 */
function indexed(em: MethodEmitter, a: u32, r: i32): bool {
  return em.abc.pool.mnKind[a] === C.CONSTANT_MultinameL && isNumber(em, r);
}

/**
 * Whether multiname `a` is a runtime name alone, not an attribute, whose
 * name in register r is of a type that tells nothing of what it is at run
 * time, a number or an object among them: as avmplus' JIT, which hands
 * such a key to getprop_index and setprop_index, the runtime looks at the
 * key before it makes a name of it. A String's is a name always, a number's
 * an index (indexed). Not in a script's or a class's initializer, which
 * avmplus interprets: there a Dictionary is asked for an object by any
 * name, and a Proxy is handed a number that is no index as a QName, as the
 * name made of the key has it.
 */
function keyed(em: MethodEmitter, a: u32, r: i32): bool {
  return (
    !em.staticInit &&
    em.abc.pool.mnKind[a] === C.CONSTANT_MultinameL &&
    !isNumber(em, r) &&
    em.builtinOf(r) !== BUILTIN_String
  );
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

/**
 * `new` of what slot `slot` of register `src` holds, with `argc`
 * arguments after it: a class the runtime has marked as one constructClass
 * would only allocate and initialize (no hook, interface or restriction,
 * `$new`), in place, as constructClass does it, so that each site calls its
 * class's instance initializer itself, with its arguments as they are;
 * anything else, a class not yet made among them, by rt.construct.
 */
function constructSlot(em: MethodEmitter, src: i32, slot: u32, argc: u32, ctraits: i32): void {
  const out = em.out;
  em.constructsInPlace = true;
  out.text("($c = ");
  em.member(src);
  slotMember(out, slot);
  out.text(")?.$new === true ? ($o = $c.$it.instance(), $c.$it.proto.");
  const init = boundConstructor(em, ctraits, argc);
  if (init >= 0) {
    // As avmplus' JIT, which coerces a known constructor's arguments at
    // the call site and calls it: its entry for bound calls.
    out.text("$binit.call($o");
    const traits = em.domain.traits;
    const start = traits.paramStart[init];
    for (let k: u32 = 0; k < argc; k++) {
      const r = src + 1 + <i32>k;
      out.text(", ");
      convert(em, "", r, traits.paramType[start + k], em.regType[r]);
    }
  } else {
    out.text("$init.call($o");
    args(em, src + 1, argc);
  }

  // A slot still empty is a null constructor: avmplus' JIT, which binds a
  // known constructor that takes the count, checks it first (1009); its
  // interpreter, which runs static initializers, constructs late (1007).
  out.text(
    !em.staticInit && knownConstructor(em, ctraits, argc) >= 0
      ? "), $o) : rt.construct($c ?? nn($c)"
      : "), $o) : rt.construct($c",
  );
  args(em, src + 1, argc);
  out.text(")");
}

/**
 * How `super()` calls the constructor of `base`, whose arguments the
 * verifier coerced to it and counted: by its entry for bound calls, if it
 * has one.
 */
function superEntry(em: MethodEmitter, base: i32): string {
  const init = base >= 0 ? em.domain.traits.init[base] : -1;
  return init >= 0 && hasBoundEntry(em, <u32>init)
    ? "sup.$it.proto.$binit.call("
    : "sup.$it.proto.$init.call(";
}

/**
 * The instance initializer of the class whose class traits are
 * `ctraits`, where `new` of it with `argc` arguments can call its entry
 * for bound calls with them coerced: one avmplus' JIT binds
 * (knownConstructor) that has the entry (hasBoundEntry, which takes no
 * rest, so no more arguments than its parameters); else -1.
 */
function boundConstructor(em: MethodEmitter, ctraits: i32, argc: u32): i32 {
  const init = knownConstructor(em, ctraits, argc);
  return init >= 0 && hasBoundEntry(em, <u32>init) ? init : -1;
}

/**
 * The instance initializer, domain-wide, of the class whose class traits
 * are `ctraits`, where avmplus' JIT binds `new` of it with `argc`
 * arguments: one the verifier resolved (see OP_constructprop) that takes
 * the count; else -1.
 */
function knownConstructor(em: MethodEmitter, ctraits: i32, argc: u32): i32 {
  const domain = em.domain;
  const traits = domain.traits;
  const itraits = domain.instanceTraitsOf(ctraits);
  const init = itraits >= 0 ? traits.init[itraits] : -1;
  if (init < 0 || !traits.signed[init]) {
    return -1;
  }

  const count = traits.paramCount[init];
  const required = count - traits.optionalCount[init];
  return argc >= required && (argc <= count || domain.allowsExtraArgs(<u32>init)) ? init : -1;
}

/**
 * A call of an interface's method, dispatch id `disp` in the interface's
 * layout, on the receiver in `src`, with `argc` arguments after it, no
 * more than the method declares: the receiver's class's entry for bound
 * calls, as the class's method has the interface's signature and the
 * arguments are coerced to it. It is called by the alias every class
 * implementing the interface has of it (interfaceAlias), one name
 * whatever the class, so that a site that sees several classes stays
 * polymorphic in the engine; a member in a private namespace, which has
 * none, by the key the runtime finds for the receiver's class.
 */
function interfaceCall(em: MethodEmitter, disp: u32, src: i32, argc: u32): void {
  const out = em.out;
  const domain = em.domain;
  const ifc = em.regType[src];
  const m = aliasedMember(domain, <u32>ifc, disp);
  em.member(src);
  if (m >= 0) {
    out.text("[");
    interfaceAlias(out, domain, domain.traits.memberNs[m], domain.traits.memberName[m]);
    out.text("](");
  } else {
    out.text("[rt.interfaceKey(");
    typeRef(em, ifc);
    out.text(", ");
    out.uint(disp);
    out.text(", ");
    em.read(src);
    out.text(")](");
  }

  list(em, src + 1, argc);
  out.text(")");
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
 * arguments after it, which the verifier bound to method `m` (-1 for
 * none): a method of the receiver's prototype, or for a primitive
 * receiver, or a namespace, which the runtime represents itself, of its
 * class's. Where m has an entry for bound calls, an object's own method
 * is called by it, `$b`, as the arguments are coerced already.
 */
function virtual(em: MethodEmitter, disp: u32, src: i32, argc: u32, m: i32): void {
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
  out.text(m >= 0 && hasBoundEntry(em, <u32>m) ? ".$b" : ".$m");
  out.uint(disp);
  out.text("(");
  list(em, src + 1, argc);
  out.text(")");
}
