// An ABC's surface: its scripts, classes, traits and method signatures, as
// a SWF linking against it sees them, without the code. Method bodies are
// only counted, so a library's AS3 can be told from its natives.
//
// The reader trusts its input: it is for libraries such as builtin.abc and
// playerglobal.abc, which avmplus accepts, not for checking malformed ABCs.

export interface Surface {
  version: string;
  scripts: Script[];
  /** Methods with neither a trait nor a class to own them, such as closures. */
  orphans: Method[];
}

export interface Script {
  init: Method;
  traits: Trait[];
}

export interface Class {
  name: string;
  super: string | null;
  flags: string[];
  protectedNs?: string;
  interfaces: string[];
  init: Method;
  instance: Trait[];
  classInit: Method;
  static: Trait[];
}

export type Trait =
  | {
      kind: "slot" | "const";
      name: string;
      slot: number;
      type: string;
      value?: Value;
      meta?: Meta[];
    }
  | { kind: "class"; name: string; slot: number; class: Class; meta?: Meta[] }
  | { kind: "function"; name: string; slot: number; method: Method; meta?: Meta[] }
  | {
      kind: "method" | "getter" | "setter";
      name: string;
      disp: number;
      flags: string[];
      method: Method;
      meta?: Meta[];
    };

export interface Method {
  params: Param[];
  returns: string;
  flags: string[];
  /** Code bytes in the method's body; absent for a native method or a declaration. */
  code?: number;
}

export interface Param {
  type: string;
  name?: string;
  default?: Value;
}

/** A constant: its kind, then its value as the ABC spells it. */
export type Value = [string, string | number | boolean | null];

/** A metadata entry: its name and its [key, value] items, key "" for a bare value. */
export type Meta = [string, [string, string][]];

const NS_KINDS: Record<number, string> = {
  5: "private",
  8: "namespace",
  22: "package",
  23: "internal",
  24: "protected",
  25: "explicit",
  26: "staticprotected",
};

const METHOD_FLAGS: [number, string][] = [
  [0x01, "arguments"],
  [0x02, "activation"],
  [0x04, "rest"],
  [0x10, "ignorerest"],
  [0x20, "native"],
  [0x40, "dxns"],
];

const CLASS_FLAGS: [number, string][] = [
  [0x01, "sealed"],
  [0x02, "final"],
  [0x04, "interface"],
];

const TRAIT_KINDS = ["slot", "method", "getter", "setter", "class", "function", "const"];

interface Pool {
  ints: number[];
  uints: number[];
  doubles: number[];
  strings: string[];
  namespaces: string[];
  nsSets: string[][];
  names: string[];
}

class Reader {
  at = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    return this.bytes[this.at++];
  }

  u16(): number {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }

  u30(): number {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.bytes[this.at++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) {
        break;
      }
    }

    return v >>> 0;
  }

  d64(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }

  utf8(length: number): string {
    const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return s;
  }
}

/** Where the version mark avmplus appends to a builtin namespace's URI begins. */
const MIN_API_MARK = 0xe294;

/** A URI with its version mark, if any, spelt as "uri@v<api>". */
function uri(s: string): string {
  const last = s.codePointAt(s.length - 1) ?? 0;
  if (s.length && last >= MIN_API_MARK && last <= 0xf8ff) {
    return `${s.slice(0, -1)}@v${last - MIN_API_MARK}`;
  }

  return s;
}

function readPool(r: Reader): Pool {
  const count = () => Math.max(r.u30() - 1, 0);
  const ints = [0];
  for (let n = count(); n > 0; n--) {
    ints.push(r.u30() | 0);
  }

  const uints = [0];
  for (let n = count(); n > 0; n--) {
    uints.push(r.u30());
  }

  const doubles = [Number.NaN];
  for (let n = count(); n > 0; n--) {
    doubles.push(r.d64());
  }

  const strings = [""];
  for (let n = count(); n > 0; n--) {
    strings.push(r.utf8(r.u30()));
  }

  // Each private namespace is its own, whatever its name: number them.
  const namespaces = ["*"];
  let privates = 0;
  for (let n = count(); n > 0; n--) {
    const kind = r.u8();
    const name = uri(strings[r.u30()]);
    const k = NS_KINDS[kind] ?? `ns${kind}`;
    namespaces.push(kind === 0x05 ? `private#${privates++}` : `${k}:${name}`);
  }

  const nsSets: string[][] = [[]];
  for (let n = count(); n > 0; n--) {
    const set: string[] = [];
    for (let m = r.u30(); m > 0; m--) {
      set.push(namespaces[r.u30()]);
    }

    nsSets.push(set);
  }

  const names = ["*"];
  for (let n = count(); n > 0; n--) {
    names.push(readName(r, strings, namespaces, nsSets));
  }

  return { ints, uints, doubles, strings, namespaces, nsSets, names };
}

