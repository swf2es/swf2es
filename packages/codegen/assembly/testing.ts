// Test-only entry point: what codegen.wasm exports, and the reader, the
// verifier and the emitter besides, for the node tests to look inside.
import { Action, Actions, ERROR_None, ERROR_PushType } from "./avm1/actions/decode";
import * as avm1 from "./avm1/actions/opcodes";
import { branches, Flow, Region } from "./avm1/flow/regions";
import { Abc } from "./avm2/abc/abc";
import { BodyDecoder, verifyMethods } from "./avm2/abc/code";
import { OP_lookupswitch, opcodeFlags, opcodeNames, opcodeOperands } from "./avm2/abc/opcodes";
import { readAbc } from "./avm2/abc/parse";
import { readConstantPool } from "./avm2/abc/pool";
import { PADDING, Reader } from "./avm2/abc/reader";
import { MethodEmitter } from "./avm2/emit/method";
import {
  IR_CallGetter,
  IR_CallInterface,
  IR_CallSetter,
  IR_CheckNull,
  IR_Coerce,
  IR_ConstructSlot,
  IR_FindPropGlobal,
  IR_FindPropGlobalStrict,
  IR_GetGlobalScope,
  IR_Nip,
  Ir,
} from "./avm2/ir/ir";
import {
  TRAITS_Activation,
  TRAITS_Catch,
  TRAITS_Class,
  TRAITS_Instance,
  TRAITS_Null,
  TRAITS_Script,
  TRAITS_Void,
} from "./avm2/link/traits";
import { domain } from "./compile";

export const U8: u8 = 0;
export const U16: u8 = 1;
export const S24: u8 = 2;
export const U30: u8 = 3;
export const U32: u8 = 4;
export const S32: u8 = 5;
export const D64: u8 = 6;
export const UTF8: u8 = 7;

/**
 * Read `kinds` in order from `bytes` and return the values, then the final
 * position and 1 if the reader failed. UTF8 yields the string's byte length
 * and skips its bytes.
 */
export function readAll(bytes: Uint8Array, kinds: Uint8Array): Float64Array {
  const start = padded(bytes);
  const r = new Reader(start, start + bytes.length);
  const values = new Float64Array(kinds.length + 2);
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    let value: f64 = 0;
    if (kind === U8) {
      value = r.u8();
    } else if (kind === U16) {
      value = r.u16();
    } else if (kind === S24) {
      value = r.s24();
    } else if (kind === U30) {
      value = r.u30();
    } else if (kind === U32) {
      value = r.u32();
    } else if (kind === S32) {
      value = r.s32();
    } else if (kind === D64) {
      value = r.d64();
    } else if (kind === UTF8) {
      const length = r.utf8Length();
      r.skip(length);
      value = length;
    }
    values[i] = value;
  }

  values[kinds.length] = <f64>(r.pos - start);
  values[kinds.length + 1] = r.failed ? 1 : 0;
  return values;
}

/**
 * Parse the constant pool of a whole ABC block and describe it one entry
 * per line: "int 1 -5", "string 2 foo", "ns 1 0x16 2", "nsset 1 1,2",
 * "mn 3 0x07 1 2", then "error N" if avmplus would reject it.
 */
