// Flash's policy files (apps/desktop/src/main/policy.ts) in node: the
// parser, and what a policy grants, by Adobe's Cross Domain Policy File
// Specification, its examples among the cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowsAccess,
  allowsHeaders,
  allowsSocket,
  domainMatches,
  forbiddenHeader,
  type Policy,
  parsePolicy,
  parsePorts,
  policyContentType,
  type Requester,
  type UrlPolicy,
  urlMetaPolicy,
  usablePolicies,
} from "../../apps/desktop/src/main/policy.ts";

const DOCTYPE =
  '<?xml version="1.0"?>\n' +
  '<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">\n';

function policy(body: string): Policy {
  const parsed = parsePolicy(`${DOCTYPE}<cross-domain-policy>${body}</cross-domain-policy>`);
  assert.ok(parsed);
  return parsed;
}

const http = (host: string): Requester => ({ host, scheme: "http" });
const https = (host: string): Requester => ({ host, scheme: "https" });
const local: Requester = { host: null, scheme: null };

function served(
  url: string,
  body: string,
  contentType = "text/x-cross-domain-policy",
  permitted: string[] = [],
): UrlPolicy {
  return { policy: policy(body), url: new URL(url), contentType, permitted };
}

test("a policy is a well-formed document whose root is cross-domain-policy", () => {
  const parsed = parsePolicy(
    `﻿${DOCTYPE}<!-- a comment -->
<cross-domain-policy>
  <site-control permitted-cross-domain-policies="by-content-type"/>
  <allow-access-from domain="*.example.com" />
  <allow-access-from domain='www.example.com' secure="false"
    to-ports="507,516-523"></allow-access-from>
  <allow-http-request-headers-from domain="*.adobe.com" headers="SOAPAction, X-Foo*"/>
  <allow-access-from-identity><signatory>
    <certificate fingerprint="01" fingerprint-algorithm="sha-1"/>
  </signatory></allow-access-from-identity>
  <![CDATA[ <allow-access-from domain="cdata.example"/> ]]>
</cross-domain-policy>
`,
  );
  assert.deepEqual(parsed, {
    siteControl: "by-content-type",
    access: [
      { domain: "*.example.com", secure: null, ports: null },
      {
        domain: "www.example.com",
        secure: false,
        ports: [
          [507, 507],
          [516, 523],
        ],
      },
    ],
    headers: [{ domain: "*.adobe.com", headers: ["soapaction", "x-foo*"], secure: null }],
  });

  // A socket server's answer ends in a NUL.
  assert.equal(
    parsePolicy(
      '<cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0',
    )?.access.length,
    1,
  );
  // Entities in attributes, and an element nested deeper is no rule.
  assert.deepEqual(
    parsePolicy(
      '<cross-domain-policy><allow-access-from domain="a&amp;b&#46;c"/>' +
        '<x><allow-access-from domain="*"/></x></cross-domain-policy>',
    )?.access.map((r) => r.domain),
    ["a&b.c"],
  );

  for (const bad of [
    "",
    "not xml",
    "<cross-domain-policy>",
    '<cross-domain-policy><allow-access-from domain="*"></cross-domain-policy>',
    '<other-root><allow-access-from domain="*"/></other-root>',
    "<cross-domain-policy/><cross-domain-policy/>",
    'text<cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>',
    '<cross-domain-policy><allow-access-from domain="*" domain="x"/></cross-domain-policy>',
    '<cross-domain-policy><allow-access-from domain="&undefined;"/></cross-domain-policy>',
    '<cross-domain-policy><allow-access-from domain="a<b"/></cross-domain-policy>',
    // An internal subset's entities are never read, nor expanded.
    '<!DOCTYPE x [<!ENTITY e "*">]>' +
      '<cross-domain-policy><allow-access-from domain="&e;"/></cross-domain-policy>',
  ]) {
    assert.equal(parsePolicy(bad), null, bad);
  }

  // A self-closed root grants nothing, and is a policy.
  assert.deepEqual(parsePolicy("<cross-domain-policy/>"), {
    siteControl: null,
    access: [],
    headers: [],
  });
  // An unknown meta-policy permits nothing.
  assert.equal(
    policy('<site-control permitted-cross-domain-policies="everything"/>').siteControl,
    "none",
  );
});

