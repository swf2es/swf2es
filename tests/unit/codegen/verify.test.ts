import assert from "node:assert/strict";
import { test } from "node:test";
import { abc, tables, u30 } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";
import { verifyCases } from "./verify-cases.ts";

/** The first error swf2es' decoder reports for any body, or undefined. */
function verify(abc: Uint8Array): number | undefined {
  const error = (testing.codeDump(abc) as string)
    .split("\n")
    .find((l) => l.trim().startsWith("error"));
  return error ? Number(error.trim().split(" ")[1]) : undefined;
}

for (const c of verifyCases) {
  test(c.name, () => {
    assert.equal(verify(c.abc), c.error);
  });
}

// The arguments a failing method's factory gives its VerifyError, as
// avmplus' Verifier.cpp passes them to its message. avmshell, a release
// build, prints no messages, so this is where they are held.

/** An ABC whose script has function `name`, of `code`, or without a body for null. */
function scriptFunction(code: number[] | null, name = "f"): Uint8Array {
  return abc(
    {
      strings: ["", name],
      namespaces: [[0x16, ...u30(1)]],
      multinames: [[0x07, ...u30(1), ...u30(2)]],
    },
    tables({
      methods: [{}, {}],
      scripts: [{ init: 0, traits: [{ name: 1, kind: 1, index: 1 }] }],
      bodies: [
        { method: 0 },
        ...(code ? [{ method: 1, code, maxStack: 4, localCount: 1, maxScopeDepth: 2 }] : []),
      ],
    }),
  );
}

/** The arguments of the module's rt.verifyError or rt.noBody, and which it is. */
function failure(abc: Uint8Array): unknown[] {
  testing.domainReset(50);
  assert.equal(testing.domainAdd(abc, false), 0);
  const lines = (testing.domainModule("a") as string)
    .split("\n")
    .filter((l) => /rt\.(verifyError|noBody)\(/.test(l));
  assert.equal(lines.length, 1);
  const line = lines[0];
  const call = line.slice(line.indexOf("rt."), line.lastIndexOf(")") + 1);
  const rt = {
    verifyError: (...args: unknown[]) => ["verifyError", ...args],
    noBody: (...args: unknown[]) => ["noBody", ...args],
  };
  return new Function("rt", `return ${call}`)(rt);
}

const s24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

test("1011 names the method, the illegal opcode and its offset", () => {
  assert.deepEqual(failure(scriptFunction([0x24, 1, 0xff, 0x47])), [
    "verifyError",
    1011,
    "global/f()",
    255,
    2,
  ]);
});

test("1015 and 1035 name the method", () => {
  // dxns without SETS_DXNS; callsuper in a function, which has no base class.
  assert.deepEqual(failure(scriptFunction([0x06, 1, 0x47])), ["verifyError", 1015, "global/f()"]);
  assert.deepEqual(failure(scriptFunction([0xd0, 0x30, 0xd0, 0x45, 1, 0, 0x29, 0x47])), [
    "verifyError",
    1035,
    "global/f()",
  ]);
});

test("1030 and 1031 name the arriving depth, then the target's", () => {
  // iftrue +1 to 6 records depth 0 there; the fall-through arrives with 1.
  assert.deepEqual(failure(scriptFunction([0x26, 0x11, ...s24(1), 0x20, 0x47])), [
    "verifyError",
    1030,
    1,
    0,
  ]);
  assert.deepEqual(failure(scriptFunction([0x26, 0x11, ...s24(2), 0xd0, 0x30, 0x47])), [
    "verifyError",
    1031,
    1,
    0,
  ]);
  // 0: jump to 10; 4: label; 5: pushnull; 6: jump to 11; 10, 11: nop; 12:
  // jump to 4. Decoded from 0, 10 walks on through 11 with depth 0; the
  // jump from 6 then reaches 11 with 1. avmplus, in order, records 1 at 11
  // from the jump at 6, and the code from 10 arrives with 0.
  const walked = [0x10, ...s24(6), 0x09, 0x20, 0x10, ...s24(1), 0x02, 0x02, 0x10, ...s24(-12)];
  assert.deepEqual(failure(scriptFunction(walked)), ["verifyError", 1030, 0, 1]);
});

test("1019 and 1025 name the scope's index and the register", () => {
  assert.deepEqual(failure(scriptFunction([0xd0, 0x30, 0x65, 1, 0x29, 0x47])), [
    "verifyError",
    1019,
    1,
  ]);
  assert.deepEqual(failure(scriptFunction([0x62, 5, 0x29, 0x47])), ["verifyError", 1025, 5]);
});

test("1019 from getouterscope names the index only where no scope was captured", () => {
  // A script's initializer captures nothing: "Getscopeobject 3 is out of bounds."
  const init = abc(
    { strings: [""] },
    tables({
      methods: [{}],
      scripts: [{ init: 0, traits: [] }],
      bodies: [{ method: 0, code: [0x67, 3, 0x29, 0x47], maxStack: 1, localCount: 1 }],
    }),
  );
  assert.deepEqual(failure(init), ["verifyError", 1019, 3]);
  // A closure the initializer makes captures its global scope, and avmplus passes nothing past it.
  const closure = abc(
    { strings: [""] },
    tables({
      methods: [{}, {}],
      scripts: [{ init: 0, traits: [] }],
      bodies: [
        {
          method: 0,
          code: [0xd0, 0x30, 0x40, 1, 0x29, 0x47],
          maxStack: 1,
          localCount: 1,
          maxScopeDepth: 1,
        },
        { method: 1, code: [0x67, 3, 0x29, 0x47], maxStack: 1, localCount: 1 },
      ],
    }),
  );
  assert.deepEqual(failure(closure), ["verifyError", 1019]);
});

test("1001 names the method without a body", () => {
  assert.deepEqual(failure(scriptFunction(null)), ["noBody", "global/f()"]);
});

test("a method's name stays inside its string, whatever it holds", () => {
  // A quote, a backslash, line ends, a script's end and a template's placeholder.
  const name = `x"); throw 1; ("\\\n\u2028</script>$\{a}\``;
  assert.deepEqual(failure(scriptFunction(null, name)), ["noBody", `global/${name}()`]);
  assert.deepEqual(failure(scriptFunction([0x06, 1, 0x47], name)), [
    "verifyError",
    1015,
    `global/${name}()`,
  ]);
});
