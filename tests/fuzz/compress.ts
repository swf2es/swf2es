// Fuzzes @swf2es/native/compress through format's functions with malformed CWS and
// ZWS SWFs, zlib and raw deflate streams, and ByteArray LZMA: cut short,
// bits flipped, runs overwritten, LZMA properties and zlib headers changed,
// declared lengths wrong in both directions, garbage after the stream, and
// garbage alone. A SWF loads whatever a page or a script hands it, so for
// any bytes each call must
//
//   - not trap (a trap is a WebAssembly.RuntimeError), nor throw anything
//     but CompressedDataError, or TypeError for what is not a SWF;
//   - when decompressSwf succeeds, give the length its header names, and
//     decompressSwfPrefix the same bytes as far as it is asked;
//   - when decompressSwf fails, still give a prefix that starts with the
//     header, and never more than asked;
//   - leave the module working: a valid stream decodes right after.
//
// The seeds are synthetic SWF bodies of a few shapes, compressed by the
// package itself. The generator is seeded, so a run repeats exactly:
//
//   node tests/fuzz/compress.ts [cases, 2000] [seed, 1]
import {
  CompressedDataError,
  decompressSwf,
  decompressSwfPrefix,
  deflateCompress,
  lzmaByteArrayCompress,
  lzmaByteArrayUncompress,
  zlibCompress,
  zlibUncompress,
} from "../../packages/format/dist/index.js";

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

/** A body: text-like runs, noise, zeros, or a mix, as SWFs hold. */
function body(): Uint8Array {
  const out = new Uint8Array(below(4) === 0 ? below(64) : 64 + below(40_000));
  const shape = below(4);
  for (let i = 0; i < out.length; i++) {
    out[i] =
      shape === 0
        ? 97 + ((i * 7 + (i >> 5)) % 13)
        : shape === 1
          ? below(256)
          : shape === 2
            ? 0
            : i % 300 < 150
              ? below(4)
              : out[i - 150];
  }

  return out;
}

function swf(signature: "CWS" | "ZWS", data: Uint8Array): Uint8Array {
  if (signature === "CWS") {
    const z = zlibCompress(data, ([1, 6, 9] as const)[below(3)]);
    const out = new Uint8Array(8 + z.length);
    out.set([0x43, 0x57, 0x53, 10]);
    new DataView(out.buffer).setUint32(4, 8 + data.length, true);
    out.set(z, 8);
    return out;
  }

  const l = lzmaByteArrayCompress(data);
  const out = new Uint8Array(17 + l.length - 13);
  out.set([0x5a, 0x57, 0x53, 13]);
  new DataView(out.buffer).setUint32(4, 8 + data.length, true);
  new DataView(out.buffer).setUint32(8, l.length - 13, true);
  out.set(l.subarray(0, 5), 12);
  out.set(l.subarray(13), 17);
  return out;
}

function mutate(file: Uint8Array): Uint8Array {
  const out = file.slice();
  const view = new DataView(out.buffer);
  const start = file[0] === 0x5a ? 17 : 8;
  const at = () => start + below(Math.max(1, out.length - start));
  switch (below(10)) {
    case 0:
      return out.subarray(0, start + below(file.length - start + 1));
    case 1:
      for (let i = 1 + below(8); i > 0; i--) {
        out[at()] ^= 1 << below(8);
      }

      return out;
    case 2: {
      const from = at();
      for (let i = from; i < Math.min(out.length, from + 1 + below(64)); i++) {
        out[i] = below(256);
      }

      return out;
    }
    case 3:
      view.setUint32(4, below(view.getUint32(4, true) + 1), true);
      return out;
    case 4:
      view.setUint32(4, (view.getUint32(4, true) + 1 + below(2 ** 31)) >>> 0, true);
      return out;
    case 5:
      out[(file[0] === 0x5a ? 12 + below(5) : 8 + below(2)) % out.length] = below(256);
      return out;
    case 6: {
      const longer = new Uint8Array(out.length + 1 + below(200));
      longer.set(out);
      for (let i = out.length; i < longer.length; i++) {
        longer[i] = below(256);
      }

      return longer;
    }
    case 7: {
      const garbage = new Uint8Array(start + below(600));
      garbage.set(out.subarray(0, start));
      for (let i = start; i < garbage.length; i++) {
        garbage[i] = below(256);
      }

      return garbage;
    }
    case 8:
      out[start + below(Math.min(16, Math.max(1, out.length - start)))] ^= 1 << below(8);
      return out;
    default:
      return out;
  }
}

const failures: string[] = [];
let decoded = 0;
let refused = 0;

/** `f`'s result, or null for a refusal it may make; anything else is a failure. */
function attempt<T>(what: string, f: () => T): T | null {
  try {
    return f();
  } catch (e) {
    if (e instanceof CompressedDataError || (e instanceof TypeError && what === "swf")) {
      return null;
    }

    failures.push(
      `${what}: ${(e as Error).constructor.name === "RuntimeError" ? "TRAP " : ""}${e}`,
    );
    return null;
  }
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

for (let n = 0; n < caseCount; n++) {
  const data = body();
  const signature = below(2) === 0 ? "CWS" : "ZWS";
  const file = mutate(swf(signature, data));
  const header = new DataView(file.buffer, file.byteOffset).getUint32(4, true);
  const whole = attempt("swf", () => decompressSwf(file));
  const ask = [0, 9, 64, 300, 1 << 20][below(5)];
  const prefix = attempt("prefix", () => decompressSwfPrefix(file, ask));
  if (
    prefix === null ||
    prefix.length > Math.max(8, ask) ||
    (prefix.length > 0 && prefix[0] !== 0x46)
  ) {
    failures.push(`case ${n}: a prefix of ${prefix?.length} bytes for ${ask}`);
  }

  if (whole) {
    decoded++;
    if (whole.length !== header) {
      failures.push(`case ${n}: ${whole.length} bytes where the header says ${header}`);
    }

    if (prefix && !same(prefix, whole.subarray(0, prefix.length))) {
      failures.push(`case ${n}: the prefix differs from the whole`);
    }
  } else {
    refused++;
  }

  // The same streams as ByteArray's.
  if (signature === "CWS") {
    attempt("zlib", () => zlibUncompress(file.subarray(8)));
    attempt("raw", () => zlibUncompress(file.subarray(10), true));
  } else if (file.length >= 17) {
    const b = new Uint8Array(13 + file.length - 17);
    b.set(file.subarray(12, 17));
    new DataView(b.buffer).setUint32(5, Math.max(0, header - 8), true);
    b.set(file.subarray(17), 13);
    attempt("lzma", () => lzmaByteArrayUncompress(b));
  }

  // The module is still well after whatever it was handed.
  if (n % 50 === 0) {
    const check = body();
    const back = attempt("check", () => zlibUncompress(deflateCompress(check), true));
    const lzma = attempt("check", () => lzmaByteArrayUncompress(lzmaByteArrayCompress(check)));
    if (!back || !same(back, check) || !lzma || !same(lzma, check)) {
      failures.push(`case ${n}: a valid stream no longer round trips`);
    }
  }
}

console.log(
  `compress fuzz: ${caseCount} cases from seed ${seed}, ${decoded} decoded, ${refused} refused`,
);
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  console.log(`${failures.length} failures`);
  process.exit(1);
}
