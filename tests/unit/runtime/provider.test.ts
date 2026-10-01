// A runtime's natives may come from a provider, made for the runtime they
// serve: how a natives module closes over its runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";

test("a natives provider is given the runtime it serves, once", () => {
  let made = 0;
  const seen: avm2.Runtime[] = [];
  const rt = new avm2.Runtime((runtime) => {
    made++;
    seen.push(runtime);
    return { "Probe.who": avm2.plain(() => runtime) };
  }, {});
  assert.equal(made, 1);
  assert.equal(seen[0], rt);
  // Bound as a module binds one, the native sees the runtime the provider was given.
  assert.equal(rt.native("Probe.who")(rt.empty, null)(), rt);
  assert.equal(made, 1);

  // A record works as before.
  const plain = new avm2.Runtime({ "Probe.who": avm2.plain(() => "record") }, {});
  assert.equal(plain.native("Probe.who")(plain.empty, null)(), "record");
});
