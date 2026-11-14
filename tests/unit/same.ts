// assert.equal for tests that compare display objects, or anything that
// reaches one: a failure names the two instead of printing them. Node's
// AssertionError prints both values in full, to any depth and every array
// element, and a display object reaches its whole tree, bitmaps' pixels and
// all: one failed comparison then ran a test process into tens of gigabytes.
import assert from "node:assert/strict";

/** What a failure shows of a value: a primitive as it is, an object by its class and name. */
function named(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return String(value);
  }

  // A display object by its name and serial, an AS3 object by its display object's.
  const display = (value as { $display?: object }).$display;
  const of = (d: object) => {
    const { name, serial } = d as { name?: unknown; serial?: unknown };
    const parts = typeof name === "string" && name !== "" ? [`"${name}"`] : [];
    if (serial !== undefined) {
      parts.push(`#${String(serial)}`);
    }

    return parts.join(" ");
  };
  const shown = display ? `of ${display.constructor?.name} ${of(display)}` : of(value);
  return `${value.constructor?.name ?? "Object"} ${shown}`.trim();
}

/** Whether `actual` is `expected` (Object.is, as assert.equal compares), named, not printed, if not. */
export function equal(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    assert.fail(message ?? `expected ${named(expected)}, got ${named(actual)}`);
  }
}
