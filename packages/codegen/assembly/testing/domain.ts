// The test build's look inside a domain, for the node tests: its lookups,
// traits and builtins, each body's verification and IR, and a method as the
// emitter writes it.

import { BodyDecoder, verifyMethods } from "../avm2/abc/code";
import { opcodeNames } from "../avm2/abc/opcodes";
import { MethodEmitter } from "../avm2/emit/method";
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
} from "../avm2/ir/ir";
import {
  TRAITS_Activation,
  TRAITS_Catch,
  TRAITS_Class,
  TRAITS_Instance,
  TRAITS_Null,
  TRAITS_Script,
  TRAITS_Void,
} from "../avm2/link/traits";
import { domain } from "../compile";

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
