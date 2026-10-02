// How a method's code reaches properties, as avmplus' Verifier types and
// binds them: finding a property's object along the scope chain, getting,
// setting and calling it, early where the receiver's type binds the name
// and late otherwise, and the super calls and properties.
import {
  IR_CallGetter,
  IR_CallInterface,
  IR_CallSetter,
  IR_FindPropGlobal,
  IR_FindPropGlobalStrict,
  IR_GetGlobalScope,
  IR_Nip,
} from "../ir/ir";
import { BIND_None, TRAITS_Instance, TYPE_Any } from "../link/traits";
import { BIND_Ambiguous, bindingType, getBinding, isBindingName, isNumeric } from "../link/types";
import {
  BodyDecoder,
  MN_Attr,
  MN_QName,
  MN_Rtname,
  MN_Rtns,
  NOT_NULL,
  nameParts,
  WITH,
} from "./code";
import * as C from "./constants";
import * as ops from "./opcodes";

/**
 * As Verifier::checkPropertyMultiname: count the runtime parts of
 * multiname `mn` above the `n` values below them, checking that a runtime
 * name with a namespace is a String and a runtime namespace a Namespace.
 * Returns the depth of the receiver, or 0 after recording an error.
 */
export function propertyDepth(bd: BodyDecoder, mn: u32, n: u32): u32 {
  const domain = bd.domain;
  const parts = nameParts(bd.abc.pool, mn);
  if (parts & MN_Rtname) {
    if (parts & MN_QName && !bd.peekType(n, domain.stringType)) {
      return 0;
    }

    n++;
  }

  if (parts & MN_Rtns) {
    if (!bd.peekType(n, domain.namespaceType)) {
      return 0;
    }

    n++;
  }

  return n;
}

/** The binding of `mn` on `type`, recording 1008 if it is ambiguous. */
export function binding(bd: BodyDecoder, type: i32, mn: u32): u32 {
  const b = getBinding(bd.domain, bd.index, type, mn);
  if (b === BIND_Ambiguous) {
    bd.fail(C.kAmbiguousBindingError);
  }

  return b;
}

/** As Verifier::readBinding: resolve `type`, then the type of its binding b; below TYPE_Any on error. */
export function readBinding(bd: BodyDecoder, type: i32, b: u32): i32 {
  if (type < 0) {
    return TYPE_Any;
  }

  const domain = bd.domain;
  const error = domain.traits.resolve(domain, <u32>type);
  if (error) {
    bd.fail(error);
    return -2;
  }

  return bindingType(domain, type, b);
}

/** As Verifier::checkTypeName: the type multiname `mn` names; below TYPE_Any on error. */
export function typeName(bd: BodyDecoder, mn: u32): i32 {
  const pool = bd.abc.pool;
  if (mn === 0 || mn >= pool.multinameCount) {
    bd.fail(C.kCpoolIndexRangeError);
    return -2;
  }

  const domain = bd.domain;
  const t = domain.checkTypeName(bd.index, mn);
  if (t < TYPE_Any) {
    bd.fail(domain.typeError);
  }

  return t;
}

/**
 * As Verifier::emitCoerceArgs: method m must take `argc` arguments, which
 * become its parameter types, and the receiver below them its receiver type.
 */
export function coerceArgs(bd: BodyDecoder, m: u32, argc: u32): bool {
  const domain = bd.domain;
  const traits = domain.traits;
  const error = traits.sign(domain, m);
  if (error) {
    return bd.fail(error);
  }

  const count = traits.paramCount[m];
  const required = count - traits.optionalCount[m];
  if (argc < required || (argc > count && !domain.allowsExtraArgs(m))) {
    return bd.fail(C.kWrongArgumentCountError);
  }

  const start = traits.paramStart[m];
  for (let k: u32 = 1; k <= argc; k++) {
    const target = k <= count ? traits.paramType[start + k - 1] : TYPE_Any;
    bd.coerce(bd.peek(argc - k + 1), target);
  }

  bd.coerce(bd.peek(argc + 1), traits.receiverType[m]);
  return true;
}

/** As Verifier::emitCoerceSuper: the receiver at i becomes the declaring class's base. */
export function coerceSuper(bd: BodyDecoder, i: u32): i32 {
  const base = bd.declarer >= 0 ? bd.domain.traits.base[bd.declarer] : -1;
  if (base < 0) {
    bd.fail(C.kIllegalSuperCallError);
    return -2;
  }

  bd.coerce(i, base);
  bd.rowC = base;
  return base;
}

