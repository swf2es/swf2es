// Fuzzes @swf2es/native/atf with malformed ATF textures: cut short, bits
// flipped, runs overwritten in the LZMA and JPEG XR blocks, block lengths,
// the length, format, size and count changed, and garbage alone. A SWF
// uploads whatever bytes it has, so for any of them reading the header and
// decoding must
//
//   - not trap (jxrlib's calls are counted, as the wrapper refuses one that
//     traps), nor throw anything but AtfError;
//   - when they decode, give each level the bytes its size and encoding
//     need, within the texture's levels and faces;
//   - leave the module working: a fixture decodes right after.
//
// The seeds are tests/context3d/atf's fixtures, and the same with the old
// header. The generator is seeded, so a run repeats exactly:
//
//   node tests/fuzz/atf.ts [cases, 2000] [seed, 1]
import { readdirSync, readFileSync } from "node:fs";
import {
  AtfError,
  atfEncoding,
  decodeAtf,
  jxrTraps,
  readAtfHeader,
} from "../../packages/native/dist/atf/index.js";
import { oldHeader } from "../context3d/atf/old-header.ts";

const caseCount = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1);

/** mulberry32: a small generator whose sequence the seed fixes. */
function generator(start: number): () => number {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(seed);
const below = (n: number) => Math.floor(random() * n);

const directory = new URL("../context3d/atf/", import.meta.url);
const seeds: Uint8Array[] = [];
for (const name of readdirSync(directory)
  .filter((n) => n.endsWith(".atf"))
  .sort()) {
  const atf = new Uint8Array(readFileSync(new URL(name, directory)));
  seeds.push(atf, oldHeader(atf));
}

/** Where each block's length field is, so that mutations can aim at them and at what follows. */
function fields(atf: Uint8Array): number[] {
  const old = atf[6] !== 0xff;
  const wide = !old;
  const out: number[] = [];
  let at = old ? 10 : 16;
  while (at + (wide ? 4 : 3) <= atf.length) {
    out.push(at);
    const length = wide
      ? new DataView(atf.buffer, atf.byteOffset).getUint32(at)
      : (atf[at] << 16) | (atf[at + 1] << 8) | atf[at + 2];
    at += (wide ? 4 : 3) + length;
  }

  return out;
}

function mutate(file: Uint8Array): Uint8Array {
  const out = file.slice();
  const old = file[6] !== 0xff;
  const head = old ? 6 : 12;
  const blocks = fields(file);
  const block = blocks[below(blocks.length)] ?? head + 4;
  const after = () => Math.min(out.length - 1, block + 4 + below(64));
  switch (below(13)) {
    case 0:
      return out.subarray(0, below(file.length + 1));
    case 1:
      for (let i = 1 + below(8); i > 0; i--) {
        out[below(out.length)] ^= 1 << below(8);
      }

      return out;
    case 2: {
      // A run overwritten inside a block: LZMA's properties and stream, or JPEG XR's container and tiles.
      const from = after();
      for (let i = from; i < Math.min(out.length, from + 1 + below(96)); i++) {
        out[i] = below(256);
      }

      return out;
    }
    case 3:
      out[block + below(old ? 3 : 4)] = below(256);
      return out;
    case 4:
      // The length, smaller or larger.
      out[(old ? 3 : 8) + below(old ? 3 : 4)] = below(256);
      return out;
    case 5:
      out[head + below(4)] = below(4) === 0 ? below(256) : out[head + below(4)] + below(3) - 1;
      return out;
    case 6:
      if (!old) {
        out[7] = below(6);
      }

      return out;
    case 7: {
      const garbage = new Uint8Array(head + 4 + below(2000));
      garbage.set(out.subarray(0, head + 4));
      for (let i = head + 4; i < garbage.length; i++) {
        garbage[i] = below(256);
      }

      return garbage;
    }
    case 8: {
      // Bits flipped in one JPEG XR or LZMA header, where decoders trust most.
      const at = Math.min(out.length - 1, block + (old ? 3 : 4) + below(48));
      out[at] ^= 1 << below(8);
      return out;
    }
    case 9: {
      const longer = new Uint8Array(out.length + 1 + below(200));
      longer.set(out);
      for (let i = out.length; i < longer.length; i++) {
        longer[i] = below(256);
      }

      return longer;
    }
    case 10:
      return out.subarray(0, Math.min(out.length, block + below(80)));
    case 11: {
      // Anywhere in a block's body: the coded tiles past JPEG XR's headers, LZMA's stream.
      const from = Math.min(out.length - 1, block + below(Math.max(1, out.length - block)));
      for (let i = from; i < Math.min(out.length, from + 1 + below(8)); i++) {
        out[i] = below(256);
      }

      return out;
    }
    default:
      return out;
  }
}

const failures: string[] = [];
let decoded = 0;
let refused = 0;

function run(file: Uint8Array, n: number): boolean {
  try {
    const header = readAtfHeader(file, 0);
    const images = decodeAtf(file, header);
    const encoding = atfEncoding(header.format);
    for (const image of images) {
      const across = Math.max(1, image.width >> 2);
      const down = Math.max(1, image.height >> 2);
      const length =
        encoding === "bgra"
          ? image.width * image.height * 4
          : across * down * (encoding === "dxt1" ? 8 : 16);
      if (
        image.bytes.length !== length ||
        image.level >= header.count ||
        image.face >= (header.cube ? 6 : 1) ||
        image.width !== Math.max(1, header.width >> image.level) ||
        image.height !== Math.max(1, header.height >> image.level)
      ) {
        failures.push(`case ${n}: level ${image.level} of face ${image.face} is malformed`);
      }
    }

    return true;
  } catch (e) {
    if (!(e instanceof AtfError)) {
      failures.push(`case ${n}: ${e}`);
    }

    return false;
  }
}

for (let n = 0; n < caseCount; n++) {
  const file = mutate(seeds[below(seeds.length)]);
  if (run(file, n)) {
    decoded++;
  } else {
    refused++;
  }

  if (n % 50 === 0 && !run(seeds[below(seeds.length)], n)) {
    failures.push(`case ${n}: a fixture no longer decodes`);
  }
}

if (jxrTraps() !== 0) {
  failures.push(`${jxrTraps()} JPEG XR decodes trapped`);
}

console.log(
  `atf fuzz: ${caseCount} cases from seed ${seed}, ${decoded} decoded, ${refused} refused`,
);
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  console.log(`${failures.length} failures`);
  process.exit(1);
}
