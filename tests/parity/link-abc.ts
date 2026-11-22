// ABCs that link with nothing before them, for the Zig compiler's own tests
// of linking (packages/codegen/zig/src/testing/domain.zig holds their
// bytes, which a unit test checks against these): a builtin one with
// Object, Class and Function, an interface, and classes with slots, a
// constant, methods, accessors and overrides; a user one extending its
// class across ABCs; and one that fails to link, extending Class.
import { classes, GETTER, METHOD, mn, OVERRIDE, SETTER, SLOT } from "../unit/codegen/link-cases.ts";

const INTERFACE = 0x04;
const CONST = 6;
const I_M = mn("n") + 3;

export function linkAbcs(): { builtin: Uint8Array; user: Uint8Array; failing: Uint8Array } {
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
  return { builtin, user, failing };
}
