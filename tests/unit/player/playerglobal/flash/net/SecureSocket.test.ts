// No-host defaults, AS3 over local TLS, and deterministic late-host callbacks.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { createServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { nodeSocketHost, validCertificate } from "@swf2es/player-hosts/node";
import { avm2 } from "@swf2es/runtime";
import type {
  SecureSocketEvents,
  SecureSocketOptions,
  SocketHost,
} from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerNatives } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { readCertificate } from "../../../../../../packages/player-hosts/dist/certificates.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";
import { tlsCertificates } from "../../../../../tls-certificates.ts";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const out = fileURLToPath(new URL("../../../../out/secure-socket/", import.meta.url));
const compile = compiler(out);
const certificates = tlsCertificates();
after(certificates.dispose);

async function setup(
  host: SocketHost,
  script = "SecureSocketRoot",
  parameters: Record<string, string> = {},
) {
  const abc =
    script === "SecureSocketRoot"
      ? compile(
          script,
          "package { import flash.display.Sprite; public class SecureSocketRoot extends Sprite {} }",
        )
      : compile(script);
  const lines: string[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    debugger: true,
    air: parameters.air === "true",
    socket: host,
    print: (line) => lines.push(line),
    parameters,
    audio: null,
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, script), s);
  try {
    await player.start();
  } catch (error) {
    player.destroy();
    console.error(lines.join("\n"));
    throw error;
  }
  return { s, player, lines };
}

test("SecureSocket is not supported, and one has no certificate", async () => {
  const s = new Scripting(await createCodegen(wasm));
  const natives = playerNatives(s);
  const get = (key: string, self: unknown) =>
    natives[`flash.net::SecureSocket${key}`](s.rt).call(self);
  assert.equal(get(".get:isSupported", null), false);
  assert.equal(get("#get:serverCertificateStatus", {}), "unknown");
  assert.equal(get("#get:serverCertificate", {}), null);
});

test("a plain SocketHost cannot silently supply a SecureSocket connection", async () => {
  let connects = 0;
  const { s, player } = await setup({
    connect: () => {
      connects++;
      return { send() {}, close() {} };
    },
  });
  try {
    const object = s.rt.construct(s.rt.classNamed("flash.net::SecureSocket"));
    object.$listeners = new Map([["ioError", [{ fn: { $f() {} }, capture: false, priority: 0 }]]]);
    s.rt.callProperty(object, s.rt.publicName("connect"), "localhost", 1234);
    player.tick();
    assert.equal(connects, 0);
    assert.equal(s.rt.getProperty(object, s.rt.publicName("connected")), false);
  } finally {
    player.destroy();
  }
});

test("SecureSocket shares Socket I/O, snapshots certificates and rejects stale callbacks", async () => {
  const connections: {
    events: SecureSocketEvents;
    options: SecureSocketOptions;
    closed: number;
    sent: Uint8Array[];
  }[] = [];
  const { s, player } = await setup({
    connect: () => {
      throw new Error("plaintext used");
    },
    secure: {
      isCertificate: validCertificate,
      connect: (_host, _port, events, options) => {
        const connection = { events, options, closed: 0, sent: [] as Uint8Array[] };
        connections.push(connection);
        return {
          send: (bytes) => connection.sent.push(new Uint8Array(bytes)),
          close: () => {
            connection.closed++;
          },
        };
      },
    },
  });
  try {
    const rt = s.rt;
    const object = rt.construct(rt.classNamed("flash.net::SecureSocket"));
    const call = (name: string, ...args: avm2.Value[]) =>
      rt.callProperty(object, rt.publicName(name), ...args);
    const get = (name: string) => rt.getProperty(object, rt.publicName(name));
    const events: string[] = [];
    object.$listeners = new Map(
      ["connect", "socketData", "ioError", "close"].map((type) => [
        type,
        [{ fn: { $f: () => events.push(type) }, capture: false, priority: 0 }],
      ]),
    );
    const input = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    const bytes = avm2.bytesOf(rt, input);
    bytes.write(certificates.ca);
    bytes.position = 3;
    call("addBinaryChainBuildingCertificate", input, true);
    bytes.buffer[0] = 0;
    assert.equal(bytes.position, 3);
    rt.setProperty(object, rt.publicName("tcpNoDelay"), true);
    call("connect", "localhost", 1234);
    assert.equal(connections[0].options.certificates[0].encoded[0], 48);
    assert.equal(connections[0].options.noDelay, true);
    const data = readCertificate(certificates.leafDer);
    connections[0].events.certificate("trusted", data);
    data.subject.commonName = "host changed";
    connections[0].events.open();
    const incoming = Buffer.from([1, 2, 255]);
    connections[0].events.data(incoming);
    incoming.fill(0);
    assert.equal(get("serverCertificateStatus"), "unknown");
    player.tick();
    assert.deepEqual(events, ["connect", "socketData"]);
    assert.equal(get("serverCertificateStatus"), "trusted");
    const certificate = get("serverCertificate");
    assert.notEqual(certificate, get("serverCertificate"));
    const subject = rt.getProperty(certificate, rt.publicName("subject"));
    assert.equal(rt.getProperty(subject, rt.publicName("commonName")), "localhost");
    assert.equal(call("readUnsignedByte"), 1);
    assert.equal(call("readUnsignedByte"), 2);
    assert.equal(call("readUnsignedByte"), 255);
    call("writeByte", 42);
    call("flush");
    assert.deepEqual(connections[0].sent, [Uint8Array.of(42)]);
    call("close");
    assert.equal(get("serverCertificate"), null);
    assert.equal(get("serverCertificateStatus"), "trusted");
    call("connect", "localhost", 1234);
    assert.equal(get("serverCertificateStatus"), "unknown");
    connections[0].events.certificate("expired", data);
    connections[0].events.open();
    connections[0].events.error("old error");
    connections[0].events.close();
    player.tick();
    assert.equal(get("serverCertificateStatus"), "unknown");
    assert.equal(get("serverCertificate"), null);
    assert.deepEqual(events, ["connect", "socketData"]);
    connections[1].events.certificate("untrustedSigners", data);
    connections[1].events.error("Error #2031: Socket Error.");
    connections[1].events.close();
    player.tick();
    assert.equal(get("serverCertificateStatus"), "untrustedSigners");
    assert.ok(get("serverCertificate"));
    assert.deepEqual(events, ["connect", "socketData", "ioError"]);
    assert.equal(connections[1].closed, 1);
    call("connect", "localhost", 1234);
    player.destroy();
    assert.equal(connections[2].closed, 1);
  } finally {
    player.destroy();
  }
});

