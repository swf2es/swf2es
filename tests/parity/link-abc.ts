// ABCs that link with nothing before them, for the Zig compiler's own tests
// of linking (packages/codegen/zig/src/testing/domain.zig holds their
// bytes, which a unit test checks against these): a builtin one with
// Object, Class and Function, an interface, and classes with slots, a
// constant, methods, accessors and overrides; a user one extending its
// class across ABCs; one that fails to link, extending Class; and a wide
// one, whose strings, namespaces and members each outgrow an id table's
// first 64 slots in the one call that links it.
import { abc, tables, u30 } from "../unit/codegen/abc-builder.ts";
import { classes, GETTER, METHOD, mn, OVERRIDE, SETTER, SLOT } from "../unit/codegen/link-cases.ts";

const INTERFACE = 0x04;
const CONST = 6;
const I_M = mn("n") + 3;

export function linkAbcs(): {
  builtin: Uint8Array;
  user: Uint8Array;
  failing: Uint8Array;
  wide: Uint8Array;
} {
  const builtin = classes([
    { name: mn("Object") },
    { name: mn("Class"), base: mn("Object") },
    { name: mn("Function"), base: mn("Object") },
    { name: mn("I"), flags: INTERFACE, traits: [{ name: I_M, kind: METHOD }] },
    {
      name: mn("A"),
      base: mn("Object"),
      interfaces: [mn("I")],
      traits: [
        { name: mn("x"), kind: SLOT, index: mn("A") },
        { name: mn("F"), kind: CONST, index: mn("Object"), value: 1, valueKind: 0x03 },
        { name: mn("m"), kind: METHOD },
        { name: mn("n"), kind: GETTER },
        { name: mn("n"), kind: SETTER },
      ],
      statics: [{ name: mn("x"), kind: SLOT, index: mn("Object") }],
    },
    {
      name: mn("B"),
      base: mn("A"),
      traits: [
        { name: mn("m"), kind: METHOD, attr: OVERRIDE },
        { name: mn("n"), kind: GETTER, attr: OVERRIDE },
      ],
    },
  ]);
  const user = classes([
    {
      name: mn("Error"),
      base: mn("B"),
      traits: [
        { name: mn("m"), kind: METHOD, attr: OVERRIDE },
        { name: mn("prototype"), kind: SLOT, index: mn("B") },
      ],
    },
  ]);
  const failing = classes([{ name: mn("Missing"), base: mn("Class") }]);
  return { builtin, user, failing, wide: wideAbc(80) };
}

/**
 * A class Wide extending Object with `n` slots, each a name of its own in a
 * package namespace of its own, and a script that defines it and as many
 * slots again.
 */
function wideAbc(n: number): Uint8Array {
  // Strings: 1 "", 2 Object, 3 Wide, then n names and n URIs.
  const strings = ["", "Object", "Wide"];
  for (let i = 0; i < n; i++) {
    strings.push(`w${i}`, `p.w${i}`);
  }

  // Namespaces: 1 public "", then a package namespace per URI.
  const namespaces = [[0x16, ...u30(1)]];
  // Multinames: 1 Object, 2 Wide, then each name in its namespace.
  const multinames = [
    [0x07, ...u30(1), ...u30(2)],
    [0x07, ...u30(1), ...u30(3)],
  ];
  for (let i = 0; i < n; i++) {
    namespaces.push([0x16, ...u30(5 + 2 * i)]);
    multinames.push([0x07, ...u30(2 + i), ...u30(4 + 2 * i)]);
  }

  const slots = (from: number) =>
    Array.from({ length: n }, (_, i) => ({ name: 3 + i, kind: SLOT, id: from + i }));
  return abc(
    { strings, namespaces, multinames },
    tables({
      methods: [{}, {}, {}],
      classes: [{ instance: { name: 2, base: 1, init: 0, traits: slots(1) }, init: 1 }],
      scripts: [{ init: 2, traits: [{ name: 2, kind: 4, id: 1, index: 0 }, ...slots(2)] }],
      bodies: [{ method: 2, code: [0x47] }],
    }),
  );
}
