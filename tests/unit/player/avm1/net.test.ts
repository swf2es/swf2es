// What AVM1's network hands its host: a send's signal aborts with the player
// only until the send settles, so a host that listens to it keeps nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Avm1Net } from "../../../../packages/player/dist/avm1/net.js";

test("a send's signal is the player's to abort only until the send settles", async () => {
  const given: AbortSignal[] = [];
  let finish = () => {};
  const settled = new Promise<void>((done) => {
    finish = done;
  });
  const net = new Avm1Net(
    async (_request, signal) => {
      given.push(signal);
      await settled;
      return { status: 200, bytes: new Uint8Array(0), headers: [] };
    },
    null,
    "http://a.test/",
  );

  assert.equal(net.send({ url: "x", method: "GET", headers: [], body: null }), true);
  finish();
  await new Promise((done) => setTimeout(done, 0));
  net.destroy();
  assert.equal(given.length, 1);
  assert.equal(given[0].aborted, false);
});
