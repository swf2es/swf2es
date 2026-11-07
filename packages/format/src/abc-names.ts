// The names an ABC refers to, read from its constant pool alone: each
// qualified name, "package::Name" as avmplus writes a definition's (a
// top-level one bare), from the pool's QNames in a package's namespace,
// and from each Multiname, once for every package namespace in its set,
// as a lookup that names the class unqualified finds it in one of them.
// What it may name is enough to tell which libraries a SWF expects, as the
// web element tells an AIR application's SWF from one for the browser.
import { utf8 } from "./display.js";

const CONSTANT_Namespace = 0x08;
const CONSTANT_PackageNamespace = 0x16;
const CONSTANT_QName = 0x07;
const CONSTANT_QNameA = 0x0d;
const CONSTANT_RTQName = 0x0f;
const CONSTANT_RTQNameA = 0x10;
const CONSTANT_RTQNameL = 0x11;
const CONSTANT_RTQNameLA = 0x12;
const CONSTANT_Multiname = 0x09;
const CONSTANT_MultinameA = 0x0e;
const CONSTANT_MultinameL = 0x1b;
const CONSTANT_MultinameLA = 0x1c;
const CONSTANT_TypeName = 0x1d;

/** The qualified names `abc` may refer to; what it cannot read stops the reading, keeping what came before. */
export function abcReferences(abc: Uint8Array): Set<string> {
  const names = new Set<string>();
  let at = 4;
  const u30 = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (at >= abc.length) {
        throw new RangeError("ABC cut short");
      }

      const b = abc[at++];
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        break;
      }
    }

    return value;
  };
  const skipU30s = (count: number) => {
    for (let i = 1; i < count; i++) {
      u30();
    }
  };

  try {
    skipU30s(u30()); // ints
    skipU30s(u30()); // uints
    const doubles = u30();
    at += Math.max(0, doubles - 1) * 8;
    // From 47.16 AIR's ABCs have a pool of 4-byte floats next (codegen's parse.ts).
    const minor = abc[0] | (abc[1] << 8);
    const major = abc[2] | (abc[3] << 8);
    if (major === 47 && minor >= 16) {
      const floats = u30();
      at += Math.max(0, floats - 1) * 4;
    }
    const strings: string[] = [""];
    for (let i = 1, n = u30(); i < n; i++) {
      const length = u30();
      strings.push(utf8(abc.subarray(at, at + length)));
      at += length;
    }

    // A package's namespace by its URI; null for any other kind.
    const namespaces: (string | null)[] = [null];
    for (let i = 1, n = u30(); i < n; i++) {
      const kind = abc[at++];
      const name = strings[u30()] ?? "";
      namespaces.push(
        kind === CONSTANT_PackageNamespace || kind === CONSTANT_Namespace ? name : null,
      );
    }

    const sets: number[][] = [[]];
    for (let i = 1, n = u30(); i < n; i++) {
      const set: number[] = [];
      for (let j = 0, count = u30(); j < count; j++) {
        set.push(u30());
      }

      sets.push(set);
    }

    const add = (ns: string | null | undefined, name: string | undefined) => {
      if (ns !== null && ns !== undefined && name) {
        names.add(ns === "" ? name : `${ns}::${name}`);
      }
    };
    for (let i = 1, n = u30(); i < n; i++) {
      const kind = abc[at++];
      switch (kind) {
        case CONSTANT_QName:
        case CONSTANT_QNameA: {
          const ns = u30();
          add(namespaces[ns], strings[u30()]);
          break;
        }
        case CONSTANT_RTQName:
        case CONSTANT_RTQNameA:
          u30();
          break;
        case CONSTANT_RTQNameL:
        case CONSTANT_RTQNameLA:
          break;
        case CONSTANT_Multiname:
        case CONSTANT_MultinameA: {
          const name = strings[u30()];
          for (const ns of sets[u30()] ?? []) {
            add(namespaces[ns], name);
          }

          break;
        }
        case CONSTANT_MultinameL:
        case CONSTANT_MultinameLA:
          u30();
          break;
        case CONSTANT_TypeName: {
          u30();
          skipU30s(u30() + 1);
          break;
        }
        default:
          // A kind no ABC has: what follows cannot be read.
          return names;
      }
    }
  } catch {
    // Cut short: what was read is what it names.
  }

  return names;
}
