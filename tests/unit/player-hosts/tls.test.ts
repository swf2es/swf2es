import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { type Socket, connect as tcpConnect, createServer as tcpServer } from "node:net";
import { after, test } from "node:test";
import { createServer } from "node:tls";
import { nodeSocketHost, tlsSocket, validCertificate } from "@swf2es/player-hosts/node";
import type {
  Certificate,
  CertificateStatus,
  SecureSocketEvents,
  SecureSocketOptions,
} from "../../../packages/player/dist/index.js";
import { readCertificate } from "../../../packages/player-hosts/dist/certificates.js";
import { statusOf } from "../../../packages/player-hosts/dist/tls.js";
import { tlsCertificates } from "../../tls-certificates.ts";

const certificates = tlsCertificates();
const host = nodeSocketHost().secure;
assert.ok(host);
after(certificates.dispose);

async function server(cert = certificates.leaf, key = certificates.key, greeting?: Uint8Array) {
  const peers = new Set<Socket>();
  const server = createServer({ cert, key }, (peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => peers.delete(peer));
    peer.on("data", (bytes) => peer.write(bytes));

    if (greeting) {
      peer.write(greeting);
    }
  });
  server.on("connection", (peer) => {
    peers.add(peer);
    peer.on("close", () => peers.delete(peer));
  });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => {
      for (const peer of peers) {
        peer.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function recorded(accept?: boolean) {
  const log: string[] = [];
  let certificate: Certificate | null = null;
  let status: CertificateStatus = "unknown";
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const events: SecureSocketEvents = {
    open: () => {
      log.push("open");
      resolve();
    },
    data: (bytes) => log.push(`data:${Buffer.from(bytes).toString()}`),
    error: () => {
      log.push("error");
      resolve();
    },
    close: () => log.push("close"),
    certificate: (result, data) => {
      status = result;
      certificate = data;
      log.push(`certificate:${result}`);
    },
    certificateError: (proceed) => {
      log.push("certificateError");
      proceed(accept === true);
    },
  };
  return { log, events, done, status: () => status, certificate: () => certificate };
}

const options = (trusted = true): SecureSocketOptions => ({
  certificates: [{ encoded: certificates.ca, trusted }],
  timeout: 2000,
});

test("DER metadata matches AIR for RSA, EC, repeated names and UTF-8", () => {
  const rsa = readCertificate(certificates.leafDer);
  assert.equal(rsa.version, 2);
  assert.equal(rsa.serialNumber, "80ab12");
  assert.equal(rsa.signatureAlgorithmOID, "OID.1.2.840.113549.1.1.11");
  assert.equal(rsa.subjectPublicKeyAlgorithmOID, "OID.1.2.840.113549.1.1.1");
  assert.equal(
    rsa.subjectPublicKey,
    new X509Certificate(certificates.leaf).publicKey
      .export({ format: "der", type: "pkcs1" })
      .toString("hex"),
  );
  assert.equal(rsa.subject.organizationalUnitName, "First");
  assert.equal(
    rsa.subject.text,
    "/C=FI/ST=Uusimaa/L=Helsinki/O=swf2es Test/OU=First/OU=Second/CN=localhost",
  );
  assert.equal(rsa.issuer.text, "/CN=swf2es test root");
  assert.equal(rsa.issuer.countryName, null);
  assert.equal(rsa.signatureAlgorithmParams.length, 0);
  assert.equal(rsa.issuerUniqueID, null);
  assert.equal(rsa.subjectUniqueID, null);
  assert.deepEqual(rsa.encoded, new Uint8Array(certificates.leafDer));
  const ec = readCertificate(certificates.selfDer);
  assert.equal(ec.signatureAlgorithmOID, "OID.1.2.840.10045.4.3.2");
  assert.equal(ec.subjectPublicKeyAlgorithmOID, "OID.1.2.840.10045.2.1");
  assert.equal(ec.subjectPublicKey.length, 130);
  assert.equal(ec.subject.organizationName, "Café");
  assert.equal(ec.subject.commonName, "localhost");
  assert.equal(
    ec.subject.text,
    "/C=FI/O=Caf\\xC3\\xA9/OU=A/CN=localhost/CN=Second/emailAddress=test@example.invalid",
  );
  assert.equal(ec.signatureAlgorithmParams.length, 0);
});

test("DER validation refuses PEM, truncation, extra bytes and corrupt lengths", () => {
  assert.equal(validCertificate(certificates.ca), true);
  for (const bytes of [
    new Uint8Array(),
    certificates.leaf,
    certificates.ca.subarray(0, 10),
    Buffer.concat([certificates.ca, Buffer.from([0])]),
    Uint8Array.of(48, 128, 0, 0),
    Uint8Array.of(48, 132, 255, 255, 255, 255),
  ]) {
    assert.equal(validCertificate(bytes), false);
  }
});

function derLength(length: number): number[] {
  if (length < 128) {
    return [length];
  }

  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest & 255);
  }
  return [128 | bytes.length, ...bytes];
}

