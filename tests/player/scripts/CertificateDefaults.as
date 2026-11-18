package {
    import flash.display.Sprite;
    import flash.security.X500DistinguishedName;
    import flash.security.X509Certificate;

    public class CertificateDefaults extends Sprite {
        public function CertificateDefaults() {
            var name:X500DistinguishedName = new X500DistinguishedName();
            for each (var key:String in ["commonName", "countryName", "localityName",
                "organizationName", "organizationalUnitName", "stateOrProvinceName"]) {
                trace("name " + key + " " + (name[key] === null));
            }
            trace("name toString " + (name.toString() === null));

            var certificate:X509Certificate = new X509Certificate();
            trace("version " + certificate.version);
            for each (key in ["serialNumber", "signatureAlgorithmOID", "signatureAlgorithmParams",
                "issuer", "validNotBefore", "validNotAfter", "subject", "subjectPublicKeyAlgorithmOID",
                "subjectPublicKey", "issuerUniqueID", "subjectUniqueID", "encoded"]) {
                trace("certificate " + key + " " + (certificate[key] === null));
            }
        }
    }
}
