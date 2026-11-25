// Structured method bodies for the verifier, seeds of abc.ts: five bodies an ABC of statements that branch, switch,
// throw and catch, call, construct, get and set properties, push and pop
// scopes and create functions and classes, with handlers over random
// ranges and a few raw mutations, linked after the builtins.
import { abc as abcOf, tables, u30 } from "../unit/codegen/abc-builder.ts";

let s = 1;
function rnd(): number {
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  return s;
}
const below = (n: number) => rnd() % n;
const pick = <T>(a: T[]) => a[below(a.length)];
const s24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];

const strings = [
  "",
  "a",
  "Object",
  "String",
  "int",
  "Array",
  "length",
  "x",
  "Error",
  "trace",
  "Number",
  "push",
  "Boolean",
  "Function",
  "toString",
  "prototype",
];
// multinames: 1..15 QName(public, strings[i]); 16 Multiname(name x, nsset 1); 17 MultinameL(nsset1); 18 RTQName(x); 19 RTQNameL; 20 QNameA
const multinames = [
  ...strings.slice(1).map((_, i) => [0x07, 1, i + 2]),
  [0x09, 8, 1],
  [0x1b, 1],
  [0x0f, 8],
  [0x11],
  [0x0d, 1, 8],
];
const pool = {
  ints: [5, -7],
  doubles: [1.5],
  strings,
  namespaces: [[0x16, 1]],
  nsSets: [[1]],
  multinames,
};
const MN = multinames.length;

