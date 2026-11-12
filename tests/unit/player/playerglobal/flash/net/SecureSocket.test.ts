// flash.net.SecureSocket: no host connects over TLS, so it is not supported;
// one not connected has no certificate and an "unknown" status, as in
// Flash Player 32 and adl (AIR 51.3).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { playerNatives } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("SecureSocket is not supported, and one has no certificate", async () => {
  const s = new Scripting(await createCodegen(wasm));
  const natives = playerNatives(s);
  const get = (key: string, self: unknown) =>
    natives[`flash.net::SecureSocket${key}`](s.rt).call(self);
  assert.equal(get(".get:isSupported", null), false);
  assert.equal(get("#get:serverCertificateStatus", {}), "unknown");
  assert.equal(get("#get:serverCertificate", {}), null);
});
