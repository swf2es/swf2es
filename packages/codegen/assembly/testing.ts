// Test-only entry point: exposes the reader to node tests without adding
// exports to codegen.wasm.
import { Abc } from "./abc/abc";
import { readAbc } from "./abc/parse";
import { readConstantPool } from "./abc/pool";
import { PADDING, Reader } from "./abc/reader";

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
 * tables of a rejected ABC are incomplete.
 */
export function abcDump(bytes: Uint8Array): string {
  const abc = readAbc(padded(bytes), bytes.length);
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