export function poolDump(bytes: Uint8Array): string {
  const base = padded(bytes);
  const r = new Reader(base, base + bytes.length);
  const minor = r.u16();
  const major = r.u16();
  const pool = readConstantPool(r, base, major === 47 && minor >= 16);

  // Lines joined once: the minimal runtime frees nothing during a call.
  const out: string[] = [];
  for (let i = 1; i < pool.ints.length; i++) {
    out.push(`int ${i} ${pool.ints[i]}`);
  }
  for (let i = 1; i < pool.uints.length; i++) {
    out.push(`uint ${i} ${pool.uints[i]}`);
  }
  for (let i = 1; i < pool.doubles.length; i++) {
    out.push(`double ${i} ${pool.doubles[i]}`);
  }
  for (let i = 1; i < pool.floats.length; i++) {
    out.push(`float ${i} ${<f64>pool.floats[i]}`);
  }
  for (let i = 1; i < pool.stringStart.length; i++) {
    const text = String.UTF8.decodeUnsafe(base + pool.stringStart[i], pool.stringLength[i]);
    out.push(`string ${i} ${text}`);
  }
  for (let i = 1; i < pool.nsKind.length; i++) {
    out.push(`ns ${i} ${hex(pool.nsKind[i])} ${pool.nsName[i]}`);
  }
  for (let i: u32 = 1; i < pool.nsSetCount; i++) {
    const members: string[] = [];
    for (let j = pool.nsSetStart[i]; j < pool.nsSetStart[i + 1]; j++) {
      members.push(pool.nsSetMembers[j].toString());
    }
    out.push(`nsset ${i} ${members.join(",")}`);
  }
  for (let i = 1; i < pool.mnKind.length; i++) {
    out.push(`mn ${i} ${hex(pool.mnKind[i])} ${pool.mnA[i]} ${pool.mnB[i]}`);
  }
  if (pool.error) {
    out.push(`error ${pool.error}`);
  }

  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * Parse a whole ABC block and describe the tables after the constant pool,
 * one entry per line; just "error N" if avmplus would reject it, since the
 * tables of a rejected ABC are incomplete. `builtin` parses it as an ABC the
 * player ships.
 */
export function abcDump(bytes: Uint8Array, builtin: bool = false): string {
  const abc = readAbc(padded(bytes), bytes.length, builtin);
  if (abc.error) {
    return `error ${abc.error}`;
  }

  const out: string[] = [];

  for (let i: u32 = 0; i < abc.methodCount; i++) {
    let line = `method ${i} ret=${abc.methodReturnType[i]} params=`;
    line += join(abc.paramTypes, abc.methodParamStart[i], abc.methodParamStart[i + 1]);
    line += ` name=${abc.methodName[i]} flags=${hex(abc.methodFlags[i])}`;
    const optional: string[] = [];
    for (let j = abc.methodOptionalStart[i]; j < abc.methodOptionalStart[i + 1]; j++) {
      optional.push(`${abc.optionalValue[j]}:${hex(abc.optionalKind[j])}`);
    }
    if (optional.length) {
      line += ` optional=${optional.join(",")}`;
    }
    out.push(line);
  }

  for (let i: u32 = 0; i < abc.metadataCount; i++) {
    const items: string[] = [];
    for (let j = abc.metadataItemStart[i]; j < abc.metadataItemStart[i + 1]; j++) {
      items.push(`${abc.metadataKey[j]}:${abc.metadataValue[j]}`);
    }
    out.push(`metadata ${i} name=${abc.metadataName[i]} items=${items.join(",")}`);
  }

  for (let i: u32 = 0; i < abc.classCount; i++) {
    let line = `instance ${i} name=${abc.instanceName[i]} super=${abc.instanceSuper[i]}`;
    line += ` flags=${hex(abc.instanceFlags[i])} protectedNs=${abc.instanceProtectedNs[i]}`;
    line += ` interfaces=${join(abc.interfaces, abc.instanceInterfaceStart[i], abc.instanceInterfaceStart[i + 1])}`;
    out.push(`${line} init=${abc.instanceInit[i]}`);
    dumpTraits(abc, out, `instance ${i}`, abc.instanceTraitStart[i], abc.instanceTraitStart[i + 1]);
  }

  for (let i: u32 = 0; i < <u32>abc.classInit.length; i++) {
    out.push(`class ${i} init=${abc.classInit[i]}`);
    dumpTraits(abc, out, `class ${i}`, abc.classTraitStart[i], abc.classTraitStart[i + 1]);
  }

  for (let i: u32 = 0; i < abc.scriptCount; i++) {
    out.push(`script ${i} init=${abc.scriptInit[i]}`);
    dumpTraits(abc, out, `script ${i}`, abc.scriptTraitStart[i], abc.scriptTraitStart[i + 1]);
  }

  for (let b: u32 = 0; b < abc.bodyCount; b++) {
    const method = abc.bodyMethod[b];
    let line = `body ${b} method=${method} stack=${abc.bodyMaxStack[b]} locals=${abc.bodyLocalCount[b]}`;
    line += ` scope=${abc.bodyInitScopeDepth[b]}..${abc.bodyMaxScopeDepth[b]}`;
    line += ` code=${abc.bodyCodeStart[b]}+${abc.bodyCodeLength[b]}`;
    const exceptions: string[] = [];
    for (let e = abc.bodyExceptionStart[b]; e < abc.bodyExceptionStart[b + 1]; e++) {
      exceptions.push(
        `${abc.exceptionFrom[e]}-${abc.exceptionTo[e]}>${abc.exceptionTarget[e]}:${abc.exceptionType[e]}:${abc.exceptionName[e]}`,
      );
    }
    if (exceptions.length) {
      line += ` exceptions=${exceptions.join(",")}`;
    }
    out.push(line);
    dumpTraits(abc, out, `activation ${method}`, abc.bodyTraitStart[b], abc.bodyTraitStart[b + 1]);
  }

  for (let i: u32 = 0; i < abc.methodCount; i++) {
    const owner = abc.methodOwner[i];
    if (owner >= 0) {
      out.push(`bound method ${i} to ${ownerLabel(abc, owner)}`);
    }
  }

  return out.join("\n");
}

function dumpTraits(abc: Abc, out: Array<string>, owner: string, start: u32, end: u32): void {
  for (let t = start; t < end; t++) {
    const tag = abc.traitTag[t];
    let line = `  trait ${owner} name=${abc.traitName[t]} kind=${tag & 0x0f} attr=${hex(tag & 0xf0)}`;
    line += ` id=${abc.traitId[t]} index=${abc.traitIndex[t]}`;
    if (abc.traitValue[t]) {
      line += ` value=${abc.traitValue[t]}:${hex(abc.traitValueKind[t])}`;
    }
    const metadataStart = abc.traitMetadataStart[t];
    const metadataEnd = abc.traitMetadataStart[t + 1];
    if (metadataEnd > metadataStart) {
      line += ` metadata=${join(abc.traitMetadata, metadataStart, metadataEnd)}`;
    }
    out.push(line);
  }
}

function ownerLabel(abc: Abc, owner: i32): string {
  const classes = <i32>abc.classCount;
  if (owner < classes) {
    return `instance ${owner}`;
  }
  if (owner < 2 * classes) {
    return `class ${owner - classes}`;
  }
  const scripts = <i32>abc.scriptCount;
  if (owner < 2 * classes + scripts) {
    return `script ${owner - 2 * classes}`;
  }
  return `activation ${owner - 2 * classes - scripts}`;
}

function join(items: Array<u32>, start: u32, end: u32): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    parts.push(items[i].toString());
  }
  return parts.join(",");
}