type Atom = number[] | { op: number; t: number } | { sw: number[]; d: number };
function genBody(locals: number, nHandlersWanted: number, _isFn: boolean) {
  const n = 4 + below(below(4) === 0 ? 60 : 16);
  const stmts: Atom[][] = [];
  const catchEntries: number[] = [];
  const T = () => below(n + 1);
  const L = () => below(locals + (below(40) === 0 ? 2 : 0));
  const getl = (k: number) => (k < 4 && below(3) ? [0xd0 + k] : [0x62, ...u30(k)]);
  const setl = (k: number) => (k < 4 && below(3) ? [0xd4 + k] : [0x63, ...u30(k)]);
  const mn = () => (below(8) === 0 ? below(MN + 3) : 1 + below(15));
  const value = (): number[] => {
    switch (below(16)) {
      case 0:
        return [0x20];
      case 1:
        return [0x21];
      case 2:
        return [0x26];
      case 3:
        return [0x24, below(256)];
      case 4:
        return [0x28];
      case 5:
        return [0x2c, ...u30(1 + below(15))];
      case 6:
        return [0xd0];
      case 7:
      case 8:
      case 9:
        return getl(L());
      case 10:
        return [0x55, 0];
      case 11:
        return [0x56, 0];
      case 12:
        return [0x40, ...u30(below(8) === 0 ? below(4) : 1)];
      case 13:
        return [0x60, ...u30(mn())];
      case 14:
        return [0x2d, ...u30(1 + below(2))];
      default:
        return [0x2f, 1];
    }
  };
  for (let i = 0; i < n; i++) {
    const st: Atom[] = [];
    if (below(3) === 0) {
      st.push([0x09]);
    }
    switch (below(below(3) ? 30 : 36)) {
      case 0:
      case 1:
      case 2:
      case 3:
        st.push(value(), setl(L()));
        break;
      case 4:
      case 5:
        st.push(
          getl(L()),
          getl(L()),
          [pick([0xa0, 0xa1, 0xa2, 0xa3, 0xad, 0xae, 0xab, 0xac, 0xb4, 0xb3, 0x87])],
          below(2) ? [0x29] : setl(L()),
        );
        break;
      case 6:
      case 7:
        st.push(getl(L()), pick([[0x20], [0x21]]), [0xab], below(2) ? [] : [0x96], {
          op: pick([0x11, 0x12]),
          t: T(),
        });
        break;
      case 8:
        st.push(getl(L()), { op: pick([0x11, 0x12]), t: T() });
        break;
      case 9:
      case 10:
        st.push({ op: 0x10, t: T() });
        break;
      case 11: {
        const c = below(below(5) === 0 ? 40 : 4);
        st.push([0x24, 1], { sw: Array.from({ length: c + 1 }, T), d: T() });
        break;
      }
      case 12:
        st.push(getl(L()), [0x03]);
        break;
      case 13:
        st.push(below(3) ? [0x47] : [...getl(L()), 0x48]);
        break;
      case 14:
        st.push(getl(L()), [below(4) ? 0x30 : 0x1c]);
        break;
      case 15:
        st.push([0x1d]);
        break;
      case 16:
        st.push(getl(L()), [0x66, ...u30(mn())], below(2) ? [0x29] : setl(L()));
        break;
      case 17:
        st.push(getl(L()), getl(L()), [pick([0x61, 0x68]), ...u30(mn())]);
        break;
      case 18:
        st.push([pick([0x5d, 0x5e]), ...u30(mn())], [0x29]);
        break;
      case 19:
        st.push(getl(L()), value(), [0x4f, ...u30(mn()), 1]);
        break;
      case 20:
        st.push(getl(L()), [pick([0x80, 0x86]), ...u30(mn())], setl(L()));
        break;
      case 21:
        st.push(
          getl(L()),
          [
            pick([
              0x73, 0x74, 0x75, 0x76, 0x70, 0x82, 0x85, 0x95, 0x90, 0x91, 0x93, 0x96, 0xc0, 0xc1,
              0x78,
            ]),
          ],
          setl(L()),
        );
        break;
      case 22:
        st.push(getl(L()), pick([[0x20], [0x21]]), {
          op: pick([0x13, 0x14, 0x19, 0x1a, 0x15]),
          t: T(),
        });
        break;
      case 23:
        st.push([0x5a, ...u30(below(3))], below(2) ? [0x29] : [0x2a, 0x30, ...getl(L()), 0x6d, 1]);
        break;
      case 24:
        st.push([pick([0x08, 0x92, 0xc2, 0x94, 0xc3]), ...u30(L())]);
        break;
      case 25:
        st.push([0x32, ...u30(L()), ...u30(L())], { op: 0x11, t: T() });
        break;
      case 26:
        st.push(value());
        break; // leaves a value
      case 27:
        st.push([0x29]);
        break; // pops one
      case 28:
        st.push(getl(L()), [0x2a], { op: 0x11, t: T() }, [0x29]);
        break;
      case 29: {
        const G: [number, number, number, string][] = [
          [0x45, 1, 1, "mn,argc"],
          [0x4e, 1, 0, "mn,argc"],
          [0x49, 1, 0, "argc"],
          [0x6c, 1, 1, "u"],
          [0x6d, 2, 0, "u"],
          [0x44, 1, 1, "method,argc"],
          [0x43, 1, 1, "u,argc"],
          [0x04, 1, 1, "mn"],
          [0x05, 2, 0, "mn"],
          [0x59, 1, 1, "mn"],
          [0x6a, 1, 1, "mn"],
          [0xb4, 2, 1, ""],
          [0xb1, 2, 1, ""],
          [0xb2, 1, 1, "mn"],
          [0xb3, 2, 1, ""],
          [0x86, 1, 1, "mn"],
          [0x87, 2, 1, ""],
          [0x53, 1, 1, "argc"],
          [0x42, 1, 1, "argc"],
          [0x4a, 1, 1, "mn,argc"],
          [0x46, 1, 1, "mn,argc"],
          [0x4c, 1, 1, "mn,argc"],
          [0x41, 2, 1, "argc"],
          [0x6e, 0, 1, "u"],
          [0x6f, 1, 0, "u"],
          [0x1e, 2, 1, ""],
          [0x23, 2, 1, ""],
          [0x1f, 2, 1, ""],
          [0x78, 1, 1, ""],
          [0x71, 1, 1, ""],
          [0x72, 1, 1, ""],
          [0x35, 1, 1, ""],
          [0x3a, 2, 0, ""],
          [0x50, 1, 1, ""],
          [0x06, 0, 0, "u"],
          [0x07, 1, 0, ""],
          [0xf0, 0, 0, "u"],
          [0xf1, 0, 0, "u"],
          [0x25, 0, 1, "u"],
          [0x55, 0, 1, "obj"],
          [0x56, 0, 1, "argc"],
          [0x64, 0, 1, ""],
          [0x5f, 0, 1, "mn"],
          [0x58, 1, 1, "u"],
          [0x2b, 2, 2, ""],
          [0x02, 0, 0, ""],
          [0xa5, 2, 1, ""],
          [0xa8, 2, 1, ""],
          [0xc0, 1, 1, ""],
          [0x97, 1, 1, ""],
          [0x84, 1, 1, ""],
          [0x77, 1, 1, ""],
          [0x89, 1, 1, ""],
          [0x81, 1, 1, ""],
          [0x83, 1, 1, ""],
          [0x88, 1, 1, ""],
          [0x2e, 0, 1, "u"],
          [0x31, 0, 1, "u"],
          [0x01, 0, 0, ""],
          [0x60, 0, 1, "mn"],
          [0x5d, 0, 1, "mn"],
          [0x66, 1, 1, "mn"],
          [0x61, 2, 0, "mn"],
          [0x80, 1, 1, "mn"],
          [0x4f, 1, 0, "mn,argc"],
          [0x0c, 2, 0, "br"],
          [0x17, 2, 0, "br"],
          [0x18, 2, 0, "br"],
          [0x16, 2, 0, "br"],
        ];
        const [op, pops, pushes, kind] = pick(G);
        const argc = below(3);
        const extra = kind.endsWith("argc") ? argc : kind === "obj" ? argc * 2 : 0;
        for (let v = 0; v < pops + extra; v++) {
          st.push(below(2) ? value() : getl(L()));
        }
        if (kind === "br") {
          st.push({ op, t: T() });
          break;
        }
        const ops2 = [op];
        if (kind.startsWith("mn")) {
          ops2.push(...u30(mn()));
        }
        if (kind.startsWith("method")) {
          ops2.push(...u30(below(7)));
        }
        if (kind.startsWith("u")) {
          ops2.push(...u30(below(4)));
        }
        if (kind.endsWith("argc") || kind === "obj") {
          ops2.push(...u30(argc));
        }
        st.push(ops2);
        for (let v = 0; v < pushes; v++) {
          st.push(below(2) ? [0x29] : setl(L()));
        }
        break;
      }
      case 30:
        st.push([
          0xd1,
          0x11,
          6,
          0,
          0,
          0xd0,
          pick([0x30, 0x1c]),
          0x10,
          2,
          0,
          0,
          0xd0,
          pick([0x1c, 0x30]),
          0x1d,
        ]);
        break;
      case 31:
        st.push(
          [0x60, 2, 0x30, 0x60, pick([2, 2, 2, 9, 3]), 0x58, 0, 0x1d],
          below(2) ? [0x29] : [0x68, 1],
        );
        break;
      default:
        st.push(below(2) ? [0x57, 0x2a, 0x30, ...setl(L())] : [0x65, below(3), 0x29]);
        break;
    }
    stmts.push(st);
    if (below(6) === 0 && i + 1 < n) {
      // a catch entry: terminal, then a statement entered with the exception.
      stmts.push([below(2) ? [0x47] : { op: 0x10, t: T() }]);
      catchEntries.push(stmts.length);
      stmts.push([below(4) ? setl(L()) : [0x29]]);
      i += 2;
    }
  }
  stmts.push([[0x47]]);
  // layout
  const size = (a: Atom) =>
    Array.isArray(a) ? a.length : "op" in a ? 4 : 4 + u30(a.sw.length - 1).length + 3 * a.sw.length;
  const at: number[] = [];
  let pos = 0;
  for (const st of stmts) {
    at.push(pos);
    for (const a of st) {
      pos += size(a);
    }
  }
  at.push(pos);
  const where = (t: number) => at[Math.min(t, stmts.length - 1)];
  const code: number[] = [];
  for (const st of stmts) {
    for (const a of st) {
      if (Array.isArray(a)) {
        code.push(...a);
      } else if ("op" in a) {
        code.push(a.op, ...s24(where(a.t) - (code.length + 4)));
      } else {
        const p = code.length;
        code.push(
          0x1b,
          ...s24(where(a.d) - p),
          ...u30(a.sw.length - 1),
          ...a.sw.flatMap((t) => s24(where(t) - p)),
        );
      }
    }
  }
  const exceptions: [number, number, number, number, number][] = [];
  for (let h = 0; h < nHandlersWanted; h++) {
    let a = below(stmts.length),
      b = below(stmts.length);
    if (a > b && below(20)) {
      [a, b] = [b, a];
    }
    const later = catchEntries.filter((c) => c >= b);
    const t = later.length && below(10) ? pick(later) : below(stmts.length);
    exceptions.push([
      where(a),
      where(b) + (below(10) ? 0 : below(3)),
      where(t),
      below(3) ? 0 : pick([3, 4, 9, 1, 2, 17, 30]),
      below(2) ? 0 : pick([8, 1, 17, 16, 20]),
    ]);
  }
  // raw mutations
  if (below(4) === 0) {
    for (let e = 1 + below(3); e > 0; e--) {
      code[below(code.length)] = below(3)
        ? pick([
            0x09, 0x10, 0x11, 0x47, 0x29, 0x2a, 0xd0, 0xd1, 0x30, 0x1d, 0x03, 0, 1, 2, 0xff, 0x80,
            0x1b, 0x24, 0x08,
          ])
        : below(256);
    }
  }
  return { code, exceptions };
}

