// The test build's look at AVM1, for the node tests: its opcodes, and a
// SWF's action blocks as the decoder reads them and the flow divides them
// into regions.

import { Action, Actions, ERROR_None, ERROR_PushType } from "../avm1/actions/decode";
import * as avm1 from "../avm1/actions/opcodes";
import { branches, Flow, Region } from "../avm1/flow/regions";
import { hex } from "./abc";

/** The AVM1 actions Flash knows, one a line: "0x96 Push". */
export function avm1Opcodes(): string {
  const out: string[] = [];
  for (let op = 0; op < 256; op++) {
    if (avm1.opcodeKnown[op]) {
      out.push(`${hex(<u8>op)} ${avm1.opcodeNames[op]}`);
    }
  }

  return out.join("\n");
}

const REGION_NAMES = ["block", "function"];

/**
 * An AVM1 block's regions as the flow finds them, each with its blocks and
 * their actions, one a line: "region 1 function 9-20 from 0 at 3", "block 9",
 * "9 Push 1i r2", "14 If -> 9", "17 Jump -> exit 40"; only "too large" if it is.
 */
export function avm1Dump(bytes: Uint8Array): string {
  const actions = new Actions(bytes);
  const flow = new Flow(actions);
  if (flow.tooLarge) {
    return "too large";
  }

  const out: string[] = [];
  for (let r = 0; r < flow.regions.length; r++) {
    const region = flow.regions[r];
    let head = `region ${r} ${REGION_NAMES[region.kind]} ${region.start}-${region.end}`;
    if (region.parent >= 0) {
      head += ` from ${region.parent} at ${actions.actions[region.opener].offset}`;
    }
    out.push(head);

    for (let k = 0; k < region.blocks.length; k++) {
      out.push(`block ${region.blocks[k]}`);
      for (let i = region.blockFirst[k]; i < region.blockFirst[k + 1]; i++) {
        out.push(avm1Line(actions, actions.actions[region.order[i]], region));
      }
    }
  }

  return out.join("\n");
}

/**
 * What avm1Dump shows, briefly, for the fuzzer: "regions, actions, a hash of
 * every region's blocks and actions", "too large", or the first region that
 * lists an action in two of its blocks.
 */
export function avm1Check(bytes: Uint8Array): string {
  const actions = new Actions(bytes);
  const flow = new Flow(actions);
  if (flow.tooLarge) {
    return "too large";
  }

  const seen = new StaticArray<i32>(bytes.length);
  let hash: u32 = 2166136261;
  let count = 0;
  for (let r = 0; r < flow.regions.length; r++) {
    const region = flow.regions[r];
    hash = (hash ^ (<u32>region.kind | ((<u32>region.start) << 3))) * 16777619;
    hash = (hash ^ <u32>region.end) * 16777619;
    for (let k = 0; k < region.blocks.length; k++) {
      hash = (hash ^ <u32>region.blocks[k]) * 16777619;
    }

    for (let i = 0; i < region.order.length; i++) {
      const action = actions.actions[region.order[i]];
      if (seen[action.offset] === r + 1) {
        return `repeated in region ${r}`;
      }

      seen[action.offset] = r + 1;
      hash = (hash ^ (<u32>action.offset | ((<u32>action.opcode) << 24))) * 16777619;
      hash = (hash ^ <u32>action.target) * 16777619;
      count++;
    }
  }

  return `${flow.regions.length} ${count} ${hash}`;
}

/** The action at `offset` of an AVM1 block alone, and where the next one starts. */
export function avm1Action(bytes: Uint8Array, offset: i32): string {
  const actions = new Actions(bytes);
  const action = actions.decode(offset);
  actions.skip(action);
  const region = new Region(0, 0, bytes.length, -1, -1);
  return `${avm1Line(actions, action, region)} next ${action.next}`;
}

