// Each AVM1 action as the block writes it.
//
// The actions written so far: Push, ConstantPool, Trace, Pop, Jump, If,
// Play, Stop, End, PushDuplicate and StackSwap, and the arithmetic,
// comparison, logical, bitwise, string and conversion actions, each a call
// of its version's operation (V.add2, V.less2...), and the variable, member,
// object and call actions, each a call that takes its operands as they are
// popped, the top first, or pops them itself where their number is on the
// stack (V.initObject, V.callMethod...); DefineFunction and DefineFunction2,
// which make a function of a region, StoreRegister and Return; Extends,
// InstanceOf, CastOp, ImplementsOp and RandomNumber; the clip actions,
// SetTarget, SetTarget2, GetProperty, SetProperty, the gotos, NextFrame,
// PrevFrame, WaitForFrame and WaitForFrame2 (a branch on whether the frame
// is loaded), TargetPath, Call, StopSounds, ToggleQuality, GetTime,
// CloneSprite, RemoveSprite, GetUrl and GetUrl2. A function's region takes
// its `this` and its arguments, and a DefineFunction2's registers are its
// `let`s; every other register is one of the movie's four, `cx.g`. A jump
// back counts down V.budget, and the script timeout's check reads the clock
// only as the count runs out. With, Try and Throw are calls too, and a
// region that has a With or a Try keeps what they hold on the activation, by
// ranges of its blocks, which come off as control leaves them (see
// `heldRanges` in control.ts). That is every action Flash knows; one left
// out would be a call that throws, V.notYet. One it does not know is
// skipped, as Flash skips it. An action Flash cannot read, cut short or a
// Push of a value type it does not know, stops the SWF, V.halt, as adl does.