function readName(r: Reader, strings: string[], namespaces: string[], nsSets: string[][]): string {
  const kind = r.u8();
  switch (kind) {
    case 0x07:
    case 0x0d: {
      const ns = namespaces[r.u30()];
      return qualified(ns, strings[r.u30()]);
    }
    case 0x0f:
    case 0x10:
      return `(rt)::${strings[r.u30()]}`;
    case 0x11:
    case 0x12:
      return "(rt)::(late)";
    case 0x09:
    case 0x0e: {
      const name = strings[r.u30()];
      return `{${nsSets[r.u30()].join(",")}}::${name}`;
    }
    case 0x1b:
    case 0x1c:
      return `{${nsSets[r.u30()].join(",")}}::(late)`;
    case 0x1d: {
      const base = r.u30();
      const params: number[] = [];
      for (let n = r.u30(); n > 0; n--) {
        params.push(r.u30());
      }

      // A type name may name a later entry: resolve it once the pool is read.
      return `${base}.<${params.join(",")}>`;
    }
    default:
      throw new Error(`multiname kind ${kind} at ${r.at - 1}`);
  }
}

/**
 * A QName as a type is written: "Array" or "flash.utils::ByteArray" in a
 * public namespace without a version mark, else "{ns}::name" as a
 * multiname with its one namespace.
 */
function qualified(ns: string, name: string): string {
  if (ns.startsWith("package:") && !ns.includes("@v")) {
    const pkg = ns.slice("package:".length);
    return pkg ? `${pkg}::${name}` : name;
  }

  return `{${ns}}::${name}`;
}

/** The pool's type names, read as indices, written out by name. */
function resolveTypeNames(pool: Pool): void {
  for (let i = 0; i < pool.names.length; i++) {
    const m = pool.names[i].match(/^(\d+)\.<([\d,]*)>$/);
    if (m) {
      const params = m[2] ? m[2].split(",").map((p) => pool.names[Number(p)]) : [];
      pool.names[i] = `${pool.names[Number(m[1])]}.<${params.join(",")}>`;
    }
  }
}

function value(pool: Pool, index: number, kind: number): Value {
  switch (kind) {
    case 0x00:
      return ["undefined", null];
    case 0x01:
      return ["string", pool.strings[index]];
    case 0x03:
      return ["int", pool.ints[index]];
    case 0x04:
      return ["uint", pool.uints[index]];
    case 0x06: {
      const d = pool.doubles[index];
      // JSON has no NaN or infinities, and -0 would print as 0.
      const finite = Number.isFinite(d) && !Object.is(d, -0);
      return ["double", finite ? d : String(d === 0 ? "-0" : d)];
    }
    case 0x0a:
      return ["boolean", false];
    case 0x0b:
      return ["boolean", true];
    case 0x0c:
      return ["null", null];
    default:
      return ["namespace", pool.namespaces[index]];
  }
}

function flags(bits: number, table: [number, string][]): string[] {
  return table.filter(([bit]) => bits & bit).map(([, name]) => name);
}

