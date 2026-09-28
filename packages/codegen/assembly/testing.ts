// Test-only entry point: exposes the reader to node tests without adding
// exports to codegen.wasm.
import { Abc } from "./abc/abc";
import { BodyDecoder, verifyMethods } from "./abc/code";
import { OP_lookupswitch, opcodeFlags, opcodeNames, opcodeOperands } from "./abc/opcodes";
import { readAbc } from "./abc/parse";
import { readConstantPool } from "./abc/pool";
import { PADDING, Reader } from "./abc/reader";
import { Domain } from "./link/domain";

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
  r.u16();
  r.u16();
  const pool = readConstantPool(r, base);

  let out = "";
  for (let i = 1; i < pool.ints.length; i++) {
    out += `int ${i} ${pool.ints[i]}\n`;
  }
  for (let i = 1; i < pool.uints.length; i++) {
    out += `uint ${i} ${pool.uints[i]}\n`;
  }
  for (let i = 1; i < pool.doubles.length; i++) {
    out += `double ${i} ${pool.doubles[i]}\n`;
  }
  for (let i = 1; i < pool.stringStart.length; i++) {
    const text = String.UTF8.decodeUnsafe(base + pool.stringStart[i], pool.stringLength[i]);
    out += `string ${i} ${text}\n`;
  }
  for (let i = 1; i < pool.nsKind.length; i++) {
    out += `ns ${i} ${hex(pool.nsKind[i])} ${pool.nsName[i]}\n`;
  }
  for (let i: u32 = 1; i < pool.nsSetCount; i++) {
    let members = "";
    for (let j = pool.nsSetStart[i]; j < pool.nsSetStart[i + 1]; j++) {
      members += (members.length ? "," : "") + pool.nsSetMembers[j].toString();
    }
    out += `nsset ${i} ${members}\n`;
  }
  for (let i = 1; i < pool.mnKind.length; i++) {
    out += `mn ${i} ${hex(pool.mnKind[i])} ${pool.mnA[i]} ${pool.mnB[i]}\n`;
  }
  if (pool.error) {
    out += `error ${pool.error}\n`;
  }

  return out;
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

let domain = new Domain();

/** Start a new domain whose user ABCs have API version `apiVersion`. */
export function domainReset(apiVersion: i32): void {
  domain = new Domain();
  domain.apiVersion = <u8>apiVersion;
}

/** Add an ABC to the domain; 0, or the VerifyError it was rejected with. */
export function domainAdd(bytes: Uint8Array, builtin: bool): i32 {
  const buffer = new StaticArray<u8>(bytes.length + PADDING);
  memory.copy(changetype<usize>(buffer), bytes.dataStart, bytes.length);
  return domain.add(buffer, bytes.length, builtin).error;
}

/**
 * The domain's binding of `name` in the namespace of type `type` (NS_*) and
 * URI `uri`, visible at `version`: "abc A script S trait T", or "none".
 */
export function domainFind(type: u8, uri: string, name: string, version: i32): string {
  const uriBytes = String.UTF8.encode(uri);
  const nameBytes = String.UTF8.encode(name);
  const uriId = domain.findString(changetype<usize>(uriBytes), uriBytes.byteLength);
  const nameId = domain.findString(changetype<usize>(nameBytes), nameBytes.byteLength);
  if (uriId < 0 || nameId < 0) {
    return "none";
  }

  const ns = domain.findNamespace(type, uriId);
  const b = ns < 0 ? -1 : domain.find(ns, nameId, <u8>version);
  if (b < 0) {
    return "none";
  }

  return `abc ${domain.bindingAbc[b]} script ${domain.bindingScript[b]} trait ${domain.bindingTrait[b]}`;
}

/** Counts of the domain's tables, then the URIs builtin ABCs version, sorted. */
export function domainSummary(): string {
  const uris: string[] = [];
  for (let i = 0; i < domain.versioned.length; i++) {
    if (domain.versioned[i]) {
      uris.push(String.UTF8.decodeUnsafe(domain.stringPtr[i], domain.stringLength[i]));
    }
  }

  uris.sort();
  return `strings ${domain.stringPtr.length} namespaces ${domain.nsType.length} bindings ${domain.bindingNs.length} versioned ${uris.join(",")}`;
}

/** The domain's bindings in load order: "uri::name version V abc A trait T". */
export function domainBindings(): string {
  const out: string[] = [];
  for (let b = 0; b < domain.bindingNs.length; b++) {
    const uri = domain.nsUri[domain.bindingNs[b]];
    const name = domain.bindingName[b];
    const uriText =
      uri === 0xffffffff
        ? "*"
        : String.UTF8.decodeUnsafe(domain.stringPtr[uri], domain.stringLength[uri]);
    const nameText = String.UTF8.decodeUnsafe(domain.stringPtr[name], domain.stringLength[name]);
    out.push(
      `${uriText}::${nameText} version ${domain.bindingVersion[b]} abc ${domain.bindingAbc[b]} trait ${domain.bindingTrait[b]}`,
    );
  }

  return out.join("\n");
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
 * Verify the script initializers of the domain's last ABC with types, as
 * avmplus does before running each: a line per script, "script S ok" or
 * "script S error N".
 */
export function domainVerifyScripts(): string {
  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
  const out: string[] = [];
  for (let s: u32 = 0; s < abc.scriptCount; s++) {
    const body = abc.methodBody[abc.scriptInit[s]];
    const error = body < 0 ? 0 : decoder.decode(<u32>body).error;
    out.push(`script ${s} ${error ? `error ${error}` : "ok"}`);
  }

  return out.join("\n");
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