import { Action, Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { Region } from "../flow/regions";
import { BlockEmitter } from "./block";
import { branch, firstFrom, goto, within } from "./control";
import { operation, push, pushed, top } from "./stack";

export function action(
  em: BlockEmitter,
  actions: Actions,
  region: Region,
  action: Action,
  pool: i32,
): void {
  const out = em.out;
  if (action.error !== ERROR_None) {
    // adl stops the whole SWF at an action it cannot read; the block's end returns.
    out.text("V.halt(cx);\n");
    return;
  }

  const op = action.opcode;
  switch (op) {
    case ops.OP_End:
      break;
    case ops.OP_Push:
      push(em, actions, action, pool);
      break;
    case ops.OP_ConstantPool:
      out.text("V.constantPool(cx, [");
      for (let i = 0; i < action.count; i++) {
        if (i > 0) {
          out.text(", ");
        }

        em.string(actions, action.first + i);
      }
      out.text("]);\n");
      break;
    case ops.OP_Trace:
      top(em, "V.trace(cx, ", ");\n");
      break;
    case ops.OP_Pop:
      out.text("st.pop();\n");
      break;
    case ops.OP_Play:
      out.text("V.play(cx);\n");
      break;
    case ops.OP_Stop:
      out.text("V.stop(cx);\n");
      break;
    case ops.OP_Add:
      operation(em, "add", 2);
      break;
    case ops.OP_Add2:
      operation(em, "add2", 2);
      break;
    case ops.OP_Subtract:
      operation(em, "subtract", 2);
      break;
    case ops.OP_Multiply:
      operation(em, "multiply", 2);
      break;
    case ops.OP_Divide:
      operation(em, "divide", 2);
      break;
    case ops.OP_Modulo:
      operation(em, "modulo", 2);
      break;
    case ops.OP_Equals:
      operation(em, "equals", 2);
      break;
    case ops.OP_Equals2:
      operation(em, "equals2", 2);
      break;
    case ops.OP_StrictEquals:
      operation(em, "strictEquals", 2);
      break;
    case ops.OP_Less:
      operation(em, "less", 2);
      break;
    case ops.OP_Less2:
      operation(em, "less2", 2);
      break;
    case ops.OP_Greater:
      operation(em, "greater", 2);
      break;
    case ops.OP_And:
      operation(em, "and", 2);
      break;
    case ops.OP_Or:
      operation(em, "or", 2);
      break;
    case ops.OP_Not:
      operation(em, "not", 1);
      break;
    case ops.OP_BitAnd:
      operation(em, "bitAnd", 2);
      break;
    case ops.OP_BitOr:
      operation(em, "bitOr", 2);
      break;
    case ops.OP_BitXor:
      operation(em, "bitXor", 2);
      break;
    case ops.OP_BitLShift:
      operation(em, "bitLShift", 2);
      break;
    case ops.OP_BitRShift:
      operation(em, "bitRShift", 2);
      break;
    case ops.OP_BitURShift:
      operation(em, "bitURShift", 2);
      break;
    case ops.OP_Increment:
      operation(em, "increment", 1);
      break;
    case ops.OP_Decrement:
      operation(em, "decrement", 1);
      break;
    case ops.OP_StringAdd:
      operation(em, "stringAdd", 2);
      break;
    case ops.OP_StringEquals:
      operation(em, "stringEquals", 2);
      break;
    case ops.OP_StringLess:
      operation(em, "stringLess", 2);
      break;
    case ops.OP_StringGreater:
      operation(em, "stringGreater", 2);
      break;
    case ops.OP_StringLength:
      operation(em, "stringLength", 1);
      break;
    case ops.OP_MBStringLength:
      operation(em, "mbStringLength", 1);
      break;
    case ops.OP_StringExtract:
      operation(em, "stringExtract", 3);
      break;
    case ops.OP_MBStringExtract:
      operation(em, "mbStringExtract", 3);
      break;
    case ops.OP_CharToAscii:
      operation(em, "charToAscii", 1);
      break;
    case ops.OP_AsciiToChar:
      operation(em, "asciiToChar", 1);
      break;
    case ops.OP_MBCharToAscii:
      operation(em, "mbCharToAscii", 1);
      break;
    case ops.OP_MBAsciiToChar:
      operation(em, "mbAsciiToChar", 1);
      break;
    case ops.OP_ToNumber:
      operation(em, "toNumber", 1);
      break;
    case ops.OP_ToString:
      operation(em, "toString", 1);
      break;
    case ops.OP_ToInteger:
      operation(em, "toInteger", 1);
      break;
    case ops.OP_TypeOf:
      operation(em, "typeOf", 1);
      break;
    case ops.OP_GetVariable:
      pushed(em, top(em, "st.push(V.getVariable(cx, ", "));\n"));
      break;
    case ops.OP_SetVariable:
      top(em, "V.setVariable(cx, ", ", st.pop());\n");
      break;
    case ops.OP_DefineLocal:
      top(em, "V.defineLocal(cx, ", ", st.pop());\n");
      break;
    case ops.OP_DefineLocal2:
      top(em, "V.defineLocal2(cx, ", ");\n");
      break;
    case ops.OP_GetMember:
      pushed(em, top(em, "st.push(V.getMember(cx, ", ", st.pop()));\n"));
      break;
    case ops.OP_SetMember:
      top(em, "V.setMember(cx, ", ", st.pop(), st.pop());\n");
      break;
    case ops.OP_Delete:
      pushed(em, top(em, "st.push(V.deleteMember(cx, ", ", st.pop()));\n"));
      break;
    case ops.OP_Delete2:
      pushed(em, top(em, "st.push(V.deleteVariable(cx, ", "));\n"));
      break;
    case ops.OP_Enumerate:
      top(em, "V.enumerate(cx, ", ");\n");
      break;
    case ops.OP_Enumerate2:
      top(em, "V.enumerate2(cx, ", ");\n");
      break;
    case ops.OP_InitObject:
      out.text("V.initObject(cx);\n");
      break;
    case ops.OP_InitArray:
      out.text("V.initArray(cx);\n");
      break;
    case ops.OP_CallFunction:
      out.text("V.callFunction(cx);\n");
      break;
    case ops.OP_CallMethod:
      out.text("V.callMethod(cx);\n");
      break;
    case ops.OP_NewObject:
      out.text("V.newObject(cx);\n");
      break;
    case ops.OP_NewMethod:
      out.text("V.newMethod(cx);\n");
      break;
    case ops.OP_Extends:
      top(em, "V.extends(cx, ", ", st.pop());\n");
      break;
    case ops.OP_InstanceOf:
      pushed(em, top(em, "st.push(V.instanceOf(cx, ", ", st.pop()));\n"));
      break;
    case ops.OP_CastOp:
      pushed(em, top(em, "st.push(V.castOp(cx, ", ", st.pop()));\n"));
      break;
    case ops.OP_ImplementsOp:
      out.text("V.implementsOp(cx);\n");
      break;
    case ops.OP_RandomNumber:
      pushed(em, top(em, "st.push(V.randomNumber(", "));\n"));
      break;
    case ops.OP_DefineFunction:
    case ops.OP_DefineFunction2:
      defineFunction(em, actions, action);
      break;
    case ops.OP_StoreRegister:
      // The value stays: popped and pushed again, undefined on an empty stack.
      out.text("st.push(");
      if (em.register(action.a)) {
        out.text(" = ");
      }
      out.text("st.pop());\n");
      break;
    case ops.OP_Return:
      // A Try's finally runs first, where one holds.
      if (within(em.returns, em.k)) {
        out.text("b = V.ret(cx); continue;\n");
      } else if (em.inUnit) {
        top(em, "cx.ret = ", "; return -2;\n");
      } else {
        top(em, "return ", ";\n");
      }
      break;
    case ops.OP_With:
      out.text("if (!V.with(cx, st.pop(), ");
      out.uint(firstFrom(region, action.s0));
      out.text(", ");
      out.uint(firstFrom(region, action.s1));
      out.text(")) { ");
      goto(em, region, action.next);
      out.text(" }\n");
      break;
    case ops.OP_Try:
      em.try(actions, region, action);
      break;
    case ops.OP_Throw:
      top(em, "V.throw(", ");\n");
      break;
    case ops.OP_PushDuplicate:
      out.text("{ const a = st.pop(); st.push(a, a); }\n");
      break;
    case ops.OP_StackSwap:
      out.text("{ const a = st.pop(), b = st.pop(); st.push(a, b); }\n");
      break;
    case ops.OP_Jump:
      goto(em, region, action.target);
      out.byte(0x0a);
      break;
    case ops.OP_If:
      top(em, "if (V.toBoolean(", ")) ");
      branch(em, region, action.target);
      break;
    case ops.OP_WaitForFrame:
      // A frame not loaded skips the actions after.
      out.text("if (!V.frameLoaded(cx, ");
      out.uint(action.a);
      out.text(")) ");
      branch(em, region, action.target);
      break;
    case ops.OP_WaitForFrame2:
      top(em, "if (!V.frameLoaded2(cx, ", ")) ");
      branch(em, region, action.target);
      break;
    case ops.OP_GotoFrame:
      out.text("V.gotoFrame(cx, ");
      out.uint(action.a);
      out.text(");\n");
      break;
    case ops.OP_GotoLabel:
      out.text("V.gotoLabel(cx, ");
      em.string(actions, action.first);
      out.text(");\n");
      break;
    case ops.OP_GotoFrame2:
      top(em, "V.gotoFrame2(cx, ", action.a !== 0 ? ", true, " : ", false, ");
      out.uint(action.b);
      out.text(");\n");
      break;
    case ops.OP_NextFrame:
      out.text("V.nextFrame(cx);\n");
      break;
    case ops.OP_PreviousFrame:
      out.text("V.prevFrame(cx);\n");
      break;
    case ops.OP_SetTarget:
      out.text("V.setTarget(cx, ");
      em.string(actions, action.first);
      out.text(");\n");
      break;
    case ops.OP_SetTarget2:
      top(em, "V.setTarget2(cx, ", ");\n");
      break;
    case ops.OP_GetProperty:
      pushed(em, top(em, "st.push(V.getProperty(cx, ", ", st.pop()));\n"));
      break;
    case ops.OP_SetProperty:
      top(em, "V.setProperty(cx, ", ", st.pop(), st.pop());\n");
      break;
    case ops.OP_TargetPath:
      pushed(em, top(em, "st.push(V.targetPath(cx, ", "));\n"));
      break;
    case ops.OP_Call:
      top(em, "V.callFrame(cx, ", ");\n");
      break;
    case ops.OP_StopSounds:
      out.text("V.stopSounds(cx);\n");
      break;
    case ops.OP_GetTime:
      pushed(em, out.length, "st.push(V.getTime(cx));\n");
      break;
    case ops.OP_CloneSprite:
      top(em, "V.cloneSprite(cx, ", ", st.pop(), st.pop());\n");
      break;
    case ops.OP_RemoveSprite:
      top(em, "V.removeSprite(cx, ", ");\n");
      break;
    case ops.OP_StartDrag:
      out.text("V.startDrag(cx);\n");
      break;
    case ops.OP_EndDrag:
      out.text("V.stopDrag(cx);\n");
      break;
    case ops.OP_ToggleQuality:
      out.text("V.toggleQuality(cx);\n");
      break;
    case ops.OP_GetUrl:
      out.text("V.getUrl(cx, ");
      em.string(actions, action.first);
      out.text(", ");
      em.string(actions, action.first + 1);
      out.text(");\n");
      break;
    case ops.OP_GetUrl2:
      top(em, "V.getUrl2(cx, ", ", st.pop(), ");
      out.uint(action.a);
      out.text(");\n");
      break;
    default:
      if (ops.opcodeKnown[op]) {
        notYet(em, ops.opcodeNames[op]);
        out.text(";\n");
      }
      break;
  }
}

/**
 * DefineFunction and DefineFunction2: the function made of region
 * `action.region`, with its name, and its parameters that are variables,
 * null for those in a register; a DefineFunction2's flags.
 */
function defineFunction(em: BlockEmitter, actions: Actions, action: Action): void {
  const out = em.out;
  const two = action.opcode === ops.OP_DefineFunction2;
  out.text(two ? "V.defineFunction2(cx, " : "V.defineFunction(cx, ");
  out.uint(action.region);
  out.text(", ");
  em.string(actions, action.first);
  out.text(", [");
  for (let i = 1; i < action.count; i++) {
    if (i > 1) {
      out.text(", ");
    }

    const index = action.first + i;
    if (two && actions.stringRegister[index] !== 0) {
      out.text("null");
    } else {
      em.string(actions, index);
    }
  }
  out.byte(0x5d);
  if (two) {
    out.text(", ");
    out.uint(<u32>action.b);
  }
  out.text(");\n");
}

function notYet(em: BlockEmitter, name: string): void {
  const out = em.out;
  out.text('V.notYet("');
  out.text(name);
  out.text('")');
}