function der(tag: number, ...body: Uint8Array[]): Uint8Array {
  const content = Buffer.concat(body);
  return Buffer.concat([Uint8Array.of(tag, ...derLength(content.length)), content]);
}

/** A DER element's children, each whole. */
function children(bytes: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  let at = bytes[1] & 128 ? 2 + (bytes[1] & 127) : 2;
  while (at < bytes.length) {
    const start = at++;
    let length = bytes[at++];
    if (length & 128) {
      const count = length & 127;
      length = 0;
      for (let i = 0; i < count; i++) {
        length = length * 256 + bytes[at++];
      }
    }
    at += length;
    result.push(bytes.subarray(start, at));
  }

  return result;
}

/** The test root with `issuer` as its issuer: OpenSSL still reads it, its signature unchecked. */
function withIssuer(issuer: Uint8Array): Uint8Array {
  const [tbs, algorithm, signature] = children(certificates.ca);
  const fields = children(tbs);
  fields[3] = issuer;
  return der(48, der(48, ...fields), algorithm, signature);
}

/** A name of one attribute per `[oid, value]`, each its own RDN. */
function nameOf(attributes: [Uint8Array, Uint8Array][]): Uint8Array {
  return der(48, ...attributes.map(([id, value]) => der(49, der(48, der(6, id), value))));
}

const commonName = Uint8Array.of(85, 4, 3);
const utf8 = (text: string) => der(12, Buffer.from(text));

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}

test("DER validation takes time linear in a certificate, whatever its OIDs and names hold", () => {
  // One arc 100 KB long: OpenSSL reads it in a millisecond; decoding it as one
  // number took over a second, 31 s at 250 KB.
  const long = new Uint8Array(100_000).fill(255);
  long[long.length - 1] = 127;
  const longArc = withIssuer(nameOf([[long, utf8("x")]]));
  assert.doesNotThrow(() => new X509Certificate(longArc));
  // Many short arcs, past any registered OID's length.
  const manyArcs = withIssuer(nameOf([[new Uint8Array(200).fill(1), utf8("x")]]));
  // As many RDNs as 256 KiB holds, past the 256 any name may have; the most it may; and
  // one long BMPString.
  const rdns = (count: number) =>
    withIssuer(nameOf(new Array<[Uint8Array, Uint8Array]>(count).fill([commonName, utf8("x")])));
  const many = rdns(20_000);
  const most = rdns(256);
  const wide = withIssuer(nameOf([[commonName, der(30, new Uint8Array(200_000).fill(0x41))]]));
  for (const [bytes, valid] of [
    [longArc, false],
    [manyArcs, false],
    [many, false],
    [most, true],
    [wide, true],
  ] as const) {
    assert.ok(bytes.length <= 256 * 1024);
    // The first read warms the code up; the answer is then kept, so time the reader itself.
    readCertificate(certificates.ca);
    const [read, ms] = timed(() => {
      try {
        return readCertificate(bytes);
      } catch {
        return null;
      }
    });
    assert.equal(read !== null, valid);
    assert.ok(ms < 50, `${bytes.length} bytes read in ${ms.toFixed(1)} ms`);
    assert.equal(validCertificate(bytes), valid);
    assert.equal(validCertificate(bytes), valid);
  }

  assert.equal(readCertificate(most).issuer.text, "/CN=x".repeat(256));
  assert.equal(validCertificate(rdns(257)), false);
  assert.equal(readCertificate(wide).issuer.commonName, "\u4141".repeat(100_000));
});

