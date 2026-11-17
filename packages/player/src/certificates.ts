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
