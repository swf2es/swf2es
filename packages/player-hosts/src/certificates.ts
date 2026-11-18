// X.509 metadata for the Node TLS host. OpenSSL parses and validates certificates;
// this reader exposes DER fields its public Node API does not describe.
import { X509Certificate } from "node:crypto";
import type { Certificate, CertificateName } from "@swf2es/player";

export const MAX_CERTIFICATE_BYTES = 256 * 1024;

interface Field {
  tag: number;
  bytes: Uint8Array;
}

/** Definite, bounded DER lengths only. No recursive walk through arbitrary input. */
function fields(bytes: Uint8Array): Field[] {
  const result: Field[] = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = bytes[at++];
    if ((tag & 31) === 31 || at >= bytes.length) {
      throw new Error("Invalid certificate DER");
    }

    let length = bytes[at++];
    if (length & 128) {
      const count = length & 127;
      if (count === 0 || count > 4 || at + count > bytes.length || bytes[at] === 0) {
        throw new Error("Invalid certificate DER length");
      }

      length = 0;
      for (let i = 0; i < count; i++) {
        length = length * 256 + bytes[at++];
      }
      if (length < 128) {
        throw new Error("Non-minimal certificate DER length");
      }
    }

    if (length > bytes.length - at) {
      throw new Error("Truncated certificate DER");
    }

    result.push({ tag, bytes: bytes.subarray(at, at + length) });
    at += length;
  }

  return result;
}

function content(field: Field | undefined, tag: number): Uint8Array {
  if (!field || field.tag !== tag) {
    throw new Error("Unexpected certificate DER field");
  }

  return field.bytes;
}

function sequence(field: Field | undefined): Field[] {
  return fields(content(field, 48));
}

function oid(field: Field | undefined): string {
  const bytes = content(field, 6);
  const parts: bigint[] = [];
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = value * 128n + BigInt(bytes[i] & 127);
    if (!(bytes[i] & 128)) {
      if (parts.length === 0) {
        let first = 2n;
        if (value < 40n) {
          first = 0n;
        } else if (value < 80n) {
          first = 1n;
        }
        parts.push(first, value - first * 40n);
      } else {
        parts.push(value);
      }
      value = 0n;
    }
  }

  if (parts.length === 0 || bytes[bytes.length - 1] & 128) {
    throw new Error("Invalid certificate OID");
  }

  return parts.join(".");
}

const attributes: Record<string, [string, (keyof CertificateName)?]> = {
  "2.5.4.3": ["CN", "commonName"],
  "2.5.4.6": ["C", "countryName"],
  "2.5.4.7": ["L", "localityName"],
  "2.5.4.8": ["ST", "stateOrProvinceName"],
  "2.5.4.10": ["O", "organizationName"],
  "2.5.4.11": ["OU", "organizationalUnitName"],
  "2.5.4.4": ["SN"],
  "2.5.4.5": ["serialNumber"],
  "2.5.4.9": ["street"],
  "2.5.4.12": ["title"],
  "2.5.4.42": ["GN"],
  "2.5.4.46": ["dnQualifier"],
  "1.2.840.113549.1.9.1": ["emailAddress"],
  "0.9.2342.19200300.100.1.25": ["DC"],
  "0.9.2342.19200300.100.1.1": ["UID"],
};

function nameString(field: Field): string {
  switch (field.tag) {
    case 12:
      return Buffer.from(field.bytes).toString("utf8");
    case 30: {
      let text = "";
      for (let i = 0; i + 1 < field.bytes.length; i += 2) {
        text += String.fromCharCode(field.bytes[i] * 256 + field.bytes[i + 1]);
      }
      return text;
    }
    case 28: {
      let text = "";
      for (let i = 0; i + 3 < field.bytes.length; i += 4) {
        const point =
          field.bytes[i] * 16777216 +
          field.bytes[i + 1] * 65536 +
          field.bytes[i + 2] * 256 +
          field.bytes[i + 3];
        text += String.fromCodePoint(point);
      }
      return text;
    }
    default:
      return Buffer.from(field.bytes).toString("latin1");
  }
}

function escaped(text: string): string {
  let result = "";
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte < 32 || byte > 126) {
      result += `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      if (byte === 47 || byte === 43) {
        result += "\\";
      }
      result += String.fromCharCode(byte);
    }
  }

  return result;
}

function name(field: Field | undefined): CertificateName {
  const result: CertificateName = {
    text: "",
    commonName: null,
    countryName: null,
    localityName: null,
    organizationName: null,
    organizationalUnitName: null,
    stateOrProvinceName: null,
  };
  const sets = sequence(field);
  for (const set of sets) {
    const entries = fields(content(set, 49));
    for (let i = 0; i < entries.length; i++) {
      const entry = sequence(entries[i]);
      const id = oid(entry[0]);
      const [short, key] = attributes[id] ?? [id];
      const text = nameString(entry[1]);
      if (key && result[key] === null) {
        result[key] = text;
      }
      result.text += `/${short}=${escaped(text)}`;
    }
  }

  return result;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** DER only: PEM, trailing bytes and auxiliary trust metadata are not SWF inputs. */
export function readCertificate(bytes: Uint8Array): Certificate {
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES) {
    throw new Error("Invalid certificate size");
  }

  const top = fields(bytes);
  if (top.length !== 1) {
    throw new Error("Trailing certificate data");
  }

  const decoded = new X509Certificate(bytes);
  const certificate = sequence(top[0]);
  const tbs = sequence(certificate[0]);
  let at = 0;
  let version = 0;
  if (tbs[0].tag === 160) {
    const versionBytes = content(fields(tbs[at++].bytes)[0], 2);
    if (versionBytes.length !== 1 || versionBytes[0] > 2) {
      throw new Error("Invalid certificate version");
    }
    version = versionBytes[0];
  }

  at += 2; // serial and the signature algorithm, also available outside TBSCertificate.
  const issuer = name(tbs[at++]);
  at++; // OpenSSL decodes the validity dates.
  const subject = name(tbs[at++]);
  const publicKey = sequence(tbs[at++]);
  const publicAlgorithm = sequence(publicKey[0]);
  const signature = sequence(certificate[1]);
  let issuerUniqueID: string | null = null;
  let subjectUniqueID: string | null = null;
  for (; at < tbs.length; at++) {
    switch (tbs[at].tag) {
      case 129:
        issuerUniqueID = hex(tbs[at].bytes.subarray(1));
        break;
      case 130:
        subjectUniqueID = hex(tbs[at].bytes.subarray(1));
        break;
    }
  }

  return {
    version,
    serialNumber: decoded.serialNumber.toLowerCase(),
    signatureAlgorithmOID: `OID.${oid(signature[0])}`,
    signatureAlgorithmParams: new Uint8Array(signature[1]?.bytes ?? []),
    issuer,
    subject,
    validNotBefore: decoded.validFromDate.getTime(),
    validNotAfter: decoded.validToDate.getTime(),
    subjectPublicKeyAlgorithmOID: `OID.${oid(publicAlgorithm[0])}`,
    subjectPublicKey: hex(content(publicKey[1], 3).subarray(1)),
    issuerUniqueID,
    subjectUniqueID,
    encoded: new Uint8Array(decoded.raw),
  };
}

export function validCertificate(bytes: Uint8Array): boolean {
  try {
    readCertificate(bytes);
    return true;
  } catch {
    return false;
  }
}
