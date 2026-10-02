// String case mapping as avmplus does it: unit by unit, from Unicode tables
// older than JavaScript's, so a unit never maps to more than one and never
// by context (no final sigma), and a surrogate pair keeps its case.

// Where avmplus' mapping of a unit differs from JavaScript's, as the
// oracle's avmshell maps each of the 65536: runs of [first unit, count,
// stride, what to add to each], most of them 0, a unit avmplus leaves as it is.
const UPPER = [
  181, 1, 1, 0, 223, 1, 1, 0, 329, 1, 1, 0, 384, 1, 1, 0, 410, 2, 1, 0, 414, 1, 1, 0, 496, 1, 1, 0,
  572, 1, 1, 0, 575, 2, 1, 0, 578, 1, 1, 0, 583, 5, 2, 0, 592, 3, 1, 0, 604, 1, 1, 0, 609, 1, 1, 0,
  612, 3, 1, 0, 618, 3, 1, 0, 625, 1, 1, 0, 637, 1, 1, 0, 642, 1, 1, 0, 647, 2, 2, 0, 652, 1, 1, 0,
  669, 2, 1, 0, 881, 2, 2, 0, 887, 1, 1, 0, 891, 3, 1, 0, 912, 1, 1, 0, 944, 1, 1, 0, 962, 1, 1,
  -32, 983, 1, 1, 0, 1010, 1, 1, -79, 1011, 1, 1, 0, 1016, 1, 1, 0, 1019, 1, 1, 0, 1222, 1, 1, 0,
  1226, 1, 1, 0, 1230, 2, 1, 0, 1275, 27, 2, 0, 1415, 1, 1, 0, 4304, 43, 1, 0, 4349, 3, 1, 0, 5112,
  6, 1, 0, 7296, 9, 1, 0, 7306, 1, 1, 0, 7545, 1, 1, 0, 7549, 1, 1, 0, 7566, 1, 1, 0, 7830, 5, 1, 0,
  7931, 3, 2, 0, 8016, 4, 2, 0, 8064, 8, 1, 8, 8072, 8, 1, 0, 8080, 8, 1, 8, 8088, 8, 1, 0, 8096, 8,
  1, 8, 8104, 8, 1, 0, 8114, 1, 1, 0, 8115, 1, 1, 9, 8116, 2, 2, 0, 8119, 1, 1, 0, 8124, 1, 1, 0,
  8130, 1, 1, 0, 8131, 1, 1, 9, 8132, 2, 2, 0, 8135, 1, 1, 0, 8140, 1, 1, 0, 8146, 2, 1, 0, 8150, 2,
  1, 0, 8162, 3, 1, 0, 8166, 2, 1, 0, 8178, 1, 1, 0, 8179, 1, 1, 9, 8180, 2, 2, 0, 8183, 1, 1, 0,
  8188, 1, 1, 0, 8526, 1, 1, 0, 8580, 1, 1, 0, 11312, 48, 1, 0, 11361, 1, 1, 0, 11365, 2, 1, 0,
  11368, 3, 2, 0, 11379, 1, 1, 0, 11382, 1, 1, 0, 11393, 50, 2, 0, 11500, 2, 2, 0, 11507, 1, 1, 0,
  11520, 38, 1, 0, 11559, 1, 1, 0, 11565, 1, 1, 0, 42561, 23, 2, 0, 42625, 14, 2, 0, 42787, 7, 2, 0,
  42803, 31, 2, 0, 42874, 2, 2, 0, 42879, 5, 2, 0, 42892, 1, 1, 0, 42897, 2, 2, 0, 42900, 1, 1, 0,
  42903, 10, 2, 0, 42933, 8, 2, 0, 42952, 2, 2, 0, 42957, 8, 2, 0, 42998, 1, 1, 0, 43859, 1, 1, 0,
  43888, 80, 1, 0, 64256, 7, 1, 0, 64275, 5, 1, 0,
];
const LOWER = [
  304, 1, 1, -199, 544, 1, 1, 0, 570, 2, 1, 0, 573, 2, 1, 0, 577, 2, 2, 0, 580, 3, 1, 0, 584, 4, 2,
  0, 880, 2, 2, 0, 886, 1, 1, 0, 895, 1, 1, 0, 930, 1, 1, 32, 975, 1, 1, 0, 1015, 2, 2, 0, 1018, 1,
  1, 0, 1021, 3, 1, 0, 1216, 1, 1, 0, 1221, 1, 1, 0, 1225, 1, 1, 0, 1229, 1, 1, 0, 1274, 27, 2, 0,
  4256, 38, 1, 48, 4295, 1, 1, 0, 4301, 1, 1, 0, 5024, 86, 1, 0, 7305, 1, 1, 0, 7312, 43, 1, 0,
  7357, 3, 1, 0, 7838, 1, 1, 0, 7930, 3, 2, 0, 8498, 1, 1, 0, 8579, 1, 1, 0, 11264, 48, 1, 0, 11360,
  2, 2, 0, 11363, 2, 1, 0, 11367, 4, 2, 0, 11374, 3, 1, 0, 11378, 1, 1, 0, 11381, 1, 1, 0, 11390, 3,
  1, 0, 11394, 49, 2, 0, 11499, 2, 2, 0, 11506, 1, 1, 0, 42560, 23, 2, 0, 42624, 14, 2, 0, 42786, 7,
  2, 0, 42802, 31, 2, 0, 42873, 3, 2, 0, 42878, 5, 2, 0, 42891, 2, 2, 0, 42896, 2, 2, 0, 42902, 11,
  2, 0, 42923, 4, 1, 0, 42928, 5, 1, 0, 42934, 8, 2, 0, 42949, 3, 1, 0, 42953, 2, 2, 0, 42956, 9, 2,
  0, 42997, 1, 1, 0,
];

// Below the first unit either table names, JavaScript maps a string as avmplus does.
const PLAIN = /^[\0-\xb4]*$/;

let upper: Map<number, number> | undefined;
let lower: Map<number, number> | undefined;

function table(runs: number[]): Map<number, number> {
  const t = new Map<number, number>();
  for (let i = 0; i < runs.length; i += 4) {
    for (let k = 0; k < runs[i + 1]; k++) {
      const c = runs[i] + k * runs[i + 2];
      t.set(c, c + runs[i + 3]);
    }
  }

  return t;
}

function map(s: string, t: Map<number, number>, js: (c: string) => string): string {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const m = t.get(c);
    if (m !== undefined) {
      out.push(m);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out.push(c);
    } else {
      out.push(js(String.fromCharCode(c)).charCodeAt(0));
    }
  }

  const parts: string[] = [];
  for (let i = 0; i < out.length; i += 0x1000) {
    parts.push(String.fromCharCode(...out.slice(i, i + 0x1000)));
  }

  return parts.join("");
}

/** String::toUpperCase. */
export function upperCase(s: string): string {
  if (PLAIN.test(s)) {
    return s.toUpperCase();
  }

  upper ??= table(UPPER);
  return map(s, upper, (c) => c.toUpperCase());
}

/** String::toLowerCase. */
export function lowerCase(s: string): string {
  if (PLAIN.test(s)) {
    return s.toLowerCase();
  }

  lower ??= table(LOWER);
  return map(s, lower, (c) => c.toLowerCase());
}
