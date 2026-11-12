// flash.net.SecureSocket: no host gives the player a TLS connection
// (hosts.ts's SocketHost is plain TCP), so it is not supported, which
// Flash Player 32 and AIR on a desktop say it is. Before a connection,
// one has no certificate and its status is "unknown", as in both.
import { avm2 } from "@swf2es/runtime";

export function secureSocketNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class SecureSocketNatives {
    static get isSupported(): boolean {
      return false;
    }

    get serverCertificateStatus(): string {
      return "unknown";
    }

    get serverCertificate(): avm2.Value {
      return null;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::SecureSocket", SecureSocketNatives);
  return natives;
}
