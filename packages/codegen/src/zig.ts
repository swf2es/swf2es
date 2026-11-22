/**
 * The compiler in Zig (packages/codegen/zig, docs/zig-codegen.md) behind
 * the same object asc's glue gives for codegen.wasm, export for export, so
 * that createCodegen runs over either.
 *
 * Zig's module takes bytes, not managed objects: every call starts with
 * the module's `input`, which gives room for its arrays and strings, staged
 * there and each passed as its address and length; what a call hands
 * out is an address, `outputLength` bytes, valid until the next call
 * starts. A call that ran out of memory hands out nothing and says so in
 * `codegenError`, and is thrown here, as asc's trap would be. A panic, a
 * failed safety check of the ReleaseSafe build, is the module's one import,
 * env.abort, and any other trap are thrown as a CodegenPanic, after which
 * the instance is dead and every call throws one, for the wrapper to start
 * another.
 *
 * An export the module does not have yet, as the port goes on stage by
 * stage, throws when called.
 */
import type { instantiate as instantiateAs } from "./codegen.js";

/** codegen.wasm's exports as asc's glue gives them. */
export type CodegenExports = Awaited<ReturnType<typeof instantiateAs>>;

/** What asc's runtime exports beside the compiler's, which Zig's module has no use for. */
type Runtime = "memory" | "__new" | "__pin" | "__unpin" | "__collect" | "__rtti_base";

/**
 * An export's parameters, as asc's glue takes them, and its result.
 * Parameters are space-separated: `u8s` a Uint8Array, `i32s` an
 * Int32Array, `str` a string, each staged; `i32` and `bool` passed as they
 * are; `=value` a default, as the AssemblyScript function declares it.
 * Results: `str` UTF-8 handed out, decoded as AssemblyScript decodes it;
 * `address` an address handed out, as the *Bytes exports return it;
 * `f64x2` two doubles at an address; `f64s` doubles handed out, as many as
 * `outputLength` bytes hold.
 */
export type Signature = readonly [
  string,
  "void" | "i32" | "bool" | "str" | "address" | "f64x2" | "f64s",
];

/** Every export of codegen.wasm's, by its AssemblyScript signature. */
export const SIGNATURES: { readonly [name in Exclude<keyof CodegenExports, Runtime>]: Signature } =
  {
    compilerVersion: ["", "str"],
    abcVersion: ["u8s", "i32"],
    actionsEmitEach: ["u8s i32s i32s i32 str bool", "str"],
    actionsEmitEachBytes: ["u8s i32s i32s i32 str bool", "address"],
    actionsHeldCount: ["", "i32"],
    actionsHeldEmitEachBytes: ["i32 i32 str", "address"],
    actionsHeldUnitBytes: ["i32 i32 i32 i32 i32 bool", "address"],
    actionsHold: ["i32 u8s i32s i32s", "void"],
    actionsModuleBytes: ["u8s i32s i32s i32 bool=false", "address"],
    actionsModuleEntries: ["", "str"],
    actionsModuleUnits: ["", "str"],
    actionsRelease: ["i32", "void"],
    actionsUnitBytes: ["u8s i32s i32s i32 i32 i32 i32 bool", "address"],
    actionsUnitLimits: ["", "f64x2"],
    domainAdd: ["u8s bool i32=0", "i32"],
    domainChild: ["i32", "i32"],
    domainCompact: ["bool=false", "bool"],
    domainContext: ["i32=-1 i32=0 i32=-1", "str"],
    domainDrop: ["i32", "void"],
    domainEvict: ["i32", "void"],
    domainFound: ["i32 i32 str str i32 bool", "void"],
    domainKeyFork: ["i32", "i32"],
    domainKeyHeaderBytes: ["i32=-1", "address"],
    domainKeyLogBytes: ["i32 i32 i32 i32 i32 i32", "address"],
    domainLinked: ["i32=-1", "str"],
    domainLoad: ["u8s", "bool"],
    domainLoadAbc: ["i32 u8s", "i32"],
    domainLoadRebuild: ["", "bool"],
    domainLogMark: ["", "i32"],
    domainLogSince: ["i32 i32=-1", "str"],
    domainModule: ["str= i32=-1 bool=true bool=false", "str"],
    domainModuleBytes: ["str= i32=-1 bool=true bool=false", "address"],
    domainModuleDone: ["", "bool"],
    domainModuleEntries: ["", "str"],
    domainModuleMoreBytes: ["", "address"],
    domainParent: ["i32", "i32"],
    domainRebuildStep: ["", "i32"],
    domainReplay: ["str i32=-1", "bool"],
    domainReset: ["i32", "void"],
    domainRestore: ["i32 u8s", "i32"],
    domainRevision: ["", "str"],
    domainRevive: ["i32 bool=false", "i32"],
    domainSaveBytes: ["", "address"],
    domainSavedAbcBytes: ["i32", "address"],
    domainSourceMap: ["", "str"],
    domainState: ["i32", "i32"],
    domainUsage: ["", "str"],
    domainWantsCompact: ["i32=0", "bool"],
    outputLength: ["", "i32"],
  };

