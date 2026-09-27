// Builds ABC bytes by hand for parser tests.

/** Variable-length u32: 7 bits per byte, low bits first. */
export function u30(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    const byte = v & 0x7f;
    v >>>= 7;
    bytes.push(v ? byte | 0x80 : byte);
  } while (v);

  return bytes;
}

export function string(text: string): number[] {
  const utf8 = [...new TextEncoder().encode(text)];
  return [...u30(utf8.length), ...utf8];
}

export function double(value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes];
}

export interface Pool {
  ints?: number[];
  uints?: number[];
  doubles?: number[];
  strings?: string[];
  /** Encoded namespace_info entries, e.g. [0x16, ...u30(1)]. */
  namespaces?: number[][];
  /** Namespace indices of each set. */
  nsSets?: number[][];
  /** Encoded multiname_info entries. */
  multinames?: number[][];
}

/** A pool section: count (entries + 1, or 0 when empty), then the entries. */
function section(entries: number[][]): number[] {
  return [...u30(entries.length ? entries.length + 1 : 0), ...entries.flat()];
}

/** An ABC 46.16 block with `pool`, then `rest` (by default a byte, so strings may end). */
export function abc(pool: Pool, rest: number[] = [0]): Uint8Array {
  return new Uint8Array([
    16,
    0,
    46,
    0,
    ...section((pool.ints ?? []).map(u30)),
    ...section((pool.uints ?? []).map(u30)),
    ...section((pool.doubles ?? []).map(double)),
    ...section((pool.strings ?? []).map(string)),
    ...section(pool.namespaces ?? []),
    ...section((pool.nsSets ?? []).map((set) => [...u30(set.length), ...set.flatMap(u30)])),
    ...section(pool.multinames ?? []),
    ...rest,
  ]);
}

export interface Method {
  params?: number[];
  ret?: number;
  name?: number;
  flags?: number;
  /** [value index, value kind] pairs; sets HAS_OPTIONAL. */
  optional?: [number, number][];
  /** Sets HAS_PARAM_NAMES and writes one name per parameter. */
  paramNames?: number[];
}

export interface Trait {
  name: number;
  kind: number;
  attr?: number;
  id?: number;
  /** Type multiname (slots), class index or method index. */
  index?: number;
  value?: number;
  valueKind?: number;
  /** Metadata indices; sets ATTR_Metadata. */
  metadata?: number[];
}

export interface Instance {
  name: number;
  base?: number;
  flags?: number;
  protectedNs?: number;
  interfaces?: number[];
  init: number;
  traits?: Trait[];
}

export interface Body {
  method: number;
  maxStack?: number;
  localCount?: number;
  initScopeDepth?: number;
  maxScopeDepth?: number;
  /** Bytecode; by default a single returnvoid. */
  code?: number[];
  /** [from, to, target, type, name] */
  exceptions?: [number, number, number, number, number][];
  traits?: Trait[];
}

export interface Tables {
  methods?: Method[];
  metadata?: { name: number; items?: [number, number][] }[];
  /** instance_info and class_info, which share one count. */
  classes?: { instance: Instance; init: number; traits?: Trait[] }[];
  scripts?: { init: number; traits?: Trait[] }[];
  bodies?: Body[];
}

const list = <T>(items: T[], encode: (item: T) => number[]): number[] => [
  ...u30(items.length),
  ...items.flatMap(encode),
];

function method(m: Method): number[] {
  const params = m.params ?? [];
  let flags = m.flags ?? 0;
  flags |= m.optional ? 0x08 : 0;
  flags |= m.paramNames ? 0x80 : 0;
  return [
    ...u30(params.length),
    ...u30(m.ret ?? 0),
    ...params.flatMap(u30),
    ...u30(m.name ?? 0),
    flags,
    ...(m.optional ? list(m.optional, ([value, kind]) => [...u30(value), kind]) : []),
    ...(m.paramNames ?? []).flatMap(u30),
  ];
}

function trait(t: Trait): number[] {
  const kind = t.kind | (t.attr ?? 0) | (t.metadata ? 0x40 : 0);
  const slot = t.kind === 0 || t.kind === 6;
  return [
    ...u30(t.name),
    kind,
    ...u30(t.id ?? 0),
    ...u30(t.index ?? 0),
    ...(slot ? u30(t.value ?? 0) : []),
    ...(slot && t.value ? [t.valueKind ?? 0] : []),
    ...(t.metadata ? list(t.metadata, u30) : []),
  ];
}

function instance(i: Instance): number[] {
  const flags = (i.flags ?? 0) | (i.protectedNs !== undefined ? 0x08 : 0);
  return [
    ...u30(i.name),
    ...u30(i.base ?? 0),
    flags,
    ...(i.protectedNs !== undefined ? u30(i.protectedNs) : []),
    ...list(i.interfaces ?? [], u30),
    ...u30(i.init),
    ...list(i.traits ?? [], trait),
  ];
}

function body(b: Body): number[] {
  const code = b.code ?? [0x47];
  return [
    ...u30(b.method),
    ...u30(b.maxStack ?? 1),
    ...u30(b.localCount ?? 1),
    ...u30(b.initScopeDepth ?? 0),
    ...u30(b.maxScopeDepth ?? 1),
    ...u30(code.length),
    ...code,
    ...list(b.exceptions ?? [], (e) => e.flatMap(u30)),
    ...list(b.traits ?? [], trait),
  ];
}

/** Everything after the constant pool. */
export function tables(t: Tables): number[] {
  const classes = t.classes ?? [];
  return [
    ...list(t.methods ?? [], method),
    ...list(t.metadata ?? [], (m) => [
      ...u30(m.name),
      ...list(m.items ?? [], ([k, v]) => [...u30(k), ...u30(v)]),
    ]),
    ...list(classes, (c) => instance(c.instance)),
    ...classes.flatMap((c) => [...u30(c.init), ...list(c.traits ?? [], trait)]),
    ...list(t.scripts ?? [], (s) => [...u30(s.init), ...list(s.traits ?? [], trait)]),
    ...list(t.bodies ?? [], body),
  ];
}