function genAbc(): Uint8Array {
  const bodies = [];
  for (let m = 0; m < 5; m++) {
    const locals = m === 1 ? 3 + below(4) : 1 + below(6);
    const { code, exceptions } = genBody(locals, below(3) ? below(4) : 0, m === 1);
    bodies.push({
      method: m,
      maxStack: below(12) === 0 ? below(3) : 4 + below(3),
      localCount: below(25) === 0 ? below(3) : locals + (m === 1 ? 0 : 0),
      initScopeDepth: below(20) === 0 ? below(3) : 0,
      maxScopeDepth: below(15) === 0 ? below(3) : 2 + below(4),
      code,
      exceptions,
      traits: below(5) === 0 ? [{ name: 8, kind: 0, id: below(3), index: pick([0, 3, 4, 5]) }] : [],
    });
  }
  const methods = [
    { flags: below(4) === 0 ? pick([0x02, 0x04, 0x01, 0x40]) : 0x02 * below(2) },
    {
      params: [pick([0, 3, 4, 5, 11]), pick([0, 3, 4])],
      ret: pick([0, 3, 5]),
      flags: below(3) === 0 ? pick([0x02, 0x04, 0x01]) : 0,
    },
    { flags: below(2) * 2 },
    { flags: below(6) === 0 ? 2 : 0 },
    { flags: 0 },
    { flags: pick([0, 0x20]) },
    { params: [3], flags: 0 },
  ].slice(0, 5 + (below(10) ? 0 : below(3)));
  const classes = [
    {
      instance: {
        name: 1,
        base: below(8) ? 2 : pick([9, 0, 3]),
        flags: below(10) === 0 ? pick([1, 2, 4]) : 0,
        init: 3,
        traits: [
          { name: 8, kind: 0, id: below(2), index: pick([0, 3, 4, 5]) },
          ...(below(2)
            ? [
                {
                  name: 15,
                  kind: pick([1, 1, 1, 2, 3]),
                  id: 0,
                  index: 2,
                  attr: below(8) ? 0 : pick([0x20, 0x10]),
                },
              ]
            : []),
        ],
      },
      init: 4,
      traits: below(3) === 0 ? [{ name: 7, kind: pick([0, 6]), index: 5 }] : [],
    },
  ];
  return abcOf(
    pool,
    tables({
      methods,
      classes,
      scripts: [
        {
          init: 0,
          traits: [
            { name: 1, kind: 4, index: 0 },
            ...(below(3) === 0 ? [{ name: 8, kind: 0, index: pick([0, 3, 4]) }] : []),
          ],
        },
      ],
      bodies,
    }),
  );
}

/** `count` structured ABCs from `seed`, the same on every host. */
export function structuredAbcs(count: number, seed: number): Uint8Array[] {
  s = seed >>> 0 || 1;
  return Array.from({ length: count }, () => genAbc());
}