/** Additional exports for the host's recovery journal. */
export interface RecoveryExports extends CodegenExports {
  journalBytes(mark: number): number;
  replayEntry(kind: number, index: number, a: number, b: number): boolean;
  abandonRebuild(): void;
  loadCheckpointState(words: Uint8Array): boolean;
}

const ZIG_SIGNATURES: Record<string, Signature> = {
  ...SIGNATURES,
  journalBytes: ["i32", "address"],
  replayEntry: ["i32 i32 i32 i32", "bool"],
  abandonRebuild: ["", "void"],
  loadCheckpointState: ["u8s", "bool"],
};

/** An allocation refused by the compiler leaves it usable. */
export class CodegenOutOfMemory extends Error {}

/** A panic in the Zig module: a safety check failed, and the instance is dead. */
export class CodegenPanic extends Error {
  override name = "CodegenPanic";
}

/** The module's own exports: numbers in, numbers out. */
interface Raw {
  memory: WebAssembly.Memory;
  input(size: number): number;
  codegenError(): number;
  outputLength(): number;
  [name: string]: unknown;
}

type Kind = "u8s" | "i32s" | "str" | "i32" | "bool";

interface Parameter {
  kind: Kind;
  fallback?: number | boolean | string;
}

function parameters(spec: string): Parameter[] {
  return spec
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      const [kind, value] = token.split("=") as [Kind, string | undefined];
      if (value === undefined) {
        return { kind };
      }

      switch (kind) {
        case "bool":
          return { kind, fallback: value === "true" };
        case "i32":
          return { kind, fallback: Number(value) };
        default:
          return { kind, fallback: value };
      }
    });
}

const align8 = (n: number) => (n + 7) & ~7;

/**
 * The exports that read what the last call left rather than start one, as
 * asc's do: the call's output stays readable after them (a unit's limits,
 * read after its code, the held SWFs counted or one let go).
 */
const READS_LAST_CALL = new Set([
  "outputLength",
  "codegenError",
  "actionsUnitLimits",
  "actionsHeldCount",
  "actionsRelease",
  "abandonRebuild",
]);

/**
 * The exports of a Zig build of the compiler, instantiated from `module`,
 * as asc's glue would give them: `signatures` names them, and the test
 * build's add theirs, with those of theirs that read what the last call
 * left rather than start a call (`readsLastCall`).
 */
export async function bind<T>(
  module: WebAssembly.Module,
  signatures: { readonly [name: string]: Signature },
  readsLastCall: readonly string[] = [],
): Promise<T & { panicked(): string | null }> {
  const state = panicState();
  const instance = await WebAssembly.instantiate(module, state.imports);
  return bindInstance<T>(instance, state, signatures, readsLastCall);
}

/** A panic with no compaction spare ready can instantiate the already compiled module synchronously. */
export function recoveryInstance(module: WebAssembly.Module): CodegenExports {
  const state = panicState();
  const instance = new WebAssembly.Instance(module, state.imports);
  return bindInstance<RecoveryExports>(instance, state, ZIG_SIGNATURES, []);
}