function avm1Line(actions: Actions, action: Action, region: Region): string {
  const op = action.opcode;
  let line = `${action.offset} ${avm1.opcodeNames[op]}`;
  if (action.error !== ERROR_None) {
    return `${line} ${action.error === ERROR_PushType ? "push type" : "truncated"}`;
  }

  switch (op) {
    case avm1.OP_GotoFrame:
      line += ` ${action.a}`;
      break;
    case avm1.OP_GetUrl:
      line += ` ${avm1String(actions, action.first)} ${avm1String(actions, action.first + 1)}`;
      break;
    case avm1.OP_StoreRegister:
      line += ` r${action.a}`;
      break;
    case avm1.OP_ConstantPool:
    case avm1.OP_SetTarget:
    case avm1.OP_GotoLabel:
      for (let i = 0; i < action.count; i++) {
        line += ` ${avm1String(actions, action.first + i)}`;
      }
      break;
    case avm1.OP_WaitForFrame:
      line += ` ${action.a} skip ${action.b}`;
      break;
    case avm1.OP_WaitForFrame2:
      line += ` skip ${action.b}`;
      break;
    case avm1.OP_DefineFunction:
    case avm1.OP_DefineFunction2: {
      line += ` ${avm1String(actions, action.first)}`;
      if (op === avm1.OP_DefineFunction2) {
        line += ` registers ${action.a} flags ${hex(<u8>(action.b >> 8))}${hex(<u8>action.b).slice(2)}`;
      }
      const params: string[] = [];
      for (let i = 1; i < action.count; i++) {
        const register = actions.stringRegister[action.first + i];
        const name = avm1String(actions, action.first + i);
        params.push(register ? `r${register}=${name}` : name);
      }
      line += ` (${params.join(", ")}) body ${action.s0}-${action.s1} region ${action.region}`;
      break;
    }
    case avm1.OP_Try:
      line += ` flags ${action.a}`;
      if (action.a & avm1.TRY_CatchInRegister) {
        line += ` r${action.b}`;
      } else if (action.count) {
        line += ` ${avm1String(actions, action.first)}`;
      }
      line += ` try ${action.s0}-${action.s1} catch ${action.s1}-${action.s2}`;
      line += ` finally ${action.s2}-${action.s3}`;
      break;
    case avm1.OP_With:
      line += ` body ${action.s0}-${action.s1}`;
      break;
    case avm1.OP_Push:
      for (let i = action.first; i < action.first + action.count; i++) {
        line += ` ${avm1Value(actions, i)}`;
      }
      break;
    case avm1.OP_Jump:
    case avm1.OP_If:
      line += ` ${action.a}`;
      break;
    case avm1.OP_GetUrl2:
      line += ` ${hex(<u8>action.a)}`;
      break;
    case avm1.OP_GotoFrame2:
      line += ` play ${action.a} bias ${action.b}`;
      break;
    default:
      break;
  }

  if (branches(action)) {
    line += region.runs(action.target) ? ` -> ${action.target}` : ` -> exit ${action.target}`;
  }

  return line;
}

function avm1String(actions: Actions, index: i32): string {
  if (index < 0 || index >= actions.stringStart.length) {
    return "?";
  }

  const at = actions.bytes.dataStart + <usize>actions.stringStart[index];
  return `"${String.UTF8.decodeUnsafe(at, actions.stringLength[index])}"`;
}

function avm1Value(actions: Actions, i: i32): string {
  const number = actions.valueNumber[i];
  const index = actions.valueIndex[i];
  switch (actions.valueType[i]) {
    case avm1.PUSH_String:
      return avm1String(actions, index);
    case avm1.PUSH_Float:
      return `${number}f`;
    case avm1.PUSH_Null:
      return "null";
    case avm1.PUSH_Undefined:
      return "undefined";
    case avm1.PUSH_Register:
      return `r${index}`;
    case avm1.PUSH_Boolean:
      return number ? "true" : "false";
    case avm1.PUSH_Integer:
      return `${<i32>number}i`;
    case avm1.PUSH_Constant8:
      return `c${index}`;
    case avm1.PUSH_Constant16:
      return `C${index}`;
    default:
      return `${number}`;
  }
}
