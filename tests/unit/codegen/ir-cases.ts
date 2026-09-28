// Script initializers whose IR ir.test.ts checks.
import { abc, type Body, type Trait, tables, u30 } from "./abc-builder.ts";

// Strings 1 x, 2 "". Namespace 1 public. Multiname 1 public::x.
const pool = {
  strings: ["x", ""],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [[0x07, ...u30(1), ...u30(1)]],
};

export const s24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

/** An ABC whose script initializer has `code`, with the script `traits`. */
export function script(
  code: number[],
  frame: Partial<Body> = {},
  traits: Trait[] = [],
): Uint8Array {
  const body: Body = { method: 0, code, maxStack: 4, localCount: 4, maxScopeDepth: 1, ...frame };
  return abc(pool, tables({ methods: [{}], scripts: [{ init: 0, traits }], bodies: [body] }));
}
