import { avm2 } from "@swf2es/runtime";
import type { As3 } from "../../../as3/types.js";
import {
  type Certificate,
  copyCertificate,
  MAX_CERTIFICATE_BYTES,
  MAX_SOCKET_CERTIFICATE_BYTES,
  MAX_SOCKET_CERTIFICATES,
} from "../../../certificates.js";
import type { CertificateStatus, SocketCertificate } from "../../../hosts.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { certificate } from "../security/X509Certificate.js";
import type { SocketConnections } from "./socket-connections.js";

interface State {
  certificates: SocketCertificate[];
  certificateBytes: number;
  status: CertificateStatus;
  certificate: Certificate | null;
}

export function secureSocketNatives(s: Scripting, sockets: SocketConnections): avm2.Natives {
  const natives: avm2.Natives = {};
  const states = new WeakMap<avm2.AsObject, State>();
  const state = (object: avm2.AsObject): State => {
    let known = states.get(object);
    if (!known) {
      known = { certificates: [], certificateBytes: 0, status: "unknown", certificate: null };
      states.set(object, known);
    }

    return known;
  };

  class SecureSocketNatives {
    static get isSupported(): boolean {
      return !!s.socket?.secure;
    }

    get serverCertificateStatus(): string {
      return state(this).status;
    }

    get serverCertificate(): avm2.Value {
      const data = state(this).certificate;
      return data ? certificate(s, data) : null;
    }

    addBinaryChainBuildingCertificate(value: avm2.Value, trusted: avm2.Value): void {
      const host = s.socket?.secure;
      if (!value || !host) {
        throw s.rt.error("ArgumentError", 2004);
      }

      const bytes = avm2.bytesOf(s.rt, value);
      // Another worker can change a shareable ByteArray's length between reads.
      const length = bytes.length;
      const kept = state(this);
      if (
        length === 0 ||
        length > MAX_CERTIFICATE_BYTES ||
        kept.certificates.length >= MAX_SOCKET_CERTIFICATES ||
        length > MAX_SOCKET_CERTIFICATE_BYTES - kept.certificateBytes
      ) {
        throw s.rt.error("ArgumentError", 2004);
      }

      const encoded = new Uint8Array(bytes.buffer.subarray(0, length));
      let valid = false;
      try {
        valid = host.isCertificate(encoded);
      } catch {
        // A host parser failure is the same invalid certificate to ActionScript.
      }

      if (!valid) {
        throw s.rt.error("ArgumentError", 2004);
      }

      kept.certificates.push({ encoded, trusted: Boolean(trusted) });
      kept.certificateBytes += encoded.byteLength;
    }

    connect(host: avm2.Value, port: avm2.Value): void {
      const targetPort = s.rt.toInt(port);
      if (targetPort < 0 || targetPort > 65535) {
        throw s.rt.error("SecurityError", 2003);
      }

      const hostname = host === null ? "localhost" : s.rt.toString(host);
      const kept = state(this);
      sockets.get(this).closed = () => {
        kept.certificate = null;
      };
      kept.status = "unknown";
      kept.certificate = null;
      const transport = s.socket?.secure;
      const certificates = kept.certificates.map(({ encoded, trusted }) => ({
        encoded: new Uint8Array(encoded),
        trusted,
      }));
      const timeout = s.rt.prop(this as avm2.AsObject as As3<"flash.net::Socket">, "timeout");
      sockets.connect(
        this,
        transport
          ? (events, options, current) =>
              transport.connect(
                hostname,
                targetPort,
                {
                  ...events,
                  certificateError: (proceed) => {
                    if (!s.air) {
                      proceed(false);
                      return;
                    }

                    s.loads.deferHostEvent(() => {
                      if (!current()) {
                        proceed(false);
                        return;
                      }

                      const event = s.rt.construct(
                        s.rt.classNamed("flash.events::SecurityErrorEvent"),
                        "certificateError",
                        false,
                        true,
                        "Certificate for socket server is self-signed",
                        0,
                      );
                      proceed(!dispatchEvent(s, this, event) && current());
                    });
                  },
                  certificate: (status, data) => {
                    if (!current()) {
                      return;
                    }

                    const copy = data ? copyCertificate(data) : null;
                    s.loads.deferHostEvent(() => {
                      if (current()) {
                        kept.status = status;
                        kept.certificate = copy;
                      }
                    });
                  },
                },
                { ...options, certificates, timeout },
              )
          : undefined,
        2031,
      );
    }
  }

  avm2.registerNativeClass(natives, "flash.net::SecureSocket", SecureSocketNatives);
  return natives;
}