/**
 * Decode every method body: "body B method M", then one "offset name a b c"
 * line per reachable instruction (lookupswitch adds its case offsets), then
 * "unreachable N" bytes, or "error N" if avmplus' verifier would reject it.
 * `builtin` parses it as an ABC the player ships.
 */
export function codeDump(bytes: Uint8Array, builtin: bool = false): string {
  const base = padded(bytes);
  const abc = readAbc(base, bytes.length, builtin);
  if (abc.error) {
    return `error ${abc.error}`;
  }

  const out: string[] = [];
  const decoder = new BodyDecoder(abc, base);
  for (let body: u32 = 0; body < abc.bodyCount; body++) {
    out.push(`body ${body} method ${abc.bodyMethod[body]}`);
    const code = decoder.decode(body);
    if (code.error) {
      out.push(`  error ${code.error}`);
      continue;
    }

    let decoded: u32 = 0;
    for (let i: u32 = 0; i < code.count; i++) {
      const opcode = code.opcode[i];
      let line = `  ${code.offset[i]} ${opcodeNames[opcode]} ${code.a[i]} ${code.b[i]} ${code.c[i]}`;
      if (opcode === OP_lookupswitch) {
        const cases: string[] = [];
        for (let j = code.c[i]; j <= code.c[i] + code.b[i]; j++) {
          cases.push(code.cases[j].toString());
        }
        line += ` [${cases.join(",")}]`;
      }
      out.push(line);
      decoded += code.next[i] - code.offset[i];
    }
    out.push(`  unreachable ${abc.bodyCodeLength[body] - decoded}`);
  }

  return out.join("\n");
}