test("OIDs decode exactly, a UUID's 128-bit arc included", () => {
  // 2.25.329800735698586629295641978511506172918, the UUID example of ITU-T X.667.
  const uuid = 329800735698586629295641978511506172918n;
  const arc: number[] = [];
  for (let rest = uuid; rest > 0n; rest >>= 7n) {
    arc.unshift(Number(rest & 127n) | (arc.length ? 128 : 0));
  }
  const name = nameOf([
    [Uint8Array.of(105, ...arc), utf8("u")],
    [Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x01), utf8("e")],
    // An arc of 8 bytes, past plain numbers' 7.
    [Uint8Array.of(0x88, 0x37, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00), utf8("b")],
  ]);
  assert.equal(
    readCertificate(withIssuer(name)).issuer.text,
    `/2.25.${uuid}=u/emailAddress=e/2.999.${2n ** 49n}=b`,
  );
});

test("OpenSSL's verification errors map to AIR's certificate statuses", () => {
  for (const [error, status] of [
    ["CERT_HAS_EXPIRED", "expired"],
    ["CERT_NOT_YET_VALID", "notYetValid"],
    ["CERT_REVOKED", "revoked"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "principalMismatch"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "untrustedSigners"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "untrustedSigners"],
    ["INVALID_CA", "invalidChain"],
    ["PATH_LENGTH_EXCEEDED", "invalidChain"],
    ["CERT_SIGNATURE_FAILURE", "invalidChain"],
    ["KEYUSAGE_NO_CERTSIGN", "invalidChain"],
    ["CERT_CHAIN_TOO_LONG", "invalid"],
    ["", "invalid"],
  ] as const) {
    assert.equal(statusOf(error), status, error);
  }
});

test("sockets that add no CA share one context of the roots, not one parsed for each", {
  timeout: 10000,
}, async () => {
  // Each context parses every root again, some 10 ms.
  const tls = createRequire(import.meta.url)("node:tls") as typeof import("node:tls");
  const original = tls.createSecureContext;
  let made = 0;
  tls.createSecureContext = (...args) => {
    made++;
    return original(...args);
  };
  syncBuiltinESMExports();
  const peer = await server();
  try {
    const counted = async (config: SecureSocketOptions, status = "untrustedSigners") => {
      const before = made;
      for (let i = 0; i < 3; i++) {
        const seen = recorded();
        const transport = host.connect("localhost", peer.port, seen.events, config);
        try {
          await seen.done;
          assert.equal(seen.status(), status);
        } finally {
          transport.close();
        }
      }
      return made - before;
    };
    const plain: SecureSocketOptions = { certificates: [], timeout: 2000 };
    await counted(plain);
    assert.equal(await counted(plain), 0);
    // An untrusted root adds nothing, so it shares the roots' context too.
    assert.equal(await counted(options(false)), 0);
    assert.equal(await counted(options(), "trusted"), 3);
    assert.equal(await counted(plain), 0);
  } finally {
    tls.createSecureContext = original;
    syncBuiltinESMExports();
    await peer.close();
  }
});

test("TLS opens only after trust validation, then exchanges binary data", {
  timeout: 10000,
}, async () => {
  const peer = await server();
  const seen = recorded();
  const transport = host.connect("localhost", peer.port, seen.events, options());
  try {
    transport.send(Buffer.from("too soon"));
    await seen.done;
    assert.deepEqual(seen.log, ["certificate:trusted", "open"]);
    assert.equal(seen.certificate()?.serialNumber, "80ab12");
    const received = new Promise<void>((resolve) => {
      seen.events.data = (bytes) => {
        assert.deepEqual(new Uint8Array(bytes), Uint8Array.of(0, 1, 255, 128));
        resolve();
      };
    });
    // The host retains the event object, so this also checks real TLS delivery.
    transport.send(Uint8Array.of(0, 1, 255, 128));
    await received;
  } finally {
    transport.close();
    await peer.close();
  }
});