test("domains match by the specification's table", () => {
  const cases: [string, Requester, boolean][] = [
    ["www.example.com", http("www.example.com"), true],
    ["www.example.com", http("example.com"), false],
    ["www.example.com", http("www.example.net"), false],
    ["WWW.Example.COM", http("www.example.com"), true],
    ["*.example.com", http("example.com"), true],
    ["*.example.com", http("www.example.com"), true],
    ["*.example.com", http("deep.subdomain.example.com"), true],
    ["*.example.com", http("www.example.net"), false],
    ["*.example.com", http("badexample.com"), false],
    ["http://*.example.com", http("www.example.com"), true],
    ["http://*.example.com", https("www.example.com"), false],
    ["https://www.example.com", https("www.example.com"), true],
    ["127.0.0.1", http("127.0.0.1"), true],
    ["127.0.0.1", http("localhost"), false],
    ["127.0.0.1", http("127.0.0.2"), false],
    ["[::1]", http("::1"), true],
    ["www.example.*", http("www.example.com"), false],
    ["*.com", http("example.com"), false],
    ["*.1.2.3", http("4.1.2.3"), false],
    ["*", http("anything.test"), true],
    ["*", local, true],
    // A local SWF has no domain: only "*" names it.
    ["*.example.com", local, false],
    ["localhost", local, false],
  ];
  for (const [pattern, requester, expected] of cases) {
    assert.equal(domainMatches(pattern, requester), expected, `${pattern} ~ ${requester.host}`);
  }
});

test("an HTTPS policy grants an HTTP SWF only where secure is false", () => {
  const target = new URL("https://data.test/x.txt");
  const strict = served("https://data.test/crossdomain.xml", '<allow-access-from domain="*"/>');
  const loose = served(
    "https://data.test/crossdomain.xml",
    '<allow-access-from domain="*" secure="false"/>',
  );
  assert.equal(allowsAccess([strict], https("swf.test"), target), true);
  assert.equal(allowsAccess([strict], http("swf.test"), target), false);
  assert.equal(allowsAccess([strict], local, target), false);
  assert.equal(allowsAccess([loose], http("swf.test"), target), true);
  assert.equal(allowsAccess([loose], local, target), true);

  // Over HTTP, secure means nothing.
  const plain = served("http://data.test/crossdomain.xml", '<allow-access-from domain="*"/>');
  assert.equal(allowsAccess([plain], http("swf.test"), new URL("http://data.test/x")), true);
  // A policy is its own origin's, not another port's or scheme's.
  assert.equal(allowsAccess([plain], http("swf.test"), new URL("http://data.test:8080/x")), false);
  assert.equal(allowsAccess([plain], http("swf.test"), new URL("https://data.test/x")), false);
});

test("the meta-policy chooses which of a site's policy files count", () => {
  const master = (control: string | null, permitted: string[] = []) =>
    served(
      "http://data.test/crossdomain.xml",
      (control ? `<site-control permitted-cross-domain-policies="${control}"/>` : "") +
        '<allow-access-from domain="master.test"/>',
      "text/xml",
      permitted,
    );
  const named = served(
    "http://data.test/api/policy.xml",
    '<allow-access-from domain="swf.test"/>',
    "text/x-cross-domain-policy",
  );
  const plainType = { ...named, contentType: "text/xml" };
  const inApi = new URL("http://data.test/api/v1/data");
  const atTop = new URL("http://data.test/data");

  // Flash Player 10's default: the master alone.
  assert.equal(urlMetaPolicy(null), "master-only");
  assert.equal(urlMetaPolicy(master(null)), "master-only");
  assert.deepEqual(usablePolicies(null, [named]), []);
  assert.deepEqual(usablePolicies(master("master-only"), [named]).length, 1);

  // "all": the master and any other, within its own directory.
  const all = usablePolicies(master("all"), [named]);
  assert.equal(allowsAccess(all, http("swf.test"), inApi), true);
  assert.equal(allowsAccess(all, http("swf.test"), atTop), false);
  assert.equal(allowsAccess(all, http("master.test"), atTop), true);

  // by-content-type: only another served as text/x-cross-domain-policy.
  assert.equal(usablePolicies(master("by-content-type"), [named]).length, 2);
  assert.equal(usablePolicies(master("by-content-type"), [plainType]).length, 1);
  assert.equal(usablePolicies(master("by-ftp-filename"), [named]).length, 1);

  // none: not even the master grants.
  assert.deepEqual(usablePolicies(master("none"), [named]), []);
  // The header too, the stricter of the two winning.
  assert.equal(urlMetaPolicy(master("all", ["none"])), "none");
  assert.equal(urlMetaPolicy(master(null, ["all"])), "all");
  assert.equal(urlMetaPolicy(master("master-only", ["all"])), "master-only");

  assert.equal(policyContentType("text/x-cross-domain-policy"), true);
  assert.equal(policyContentType("text/plain"), true);
  assert.equal(policyContentType("application/xml"), true);
  assert.equal(policyContentType("application/xhtml+xml"), true);
  assert.equal(policyContentType("application/octet-stream"), false);
  assert.equal(policyContentType("image/png"), false);
});