/** Parse `bytes` as an ABC `rounds` times; returns the method count, so the work is used. */
export function benchParse(bytes: Uint8Array, rounds: i32): i32 {
  const base = padded(bytes);
  let methods = 0;
  for (let round = 0; round < rounds; round++) {
    methods += readAbc(base, bytes.length).methodCount;
  }
  return methods;
}

/** Parse once, then decode every body `rounds` times; returns instructions decoded per round. */
export function benchDecode(bytes: Uint8Array, rounds: i32): i32 {
  const base = padded(bytes);
  const abc = readAbc(base, bytes.length);
  const decoder = new BodyDecoder(abc, base);
  let instructions = 0;
  for (let round = 0; round < rounds; round++) {
    instructions = 0;
    for (let body: u32 = 0; body < abc.bodyCount; body++) {
      instructions += decoder.decode(body).count;
    }
  }
  return instructions;
}

/**
 * The domain's binding of `name` in the namespace of type `type` (NS_*) and
 * URI `uri`, visible at `version` from application domain `appDomain`:
 * "abc A script S trait T", or "none".
 */
export function domainFind(
  type: u8,
  uri: string,
  name: string,
  version: i32,
  appDomain: i32 = 0,
): string {
  const uriBytes = String.UTF8.encode(uri);
  const nameBytes = String.UTF8.encode(name);
  const uriId = domain.findString(changetype<usize>(uriBytes), uriBytes.byteLength);
  const nameId = domain.findString(changetype<usize>(nameBytes), nameBytes.byteLength);
  if (uriId < 0 || nameId < 0) {
    return "none";
  }

  const ns = domain.findNamespace(type, uriId);
  const b = ns < 0 ? -1 : domain.find(ns, nameId, <u8>version, <u32>appDomain);
  if (b < 0) {
    return "none";
  }

  return `abc ${domain.bindingAbc[b]} script ${domain.bindingScript[b]} trait ${domain.bindingTrait[b]}`;
}

/** Counts of the domain's tables and recorded findings, then the URIs builtin ABCs version, sorted. */
export function domainSummary(): string {
  const uris: string[] = [];
  for (let i = 0; i < domain.versioned.length; i++) {
    if (domain.versioned[i]) {
      uris.push(String.UTF8.decodeUnsafe(domain.stringPtr[i], domain.stringLength[i]));
    }
  }

  uris.sort();
  return `strings ${domain.stringPtr.length} namespaces ${domain.nsType.length} bindings ${domain.bindingNs.length} found ${domain.cachedDomain.length} versioned ${uris.join(",")}`;
}

/**
 * The domain's traits from `first` on: "traits T kind K base B slots S
 * methods M", then a "  uri::name kind id" line per own member.
 */
export function domainTraits(first: i32): string {
  const traits = domain.traits;
  const text = (id: u32): string =>
    id === 0xffffffff
      ? "*"
      : String.UTF8.decodeUnsafe(domain.stringPtr[id], domain.stringLength[id]);
  const out: string[] = [];
  for (let t = first; t < traits.kind.length; t++) {
    out.push(
      `traits ${t} kind ${traits.kind[t]} base ${traits.base[t]} slots ${traits.slotCount[t]} methods ${traits.methodCount[t]}`,
    );
    for (let m = traits.memberStart[t]; m < traits.memberEnd[t]; m++) {
      const binding = traits.memberBinding[m];
      out.push(
        `  ${text(domain.nsUri[traits.memberNs[m]])}::${text(traits.memberName[m])} ${binding & 7} ${binding >> 3}`,
      );
    }
  }

  return out.join("\n");
}