test("SecureSocket checks certificate budgets before host validation and keeps accepted additions", async () => {
  let checked = 0;
  const sizes: number[][] = [];
  const { s, player } = await setup({
    connect() {
      throw new Error("plaintext used");
    },
    secure: {
      isCertificate: () => {
        checked++;
        return true;
      },
      connect: (_host, _port, _events, options) => {
        sizes.push(options.certificates.map(({ encoded }) => encoded.length));
        return { send() {}, close() {} };
      },
    },
  });
  try {
    const rt = s.rt;
    const input = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    const bytes = avm2.bytesOf(rt, input);
    for (const [size, count] of [
      [1, 64],
      [256 * 1024, 16],
    ]) {
      const socket = rt.construct(rt.classNamed("flash.net::SecureSocket"));
      const add = () =>
        rt.callProperty(socket, rt.publicName("addBinaryChainBuildingCertificate"), input, true);
      const before = checked;
      bytes.setLength(256 * 1024 + 1);
      assert.throws(add);
      assert.equal(checked, before);

      bytes.setLength(size);
      for (let i = 0; i < count; i++) {
        add();
      }

      bytes.setLength(1);
      assert.throws(add);
      assert.equal(checked, before + count);
      rt.callProperty(socket, rt.publicName("connect"), "localhost", 1234);
      assert.deepEqual(sizes.at(-1), Array(count).fill(size));
    }
  } finally {
    player.destroy();
  }
});

test("AS3 SecureSocket traces success, validation failure and explicit self-signed consent", {
  timeout: 30000,
}, async () => {
  const cases: { cert: Buffer; key: Buffer; parameters: Record<string, string>; result: string }[] =
    [
      {
        cert: certificates.leaf,
        key: certificates.key,
        parameters: { ca: certificates.ca.toString("hex") },
        result: "success",
      },
      {
        cert: certificates.leaf,
        key: certificates.key,
        parameters: { ca: certificates.ca.toString("hex"), trusted: "false" },
        result: "untrustedSigners",
      },
      {
        cert: certificates.self,
        key: certificates.selfKey,
        parameters: { accept: "yes", air: "true" },
        result: "success",
      },
      {
        cert: certificates.self,
        key: certificates.selfKey,
        parameters: { accept: "no", air: "true" },
        result: "untrustedSigners",
      },
      {
        cert: certificates.self,
        key: certificates.selfKey,
        parameters: { accept: "yes", air: "false" },
        result: "untrustedSigners",
      },
    ];
  for (const scenario of cases) {
    const server = createServer({ cert: scenario.cert, key: scenario.key }, (peer) => {
      peer.on("error", () => {});
      peer.on("data", (bytes) => peer.write(bytes));
    });
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = String((server.address() as { port: number }).port);
    let player: Player | undefined;
    try {
      const run = await setup(nodeSocketHost(), "SecureSockets", {
        ...scenario.parameters,
        port,
      });
      player = run.player;
      const lines = run.lines;
      for (let i = 0; i < 2000 && !lines.includes("done"); i++) {
        player.tick();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.ok(lines.includes("done"), lines.join("\n"));
      const expected = ["supported true", "initial unknown null", "invalid 2004", "invalid 2004"];
      if (scenario.parameters.ca) {
        expected.push("certificate position 3");
      }
      expected.push("opening false unknown");
      if (scenario.parameters.accept && scenario.parameters.air === "true") {
        expected.push("certificateError true unknown");
      }
      if (scenario.result === "success") {
        expected.push(
          "connect true trusted",
          "subject localhost",
          "fresh true true true true",
          "encoded true bigEndian",
          "unchanged true true",
          "data 16909060 255",
          "closed false trusted null",
        );
      } else {
        expected.push(`error 2031 ${scenario.result} true`);
      }
      expected.push("done");
      assert.deepEqual(lines, expected);
    } finally {
      player?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
