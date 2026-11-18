// Reusable TLS over a connected or connecting TCP socket. Routing, permission
// checks and proxy tunnelling stay with the embedding host.
import { X509Certificate } from "node:crypto";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity, connect, getCACertificates, type TLSSocket } from "node:tls";
import type {
  CertificateStatus,
  SecureSocketEvents,
  SecureSocketOptions,
  SocketEndpoints,
  SocketTransport,
} from "@swf2es/player";
import { readCertificate, validCertificate } from "./certificates.js";

export { validCertificate } from "./certificates.js";

export interface TlsTransport extends SocketTransport {
  readonly socket: Socket;
}

let defaults: string[] | undefined;

function authorities(options: SecureSocketOptions): string[] {
  defaults ??= [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];
  const result = [...defaults];
  if (options.certificates.length > 64) {
    throw new Error("Too many socket certificates");
  }

  let total = 0;
  for (const { encoded, trusted } of options.certificates) {
    total += encoded.length;
    if (total > 4 * 1024 * 1024 || !validCertificate(encoded)) {
      throw new Error("Invalid socket certificate");
    }

    const certificate = new X509Certificate(encoded);
    // OpenSSL's CA store trusts self-issued entries. An untrusted root must
    // never enter it; other CAs can supply missing intermediate links. Keep
    // partial-chain trust disabled, as AIR's Linux implementation does.
    if (!trusted && (!certificate.ca || certificate.checkIssued(certificate))) {
      continue;
    }

    result.push(certificate.toString());
  }

  return result;
}

function statusOf(error: string): CertificateStatus {
  switch (error) {
    case "CERT_HAS_EXPIRED":
      return "expired";
    case "CERT_NOT_YET_VALID":
      return "notYetValid";
    case "CERT_REVOKED":
      return "revoked";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "principalMismatch";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_UNTRUSTED":
      return "untrustedSigners";
    case "INVALID_CA":
    case "PATH_LENGTH_EXCEEDED":
    case "INVALID_PURPOSE":
    case "CERT_SIGNATURE_FAILURE":
    case "KEYUSAGE_NO_CERTSIGN":
    case "UNHANDLED_CRITICAL_EXTENSION":
      return "invalidChain";
    default:
      return "invalid";
  }
}

/** Neither plaintext nor an open event reaches the caller before certificate validation. */
export function tlsSocket(
  raw: Socket,
  host: string,
  events: SecureSocketEvents,
  options: SecureSocketOptions,
  remote?: Pick<SocketEndpoints, "remoteAddress" | "remotePort">,
): TlsTransport {
  let ca: string[];
  try {
    ca = authorities(options);
  } catch (error) {
    raw.destroy();
    throw error;
  }

  let socket: Socket = raw;
  let opened = false;
  let stopped = false;
  let failed = false;
  const fail = () => {
    if (stopped || failed) {
      return;
    }

    failed = true;
    clearTimeout(timer);
    try {
      events.error(`Error #2031: Socket Error. URL: ${host}`);
    } finally {
      socket.destroy();
    }
  };
  // setTimeout's signed range is smaller than AIR's uint timeout.
  const timer = setTimeout(fail, Math.max(1, Math.min(options.timeout, 0x7fffffff)));
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    stopped = true;
    clearTimeout(timer);
    events.close();
  };
  raw.on("error", fail);
  raw.once("close", close);
  const validate = (tls: TLSSocket) => {
    if (stopped || failed) {
      return;
    }

    try {
      const peer = tls.getPeerCertificate();
      const certificate = readCertificate(peer.raw);
      const error = String(tls.authorizationError ?? "");
      let status: CertificateStatus = tls.authorized ? "trusted" : statusOf(error);
      const now = Date.now();
      if (certificate.validNotAfter < now) {
        status = "expired";
      } else if (certificate.validNotBefore > now) {
        status = "notYetValid";
      } else if (checkServerIdentity(host, peer)) {
        status = "principalMismatch";
      }

      let decided = false;
      const finish = (accepted: boolean) => {
        if (stopped || failed || decided) {
          return;
        }

        decided = true;
        // Consent may arrive after validate returns, and host callbacks can re-enter it.
        try {
          events.certificate(accepted ? "trusted" : status, certificate);
          if (stopped || failed) {
            return;
          }

          if (!accepted) {
            fail();
            return;
          }

          opened = true;
          clearTimeout(timer);
          events.open({
            localAddress: socket.localAddress ?? "",
            localPort: socket.localPort ?? 0,
            remoteAddress: remote?.remoteAddress ?? socket.remoteAddress ?? "",
            remotePort: remote?.remotePort ?? socket.remotePort ?? 0,
          });
          if (!stopped && !failed) {
            socket.resume();
          }
        } catch {
          fail();
        }
      };
      if (
        status === "untrustedSigners" &&
        error === "DEPTH_ZERO_SELF_SIGNED_CERT" &&
        events.certificateError
      ) {
        // AIR 51 offers this exception for a self-signed leaf, not an expired,
        // wrong-name or broken-chain certificate. No listener means refusal.
        events.certificateError(finish);
      } else {
        finish(status === "trusted");
      }
    } catch {
      fail();
    }
  };

  const start = () => {
    if (stopped || failed) {
      return;
    }

    try {
      // Wait for TCP: Node's address-family fallback may replace its handle
      // while connecting, which cannot safely happen underneath a TLS wrapper.
      const tls = connect({
        socket: raw,
        host,
        servername: isIP(host) ? undefined : host,
        ca,
        rejectUnauthorized: false,
      });
      socket = tls;
      tls.pause();
      tls.on("error", fail);
      tls.once("close", close);
      tls.on("data", (bytes: Buffer) => {
        if (opened && !stopped && !failed) {
          events.data(bytes, true);
        }
      });
      tls.once("secureConnect", () => validate(tls));
    } catch {
      fail();
    }
  };
  if (raw.connecting) {
    raw.once("connect", start);
  } else {
    start();
  }

  return {
    get socket() {
      return socket;
    },
    send: (bytes) => {
      if (opened && !stopped && !failed) {
        socket.write(bytes);
      }
    },
    close: () => {
      stopped = true;
      clearTimeout(timer);
      socket.destroy();
    },
  };
}