/**
 * Resolve every traits of the domain from `first` on, as avmplus does when
 * each is first used: 0, or the first VerifyError.
 */
export function domainResolve(first: i32): i32 {
  const count = domain.traits.kind.length;
  for (let t = first; t < count; t++) {
    const error = domain.traits.resolve(domain, t);
    if (error) {
      return error;
    }
  }

  return 0;
}

/** The builtin types the domain found, as traits ids. */
export function domainBuiltins(): string {
  return `object ${domain.objectType()} class ${domain.classClass} void ${domain.voidType} null ${domain.nullType} number ${domain.numberType} int ${domain.intType} uint ${domain.uintType} boolean ${domain.booleanType} string ${domain.stringType} namespace ${domain.namespaceType} vector ${domain.vectorClass} vectorObject ${domain.vectorObjectType} vectorInt ${domain.vectorIntType} vectorUint ${domain.vectorUintType} vectorDouble ${domain.vectorDoubleType}`;
}

/**
 * Verify every method of the domain's last ABC that its scripts can run,
 * with types: a "body B method M error N" line for each that fails, then
 * "verified V of B bodies".
 */
export function domainVerifyAll(): string {
  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
  const results = verifyMethods(domain, index);
  const out: string[] = [];
  let verified = 0;
  for (let b = 0; b < results.length; b++) {
    if (results[b] >= 0) {
      verified++;
    }

    if (results[b] > 0) {
      out.push(`body ${b} method ${abc.bodyMethod[b]} error ${results[b]}`);
    }
  }

  out.push(`verified ${verified} of ${results.length} bodies`);
  return out.join("\n");
}

/**
 * Verify the domain's last ABC with types `rounds` times, as verifyMethods
 * does, a body that fails too; returns the instructions of the bodies that
 * verified, per round.
 */
export function benchVerify(rounds: i32): i32 {
  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
  const traits = domain.traits;
  const methods = domain.methodStart[index];
  const scripts = domain.scriptTraits[index];
  const done = new StaticArray<bool>(abc.bodyCount);
  const queue: u32[] = [];
  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
  let instructions = 0;
  for (let round = 0; round < rounds; round++) {
    // Each round as the first: the ABC verified once, as it is compiled.
    domain.clearBindingMemo();
    instructions = 0;
    for (let b: u32 = 0; b < abc.bodyCount; b++) {
      done[b] = false;
    }

    queue.length = 0;
    for (let s: u32 = 0; s < abc.scriptCount; s++) {
      domain.methodsOf(scripts[s], queue);
    }

    for (let q = 0; q < queue.length; q++) {
      const m = queue[q];
      const body = abc.methodBody[m - methods];
      const scope = traits.scopeOf(m);
      if (body < 0 || scope === null || done[body]) {
        continue;
      }

      done[body] = true;
      const code = decoder.decode(<u32>body, scope);
      if (!code.error) {
        instructions += code.count;
      }

      for (let c = 0; c < decoder.captured.length; c++) {
        queue.push(decoder.captured[c]);
      }
    }
  }

  return instructions;
}

/**
 * The IR of body `body` of the domain's last ABC, after verifying the ABC
 * as domainVerifyAll does: "B<n> @<pc> stack [types] scope [types]" per
 * block, then a line per instruction, "<pc>: [dst =] op srcs [a b c] : type",
 * a trailing ! marking a type known not null; "error N" if it failed.
 */
