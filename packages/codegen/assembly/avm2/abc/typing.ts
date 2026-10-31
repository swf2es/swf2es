// The typed half of each instruction's verification, as Verifier::verifyBlock
// types it: the types and null flags it leaves its values with, the checks of
// its operands' types, and the scope chains the classes and functions it
// creates capture. How it reaches properties is properties.ts's.

import { IR_ConstructSlot } from "../ir/ir";
import { Scope, TYPE_Any } from "../link/traits";
import { BIND_Ambiguous, canAssign, isNumeric } from "../link/types";
import { BodyDecoder, KNOWN, NOT_NULL, WITH } from "./code";
import * as C from "./constants";
import * as ops from "./opcodes";
import {
  binding,
  callProperty,
  callStatic,
  callSuper,
  coerceArgs,
  coerceSuper,
  findDef,
  findProperty,
  getProperty,
  getSuper,
  globalScope,
  propertyDepth,
  readBinding,
  setProperty,
  slot,
  typeName,
} from "./properties";

/**
 * The type effects and type checks of the instruction at `pc`, as in
 * Verifier::verifyBlock, before the stack depth changes; `scope` is the
 * scope depth before the instruction.
 */
export function typeAt(bd: BodyDecoder, pc: u32, opcode: u8, a: u32, b: u32, scope: u32): bool {
  const domain = bd.domain;
  const top = bd.peek(1);
  switch (opcode) {
    case ops.OP_lookupswitch:
      return bd.peekType(1, domain.intType);
    case ops.OP_pushnull:
      return bd.pushNullish(domain.nullType);
    case ops.OP_pushundefined:
      return bd.pushNullish(domain.voidType);
    case ops.OP_pushtrue:
    case ops.OP_pushfalse:
      return bd.push(domain.booleanType, NOT_NULL);
    case ops.OP_pushnan:
    case ops.OP_pushdouble:
      return bd.push(domain.numberType, NOT_NULL);
    case ops.OP_pushfloat:
      return domain.floatType < 0
        ? bd.fail(C.kClassNotFoundError)
        : bd.push(domain.floatType, NOT_NULL);
    case ops.OP_pushbyte:
    case ops.OP_pushshort:
    case ops.OP_pushint:
      return bd.push(domain.intType, NOT_NULL);
    case ops.OP_pushuint:
      return bd.push(domain.uintType, NOT_NULL);
    case ops.OP_pushstring:
      return bd.push(domain.stringType, NOT_NULL);
    case ops.OP_pushnamespace:
      return bd.push(domain.namespaceType, NOT_NULL);
    case ops.OP_setlocal:
      bd.setValue(a, bd.typeOf(top), bd.valueFlags[top] & KNOWN);
      return true;
    case ops.OP_getlocal:
      return bd.pushLocal(a);
    case ops.OP_newfunction:
      if (bd.emitPass && !captureFunction(bd, a)) {
        return false;
      }

      bd.rowC = <i32>(domain.methodStart[bd.index] + a);
      return bd.push(domain.functionType, NOT_NULL);
    case ops.OP_getlex: {
      // The scope object found is the receiver of the get.
      if (!findProperty(bd, ops.OP_findpropstrict, a)) {
        return false;
      }

      bd.stack++;
      const got = getProperty(bd, a, 1);
      bd.stack--;
      return got;
    }
    case ops.OP_findpropstrict:
    case ops.OP_findproperty:
      return findProperty(bd, opcode, a);
    case ops.OP_newclass:
      if (bd.emitPass && !captureClass(bd, a)) {
        return false;
      }

      bd.coerce(top, domain.classInstanceType());
      bd.setValue(top, domain.staticTraitsOf(bd.index, a), NOT_NULL);
      bd.rowC = domain.staticTraitsOf(bd.index, a);
      return true;
    case ops.OP_finddef:
      return findDef(bd, a);
    case ops.OP_setproperty:
    case ops.OP_initproperty:
      return setProperty(bd, opcode, a);
    case ops.OP_getproperty: {
      const n = propertyDepth(bd, a, 1);
      return n > 0 && getProperty(bd, a, n);
    }
    case ops.OP_getdescendants: {
      const n = propertyDepth(bd, a, 1);
      if (n === 0) {
        return false;
      }

      bd.checkNull(bd.peek(n));
      return bd.popPush(n, TYPE_Any, 0);
    }
    case ops.OP_checkfilter:
    case ops.OP_convert_o:
      bd.checkNull(top);
      return true;
    case ops.OP_deleteproperty: {
      const n = propertyDepth(bd, a, 1);
      if (n === 0) {
        return false;
      }

      bd.checkNull(bd.peek(n));
      return bd.popPush(n, domain.booleanType, NOT_NULL);
    }
    case ops.OP_astype: {
      const t = typeName(bd, a);
      if (t < TYPE_Any) {
        return false;
      }

      if (!canAssign(domain, t, bd.typeOf(top))) {
        const result = t !== TYPE_Any && domain.isMachineType(t) ? domain.objectType() : t;
        return bd.popPush(1, result, domain.typeNotNull(result) ? NOT_NULL : 0);
      }

      return true;
    }
    case ops.OP_astypelate: {
      let t = domain.instanceTraitsOf(bd.typeOf(bd.peek(1)));
      if (t !== TYPE_Any && domain.isMachineType(t)) {
        t = domain.objectType();
      }

      return bd.popPush(2, t, domain.typeNotNull(t) ? NOT_NULL : 0);
    }
    // The conversion is the instruction itself, which only retypes the value.
    case ops.OP_coerce: {
      const t = typeName(bd, a);
      if (t < TYPE_Any) {
        return false;
      }

      bd.rowC = t;
      bd.retype(top, t);
      return true;
    }
    case ops.OP_convert_b:
    case ops.OP_coerce_b:
      bd.retype(top, domain.booleanType);
      return true;
    case ops.OP_coerce_o:
      bd.retype(top, domain.objectType());
      return true;
    case ops.OP_coerce_a:
      bd.retype(top, TYPE_Any);
      return true;
    case ops.OP_convert_i:
    case ops.OP_coerce_i:
      bd.retype(top, domain.intType);
      return true;
    case ops.OP_convert_u:
    case ops.OP_coerce_u:
      bd.retype(top, domain.uintType);
      return true;
    case ops.OP_convert_f:
      if (domain.floatType < 0) {
        return bd.fail(C.kClassNotFoundError);
      }

      bd.retype(top, domain.floatType);
      return true;
    case ops.OP_unplus:
      bd.retype(top, numericType(bd, bd.typeOf(top)));
      return true;
    case ops.OP_convert_d:
    case ops.OP_coerce_d:
      bd.retype(top, domain.numberType);
      return true;
    case ops.OP_coerce_s:
      bd.retype(top, domain.stringType);
      return true;
    case ops.OP_iftrue:
    case ops.OP_iffalse:
      bd.coerce(top, domain.booleanType);
      return true;
    case ops.OP_returnvalue:
      bd.coerce(top, domain.traits.returnType[bd.global]);
      return true;
    case ops.OP_istype:
      if (typeName(bd, a) < TYPE_Any) {
        return false;
      }

      return bd.popPush(1, domain.booleanType, NOT_NULL);
    case ops.OP_istypelate:
      return bd.popPush(2, domain.booleanType, NOT_NULL);
    case ops.OP_convert_s:
    case ops.OP_esc_xelem:
    case ops.OP_esc_xattr:
    case ops.OP_typeof:
      return bd.popPush(1, domain.stringType, NOT_NULL);
    case ops.OP_callstatic:
      return callStatic(bd, a, b);
    case ops.OP_call:
      return bd.popPush(a + 2, TYPE_Any, 0);
    case ops.OP_construct: {
      const t = domain.instanceTraitsOf(bd.typeOf(bd.peek(a + 1)));
      return bd.popPush(a + 1, t, NOT_NULL);
    }
    case ops.OP_callmethod: {
      // Always rejected, as avmplus has done since Flash Player 9.
      if (a === 0) {
        return bd.fail(C.kZeroDispIdError);
      }

      return bd.fail(
        bd.typeOf(bd.peek(b + 1)) === TYPE_Any ? C.kCorruptABCError : C.kIllegalEarlyBindingError,
      );
    }
    case ops.OP_callproperty:
    case ops.OP_callproplex:
    case ops.OP_callpropvoid:
      return callProperty(bd, opcode, a, b);
    case ops.OP_constructprop: {
      const n = propertyDepth(bd, a, b + 1);
      if (n === 0) {
        return false;
      }

      const obj = bd.peek(n);
      const type = bd.typeOf(obj);
      const found = binding(bd, type, a);
      if (found === BIND_Ambiguous) {
        return false;
      }

      const ctraits = readBinding(bd, type, found);
      if (ctraits < TYPE_Any) {
        return false;
      }

      bd.checkNull(obj);
      bd.rowC = ctraits;
      const itraits = domain.instanceTraitsOf(ctraits);
      const pushed = bd.popPush(n, itraits, itraits === TYPE_Any ? 0 : NOT_NULL);
      // A name bound to a slot, as `new` of a script's class names one:
      // what the slot holds, constructed, with no lookup by name.
      const kind = found & 7;
      if (pushed && (kind === 2 || kind === 3) && n === b + 1) {
        return bd.emitOn(IR_ConstructSlot, <i32>obj, <i32>obj, n, found >> 3, b, ctraits);
      }

      return pushed;
    }
    case ops.OP_applytype:
      return bd.popPush(a + 1, TYPE_Any, NOT_NULL);
    case ops.OP_callsuper:
    case ops.OP_callsupervoid:
      return callSuper(bd, opcode, a, b);
    case ops.OP_getsuper:
      return getSuper(bd, a);
    case ops.OP_setsuper: {
      const n = propertyDepth(bd, a, 2);
      if (n === 0) {
        return false;
      }

      const obj = bd.peek(n);
      if (coerceSuper(bd, obj) < TYPE_Any) {
        return false;
      }

      bd.checkNull(obj);
      return true;
    }
    case ops.OP_constructsuper: {
      const obj = bd.peek(a + 1);
      const base = coerceSuper(bd, obj);
      if (base < TYPE_Any) {
        return false;
      }

      const init = domain.traits.init[base];
      if (init >= 0 && !coerceArgs(bd, <u32>init, a)) {
        return false;
      }

      bd.checkNull(obj);
      return true;
    }
    case ops.OP_newobject:
      for (let n: u32 = 2; n <= 2 * a; n += 2) {
        if (!bd.peekType(n, domain.stringType)) {
          return false;
        }
      }

      return bd.popPush(2 * a, domain.objectType(), NOT_NULL);
    case ops.OP_newarray:
      return bd.popPush(a, domain.arrayType, NOT_NULL);
    case ops.OP_pushscope:
    case ops.OP_pushwith: {
      const type = bd.typeOf(top);
      const outer = bd.outer;
      if (opcode === ops.OP_pushscope && scope === 0 && outer.extra !== TYPE_Any) {
        if (type === TYPE_Any || !domain.traits.subtypeOf(<u32>type, <u32>outer.extra)) {
          return bd.fail(C.kIllegalOperandTypeError);
        }
      }

      bd.setValue(
        bd.localCount + scope,
        type,
        opcode === ops.OP_pushwith ? NOT_NULL | WITH : NOT_NULL,
      );
      return true;
    }
    case ops.OP_newactivation: {
      const t = domain.bodyTraits[bd.index][bd.abc.methodBody[bd.method]];
      const error = t >= 0 ? domain.traits.resolve(domain, <u32>t) : 0;
      if (error) {
        return bd.fail(error);
      }

      return bd.push(t, NOT_NULL);
    }
    case ops.OP_newcatch:
      return bd.push(bd.handlerScope[a], NOT_NULL);
    case ops.OP_getscopeobject: {
      const i = bd.localCount + load<u8>(bd.start + pc + 1);
      return bd.push(bd.typeOf(i), bd.valueFlags[i] & NOT_NULL);
    }
    case ops.OP_getouterscope: {
      const outer = bd.outer;
      if (a >= outer.size) {
        return bd.fail(C.kGetScopeObjectBoundsError);
      }

      return bd.push(outer.types[a], NOT_NULL);
    }
    case ops.OP_getglobalscope:
      return globalScope(bd) >= TYPE_Any;
    case ops.OP_getglobalslot: {
      const global = globalScope(bd);
      if (global < TYPE_Any) {
        return false;
      }

      // The global object pushed is replaced by the slot's value.
      const slotType = slot(bd, global, a - 1);
      return slotType >= TYPE_Any && bd.push(slotType, domain.typeNotNull(slotType) ? NOT_NULL : 0);
    }
    case ops.OP_setglobalslot: {
      const outer = bd.outer;
      const global = outer.size > 0 ? outer.types[0] : bd.typeOf(bd.localCount);
      const slotType = slot(bd, global, a - 1);
      if (slotType < TYPE_Any) {
        return false;
      }

      bd.coerce(top, slotType);
      return true;
    }
    case ops.OP_getslot: {
      const slotType = slot(bd, bd.typeOf(top), a - 1);
      if (slotType < TYPE_Any) {
        return false;
      }

      bd.checkNull(top);
      return bd.popPush(1, slotType, domain.typeNotNull(slotType) ? NOT_NULL : 0);
    }
    case ops.OP_setslot: {
      const slotType = slot(bd, bd.typeOf(bd.peek(2)), a - 1);
      if (slotType < TYPE_Any) {
        return false;
      }

      bd.coerce(top, slotType);
      bd.checkNull(bd.peek(2));
      return true;
    }
    case ops.OP_dup: {
      const i = bd.stackBase + bd.stack;
      bd.push(bd.typeOf(top), bd.valueFlags[top] & KNOWN);
      bd.origin[i] = bd.origin[top];
      bd.originWrite[i] = bd.originWrite[top];
      return true;
    }
    case ops.OP_swap: {
      const below = bd.peek(2);
      const type = bd.typeOf(top);
      const flags = bd.valueFlags[top] & KNOWN;
      bd.setValue(top, bd.typeOf(below), bd.valueFlags[below] & KNOWN);
      bd.setValue(below, type, flags);
      return true;
    }
    case ops.OP_lessthan:
    case ops.OP_greaterthan:
    case ops.OP_lessequals:
    case ops.OP_greaterequals: {
      // A comparison with a number compares numbers.
      const lhs = bd.peek(2);
      const lt = bd.typeOf(lhs);
      const rt = bd.typeOf(top);
      if (lt !== TYPE_Any && rt !== TYPE_Any) {
        if (!isNumeric(domain, lt) && isNumeric(domain, rt)) {
          bd.coerce(lhs, domain.numberType);
        } else if (isNumeric(domain, lt) && !isNumeric(domain, rt)) {
          bd.coerce(top, domain.numberType);
        }
      }

      return bd.popPush(2, domain.booleanType, NOT_NULL);
    }
    case ops.OP_in:
      bd.checkNull(top);
      return bd.popPush(2, domain.booleanType, NOT_NULL);
    case ops.OP_equals:
    case ops.OP_strictequals:
    case ops.OP_instanceof:
      return bd.popPush(2, domain.booleanType, NOT_NULL);
    case ops.OP_not:
      bd.coerce(top, domain.booleanType);
      return bd.popPush(1, domain.booleanType, NOT_NULL);
    case ops.OP_add: {
      const lhs = bd.peek(2);
      const lt = bd.typeOf(lhs);
      const rt = bd.typeOf(top);
      const string = domain.stringType;
      if ((lt === string && bd.isNotNull(lhs)) || (rt === string && bd.isNotNull(top))) {
        return bd.popPush(2, string, NOT_NULL);
      }

      if (domain.floatType >= 0 && lt === domain.floatType && rt === domain.floatType) {
        return bd.popPush(2, domain.floatType, NOT_NULL);
      }

      if (isNumeric(domain, lt) && isNumeric(domain, rt)) {
        return bd.popPush(2, domain.numberType, NOT_NULL);
      }

      // A number or a string, but not null either way.
      return bd.popPush(2, domain.objectType(), NOT_NULL);
    }
    case ops.OP_modulo:
    case ops.OP_subtract:
    case ops.OP_divide:
    case ops.OP_multiply:
      if (bd.abc.hasFloatSupport) {
        const lt = numericType(bd, bd.typeOf(bd.peek(2)));
        const rt = numericType(bd, bd.typeOf(top));
        if (lt === domain.floatType && rt === domain.floatType) {
          return bd.popPush(2, domain.floatType, NOT_NULL);
        }

        if (lt === TYPE_Any || rt === TYPE_Any) {
          return bd.popPush(2, TYPE_Any, NOT_NULL);
        }
      }

      bd.coerce(bd.peek(2), domain.numberType);
      bd.coerce(top, domain.numberType);
      return bd.popPush(2, domain.numberType, NOT_NULL);
    case ops.OP_negate:
    case ops.OP_increment:
    case ops.OP_decrement:
      if (bd.abc.hasFloatSupport) {
        const numeric = numericType(bd, bd.typeOf(top));
        if (numeric !== domain.numberType) {
          bd.retype(top, numeric);
          return true;
        }
      }

      bd.coerce(top, domain.numberType);
      return true;
    case ops.OP_increment_i:
    case ops.OP_decrement_i:
    case ops.OP_negate_i:
    case ops.OP_bitnot:
      bd.coerce(top, domain.intType);
      return true;
    case ops.OP_add_i:
    case ops.OP_subtract_i:
    case ops.OP_multiply_i:
    case ops.OP_bitand:
    case ops.OP_bitor:
    case ops.OP_bitxor:
    case ops.OP_lshift:
    case ops.OP_rshift:
      bd.coerce(bd.peek(2), domain.intType);
      bd.coerce(top, domain.intType);
      return bd.popPush(2, domain.intType, NOT_NULL);
    case ops.OP_urshift:
      bd.coerce(bd.peek(2), domain.intType);
      bd.coerce(top, domain.intType);
      return bd.popPush(2, domain.uintType, NOT_NULL);
    case ops.OP_nextvalue:
    case ops.OP_nextname:
      return bd.peekType(1, domain.intType) && bd.popPush(2, TYPE_Any, 0);
    case ops.OP_hasnext:
      return bd.peekType(1, domain.intType) && bd.popPush(2, domain.intType, NOT_NULL);
    case ops.OP_hasnext2:
      if (bd.typeOf(b) !== domain.intType) {
        return bd.fail(C.kIllegalOperandTypeError);
      }

      bd.setValue(a, TYPE_Any, 0);
      return bd.push(domain.booleanType, NOT_NULL);
    case ops.OP_sxi1:
    case ops.OP_sxi8:
    case ops.OP_sxi16:
    case ops.OP_li8:
    case ops.OP_li16:
    case ops.OP_li32:
      bd.coerce(top, domain.intType);
      return bd.popPush(1, domain.intType, NOT_NULL);
    case ops.OP_lf32:
    case ops.OP_lf64:
      bd.coerce(top, domain.intType);
      return bd.popPush(1, domain.numberType, NOT_NULL);
    case ops.OP_si8:
    case ops.OP_si16:
    case ops.OP_si32:
      bd.coerce(bd.peek(2), domain.intType);
      bd.coerce(top, domain.intType);
      return true;
    case ops.OP_sf32:
    case ops.OP_sf64:
      bd.coerce(bd.peek(2), domain.numberType);
      bd.coerce(top, domain.intType);
      return true;
    default:
      break;
  }

  if (opcode >= ops.OP_setlocal0 && opcode < ops.OP_setlocal0 + 4) {
    bd.setValue(opcode - ops.OP_setlocal0, bd.typeOf(top), bd.valueFlags[top] & KNOWN);
  } else if (opcode >= ops.OP_getlocal0 && opcode < ops.OP_getlocal0 + 4) {
    return bd.pushLocal(<u32>(opcode - ops.OP_getlocal0));
  }

  return true;
}