/**
 * As Verifier::checkEarlySlotBinding and checkSlot: `type` must come from
 * this ABC and allow early binding, and have slot `slot`, whose type this
 * returns; below TYPE_Any on error.
 */
export function slot(bd: BodyDecoder, type: i32, slot: u32): i32 {
  const domain = bd.domain;
  const traits = domain.traits;
  if (type < 0 || traits.abc[type] !== bd.index || !traits.allowEarlyBinding(<u32>type)) {
    bd.fail(C.kIllegalEarlyBindingError);
    return -2;
  }

  const error = traits.resolve(domain, <u32>type);
  if (error) {
    bd.fail(error);
    return -2;
  }

  if (slot >= traits.slotCount[type]) {
    bd.fail(C.kSlotExceedsCountError);
    return -2;
  }

  return traits.slotType[traits.slotStart[type] + slot];
}

/** As Verifier::checkGetGlobalScope: push the global object; its type, below TYPE_Any on error. */
export function globalScope(bd: BodyDecoder): i32 {
  const outer = bd.outer;
  if (outer.size > 0) {
    const t = outer.types[0];
    bd.push(t, NOT_NULL);
    return t;
  }

  if (bd.scope === 0) {
    bd.fail(C.kGetScopeObjectBoundsError);
    return -2;
  }

  const i = bd.localCount;
  bd.push(bd.typeOf(i), bd.valueFlags[i] & NOT_NULL);
  return bd.typeOf(i);
}

/**
 * As Verifier::emitFindProperty: the scope object a name is found on, from
 * the innermost scope out, stopping at a with scope, then the scripts that
 * define it; else an Object, after the runtime name parts are popped.
 */
export function findProperty(bd: BodyDecoder, opcode: u8, mn: u32): bool {
  const domain = bd.domain;
  const outer = bd.outer;
  const top = <i32>(bd.stackBase + bd.stack);
  let global = false;
  if (isBindingName(domain, bd.index, mn)) {
    // With no outer scopes, the global object is a local scope, which is not bound early.
    const base = bd.localCount + (outer.size === 0 ? 1 : 0);
    let i = <i32>(bd.localCount + bd.scope) - 1;
    for (; i >= <i32>base; i--) {
      const b = binding(bd, bd.typeOf(<u32>i), mn);
      if (b === BIND_Ambiguous) {
        return false;
      }

      if (b !== 0) {
        bd.push(bd.typeOf(<u32>i), bd.valueFlags[i] & NOT_NULL);
        return emitFound(bd, ops.OP_getscopeobject, top, i, <u32>i - bd.localCount, 0);
      }

      if (bd.valueFlags[i] & WITH) {
        break;
      }
    }

    if (i < <i32>base) {
      let j = <i32>outer.size - 1;
      for (; j > 0; j--) {
        const t = outer.types[j];
        const b = binding(bd, t, mn);
        if (b === BIND_Ambiguous) {
          return false;
        }

        if (b !== 0) {
          bd.push(t, NOT_NULL);
          return emitFound(bd, ops.OP_getouterscope, top, -1, <u32>j, 0);
        }

        if (outer.withs[j]) {
          break;
        }
      }

      if (j <= 0) {
        const script = domain.findScript(bd.index, mn);
        if (script >= 0) {
          bd.push(script, NOT_NULL);

          // Defined by this very script: its global object.
          if (domain.traits.init[script] === <i32>bd.global) {
            return outer.size > 0
              ? emitFound(bd, ops.OP_getouterscope, top, -1, 0, 0)
              : emitFound(bd, IR_GetGlobalScope, top, -1, 0, 0);
          }

          return emitFound(bd, ops.OP_finddef, top, -1, mn, script);
        }

        global = true;
      }
    }
  }

  const n = propertyDepth(bd, mn, 1);
  if (n === 0) {
    return false;
  }

  bd.popPush(n - 1, domain.objectType(), NOT_NULL);
  if (global) {
    const op = opcode === ops.OP_findproperty ? IR_FindPropGlobal : IR_FindPropGlobalStrict;
    return emitFound(bd, op, top, -1, mn, 0);
  }

  const at = <i32>(bd.stackBase + bd.stack) - <i32>(n - 1);
  if (bd.emitPass) {
    bd.emit(opcode, at, at, n - 1, mn, 0, 0, bd.pc);
    bd.emitted = true;
  }

  return true;
}

/** The IR of where a name was found, pushed into register `dst`. */
export function emitFound(bd: BodyDecoder, op: u16, dst: i32, src: i32, a: u32, c: i32): bool {
  if (bd.emitPass) {
    bd.emit(op, dst, src, src >= 0 ? 1 : 0, a, 0, c, bd.pc);
    bd.emitted = true;
  }

  return true;
}

