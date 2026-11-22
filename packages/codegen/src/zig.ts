/**
 * The compiler in Zig (packages/codegen/zig, docs/zig-codegen.md) behind
 * the same object asc's glue gives for codegen.wasm, export for export, so
 * that createCodegen runs over either.
 *
 * Zig's module takes bytes, not managed objects: a call's arrays and
 * strings are staged in room the module's `input` gives, which starts the
 * call, and each is passed as its address and length; what a call hands
 * out is an address, `outputLength` bytes, valid until the next call
 * starts. A call that ran out of memory hands out nothing and says so in
 * `codegenError`, and is thrown here, as asc's trap would be. A panic, a
 * failed safety check of the ReleaseSafe build, is the module's one import,
 * env.abort: thrown as a CodegenPanic, after which the instance is dead and
 * every call throws one, for the wrapper to start another.
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
 * `f64x2` two doubles at an address.
 */
export type Signature = readonly [string, "void" | "i32" | "bool" | "str" | "address" | "f64x2"];

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
 * The exports of a Zig build of the compiler, instantiated from `module`,
 * as asc's glue would give them: `signatures` names them, and the test
 * build's add theirs.
 */
export async function bind<T>(
  module: WebAssembly.Module,
  signatures: { readonly [name: string]: Signature },
): Promise<T & { panicked(): string | null }> {
  let panic: string | null = null;
  let raw: Raw | null = null;
  const instance = await WebAssembly.instantiate(module, {
    env: {
      abort(message: number, length: number) {
        panic = raw ? fromUtf8(new Uint8Array(raw.memory.buffer, message, length)) : "panic";
        throw new CodegenPanic(`codegen-zig.wasm: ${panic}`);
      },
    },
  });
  raw = instance.exports as unknown as Raw;
  const exports = raw;
  const alive = () => {
    if (panic !== null) {
      throw new CodegenPanic(`codegen-zig.wasm panicked earlier (${panic}): make another instance`);
    }
  };
  const handed = (address: number) =>
    fromUtf8(new Uint8Array(exports.memory.buffer, address, exports.outputLength()));

  const bound: Record<string, unknown> = {
    get memory() {
      return exports.memory;
    },
    // Each call's arena is given back as the next starts: nothing to collect.
    __collect() {},
    panicked: () => panic,
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
    const staged = params.some((p) => p.kind === "u8s" || p.kind === "i32s" || p.kind === "str");
    bound[name] = (...args: unknown[]) => {
      alive();
      const values = params.map((p, i) => (args[i] === undefined ? p.fallback : args[i]));
      const flat: number[] = [];
      if (staged) {
        const parts = values.map((value, i) => {
          switch (params[i].kind) {
            case "u8s":
              return value as Uint8Array;
            case "i32s": {
              const items = value as Int32Array;
              return new Uint8Array(items.buffer, items.byteOffset, items.byteLength);
            }
            case "str":
              return toUtf8(value as string);
            default:
              return null;
          }
        });
        let size = 0;
        for (const part of parts) {
          size = part ? align8(size) + part.length : size;
        }

        const base = exports.input(size);
        if (base === 0) {
          throw new Error(`codegen-zig.wasm: ${name} ran out of memory`);
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
        for (const value of values) {
          flat.push(Number(value));
        }
      }

      const value = call(...flat);
      if (exports.codegenError() !== 0) {
        throw new Error(`codegen-zig.wasm: ${name} ran out of memory`);
      }

      switch (result) {
        case "void":
          return undefined;
        case "bool":
          return value !== 0;
        case "str":
          return handed(value);
        case "f64x2":
          return new Float64Array(exports.memory.buffer, value, 2).slice();
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
  return bind<CodegenExports>(module, SIGNATURES);
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
