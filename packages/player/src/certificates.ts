/** Shared limits for player admission and host validation of socket certificates. */
export const MAX_CERTIFICATE_BYTES = 256 * 1024;
export const MAX_SOCKET_CERTIFICATES = 64;
export const MAX_SOCKET_CERTIFICATE_BYTES = 4 * 1024 * 1024;

/** A host's decoded X.509 name, including its original order and repeated attributes. */
export interface CertificateName {
  text: string;
  commonName: string | null;
  countryName: string | null;
  localityName: string | null;
  organizationName: string | null;
  organizationalUnitName: string | null;
  stateOrProvinceName: string | null;
}

/** Certificate metadata, never a trust decision. Dates are milliseconds since the epoch. */
export interface Certificate {
  version: number;
  serialNumber: string;
  signatureAlgorithmOID: string;
  signatureAlgorithmParams: Uint8Array;
  issuer: CertificateName;
  validNotBefore: number;
  validNotAfter: number;
  subject: CertificateName;
  subjectPublicKeyAlgorithmOID: string;
  subjectPublicKey: string;
  issuerUniqueID: string | null;
  subjectUniqueID: string | null;
  encoded: Uint8Array;
}

export function copyCertificate(data: Certificate): Certificate {
  return {
    ...data,
    issuer: { ...data.issuer },
    subject: { ...data.subject },
    signatureAlgorithmParams: new Uint8Array(data.signatureAlgorithmParams),
    encoded: new Uint8Array(data.encoded),
  };
}