/** As Verifier's OP_finddef: the global object of the script that defines `mn`, else Object. */
export function findDef(bd: BodyDecoder, mn: u32): bool {
  const domain = bd.domain;
  const script = domain.findScript(bd.index, mn);
  return bd.push(script >= 0 ? script : domain.objectType(), NOT_NULL);
}

/**
 * As Verifier::emitGetProperty: a slot's or getter's type when the name
 * binds early, a Vector's element type for a numeric index, else *.
 */
export function getProperty(bd: BodyDecoder, mn: u32, n: u32): bool {
  const domain = bd.domain;
  const obj = bd.peek(n);
  const type = bd.typeOf(obj);
  const b = binding(bd, type, mn);
  if (b === BIND_Ambiguous) {
    return false;
  }

  let propType = readBinding(bd, type, b);
  if (propType < TYPE_Any) {
    return false;
  }

  bd.checkNull(obj);
  const kind = b & 7;
  if (kind === 2 || kind === 3) {
    // The builtin global's Math and Number are never null.
    const notNull =
      domain.traits.abc[type] === domain.builtinAbc && domain.isMathOrNumber(bd.index, mn);
    bd.popPush(n, propType, notNull ? NOT_NULL : 0);
    return bd.emitOn(ops.OP_getslot, <i32>obj, <i32>obj, 1, b >> 3, 0, 0);
  }

  if (kind === 5 || kind === 7) {
    const getter = domain.traits.dispatch[domain.traits.dispatchStart[type] + (b >> 3)];
    if (getter >= 0 && !coerceArgs(bd, <u32>getter, 0)) {
      return false;
    }

    bd.popPush(n, propType, domain.typeNotNull(propType) ? NOT_NULL : 0);
    // An interface's accessor has no dispatch id of its own on the
    // receiver: its name finds the receiver's.
    if (domain.traits.isInterface[type]) {
      return bd.emitOn(ops.OP_getproperty, <i32>obj, <i32>obj, n, mn, 0, 0);
    }

    return bd.emitOn(IR_CallGetter, <i32>obj, <i32>obj, 1, b >> 3, 0, getter);
  }

  if (propType === TYPE_Any && numericIndex(bd, mn)) {
    if (type === domain.vectorIntType) {
      propType = domain.intType;
    } else if (type === domain.vectorUintType) {
      propType = domain.uintType;
    } else if (type === domain.vectorDoubleType) {
      propType = domain.numberType;
    } else if (
      type >= 0 &&
      domain.vectorObjectType >= 0 &&
      domain.traits.subtypeOf(<u32>type, <u32>domain.vectorObjectType)
    ) {
      propType = domain.traits.param[type];
    }
  }

  bd.popPush(n, propType, domain.typeNotNull(propType) ? NOT_NULL : 0);
  return bd.emitOn(ops.OP_getproperty, <i32>obj, <i32>obj, n, mn, 0, 0);
}

/**
 * Whether multiname `mn` is a runtime name in a public namespace, not an
 * attribute, and the top of the stack, its name, is a number.
 */
export function numericIndex(bd: BodyDecoder, mn: u32): bool {
  const domain = bd.domain;
  const parts = nameParts(bd.abc.pool, mn);
  if (parts & MN_Attr || !(parts & MN_Rtname) || !domain.hasPublicNamespace(bd.index, mn)) {
    return false;
  }

  const t = bd.typeOf(bd.peek(1));
  return t === domain.intType || t === domain.uintType || t === domain.numberType;
}