test("headers go cross-domain only as allow-http-request-headers-from lists them", () => {
  const p = served(
    "http://data.test/crossdomain.xml",
    '<allow-http-request-headers-from domain="www.example.com" headers="Authorization,X-Foo*"/>' +
      '<allow-http-request-headers-from domain="foo.example.com" headers="X-Foo*"/>',
  );
  const target = new URL("http://data.test/x");
  assert.equal(allowsHeaders([p], http("www.example.com"), target, ["Authorization"]), true);
  assert.equal(allowsHeaders([p], http("www.example.com"), target, ["x-foo-bar", "X-FOO"]), true);
  assert.equal(allowsHeaders([p], http("foo.example.com"), target, ["X-Foo-1"]), true);
  assert.equal(allowsHeaders([p], http("foo.example.com"), target, ["Authorization"]), false);
  assert.equal(allowsHeaders([p], http("other.test"), target, ["X-Foo"]), false);
  const any = served(
    "http://data.test/crossdomain.xml",
    '<allow-http-request-headers-from domain="*" headers="*"/>',
  );
  assert.equal(allowsHeaders([any], local, target, ["SOAPAction", "X-Anything"]), true);
  // Access is not headers, nor headers access.
  assert.equal(allowsAccess([any], local, target), false);
});

test("socket policies grant ports by to-ports, the 1024 rule and the meta-policy", () => {
  const socket = (body: string, port: number) => ({ policy: policy(body), port });
  const swf = http("swf.test");
  const master = socket('<allow-access-from domain="swf.test" to-ports="507,516-523"/>', 843);
  assert.equal(allowsSocket(master, [], swf, 507), true);
  assert.equal(allowsSocket(master, [], swf, 520), true);
  assert.equal(allowsSocket(master, [], swf, 524), false);
  assert.equal(allowsSocket(master, [], http("other.test"), 507), false);

  // Without to-ports a rule grants no port.
  assert.equal(allowsSocket(socket('<allow-access-from domain="*"/>', 843), [], swf, 507), false);

  // A policy from a port of 1024 or above grants only ports of 1024 and above.
  const high = socket('<allow-access-from domain="*" to-ports="*"/>', 5000);
  assert.equal(allowsSocket(null, [high], swf, 5000), true);
  assert.equal(allowsSocket(null, [high], swf, 80), false);
  const low = socket('<allow-access-from domain="*" to-ports="*"/>', 80);
  assert.equal(allowsSocket(null, [low], swf, 80), true);

  // The master's meta-policy: by default "all"; master-only and none shut the others out.
  const only = socket('<site-control permitted-cross-domain-policies="master-only"/>', 843);
  const none = socket(
    '<site-control permitted-cross-domain-policies="none"/>' +
      '<allow-access-from domain="*" to-ports="*"/>',
    843,
  );
  assert.equal(allowsSocket(only, [high], swf, 5000), false);
  assert.equal(allowsSocket(none, [high], swf, 5000), false);
  assert.equal(allowsSocket(none, [], swf, 5000), false);

  // secure, false by default in a socket policy, true for HTTPS SWFs alone.
  const secure = socket('<allow-access-from domain="*" to-ports="*" secure="true"/>', 843);
  assert.equal(allowsSocket(secure, [], swf, 5000), false);
  assert.equal(allowsSocket(secure, [], https("swf.test"), 5000), true);

  assert.deepEqual(parsePorts("*"), [[1, 65535]]);
  assert.deepEqual(parsePorts(" 80 , 100-200"), [
    [80, 80],
    [100, 200],
  ]);
  for (const bad of ["", "0", "70000", "200-100", "80,", "x", "1-2-3"]) {
    assert.equal(parsePorts(bad), null, bad);
  }
});

test("a SWF sends none of the headers Flash refused it", () => {
  for (const name of [
    "Cookie",
    "user-agent",
    "Content_Length",
    "Host",
    "Proxy-Foo",
    "Sec-Fetch-Mode",
    "x-flash-version",
  ]) {
    assert.equal(forbiddenHeader(name), true, name);
  }

  for (const name of ["Content-Type", "SOAPAction", "X-Requested-With", "Accept"]) {
    assert.equal(forbiddenHeader(name), false, name);
  }
});
