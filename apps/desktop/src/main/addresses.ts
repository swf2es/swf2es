// Where an IP address is, for the network the desktop app reaches for a
// SWF: on the internet, on a private network (a LAN, a link, a cloud's
// metadata service at 169.254.169.254), or on this machine. A SWF reaches
// a place more private than the one it came from only as that place's own
// policy file allows, as Chromium's Private Network Access asks a server
// there before a public page may. Some addresses no request may reach.
// Pure, so that node tests it (tests/desktop/network.test.ts).
import { isIPv4, isIPv6 } from "node:net";

export type AddressClass = "public" | "private" | "loopback";

/** How private a class is: a request to a higher rank than its SWF's needs the target's word. */
export const RANK: Record<AddressClass, number> = { public: 0, private: 1, loopback: 2 };

/** An IPv4 address as a number, or null. */
function ipv4(text: string): number | null {
  if (!isIPv4(text)) {
    return null;
  }

  return text.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

const inV4 = (n: number, base: string, bits: number): boolean => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === ((ipv4(base) as number) & mask) >>> 0;
};

function classOfV4(n: number): AddressClass | null {
  // This network, multicast, and the reserved block with broadcast: never a server.
  if (inV4(n, "0.0.0.0", 8) || inV4(n, "224.0.0.0", 4) || inV4(n, "240.0.0.0", 4)) {
    return null;
  }

  if (inV4(n, "127.0.0.0", 8)) {
    return "loopback";
  }

  const special: [string, number][] = [
    ["10.0.0.0", 8],
    // Carrier-grade NAT.
    ["100.64.0.0", 10],
    // Link-local, where clouds keep their metadata service.
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    // The documentation and benchmarking blocks, never on the internet.
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
  ];
  return special.some(([base, bits]) => inV4(n, base, bits)) ? "private" : "public";
}

/** An IPv6 address's 16 bytes, its zone dropped; null if it is not one. */
function ipv6(text: string): Uint8Array | null {
  const address = text.replace(/%.*$/, "");
  if (!isIPv6(address)) {
    return null;
  }

  let head = address;
  let tail = "";
  const bytes = new Uint8Array(16);
  // A dotted IPv4 tail fills the last four bytes.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  let v4: number | null = null;
  if (dotted) {
    v4 = ipv4(dotted[2]);
    head = `${dotted[1]}0:0`;
  }

  const halves = head.split("::");
  [head, tail] = [halves[0], halves[1] ?? ""];
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const front = groups(head);
  const back = groups(tail);
  const all = [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  all.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  if (v4 !== null) {
    bytes.set([v4 >>> 24, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff], 12);
  }

  return bytes;
}

const v4At = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

function startsWith(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[byte] & mask) !== ((prefix[byte] ?? 0) & mask)) {
      return false;
    }
  }

  return true;
}

function classOfV6(bytes: Uint8Array): AddressClass | null {
  const zero = (from: number, to: number) => bytes.subarray(from, to).every((b) => b === 0);
  if (zero(0, 16)) {
    return null;
  }

  if (zero(0, 15) && bytes[15] === 1) {
    return "loopback";
  }

  // An IPv4 address within, mapped, translated (RFC 2765's ::ffff:0:a.b.c.d),
  // compatible, by NAT64 or by 6to4: that address's class.
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classOfV4(v4At(bytes, 12));
  }

  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) {
    return classOfV4(v4At(bytes, 12));
  }

  if (zero(0, 12)) {
    return classOfV4(v4At(bytes, 12));
  }

  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b], 96)) {
    return classOfV4(v4At(bytes, 12));
  }

  if (startsWith(bytes, [0x20, 0x02], 16)) {
    return classOfV4(v4At(bytes, 2));
  }

  // Multicast, and the discard block.
  if (bytes[0] === 0xff || startsWith(bytes, [0x01, 0x00], 64)) {
    return null;
  }

  const special: [number[], number][] = [
    // Unique local, link-local and the old site-local.
    [[0xfc], 7],
    [[0xfe, 0x80], 10],
    [[0xfe, 0xc0], 10],
    // NAT64 for local use, Teredo, whose IPv4 address is hidden, and documentation.
    [[0, 0x64, 0xff, 0x9b, 0, 1], 48],
    [[0x20, 0x01, 0, 0], 32],
    [[0x20, 0x01, 0x0d, 0xb8], 32],
  ];
  return special.some(([prefix, bits]) => startsWith(bytes, prefix, bits)) ? "private" : "public";
}

/** Where `address` is; null for one no request may reach, or for what is no IP address. */
export function addressClass(address: string): AddressClass | null {
  const v4 = ipv4(address);
  if (v4 !== null) {
    return classOfV4(v4);
  }

  const v6 = ipv6(address.replace(/^\[(.*)\]$/, "$1"));
  return v6 ? classOfV6(v6) : null;
}

/**
 * The ports the Fetch standard blocks, as browsers do, so that a request
 * cannot speak HTTP to a mail, shell or name server; Flash in a browser
 * went through the browser's network and met the same list.
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export function badPort(port: number): boolean {
  return BAD_PORTS.has(port);
}