/** As Verifier's OP_setproperty and OP_initproperty. */
export function setProperty(bd: BodyDecoder, opcode: u8, mn: u32): bool {
  const domain = bd.domain;
  const n = propertyDepth(bd, mn, 2);
  if (n === 0) {
    return false;
  }

  const obj = bd.peek(n);
  const type = bd.typeOf(obj);
  const b = binding(bd, type, mn);
  if (b === BIND_Ambiguous) {
    return false;
  }

  const propType = readBinding(bd, type, b);
  if (propType < TYPE_Any) {
    return false;
  }

  bd.checkNull(obj);
  const kind = b & 7;
  const top = bd.peek(1);

  // A var, or a const set by the initializer of the traits declaring it.
  if (
    kind === 2 ||
    (kind === 3 &&
      opcode === ops.OP_initproperty &&
      domain.initOfDeclarer(type, bd.index, mn) === <i32>bd.global)
  ) {
    bd.coerce(top, propType);
    return bd.emitOn(ops.OP_setslot, -1, <i32>obj, 2, b >> 3, 0, 0);
  }

  if (kind === 6 || kind === 7) {
    const setter = domain.traits.dispatch[domain.traits.dispatchStart[type] + (b >> 3) + 1];
    if (setter >= 0 && !coerceArgs(bd, <u32>setter, 1)) {
      return false;
    }

    if (domain.traits.isInterface[type]) {
      return bd.emitOn(opcode, -1, <i32>obj, n, mn, 0, 0);
    }

    return bd.emitOn(IR_CallSetter, -1, <i32>obj, 2, (b >> 3) + 1, 0, setter);
  }

  if (numericIndex(bd, mn)) {
    if (type === domain.vectorIntType) {
      bd.coerce(top, domain.intType);
    } else if (type === domain.vectorUintType) {
      bd.coerce(top, domain.uintType);
    } else if (type === domain.vectorDoubleType) {
      bd.coerce(top, domain.numberType);
    }
  }

  // An instance's const initialized anywhere but in its declarer's
  // initializer is written as setproperty writes it: ReferenceError 1074.
  // A global's is left to initproperty: a SWF loaded again into the one
  // domain initializes its classes on the first load's global.
  const late =
    kind === 3 &&
    opcode === ops.OP_initproperty &&
    type >= 0 &&
    domain.traits.kind[type] === TRAITS_Instance;
  const write = late ? ops.OP_setproperty : opcode;
  return bd.emitOn(write, -1, <i32>obj, n, mn, 0, 0);
}

/** As Verifier::emitCallproperty and emitCallpropertyMethod. */
export function callProperty(bd: BodyDecoder, opcode: u8, mn: u32, argc: u32): bool {
  const domain = bd.domain;
  const traits = domain.traits;
  const n = propertyDepth(bd, mn, argc + 1);
  if (n === 0) {
    return false;
  }

  const obj = bd.peek(n);
  const type = bd.typeOf(obj);
  if (type >= 0) {
    const error = traits.resolve(domain, <u32>type);
    if (error) {
      return bd.fail(error);
    }
  }

  let b = binding(bd, type, mn);
  if (b === BIND_Ambiguous) {
    return false;
  }

  bd.checkNull(obj);
  const voidCall = opcode === ops.OP_callpropvoid;
  if ((b & 7) === 1) {
    b = fasterCall(bd, type, mn, b, argc);
    const m = traits.dispatch[traits.dispatchStart[type] + (b >> 3)];
    if (m >= 0) {
      const signError = traits.sign(domain, <u32>m);
      if (signError) {
        return bd.fail(signError);
      }

      const count = traits.paramCount[m];
      const required = count - traits.optionalCount[m];
      if (argc >= required && (argc <= count || domain.allowsExtraArgs(<u32>m))) {
        if (!coerceArgs(bd, <u32>m, argc)) {
          return false;
        }

        const result = traits.returnType[m];
        bd.popPush(n, result, domain.typeNotNull(result) ? NOT_NULL : 0);

        // An interface's method has no dispatch id of its own on the receiver.
        const call = traits.isInterface[type] ? IR_CallInterface : ops.OP_callmethod;
        return bd.emitOn(call, voidCall ? -1 : <i32>obj, <i32>obj, n, b >> 3, argc, m);
      }
    }
  } else if (((b & 7) === 2 || (b & 7) === 3) && argc === 1) {
    // Calling a class slot with one argument converts or coerces to the class.
    const slotType = bindingType(domain, type, b);
    const converted = domain.conversionOf(slotType);
    const top = bd.peek(1);
    if (converted !== -2) {
      if (converted >= 0 && domain.isConversion(slotType)) {
        bd.setValue(top, converted, NOT_NULL);
        bd.emitOn(conversionOp(bd, converted), <i32>top, <i32>top, 1, 0, 0, 0);
      } else {
        bd.coerce(top, converted);
      }

      bd.emitted = bd.emitPass;
      if (voidCall) {
        return true;
      }

      const flags = bd.valueFlags[top];
      const value = bd.typeOf(top);
      bd.popPush(n, value, flags & NOT_NULL);
      return bd.emitOn(IR_Nip, <i32>obj, <i32>obj, n, 0, 0, 0);
    }
  }

  bd.popPush(n, TYPE_Any, 0);
  return bd.emitOn(opcode, voidCall ? -1 : <i32>obj, <i32>obj, n, mn, argc, 0);
}

/** The convert opcode that gives `type`, one of the builtin conversions. */
export function conversionOp(bd: BodyDecoder, type: i32): u16 {
  const domain = bd.domain;
  if (type === domain.intType) {
    return ops.OP_convert_i;
  }

  if (type === domain.uintType) {
    return ops.OP_convert_u;
  }

  if (type === domain.numberType) {
    return ops.OP_convert_d;
  }

  return type === domain.booleanType ? ops.OP_convert_b : ops.OP_convert_s;
}