export function domainIr(body: u32): string {
  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
  const results = verifyMethods(domain, index);
  if (results[body] !== 0) {
    return results[body] < 0 ? "not verified" : `error ${results[body]}`;
  }

  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
  const m = domain.methodStart[index] + abc.bodyMethod[body];
  const code = decoder.decode(body, domain.traits.scopeOf(m));
  if (code.error) {
    return `error ${code.error}`;
  }

  const ir = decoder.ir;
  const out: string[] = [];
  const stackBase = ir.localCount + ir.maxScope;
  for (let k: u32 = 0; k < ir.blockCount; k++) {
    const entry = k * ir.frameSize;
    const stack: string[] = [];
    for (let d: u32 = 0; d < ir.blockStack[k]; d++) {
      stack.push(
        typeText(ir.entryType[entry + stackBase + d], ir.entryFlags[entry + stackBase + d] & 1),
      );
    }

    const scope: string[] = [];
    for (let d: u32 = 0; d < ir.blockScope[k]; d++) {
      scope.push(typeText(ir.entryType[entry + ir.localCount + d], 1));
    }

    out.push(`B${k} @${ir.blockPc[k]} stack [${stack.join(", ")}] scope [${scope.join(", ")}]`);
    const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
    for (let i = ir.blockFirst[k]; i < last; i++) {
      out.push(`  ${irLine(ir, i)}`);
    }
  }

  for (let h: u32 = 0; h < ir.handlerCount; h++) {
    out.push(
      `handler ${ir.handlerFrom[h]}..${ir.handlerTo[h]} B${ir.handlerBlock[h]} ${typeText(ir.handlerType[h], 0)}`,
    );
  }

  return out.join("\n");
}

/**
 * The JavaScript function body `body` of the domain's last ABC compiles to,
 * after verifying the ABC as domainVerifyAll does; "error N" if it failed.
 */
export function domainEmit(body: u32): string {
  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
  const results = verifyMethods(domain, index);
  if (results[body] !== 0) {
    return results[body] < 0 ? "not verified" : `error ${results[body]}`;
  }

  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
  const method = abc.bodyMethod[body];
  const global = domain.methodStart[index] + method;
  const code = decoder.decode(body, domain.traits.scopeOf(global));
  if (code.error) {
    return `error ${code.error}`;
  }

  const emitter = new MethodEmitter(domain, index);
  emitter.method(method, global, decoder.ir);
  const out = emitter.out;
  return String.UTF8.decodeUnsafe(changetype<usize>(out.bytes), out.length);
}

/**
 * Check the IR of every method of the domain's last ABC that verifies:
 * registers inside the frame, branch, case and handler targets that are
 * blocks, blocks that end in a terminal instruction or fall into the next,
 * and each instruction's pc inside its block. "checked N bodies, R
 * instructions" or the first problem.
 */
export function domainCheckIr(): string {
  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
  const results = verifyMethods(domain, index);
  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
  let bodies = 0;
  let rows = 0;
  for (let body: u32 = 0; body < abc.bodyCount; body++) {
    if (results[body] !== 0) {
      continue;
    }

    const m = domain.methodStart[index] + abc.bodyMethod[body];
    decoder.decode(body, domain.traits.scopeOf(m));
    const ir = decoder.ir;
    bodies++;
    rows += ir.count;
    const size = <i32>ir.frameSize;
    for (let k: u32 = 0; k < ir.blockCount; k++) {
      const first = ir.blockFirst[k];
      const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
      const end = k + 1 < ir.blockCount ? ir.blockPc[k + 1] : abc.bodyCodeLength[body];
      if (last === first && k + 1 === ir.blockCount) {
        return `body ${body} B${k}: empty last block`;
      }

      for (let i = first; i < last; i++) {
        const op = ir.op[i];
        const where = `body ${body} B${k} row ${i} (${irName(op)})`;
        if (ir.dst[i] >= size || ir.dst[i] < -1) {
          return `${where}: dst ${ir.dst[i]} outside the frame of ${size}`;
        }

        if (ir.srcCount[i] && (ir.src[i] < 0 || ir.src[i] + <i32>ir.srcCount[i] > size)) {
          return `${where}: src ${ir.src[i]}+${ir.srcCount[i]} outside the frame of ${size}`;
        }

        if (ir.pc[i] < ir.blockPc[k] || ir.pc[i] >= end) {
          return `${where}: pc ${ir.pc[i]} outside ${ir.blockPc[k]}..${end}`;
        }

        const branches = (op >= 0x0c && op <= 0x1a) || op === 0x10;
        if (branches && ir.a[i] >= ir.blockCount) {
          return `${where}: target B${ir.a[i]} of ${ir.blockCount}`;
        }

        if (ir.isSwitch(i)) {
          if (ir.a[i] >= ir.blockCount) {
            return `${where}: default B${ir.a[i]}`;
          }

          for (let c = ir.b[i]; c <= ir.b[i] + <u32>ir.c[i]; c++) {
            if (ir.cases[c] >= ir.blockCount) {
              return `${where}: case B${ir.cases[c]}`;
            }
          }
        }
      }

      // A block ends in a jump, switch, return or throw, or falls into the next.
      const lastOp = last > first ? ir.op[last - 1] : 0;
      const terminal =
        lastOp === 0x10 || lastOp === 0x1b || lastOp === 0x03 || lastOp === 0x47 || lastOp === 0x48;
      if (!terminal && k + 1 === ir.blockCount) {
        return `body ${body} B${k}: falls off the end after ${irName(lastOp)}`;
      }
    }

    for (let h: u32 = 0; h < ir.handlerCount; h++) {
      if (ir.handlerBlock[h] >= ir.blockCount) {
        return `body ${body} handler ${h}: block B${ir.handlerBlock[h]}`;
      }
    }
  }

  return `checked ${bodies} bodies, ${rows} instructions`;
}

