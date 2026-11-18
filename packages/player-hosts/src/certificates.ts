// X.509 metadata for the Node TLS host. OpenSSL parses and validates certificates;
// this reader exposes DER fields its public Node API does not describe.
import { createHash, X509Certificate } from "node:crypto";
import type { Certificate, CertificateName } from "@swf2es/player";
import { MAX_CERTIFICATE_BYTES, MAX_SOCKET_CERTIFICATES } from "@swf2es/player/certificates";

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

/**
 * Longer than any registered OID. OpenSSL keeps an OID's bytes as they came, so a
 * certificate it accepts can hold one of any length; decoding a long arc as one
 * number grew with the square of its length (a second for 100 KB).
 */
const MAX_OID_BYTES = 128;

/** 140 bits: room for a UUID's arc (2.25.x, 128 bits); plain numbers up to 7 bytes. */
const MAX_ARC_BYTES = 20;

function arc(bytes: Uint8Array, start: number, end: number): number | bigint {
  if (end - start > MAX_ARC_BYTES) {
    throw new Error("Invalid certificate OID");
  }

  if (end - start <= 7) {
    let value = 0;
    for (let i = start; i < end; i++) {
      value = value * 128 + (bytes[i] & 127);
    }
    return value;
  }

  let value = 0n;
  for (let i = start; i < end; i++) {
    value = value * 128n + BigInt(bytes[i] & 127);
  }

  return value;
}

function oid(field: Field | undefined): string {
  const bytes = content(field, 6);
  if (bytes.length === 0 || bytes.length > MAX_OID_BYTES || bytes[bytes.length - 1] & 128) {
    throw new Error("Invalid certificate OID");
  }

  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] & 128) {
      continue;
    }

    const value = arc(bytes, start, i + 1);
    if (parts.length === 0) {
      const first = value < 40 ? 0 : value < 80 ? 1 : 2;
      const rest = typeof value === "bigint" ? value - BigInt(first * 40) : value - first * 40;
      parts.push(String(first), String(rest));
    } else {
      parts.push(String(value));
    }
    start = i + 1;
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

function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

/** Code units or points to String.fromCharCode or fromCodePoint at once, under engines' limits. */
const CHUNK = 8192;

function nameString(field: Field): string {
  const bytes = field.bytes;
  switch (field.tag) {
    case 12:
      return view(bytes).toString("utf8");
    case 30:
    case 28: {
      const size = field.tag === 30 ? 2 : 4;
      const parts: string[] = [];
      const units: number[] = [];
      for (let i = 0; i + size - 1 < bytes.length; i += size) {
        units.push(
          size === 2
            ? bytes[i] * 256 + bytes[i + 1]
            : bytes[i] * 16777216 + bytes[i + 1] * 65536 + bytes[i + 2] * 256 + bytes[i + 3],
        );
        if (units.length === CHUNK) {
          parts.push(size === 2 ? String.fromCharCode(...units) : String.fromCodePoint(...units));
          units.length = 0;
        }
      }
      parts.push(size === 2 ? String.fromCharCode(...units) : String.fromCodePoint(...units));
      return parts.join("");
    }
    default:
      return view(bytes).toString("latin1");
  }
}

/** OpenSSL's escape for each byte of a name's UTF-8, or null for itself. */
const escapes: (string | null)[] = [];
for (let byte = 0; byte < 256; byte++) {
  if (byte < 32 || byte > 126) {
    escapes.push(`\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`);
  } else if (byte === 47 || byte === 43) {
    escapes.push(`\\${String.fromCharCode(byte)}`);
  } else {
    escapes.push(null);
  }
}

/** `text` as OpenSSL's one-line form writes a name's value, added to `parts`. */
function escaped(text: string, parts: string[]): void {
  const bytes = Buffer.from(text, "utf8");
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const written = escapes[bytes[i]];
    if (written !== null) {
      if (start < i) {
        parts.push(bytes.toString("latin1", start, i));
      }
      parts.push(written);
      start = i + 1;
    }
  }

  if (start === 0) {
    parts.push(text);
  } else if (start < bytes.length) {
    parts.push(bytes.toString("latin1", start));
  }
}

/**
 * Far more attributes than any real name has. OpenSSL takes any number, each costing it and
 * this reader time; a certificate past it is refused before either reads all of them.
 */
const MAX_NAME_ATTRIBUTES = 256;

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
  const text: string[] = [];
  const sets = sequence(field);
  let count = 0;
  for (const set of sets) {
    const entries = fields(content(set, 49));
    count += entries.length;
    if (count > MAX_NAME_ATTRIBUTES) {
      throw new Error("Too many certificate name attributes");
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = sequence(entries[i]);
      const id = oid(entry[0]);
      const [short, key] = attributes[id] ?? [id];
      const value = nameString(entry[1]);
      if (key && result[key] === null) {
        result[key] = value;
      }
      text.push(`/${short}=`);
      escaped(value, text);
    }
  }

  result.text = text.join("");
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

  // OpenSSL last, once the walk above has refused what would cost it time.
  const decoded = new X509Certificate(bytes);
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

/** As many answers as a socket may hold certificates: enough for one SWF's additions. */
const MAX_CHECKED = MAX_SOCKET_CERTIFICATES;
const checked = new Map<string, boolean>();

/**
 * Whether `bytes` is one DER certificate. A SWF's addition is checked as it is added and again
 * as each connection takes it, so the answer is kept, by digest, for the latest few.
 */
export function validCertificate(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES) {
    return false;
  }

  const key = createHash("sha256").update(bytes).digest("base64");
  let valid = checked.get(key);
  if (valid === undefined) {
    try {
      readCertificate(bytes);
      valid = true;
    } catch {
      valid = false;
    }
  }

  // Most recently used last, the oldest first to go.
  checked.delete(key);
  checked.set(key, valid);
  if (checked.size > MAX_CHECKED) {
    checked.delete(checked.keys().next().value as string);
  }

  return valid;
}