test("untrusted roots never become anchors and trust does not leak between connections", {
  timeout: 10000,
}, async () => {
  const peer = await server();
  try {
    for (const trusted of [false, true, false]) {
      const seen = recorded();
      const transport = host.connect("localhost", peer.port, seen.events, options(trusted));
      try {
        await seen.done;
        assert.equal(seen.log.includes("open"), trusted);
        assert.equal(seen.status(), trusted ? "trusted" : "untrustedSigners");
        assert.ok(seen.certificate());
      } finally {
        transport.close();
      }
    }
  } finally {
    await peer.close();
  }
});

test("an untrusted intermediate completes a chain only to a trusted root", {
  timeout: 10000,
}, async () => {
  const peer = await server(certificates.chain);
  try {
    for (const [rootTrusted, intermediateTrusted] of [
      [true, false],
      [false, false],
      [false, true],
    ]) {
      const seen = recorded();
      const config = options(rootTrusted);
      config.certificates = [
        ...config.certificates,
        { encoded: certificates.intermediate, trusted: intermediateTrusted },
      ];
      const transport = host.connect("localhost", peer.port, seen.events, config);
      try {
        await seen.done;
        assert.equal(seen.log.includes("open"), rootTrusted);
      } finally {
        transport.close();
      }
    }
  } finally {
    await peer.close();
  }
});

test("expiry and hostname checks cannot be accepted through the self-signed exception", {
  timeout: 10000,
}, async () => {
  for (const [cert, hostname, status] of [
    [certificates.expired, "localhost", "expired"],
    [certificates.future, "localhost", "notYetValid"],
    [certificates.leaf, "127.0.0.1", "principalMismatch"],
  ] as const) {
    const peer = await server(cert);
    const seen = recorded(true);
    const transport = host.connect(hostname, peer.port, seen.events, options());
    try {
      await seen.done;
      assert.equal(seen.status(), status);
      assert.equal(seen.log.includes("open"), false);
      assert.equal(seen.log.includes("certificateError"), false);
    } finally {
      transport.close();
      await peer.close();
    }
  }
});

test("a self-signed leaf must still be valid when consent arrives", {
  timeout: 10000,
}, async (t) => {
  const peer = await server(certificates.self, certificates.selfKey);
  const seen = recorded();
  const decision = new Promise<(accepted: boolean) => void>((resolve) => {
    seen.events.certificateError = resolve;
  });
  const transport = tlsSocket(
    tcpConnect(peer.port, "127.0.0.1"),
    "localhost",
    seen.events,
    options(),
  );
  try {
    const proceed = await decision;
    const expires = new X509Certificate(certificates.self).validToDate.getTime();
    t.mock.method(Date, "now", () => expires + 1);
    proceed(true);
    assert.deepEqual(seen.log, ["certificate:expired", "error"]);
    assert.equal(transport.socket.destroyed, true);
    proceed(true);
    assert.deepEqual(seen.log, ["certificate:expired", "error"]);
  } finally {
    transport.close();
    await peer.close();
  }
});

test("a throwing receive callback reports failure and closes the TLS socket", {
  timeout: 10000,
}, async () => {
  const peer = await server();
  const seen = recorded();
  seen.events.data = () => {
    throw new Error("receiver failed");
  };
  const closed = new Promise<void>((resolve) => {
    seen.events.close = () => {
      seen.log.push("close");
      resolve();
    };
  });
  const transport = tlsSocket(
    tcpConnect(peer.port, "127.0.0.1"),
    "localhost",
    seen.events,
    options(),
  );
  try {
    await seen.done;
    transport.send(Uint8Array.of(42));
    await closed;
    assert.deepEqual(seen.log, ["certificate:trusted", "open", "error", "close"]);
    assert.equal(transport.socket.destroyed, true);
  } finally {
    transport.close();
    await peer.close();
  }
});

test("a self-signed leaf requires explicit acceptance, with the status reported before open", {
  timeout: 10000,
}, async () => {
  const peer = await server(certificates.self, certificates.selfKey);
  try {
    for (const accept of [false, true]) {
      const seen = recorded(accept);
      const transport = host.connect("localhost", peer.port, seen.events, {
        certificates: [],
        timeout: 2000,
      });
      try {
        await seen.done;
        assert.equal(seen.log[0], "certificateError");
        assert.equal(seen.log.includes("open"), accept);
      } finally {
        transport.close();
      }
    }
  } finally {
    await peer.close();
  }
});