function irLine(ir: Ir, i: u32): string {
  const srcs: string[] = [];
  for (let k: u32 = 0; k < ir.srcCount[i]; k++) {
    srcs.push(register(ir, ir.src[i] + <i32>k));
  }

  const op = ir.op[i];
  const dst = ir.dst[i];
  let line = `${ir.pc[i]}: ${dst >= 0 ? `${register(ir, dst)} = ` : ""}${irName(op)}`;
  if (srcs.length) {
    line += ` ${srcs.join(" ")}`;
  }

  if (ir.isSwitch(i)) {
    const cases: string[] = [];
    for (let c = ir.b[i]; c <= ir.b[i] + <u32>ir.c[i]; c++) {
      cases.push(`B${ir.cases[c]}`);
    }

    line += ` default B${ir.a[i]} [${cases.join(" ")}]`;
  } else if (op === 0x10 || (op >= 0x0c && op <= 0x1a)) {
    line += ` B${ir.a[i]}`;
  } else if (op === IR_Coerce) {
    line += ` ${typeText(ir.c[i], 0)}`;
  } else if (ir.a[i] || ir.b[i] || ir.c[i]) {
    line += ` [${ir.a[i]} ${ir.b[i]} ${ir.c[i]}]`;
  }

  return dst >= 0 ? `${line} : ${typeText(ir.type[i], ir.notNull[i])}` : line;
}

function register(ir: Ir, r: i32): string {
  const local = <i32>ir.localCount;
  if (r < local) {
    return `l${r}`;
  }

  return r < local + <i32>ir.maxScope ? `sc${r - local}` : `s${r - local - <i32>ir.maxScope}`;
}

function irName(op: u16): string {
  if (op < 256) {
    return opcodeNames[op];
  }

  switch (op) {
    case IR_Coerce:
      return "coerce";
    case IR_CheckNull:
      return "checknull";
    case IR_CallGetter:
      return "callgetter";
    case IR_CallSetter:
      return "callsetter";
    case IR_CallInterface:
      return "callinterface";
    case IR_FindPropGlobal:
      return "findpropglobal";
    case IR_FindPropGlobalStrict:
      return "findpropglobalstrict";
    case IR_GetGlobalScope:
      return "getglobalscope";
    case IR_Nip:
      return "nip";
    case IR_ConstructSlot:
      return "constructslot";
    default:
      return `ir${op}`;
  }
}