/** The surface of the ABC `bytes`. */
export function readSurface(bytes: Uint8Array): Surface {
  const r = new Reader(bytes);
  const minor = r.u16();
  const major = r.u16();
  const pool = readPool(r);
  resolveTypeNames(pool);

  const typeName = (i: number) => pool.names[i];

  const methods: Method[] = [];
  for (let n = r.u30(); n > 0; n--) {
    const count = r.u30();
    const returns = typeName(r.u30());
    const params: Param[] = [];
    for (let i = 0; i < count; i++) {
      params.push({ type: typeName(r.u30()) });
    }

    r.u30(); // The method's name, which nothing linking against it sees.
    const bits = r.u8();
    if (bits & 0x08) {
      const optional = r.u30();
      for (let i = count - optional; i < count; i++) {
        const index = r.u30();
        params[i].default = value(pool, index, r.u8());
      }
    }

    if (bits & 0x80) {
      for (const p of params) {
        p.name = pool.strings[r.u30()];
      }
    }

    methods.push({ params, returns, flags: flags(bits, METHOD_FLAGS) });
  }

  const metadata: Meta[] = [];
  for (let n = r.u30(); n > 0; n--) {
    const name = pool.strings[r.u30()];
    const count = r.u30();
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
      keys.push(pool.strings[r.u30()]);
    }

    const items: [string, string][] = keys.map((k) => [k, pool.strings[r.u30()]]);
    metadata.push([name, items]);
  }

  const used = new Set<number>();
  const method = (i: number): Method => {
    used.add(i);
    return methods[i];
  };

  // Classes refer to one another through class traits, so read their traits
  // as indices first and build the tree once the scripts are read.
  type RawTrait = {
    name: string;
    kind: number;
    attrs: number;
    a: number;
    b: number;
    c: number;
    d: number;
    meta: number[];
  };
  const readTraits = (): RawTrait[] => {
    const traits: RawTrait[] = [];
    for (let n = r.u30(); n > 0; n--) {
      const name = pool.names[r.u30()];
      const tag = r.u8();
      const kind = tag & 0x0f;
      const t: RawTrait = {
        name,
        kind,
        attrs: tag >> 4,
        a: r.u30(),
        b: r.u30(),
        c: 0,
        d: 0,
        meta: [],
      };
      if (kind === 0 || kind === 6) {
        t.c = r.u30();
        if (t.c) {
          t.d = r.u8();
        }
      }

      if (tag & 0x40) {
        for (let m = r.u30(); m > 0; m--) {
          t.meta.push(r.u30());
        }
      }

      traits.push(t);
    }

    return traits;
  };

  const classCount = r.u30();
  const instances: {
    name: string;
    super: string | null;
    flags: string[];
    protectedNs?: string;
    interfaces: string[];
    init: number;
    traits: RawTrait[];
  }[] = [];
  for (let i = 0; i < classCount; i++) {
    const name = pool.names[r.u30()];
    const sup = r.u30();
    const bits = r.u8();
    const protectedNs = bits & 0x08 ? pool.namespaces[r.u30()] : undefined;
    const interfaces: string[] = [];
    for (let n = r.u30(); n > 0; n--) {
      interfaces.push(pool.names[r.u30()]);
    }

    const init = r.u30();
    instances.push({
      name,
      super: sup ? pool.names[sup] : null,
      flags: flags(bits, CLASS_FLAGS),
      protectedNs,
      interfaces,
      init,
      traits: readTraits(),
    });
  }

  const statics: { init: number; traits: RawTrait[] }[] = [];
  for (let i = 0; i < classCount; i++) {
    statics.push({ init: r.u30(), traits: readTraits() });
  }

  const rawScripts: { init: number; traits: RawTrait[] }[] = [];
  for (let n = r.u30(); n > 0; n--) {
    rawScripts.push({ init: r.u30(), traits: readTraits() });
  }

  for (let n = r.u30(); n > 0; n--) {
    const m = r.u30();
    r.u30(); // max_stack
    r.u30(); // local_count
    r.u30(); // init_scope_depth
    r.u30(); // max_scope_depth
    const length = r.u30();
    r.at += length;
    for (let e = r.u30(); e > 0; e--) {
      r.u30();
      r.u30();
      r.u30();
      r.u30();
      r.u30();
    }

    readTraits(); // An activation's traits, inside the method.
    methods[m] = { ...methods[m], code: length };
  }

  const meta = (indices: number[]): Meta[] | undefined =>
    indices.length ? indices.map((i) => metadata[i]) : undefined;

  const buildClass = (i: number): Class => {
    const inst = instances[i];
    return {
      name: inst.name,
      super: inst.super,
      flags: inst.flags,
      ...(inst.protectedNs ? { protectedNs: inst.protectedNs } : {}),
      interfaces: inst.interfaces,
      init: method(inst.init),
      instance: inst.traits.map(build),
      classInit: method(statics[i].init),
      static: statics[i].traits.map(build),
    };
  };

  function build(t: RawTrait): Trait {
    const m = meta(t.meta);
    const withMeta = m ? { meta: m } : {};
    switch (t.kind) {
      case 0:
      case 6:
        return {
          kind: t.kind === 0 ? "slot" : "const",
          name: t.name,
          slot: t.a,
          type: typeName(t.b),
          ...(t.c ? { value: value(pool, t.c, t.d) } : {}),
          ...withMeta,
        };
      case 4:
        return { kind: "class", name: t.name, slot: t.a, class: buildClass(t.b), ...withMeta };
      case 5:
        return { kind: "function", name: t.name, slot: t.a, method: method(t.b), ...withMeta };
      default:
        return {
          kind: TRAIT_KINDS[t.kind] as "method" | "getter" | "setter",
          name: t.name,
          disp: t.a,
          flags: flags(t.attrs, [
            [0x1, "final"],
            [0x2, "override"],
          ]),
          method: method(t.b),
          ...withMeta,
        };
    }
  }

  const scripts = rawScripts.map((s) => ({ init: method(s.init), traits: s.traits.map(build) }));

  const orphans = methods.filter((_, i) => !used.has(i));
  return { version: `${major}.${minor}`, scripts, orphans };
}
