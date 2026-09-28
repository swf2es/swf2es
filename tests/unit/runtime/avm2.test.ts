import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";

test("int() and uint() coerce like AS3", () => {
  assert.equal(avm2.toInt(2 ** 31), -(2 ** 31));
  assert.equal(avm2.toInt("12.9"), 12);
  assert.equal(avm2.toInt(undefined), 0);
  assert.equal(avm2.toInt(NaN), 0);
  assert.equal(avm2.toUint(-1), 4294967295);
  assert.equal(avm2.toUint(null), 0);
});

/** An empty module's descriptor, compiled after `linked`. */
const module = (hash: string, linked: string[]) => ({
  hash,
  linked,
  names: [],
  classes: [],
  scripts: [],
  activations: [],
});

test("a module loads only after the ABCs it was compiled against", () => {
  const rt = avm2.createRuntime();
  rt.abc(module("builtin", []));
  assert.throws(() => rt.abc(module("case", ["other"])), /compiled after \[other\]/);
  assert.throws(() => rt.abc(module("case", [])), /cannot load after \[builtin\]/);
  rt.abc(module("case", ["builtin"]));
});

test("error messages are the release player's, or the debugger player's with its text", () => {
  // With no builtins loaded, the runtime's errors are JavaScript errors naming them.
  assert.equal(avm2.createRuntime().error("TypeError", 1009).message, "TypeError: Error #1009");
  assert.equal(
    avm2.createRuntime({ debugger: true }).error("TypeError", 1009).message,
    "TypeError: Error #1009: Cannot access a property or method of a null object reference.",
  );
  assert.equal(
    avm2.createRuntime({ debugger: true }).errorMessage(1065, ["x"]),
    "Error #1065: Variable x is not defined.",
  );
});