test("closing from a certificate notification prevents open", { timeout: 10000 }, async () => {
  const peer = await server();
  const seen = recorded();
  const transport = host.connect("localhost", peer.port, seen.events, options());
  const certificate = seen.events.certificate;
  const closed = new Promise<void>((resolve) => {
    seen.events.close = () => resolve();
  });
  seen.events.certificate = (status, data) => {
    certificate(status, data);
    transport.close();
  };
  try {
    await closed;
    assert.deepEqual(seen.log, ["certificate:trusted"]);
  } finally {
    transport.close();
    await peer.close();
  }
});

test("self-signed consent cannot bypass the target hostname", { timeout: 10000 }, async () => {
  const peer = await server(certificates.self, certificates.selfKey);
  const seen = recorded(true);
  const transport = host.connect("127.0.0.1", peer.port, seen.events, options());
  try {
    await seen.done;
    assert.equal(seen.status(), "principalMismatch");
    assert.equal(seen.log.includes("certificateError"), false);
    assert.equal(seen.log.includes("open"), false);
  } finally {
    transport.close();
    await peer.close();
  }
});

async function plaintextBuffered(socket: Socket): Promise<void> {
  const deadline = Date.now() + 2000;
  while (socket.readableLength === 0 && !socket.destroyed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.ok(
    socket.readableLength > 0,
    "plaintext must be buffered before the certificate decision",
  );
}

test("TLS retains paused plaintext until consent and keeps delivered chunks owned", {
  timeout: 10000,
}, async () => {
  const payload = Buffer.alloc(1024 * 1024 + 37);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (i * 31 + Math.floor(i / 256)) & 255;
  }

  const peer = await server(certificates.self, certificates.selfKey, payload);
  const seen = recorded();
  const decision = new Promise<(accepted: boolean) => void>((resolve) => {
    seen.events.certificateError = resolve;
  });
  const chunks: Uint8Array[] = [];
  const ownership: (boolean | undefined)[] = [];
  let length = 0;
  let earlyData = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const received = new Promise<void>((resolve) => {
    seen.events.data = (bytes, owned) => {
      ownership.push(owned);
      earlyData ||= !seen.log.includes("open");
      chunks.push(bytes);
      length += bytes.length;
      if (length === payload.length) {
        resolve();
      }
    };
  });
  const transport = tlsSocket(
    tcpConnect(peer.port, "127.0.0.1"),
    "localhost",
    seen.events,
    options(),
  );
  try {
    const proceed = await decision;
    await plaintextBuffered(transport.socket);
    assert.equal(length, 0);
    assert.equal(seen.log.includes("open"), false);
    proceed(true);
    await Promise.race([
      received,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("TLS lost queued plaintext")), 3000);
      }),
    ]);
    assert.ok(chunks.length > 1);
    assert.equal(earlyData, false);
    assert.ok(ownership.every((owned) => owned === true));

    // Retain the actual arrays as an IPC batch or the player's receive queue does.
    assert.ok(Buffer.concat(chunks).equals(payload), "retained plaintext changed");
  } finally {
    clearTimeout(timer);
    transport.close();
    await peer.close();
  }
});

test("TLS discards paused plaintext after refusal, timeout or close", {
  timeout: 10000,
}, async () => {
  const peer = await server(certificates.self, certificates.selfKey, Buffer.alloc(1024 * 1024, 42));
  try {
    for (const action of ["refuse", "timeout", "close"] as const) {
      const seen = recorded();
      const decision = new Promise<(accepted: boolean) => void>((resolve) => {
        seen.events.certificateError = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        seen.events.close = resolve;
      });
      const transport = tlsSocket(tcpConnect(peer.port, "127.0.0.1"), "localhost", seen.events, {
        ...options(),
        timeout: action === "timeout" ? 250 : 2000,
      });
      try {
        const proceed = await decision;
        await plaintextBuffered(transport.socket);
        switch (action) {
          case "refuse":
            proceed(false);
            break;
          case "close":
            transport.close();
            break;
        }

        await closed;
        proceed(true);
        assert.equal(seen.log.includes("open"), false);
        assert.equal(
          seen.log.some((event) => event.startsWith("data:")),
          false,
        );
        assert.equal(transport.socket.destroyed, true);
      } finally {
        transport.close();
      }
    }
  } finally {
    await peer.close();
  }
});