function panicState() {
  const state = {
    panic: null as string | null,
    raw: null as Raw | null,
    imports: {
      env: {
        abort(message: number, length: number) {
          state.panic = state.raw
            ? fromUtf8(new Uint8Array(state.raw.memory.buffer, message >>> 0, length))
            : "panic";
          throw new CodegenPanic(`codegen-zig.wasm: ${state.panic}`);
        },
      },
    },
  };
  return state;
}

function bindInstance<T>(
  instance: WebAssembly.Instance,
  state: ReturnType<typeof panicState>,
  signatures: { readonly [name: string]: Signature },
  readsLastCall: readonly string[],
) {
  const exports = instance.exports as unknown as Raw;
  state.raw = exports;
  const alive = () => {
    if (state.panic !== null) {
      throw new CodegenPanic(
        `codegen-zig.wasm panicked earlier (${state.panic}): make another instance`,
      );
    }
  };
  // Addresses are u32, which wasm hands JavaScript as i32: negative past 2 GiB.
  const handed = (address: number) =>
    fromUtf8(new Uint8Array(exports.memory.buffer, address >>> 0, exports.outputLength()));
  // Any trap but a panic, too: a stack overflow, the engine's call stack
  // exhausted. It leaves the instance as a panic does, its shadow stack's
  // pointer where the trap left it and its call half done.
  const guarded = <R>(run: () => R): R => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof CodegenPanic)) {
        state.panic = `trap: ${error instanceof Error ? error.message : String(error)}`;
        throw new CodegenPanic(`codegen-zig.wasm: ${state.panic}`);
      }

      throw error;
    }
  };

  const bound: Record<string, unknown> = {
    get memory() {
      return exports.memory;
    },
    // Each call's arena is given back as the next starts: nothing to collect.
    __collect() {},
    panicked: () => state.panic,
  };
  for (const [name, [spec, result]] of Object.entries(signatures)) {
    const call = exports[name] as ((...args: number[]) => number) | undefined;
    if (typeof call !== "function") {
      bound[name] = () => {
        throw new Error(
          `codegen-zig.wasm has no ${name} yet: the Zig compiler is not ported so far`,
        );
      };
      continue;
    }

    const params = parameters(spec);
    // These read the last call, and start none (see root.zig).
    const starts = !READS_LAST_CALL.has(name) && !readsLastCall.includes(name);
    bound[name] = (...args: unknown[]) => {
      alive();
      // A default where the argument is left out, as asc's glue passes arguments.length.
      const values = params.map((p, i) => (i < args.length ? args[i] : p.fallback));
      const parts = values.map((value, i) => {
        const kind = params[i].kind;
        if (kind === "i32" || kind === "bool") {
          return null;
        }

        if (value === null || value === undefined) {
          throw new TypeError(`${name}: argument ${i} must not be null`);
        }

        if (kind === "str") {
          return toUtf8(value as string);
        }

        const items = value as Uint8Array | Int32Array;
        const bytes = new Uint8Array(items.buffer, items.byteOffset, items.byteLength);
        // A view of the module's own memory, which input may give back or grow away.
        return items.buffer === exports.memory.buffer ? bytes.slice() : bytes;
      });
      let size = 0;
      for (const part of parts) {
        size = part ? align8(size) + part.length : size;
      }

      const flat: number[] = [];
      // Only the module's own code is guarded: running out of memory is a
      // plain Error, which leaves the instance as usable as asc's left it.
      if (starts) {
        const base = guarded(() => exports.input(size)) >>> 0;
        if (base === 0) {
          throw new CodegenOutOfMemory(`codegen-zig.wasm: ${name} ran out of memory`);
        }

        // Read after input, which may have grown memory.
        const memory = new Uint8Array(exports.memory.buffer);
        let at = 0;
        for (const [i, part] of parts.entries()) {
          if (part === null) {
            flat.push(Number(values[i]));
            continue;
          }

          at = align8(at);
          memory.set(part, base + at);
          flat.push(base + at, params[i].kind === "i32s" ? part.length / 4 : part.length);
          at += part.length;
        }
      } else {
        flat.push(...values.map(Number));
      }

      const value = guarded(() => call(...flat));
      if (starts && exports.codegenError() !== 0) {
        throw new CodegenOutOfMemory(`codegen-zig.wasm: ${name} ran out of memory`);
      }

      switch (result) {
        case "void":
          return undefined;
        case "bool":
          return value !== 0;
        case "str":
          return handed(value);
        case "address":
          return value >>> 0;
        case "f64x2":
          return new Float64Array(exports.memory.buffer, value >>> 0, 2).slice();
        case "f64s":
          return new Float64Array(
            exports.memory.buffer,
            value >>> 0,
            exports.outputLength() / 8,
          ).slice();
        default:
          return value;
      }
    };
  }

  return bound as T & { panicked(): string | null };
}