/** A type's name: "*", void, null, a class's name, "Name$" for its class object, and so on. */
function typeText(t: i32, notNull: u8): string {
  const bang = notNull ? "!" : "";
  if (t < 0) {
    return `*${bang}`;
  }

  const traits = domain.traits;
  const kind = traits.kind[t];
  let name = "";
  if (kind === TRAITS_Void) {
    name = "void";
  } else if (kind === TRAITS_Null) {
    name = "null";
  } else if (kind === TRAITS_Script) {
    name = "global";
  } else if (kind === TRAITS_Activation) {
    name = "activation";
  } else if (kind === TRAITS_Catch) {
    name = "catch";
  } else if (
    traits.param[t] !== -1 ||
    (kind === TRAITS_Instance &&
      traits.first[t] === traits.end[t] &&
      traits.base[t] === domain.vectorObjectType &&
      t !== domain.vectorObjectType)
  ) {
    name = `Vector.<${typeText(traits.param[t], 0)}>`;
  } else {
    const abc = domain.abcs[traits.abc[t]];
    const id = domain.nameOf(traits.abc[t], abc.instanceName[traits.owner[t]]);
    name = String.UTF8.decodeUnsafe(domain.stringPtr[id], domain.stringLength[id]);
    if (kind === TRAITS_Class) {
      name += "$";
    }
  }

  return name + bang;
}

/**
 * The slot types of the instances of class `cls` of ABC `index`, resolving
 * them if they are not yet: each "abc A class C", or "*"; "none" if it has
 * no such class.
 */
export function domainSlotTypes(index: i32, cls: i32): string {
  if (index < 0 || index >= domain.abcs.length || cls < 0) {
    return "none";
  }

  if (<u32>cls >= domain.abcs[index].classCount) {
    return "none";
  }

  const traits = domain.traits;
  const t = domain.classTraits[domain.classStart[index] + <u32>cls];
  if (t < 0 || traits.resolve(domain, <u32>t) !== 0) {
    return "unresolved";
  }

  const out: string[] = [];
  const start = traits.slotStart[t];
  for (let s: u32 = 0; s < traits.slotCount[t]; s++) {
    const type = traits.slotType[start + s];
    out.push(type < 0 ? "*" : `abc ${traits.abc[type]} class ${traits.owner[type]}`);
  }

  return out.join(", ");
}

/** How many traits the domain has. */
export function domainTraitsCount(): i32 {
  return domain.traits.kind.length;
}

/** The opcode table, one "opcode name layout flags" line per opcode. */
export function opcodeTable(): string {
  const lines: string[] = [];
  for (let op = 0; op < 256; op++) {
    lines.push(`${op} ${opcodeNames[op]} ${opcodeOperands[op]} ${opcodeFlags[op]}`);
  }
  return lines.join("\n");
}

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

// Held in a global so the collector keeps it alive while it is read
// through raw pointers.
let input: StaticArray<u8> = new StaticArray<u8>(0);

/** Copy `bytes` into a buffer followed by PADDING bytes; returns its start. */
function padded(bytes: Uint8Array): usize {
  input = new StaticArray<u8>(bytes.length + PADDING);
  const start = changetype<usize>(input);
  memory.copy(start, bytes.dataStart, bytes.length);
  return start;
}

function hex(kind: u8): string {
  return `0x${kind < 0x10 ? "0" : ""}${kind.toString(16)}`;
}

export {
  actionsEmitEach,
  actionsEmitEachBytes,
  actionsHeldCount,
  actionsHeldEmitEachBytes,
  actionsHeldUnitBytes,
  actionsHold,
  actionsModuleBytes,
  actionsModuleEntries,
  actionsModuleUnits,
  actionsRelease,
  actionsUnitBytes,
  actionsUnitLimits,
} from "./avm1/compile";
export {
  domainAdd,
  domainChild,
  domainCompact,
  domainContext,
  domainDrop,
  domainEmitEach,
  domainEmitEachBytes,
  domainEvict,
  domainFound,
  domainLazyModuleBytes,
  domainLinked,
  domainLogMark,
  domainLogSince,
  domainModule,
  domainModuleBytes,
  domainModuleEntries,
  domainRebuild,
  domainReplay,
  domainReset,
  domainRestore,
  domainRevision,
  domainRevive,
  domainSourceMap,
  domainState,
  domainUsage,
  domainWantsCompact,
} from "./compile";
export { outputLength } from "./output";
