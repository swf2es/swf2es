// Generated certificates only, shared by the Node host and desktop TLS tests.
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tlsCertificates() {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-tls-"));
  const dispose = () => rmSync(dir, { recursive: true, force: true });
  const run = (...args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`openssl: ${result.stderr || result.error?.message}`);
    }
  };
  const read = (name: string) => readFileSync(join(dir, name));
  const key = ["-newkey", "rsa:2048", "-nodes"];
  const subject = "/C=FI/ST=Uusimaa/L=Helsinki/O=swf2es Test/OU=First/OU=Second/CN=localhost";
  try {
    run(
      "req",
      "-x509",
      ...key,
      "-days",
      "365",
      "-set_serial",
      "0x1234",
      "-subj",
      "/CN=swf2es test root",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    );
    run(
      "req",
      ...key,
      "-subj",
      "/CN=swf2es intermediate",
      "-keyout",
      "intermediate.key",
      "-out",
      "intermediate.csr",
    );
    writeFileSync(
      join(dir, "intermediate.ext"),
      "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
    );
    run(
      "x509",
      "-req",
      "-in",
      "intermediate.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-set_serial",
      "0x1235",
      "-days",
      "365",
      "-extfile",
      "intermediate.ext",
      "-out",
      "intermediate.pem",
    );
    run("req", ...key, "-subj", subject, "-keyout", "leaf.key", "-out", "leaf.csr");
    writeFileSync(
      join(dir, "leaf.ext"),
      "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n",
    );
    const sign = (issuer: string, file: string, days: string) =>
      run(
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        `${issuer}.pem`,
        "-CAkey",
        `${issuer}.key`,
        "-set_serial",
        "0x80ab12",
        "-days",
        days,
        "-extfile",
        "leaf.ext",
        "-out",
        file,
      );
    sign("ca", "leaf.pem", "365");
    sign("intermediate", "chain.pem", "365");
    writeFileSync(join(dir, "index"), "");
    writeFileSync(join(dir, "serial"), "1000\n");
    writeFileSync(
      join(dir, "ca.conf"),
      "[ca]\ndefault_ca=test\n[test]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=365\npolicy=names\nunique_subject=no\n[names]\ncommonName=supplied\n",
    );
    const dated = (file: string, from: string, to: string) =>
      run(
        "ca",
        "-batch",
        "-config",
        "ca.conf",
        "-in",
        "leaf.csr",
        "-startdate",
        from,
        "-enddate",
        to,
        "-extfile",
        "leaf.ext",
        "-notext",
        "-out",
        file,
      );
    dated("expired.pem", "20000101000000Z", "20010101000000Z");
    dated("future.pem", "20990101000000Z", "21000101000000Z");
    run(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-utf8",
      "-subj",
      "/C=FI/O=Café/OU=A+CN=localhost/CN=Second/emailAddress=test@example.invalid",
      "-keyout",
      "self.key",
      "-out",
      "self.pem",
      "-days",
      "365",
      "-addext",
      "subjectAltName=DNS:localhost",
    );
    const der = (name: string) => new X509Certificate(read(name)).raw;
    return {
      key: read("leaf.key"),
      leaf: read("leaf.pem"),
      chain: read("chain.pem"),
      expired: read("expired.pem"),
      future: read("future.pem"),
      self: read("self.pem"),
      selfKey: read("self.key"),
      ca: der("ca.pem"),
      intermediate: der("intermediate.pem"),
      leafDer: der("leaf.pem"),
      selfDer: der("self.pem"),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