/**
 * Zig's compiler as asc's glue gives codegen.wasm, for createCodegen: the
 * same signature as the glue's instantiate, whose imports it has no use for.
 */
export async function instantiate(
  module: WebAssembly.Module,
  _imports: object = {},
): Promise<CodegenExports & { panicked(): string | null }> {
  return bind<RecoveryExports>(module, ZIG_SIGNATURES);
}

/**
 * A string as AssemblyScript's String.UTF8.encode writes it, as the
 * compiler took a string in: WTF-8, a lone surrogate as three bytes, where
 * TextEncoder writes U+FFFD.
 */
export function toUtf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[at++] = c;
      continue;
    }

    if (c < 0x800) {
      out[at++] = (c >> 6) | 0xc0;
      out[at++] = (c & 63) | 0x80;
      continue;
    }

    if ((c & 0xfc00) === 0xd800 && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if ((next & 0xfc00) === 0xdc00) {
        c = 0x10000 + ((c & 0x3ff) << 10) + (next & 0x3ff);
        out[at++] = (c >> 18) | 0xf0;
        out[at++] = ((c >> 12) & 63) | 0x80;
        out[at++] = ((c >> 6) & 63) | 0x80;
        out[at++] = (c & 63) | 0x80;
        i++;
        continue;
      }
    }

    out[at++] = (c >> 12) | 0xe0;
    out[at++] = ((c >> 6) & 63) | 0x80;
    out[at++] = (c & 63) | 0x80;
  }

  return out.subarray(0, at);
}

/**
 * Bytes as AssemblyScript's String.UTF8.decodeUnsafe reads them, as the
 * compiler made a string of an ABC's bytes: valid UTF-8 as TextDecoder
 * reads it, and anything else as AssemblyScript does, which checks nothing,
 * keeps what an invalid sequence's bits say and drops a sequence cut short
 * at the end, where TextDecoder writes U+FFFD.
 */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    // Not valid UTF-8: read below.
  }

  const units: number[] = [];
  let at = 0;
  while (at < bytes.length) {
    let u0 = bytes[at++];
    if (!(u0 & 128)) {
      units.push(u0);
      continue;
    }

    if (at === bytes.length) {
      break;
    }

    const u1 = bytes[at++] & 63;
    if ((u0 & 224) === 192) {
      units.push(((u0 & 31) << 6) | u1);
      continue;
    }

    if (at === bytes.length) {
      break;
    }

    const u2 = bytes[at++] & 63;
    if ((u0 & 240) === 224) {
      u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
    } else {
      if (at === bytes.length) {
        break;
      }

      u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (bytes[at++] & 63);
    }

    if (u0 < 0x10000) {
      units.push(u0);
    } else {
      // A surrogate pair, past U+10FFFF too, up to 0x1FFFFF.
      units.push(((u0 - 0x10000) >> 10) | 0xd800, ((u0 - 0x10000) & 0x3ff) | 0xdc00);
    }
  }

  let text = "";
  for (let i = 0; i < units.length; i += 8192) {
    text += String.fromCharCode(...units.slice(i, i + 8192));
  }

  return text;
}

// TextDecoder is the web's and node's alike, though not ECMAScript's,
// whose library alone the compiler's wrapper is typed against.
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean; ignoreBOM: boolean },
) => { decode(bytes: Uint8Array): string };

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
