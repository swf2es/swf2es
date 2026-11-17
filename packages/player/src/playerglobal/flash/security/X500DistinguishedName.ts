import { avm2 } from "@swf2es/runtime";
import type { CertificateName } from "../../../certificates.js";
import type { Scripting } from "../../../scripting.js";

const names = new WeakMap<avm2.AsObject, CertificateName>();

export function distinguishedName(s: Scripting, name: CertificateName): avm2.AsObject {
  const object = s.rt.construct(s.rt.classNamed("flash.security::X500DistinguishedName"));
  names.set(object, { ...name });

  return object;
}

export function distinguishedNameNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class DistinguishedNameNatives {
    get commonName(): string | null {
      return names.get(this)?.commonName ?? null;
    }

    get countryName(): string | null {
      return names.get(this)?.countryName ?? null;
    }

    get localityName(): string | null {
      return names.get(this)?.localityName ?? null;
    }

    get organizationName(): string | null {
      return names.get(this)?.organizationName ?? null;
    }

    get organizationalUnitName(): string | null {
      return names.get(this)?.organizationalUnitName ?? null;
    }

    get stateOrProvinceName(): string | null {
      return names.get(this)?.stateOrProvinceName ?? null;
    }

    toString(): string | null {
      return names.get(this)?.text ?? null;
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.security::X500DistinguishedName",
    DistinguishedNameNatives,
  );
  return natives;
}