/** ToNumeric may preserve a float returned by an object's valueOf. */
export function numericType(bd: BodyDecoder, type: i32): i32 {
  const domain = bd.domain;
  if (type >= 0 && type === domain.floatType) {
    return type;
  }

  if (
    isNumeric(domain, type) ||
    type === domain.booleanType ||
    type === domain.stringType ||
    type === domain.nullType ||
    type === domain.voidType
  ) {
    return domain.numberType;
  }

  return TYPE_Any;
}

/** The scope chain `outer` and the scopes pushed so far, with an optional last entry and extra. */
function scopeHere(bd: BodyDecoder, last: i32, extra: i32): Scope {
  const outer = bd.outer;
  const scope = new Scope();
  for (let i: u32 = 0; i < outer.size; i++) {
    scope.types.push(outer.types[i]);
    scope.withs.push(outer.withs[i]);
  }

  for (let i: u32 = 0; i < bd.scope; i++) {
    const v = bd.localCount + i;
    scope.types.push(bd.typeOf(v));
    scope.withs.push(bd.valueFlags[v] & WITH ? 1 : 0);
  }

  if (last !== -2) {
    scope.types.push(last);
    scope.withs.push(0);
  }

  scope.size = scope.types.length;
  scope.extra = extra;
  return scope;
}

