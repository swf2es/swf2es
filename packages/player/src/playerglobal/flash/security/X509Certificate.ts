import { avm2 } from "@swf2es/runtime";
import type { Certificate } from "../../../certificates.js";
import type { Scripting } from "../../../scripting.js";
import { distinguishedName } from "./X500DistinguishedName.js";

const certificates = new WeakMap<avm2.AsObject, Certificate>();

/** A snapshot: neither the host nor the SWF can change a certificate already handed out. */
export function certificate(s: Scripting, data: Certificate): avm2.AsObject {
  const object = s.rt.construct(s.rt.classNamed("flash.security::X509Certificate"));
  certificates.set(object, {
    ...data,
    issuer: { ...data.issuer },
    subject: { ...data.subject },
    signatureAlgorithmParams: new Uint8Array(data.signatureAlgorithmParams),
    encoded: new Uint8Array(data.encoded),
  });

  return object;
}

export function certificateNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const bytes = (data: Uint8Array | undefined): avm2.Value => {
    if (!data) {
      return null;
    }

    const object = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray"));
    // AIR returns a fresh ByteArray with its position at the end.
    avm2.bytesOf(s.rt, object).write(data);
    return object;
  };
  const date = (time: number | undefined): avm2.Value =>
    time === undefined ? null : s.rt.construct(s.rt.classNamed("Date"), time);

  class CertificateNatives {
    get version(): number {
      return certificates.get(this)?.version ?? 0;
    }

    get serialNumber(): string | null {
      return certificates.get(this)?.serialNumber ?? null;
    }

    get signatureAlgorithmOID(): string | null {
      return certificates.get(this)?.signatureAlgorithmOID ?? null;
    }

    get signatureAlgorithmParams(): avm2.Value {
      return bytes(certificates.get(this)?.signatureAlgorithmParams);
    }

    get issuer(): avm2.Value {
      const name = certificates.get(this)?.issuer;
      return name ? distinguishedName(s, name) : null;
    }

    get validNotBefore(): avm2.Value {
      return date(certificates.get(this)?.validNotBefore);
    }

    get validNotAfter(): avm2.Value {
      return date(certificates.get(this)?.validNotAfter);
    }

    get subject(): avm2.Value {
      const name = certificates.get(this)?.subject;
      return name ? distinguishedName(s, name) : null;
    }

    get subjectPublicKeyAlgorithmOID(): string | null {
      return certificates.get(this)?.subjectPublicKeyAlgorithmOID ?? null;
    }

    get subjectPublicKey(): string | null {
      return certificates.get(this)?.subjectPublicKey ?? null;
    }

    get issuerUniqueID(): string | null {
      return certificates.get(this)?.issuerUniqueID ?? null;
    }

    get subjectUniqueID(): string | null {
      return certificates.get(this)?.subjectUniqueID ?? null;
    }

    get encoded(): avm2.Value {
      return bytes(certificates.get(this)?.encoded);
    }
  }

  avm2.registerNativeClass(natives, "flash.security::X509Certificate", CertificateNatives);
  return natives;
}