test("a stalled handshake times out and closing it cancels callbacks", {
  timeout: 10000,
}, async () => {
  const peers = new Set<import("node:net").Socket>();
  const server = tcpServer((peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => peers.delete(peer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const seen = recorded();
    const transport = tlsSocket(tcpConnect(port, "127.0.0.1"), "localhost", seen.events, {
      certificates: [],
      timeout: 250,
    });
    await seen.done;
    assert.equal(seen.log.includes("error"), true);
    assert.equal(seen.log.includes("open"), false);
    transport.close();
    const closed = recorded();
    const other = tlsSocket(tcpConnect(port, "127.0.0.1"), "localhost", closed.events, {
      certificates: [],
      timeout: 250,
    });
    other.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(closed.log, ["close"]);
  } finally {
    for (const peer of peers) {
      peer.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an error callback that throws still destroys the socket", { timeout: 10000 }, async () => {
  const peer = await server();
  const seen = recorded();
  const failure = new Error("host error callback failed");
  seen.events.error = () => {
    throw failure;
  };
  const closed = new Promise<void>((resolve) => {
    seen.events.close = resolve;
  });
  const raw = tcpConnect(peer.port, "127.0.0.1");
  const transport = tlsSocket(raw, "localhost", seen.events, options());
  try {
    assert.throws(
      () => raw.emit("error", new Error("TCP failed")),
      (error) => error === failure,
    );
    assert.equal(raw.destroyed, true);
    await closed;
  } finally {
    transport.close();
    await peer.close();
  }
});

test("deferred certificate decisions close on certificate or open callback exceptions", {
  timeout: 10000,
}, async () => {
  const peer = await server(certificates.self, certificates.selfKey);
  try {
    for (const callback of ["certificate", "open"] as const) {
      const seen = recorded();
      const decision = new Promise<(accepted: boolean) => void>((resolve) => {
        seen.events.certificateError = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        seen.events.close = resolve;
      });
      seen.events[callback] = () => {
        throw new Error(`host ${callback} callback failed`);
      };
      const transport = tlsSocket(
        tcpConnect(peer.port, "127.0.0.1"),
        "localhost",
        seen.events,
        options(),
      );
      try {
        const proceed = await decision;
        assert.doesNotThrow(() => proceed(true));
        assert.equal(transport.socket.destroyed, true);
        await closed;
        assert.equal(seen.log.filter((event) => event === "error").length, 1);
        assert.equal(seen.log.includes("open"), false);
        const before = [...seen.log];
        proceed(true);
        assert.deepEqual(seen.log, before);
      } finally {
        transport.close();
      }
    }
  } finally {
    await peer.close();
  }
});

test("a certificate decision cannot be changed by reentrant or repeated callbacks", {
  timeout: 10000,
}, async () => {
  const peer = await server(certificates.self, certificates.selfKey);
  try {
    for (const accepted of [true, false]) {
      const seen = recorded();
      const decision = new Promise<(accepted: boolean) => void>((resolve) => {
        seen.events.certificateError = resolve;
      });
      let proceed!: (accepted: boolean) => void;
      let certificates = 0;
      const report = seen.events.certificate;
      seen.events.certificate = (status, data) => {
        report(status, data);
        if (++certificates === 1) {
          proceed(!accepted);
        }
      };
      const transport = tlsSocket(
        tcpConnect(peer.port, "127.0.0.1"),
        "localhost",
        seen.events,
        options(),
      );
      const received = new Promise<Uint8Array>((resolve) => {
        seen.events.data = resolve;
      });
      seen.events.open = () => {
        seen.log.push("open");
        transport.send(Uint8Array.of(42));
      };
      try {
        proceed = await decision;
        proceed(accepted);
        proceed(!accepted);
        proceed(accepted);
        assert.equal(certificates, 1);
        assert.deepEqual(
          seen.log,
          accepted ? ["certificate:trusted", "open"] : ["certificate:untrustedSigners", "error"],
        );
        if (accepted) {
          assert.deepEqual(new Uint8Array(await received), Uint8Array.of(42));
        } else {
          assert.equal(transport.socket.destroyed, true);
        }
      } finally {
        transport.close();
      }
    }
  } finally {
    await peer.close();
  }
});