/**
 * As the ScopeWriter's OP_newfunction: function m is created in the scope
 * chain here, once; a method bound to traits cannot be a function, and one
 * created again must be created alike, unless it creates itself.
 */
function captureFunction(bd: BodyDecoder, m: u32): bool {
  const domain = bd.domain;
  const traits = domain.traits;
  const global = domain.methodStart[bd.index] + m;
  const scope = scopeHere(bd, -2, TYPE_Any);
  const current = traits.functionScope[global];
  // Created again alike, it is still queued, so that verifying the ABC again finds it.
  if (current !== null) {
    if (!current.equals(scope) && global !== bd.global) {
      return bd.fail(C.kCorruptABCError);
    }

    bd.captured.push(global);
    return true;
  }

  if (traits.methodTraits[global] >= 0) {
    return bd.fail(C.kCorruptABCError);
  }

  traits.methodFunction[global] = 1;
  const error = traits.sign(domain, global);
  if (error) {
    return bd.fail(error);
  }

  traits.functionScope[global] = scope;
  domain.captures++;
  bd.captured.push(global);
  return true;
}

/**
 * As the ScopeWriter's OP_newclass: the innermost scope must be the base
 * class object; the class's static methods run in the scope chain here,
 * its instance methods in that and the class object, once, and a class
 * created again must be created alike. Both traits resolve.
 */
