// Fresh objects, end positions and null defaults measured with AIR's SecureSocket
// against a local TLS server using generated certificates (AIR 51.3).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import type { Certificate } from "../../../../../../packages/player/dist/certificates.js";
import { certificate } from "../../../../../../packages/player/dist/playerglobal/flash/security/X509Certificate.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../../../player/libraries.ts";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("certificate getters retain a snapshot and return fresh AS3 values", async () => {
  const s = new Scripting(await createCodegen(wasm));
  await s.loadLibraries(libraryAbcs());
  const rt = s.rt;
  const name = {
    text: "/C=FI/OU=First/OU=Second/CN=localhost",
    commonName: "localhost",
    countryName: "FI",
    localityName: null,
    organizationName: null,
    organizationalUnitName: "First",
    stateOrProvinceName: null,
  };
  const data: Certificate = {
    version: 2,
    serialNumber: "80ab12",
    signatureAlgorithmOID: "OID.1.2.840.113549.1.1.11",
    signatureAlgorithmParams: Buffer.alloc(0),
    issuer: { ...name, commonName: "issuer" },
    validNotBefore: 1700000000000,
    validNotAfter: 1800000000000,
    subject: name,
    subjectPublicKeyAlgorithmOID: "OID.1.2.840.113549.1.1.1",
    subjectPublicKey: "3082010a",
    issuerUniqueID: null,
    subjectUniqueID: null,
    encoded: Buffer.from([48, 3, 1, 2, 3]),
  };
  const object = certificate(s, data);
  const get = (o: avm2.AsObject, key: string) => rt.getProperty(o, rt.publicName(key));
  const call = (o: avm2.AsObject, key: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(key), ...args);

  for (const key of [
    "version",
    "serialNumber",
    "signatureAlgorithmOID",
    "subjectPublicKeyAlgorithmOID",
    "subjectPublicKey",
    "issuerUniqueID",
    "subjectUniqueID",
  ] as const) {
    assert.equal(get(object, key), data[key], key);
  }

  for (const key of ["subject", "issuer"] as const) {
    const first = get(object, key);
    assert.notEqual(first, get(object, key));
    for (const field of Object.keys(name).filter((field) => field !== "text")) {
      assert.equal(get(first, field), data[key][field as keyof typeof name], field);
    }
    assert.equal(call(first, "toString"), name.text);
    assert.throws(() => rt.setProperty(first, rt.publicName("commonName"), "changed"));
  }

  for (const key of ["validNotBefore", "validNotAfter"] as const) {
    const first = get(object, key);
    assert.equal(get(first, "time"), data[key]);
    assert.notEqual(first, get(object, key));
    rt.setProperty(first, rt.publicName("time"), 0);
    assert.equal(get(get(object, key), "time"), data[key]);
  }

  for (const key of ["encoded", "signatureAlgorithmParams"] as const) {
    const first = get(object, key);
    const bytes = avm2.bytesOf(rt, first);
    assert.equal(bytes.position, data[key].length);
    assert.equal(get(first, "endian"), "bigEndian");
    assert.deepEqual(bytes.buffer.slice(0, bytes.length), new Uint8Array(data[key]));
    assert.notEqual(first, get(object, key));
    bytes.position = 0;
    bytes.write(Uint8Array.of(255));
    const again = avm2.bytesOf(rt, get(object, key));
    assert.deepEqual(again.buffer.slice(0, again.length), new Uint8Array(data[key]));
  }

  data.subject.commonName = "changed by host";
  data.encoded[0] = 0;
  assert.equal(get(get(object, "subject"), "commonName"), "localhost");
  assert.equal(avm2.bytesOf(rt, get(object, "encoded")).buffer[0], 48);
  assert.throws(() => rt.setProperty(object, rt.publicName("serialNumber"), "changed"));
  const empty = rt.construct(rt.classNamed("flash.security::X509Certificate"));
  assert.equal(get(empty, "version"), 0);
  assert.equal(get(empty, "encoded"), null);
});
