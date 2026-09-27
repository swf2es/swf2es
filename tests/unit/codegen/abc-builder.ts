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