function captureClass(bd: BodyDecoder, i: u32): bool {
  const domain = bd.domain;
  const traits = domain.traits;
  const ctraits = domain.staticTraitsOf(bd.index, i);
  const itraits = domain.instanceTraitsOf(ctraits);
  if (bd.scope === 0) {
    return bd.fail(C.kCorruptABCError);
  }

  const innermost = bd.typeOf(bd.localCount + bd.scope - 1);
  if (innermost === TYPE_Any || domain.instanceTraitsOf(innermost) !== traits.base[itraits]) {
    return bd.fail(C.kCorruptABCError);
  }

  const cscope = scopeHere(bd, -2, ctraits);
  const iscope = scopeHere(bd, ctraits, itraits);
  const error = traits.resolve(domain, <u32>ctraits) || traits.resolve(domain, <u32>itraits);
  if (error) {
    return bd.fail(error);
  }

  const current = traits.scope[ctraits];
  if (current !== null) {
    const instance = traits.scope[itraits];
    if (instance === null || !current.equals(cscope) || !instance.equals(iscope)) {
      return bd.fail(C.kCorruptABCError);
    }
  } else {
    traits.scope[ctraits] = cscope;
    traits.scope[itraits] = iscope;
    domain.captures++;
  }

  domain.methodsOf(<u32>ctraits, bd.captured);
  domain.methodsOf(<u32>itraits, bd.captured);
  return true;
}