/**
 * As Verifier::findMathFunction and findStringFunction: Math's and
 * String's methods have variants named with a leading underscore for
 * arguments of the right types, which Math's numbers and String's exactly
 * its parameter types.
 */
export function fasterCall(bd: BodyDecoder, type: i32, mn: u32, b: u32, argc: u32): u32 {
  const domain = bd.domain;
  if (type < 0 || (type !== domain.mathStatic && type !== domain.stringType)) {
    return b;
  }

  const name = domain.underscored(bd.index, mn);
  const traits = domain.traits;
  const faster = name < 0 ? BIND_None : traits.findName(type, <u32>name);
  if ((faster & 7) !== 1) {
    return b;
  }

  const m = traits.dispatch[traits.dispatchStart[type] + (faster >> 3)];
  if (m < 0 || traits.sign(domain, <u32>m)) {
    return b;
  }

  const count = traits.paramCount[m];
  const start = traits.paramStart[m];
  if (type === domain.mathStatic) {
    if (argc !== count) {
      return b;
    }

    for (let k: u32 = 1; k <= argc; k++) {
      const t = bd.typeOf(bd.peek(argc - k + 1));
      if (t === TYPE_Any || !isNumeric(domain, t)) {
        return b;
      }
    }

    return faster;
  }

  if (argc < count - traits.optionalCount[m] || argc > count) {
    return b;
  }

  for (let k: u32 = 1; k <= argc; k++) {
    if (bd.typeOf(bd.peek(argc - k + 1)) !== traits.paramType[start + k - 1]) {
      return b;
    }
  }

  return faster;
}

/** As Verifier's OP_callstatic: a bound method, called with its signature. */
export function callStatic(bd: BodyDecoder, m: u32, argc: u32): bool {
  const domain = bd.domain;
  const traits = domain.traits;
  const global = domain.methodStart[bd.index] + m;
  const error = traits.sign(domain, global);
  if (error) {
    return bd.fail(error);
  }

  if (traits.receiverType[global] === TYPE_Any) {
    return bd.fail(C.kDanglingFunctionError);
  }

  bd.checkNull(bd.peek(argc + 1));
  if (!coerceArgs(bd, global, argc)) {
    return false;
  }

  const result = traits.returnType[global];
  bd.rowC = <i32>global;
  return bd.popPush(argc + 1, result, domain.typeNotNull(result) ? NOT_NULL : 0);
}

/** As Verifier's OP_callsuper and OP_callsupervoid. */
export function callSuper(bd: BodyDecoder, opcode: u8, mn: u32, argc: u32): bool {
  const domain = bd.domain;
  const traits = domain.traits;
  const n = propertyDepth(bd, mn, argc + 1);
  if (n === 0) {
    return false;
  }

  const obj = bd.peek(n);
  const base = coerceSuper(bd, obj);
  if (base < TYPE_Any) {
    return false;
  }

  const b = binding(bd, base, mn);
  if (b === BIND_Ambiguous) {
    return false;
  }

  let result = TYPE_Any;
  if ((b & 7) === 1) {
    const error = traits.resolve(domain, <u32>base);
    if (error) {
      return bd.fail(error);
    }

    const m = traits.dispatch[traits.dispatchStart[base] + (b >> 3)];
    if (m < 0) {
      return bd.fail(C.kCorruptABCError);
    }

    const signError = traits.sign(domain, <u32>m);
    if (signError) {
      return bd.fail(signError);
    }

    result = traits.returnType[m];
  }

  bd.checkNull(obj);
  return opcode === ops.OP_callsupervoid
    ? true
    : bd.popPush(n, result, domain.typeNotNull(result) ? NOT_NULL : 0);
}

/** As Verifier's OP_getsuper. */
export function getSuper(bd: BodyDecoder, mn: u32): bool {
  const domain = bd.domain;
  const n = propertyDepth(bd, mn, 1);
  if (n === 0) {
    return false;
  }

  const obj = bd.peek(n);
  const base = coerceSuper(bd, obj);
  if (base < TYPE_Any) {
    return false;
  }

  const b = binding(bd, base, mn);
  if (b === BIND_Ambiguous) {
    return false;
  }

  const propType = readBinding(bd, base, b);
  if (propType < TYPE_Any) {
    return false;
  }

  bd.checkNull(obj);
  return bd.popPush(n, propType, domain.typeNotNull(propType) ? NOT_NULL : 0);
}
