// Where an address is (apps/desktop/src/main/addresses.ts), in every form
// an IPv4 address takes inside an IPv6 one, and the ports never reached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressClass, badPort } from "../../apps/desktop/src/main/addresses.ts";

test("addresses are this machine, a private network, the internet, or nowhere", () => {
  const cases: [string, string | null][] = [
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "private"],
    ["100.64.0.1", "private"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "private"],
    ["fe80::1%eth0", "private"],
    ["fec0::1", "private"],
    ["2001:db8::1", "private"],
    // Teredo hides its IPv4 address: private, as it may be anything.
    ["2001:0:4136:e378::1", "private"],
    ["64:ff9b:1::1", "private"],
    ["93.184.216.34", "public"],
    ["2606:4700::1111", "public"],
    ["0.0.0.0", null],
    ["0.1.2.3", null],
    ["::", null],
    ["224.0.0.1", null],
    ["239.255.255.250", null],
    ["255.255.255.255", null],
    ["240.0.0.1", null],
    ["ff02::1", null],
    ["100::1", null],
    ["not an address", null],
    ["localhost", null],
  ];
  for (const [address, expected] of cases) {
    assert.equal(addressClass(address), expected, address);
  }
});

test("an IPv4 address inside an IPv6 one is that IPv4 address", () => {
  for (const [v4, expected] of [
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["169.254.169.254", "private"],
    ["8.8.8.8", "public"],
    ["0.0.0.0", null],
  ] as const) {
    const [a, b, c, d] = v4.split(".").map(Number);
    const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    const sixToFour = `2002:${hex}::1`;
    for (const form of [
      // Mapped, dotted and in hex.
      `::ffff:${v4}`,
      `::ffff:${hex}`,
      `0:0:0:0:0:ffff:${v4}`,
      // Translated, RFC 2765.
      `::ffff:0:${v4}`,
      `::ffff:0:${hex}`,
      // Compatible, deprecated.
      `::${v4}`,
      // NAT64's well-known prefix.
      `64:ff9b::${v4}`,
      `64:ff9b::${hex}`,
      // 6to4.
      sixToFour,
    ]) {
      // ::0.0.0.0 is :: itself, and ::0.0.0.1 would be ::1: both said above.
      if (form === "::0.0.0.0") {
        continue;
      }

      assert.equal(addressClass(form), expected, form);
    }
  }
});

test("the Fetch standard's bad ports are never reached", () => {
  for (const port of [25, 22, 6667, 10080, 1]) {
    assert.equal(badPort(port), true, String(port));
  }

  for (const port of [80, 443, 8080, 843, 5000]) {
    assert.equal(badPort(port), false, String(port));
  }
});
