// registerClassAlias on a name already registered drops the reverse mapping
// of the class the name had, whatever alias that class has now, as Flash
// does (AIR's adl, oracle/flash.ts): an instance of it is then written with
// no alias. avmshell keeps the mapping, as its lookup of the name's earlier
// class misses the toplevel's domain, so avmshell is no reference here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AsObject, createRuntime } from "@swf2es/runtime/avm2";

test("a name registered again drops its earlier class's alias, as Flash does", () => {
  const rt = createRuntime({ print: () => {} });
  const a: AsObject = { $it: {} };
  const b: AsObject = { $it: {} };
  const e: AsObject = { $it: {} };
  const aliases = () => [rt.aliasOf(a.$it), rt.aliasOf(b.$it), rt.aliasOf(e.$it)];

  rt.registerClassAlias("C", a);
  assert.deepEqual(aliases(), ["C", "", ""]);

  rt.registerClassAlias("C", b);
  assert.deepEqual(aliases(), ["", "C", ""]);
  assert.equal(rt.classByAlias("C"), b);

  rt.registerClassAlias("D", a);
  assert.deepEqual(aliases(), ["D", "C", ""]);

  rt.registerClassAlias("F", e);
  rt.registerClassAlias("D", e);
  assert.deepEqual(aliases(), ["", "C", "D"]);
  assert.equal(rt.classByAlias("F"), e);

  // F's class was E, whose alias is D now: Flash drops it all the same.
  rt.registerClassAlias("F", b);
  assert.deepEqual(aliases(), ["", "F", ""]);

  rt.registerClassAlias("C", e);
  assert.deepEqual(aliases(), ["", "", "C"]);
  assert.deepEqual(
    ["C", "D", "F"].map((name) => rt.classByAlias(name)),
    [e, e, b],
  );
});
