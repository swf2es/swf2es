// Flash's lower case of a UTF-16 code unit, which AVM1 folds names by up
// to SWF 6 (and String's toLowerCase gives): an old Unicode's simple
// mappings, one code unit to one, without JavaScript's later letters
// (Cherokee, Glagolitic, Coptic, Latin Extended-C and -D...), with İ to i,
// Georgian capitals to Mkhedruli and U+03A2 to ς. Measured in adl: every
// code unit through String's toLowerCase, and each mapping through names.

/** Runs of mappings: their first code unit, how many, what each adds, and the step between them. */
const RUNS: [number, number, number, number][] = [
  [0x0041, 26, 32, 1],
  [0x00c0, 23, 32, 1],
  [0x00d8, 7, 32, 1],
  [0x0100, 24, 1, 2],
  [0x0130, 1, -199, 1],
  [0x0132, 3, 1, 2],
  [0x0139, 8, 1, 2],
  [0x014a, 23, 1, 2],
  [0x0178, 1, -121, 1],
  [0x0179, 3, 1, 2],
  [0x0181, 1, 210, 1],
  [0x0182, 2, 1, 2],
  [0x0186, 1, 206, 1],
  [0x0187, 1, 1, 1],
  [0x0189, 2, 205, 1],
  [0x018b, 1, 1, 1],
  [0x018e, 1, 79, 1],
  [0x018f, 1, 202, 1],
  [0x0190, 1, 203, 1],
  [0x0191, 1, 1, 1],
  [0x0193, 1, 205, 1],
  [0x0194, 1, 207, 1],
  [0x0196, 1, 211, 1],
  [0x0197, 1, 209, 1],
  [0x0198, 1, 1, 1],
  [0x019c, 1, 211, 1],
  [0x019d, 1, 213, 1],
  [0x019f, 1, 214, 1],
  [0x01a0, 3, 1, 2],
  [0x01a6, 1, 218, 1],
  [0x01a7, 1, 1, 1],
  [0x01a9, 1, 218, 1],
  [0x01ac, 1, 1, 1],
  [0x01ae, 1, 218, 1],
  [0x01af, 1, 1, 1],
  [0x01b1, 2, 217, 1],
  [0x01b3, 2, 1, 2],
  [0x01b7, 1, 219, 1],
  [0x01b8, 1, 1, 1],
  [0x01bc, 1, 1, 1],
  [0x01c4, 1, 2, 1],
  [0x01c5, 1, 1, 1],
  [0x01c7, 1, 2, 1],
  [0x01c8, 1, 1, 1],
  [0x01ca, 1, 2, 1],
  [0x01cb, 9, 1, 2],
  [0x01de, 9, 1, 2],
  [0x01f1, 1, 2, 1],
  [0x01f2, 2, 1, 2],
  [0x01f6, 1, -97, 1],
  [0x01f7, 1, -56, 1],
  [0x01f8, 20, 1, 2],
  [0x0222, 9, 1, 2],
  [0x0386, 1, 38, 1],
  [0x0388, 3, 37, 1],
  [0x038c, 1, 64, 1],
  [0x038e, 2, 63, 1],
  [0x0391, 27, 32, 1],
  [0x03d8, 12, 1, 2],
  [0x03f4, 1, -60, 1],
  [0x0400, 16, 80, 1],
  [0x0410, 32, 32, 1],
  [0x0460, 17, 1, 2],
  [0x048a, 27, 1, 2],
  [0x04c1, 2, 1, 2],
  [0x04c7, 1, 1, 1],
  [0x04cb, 1, 1, 1],
  [0x04d0, 21, 1, 2],
  [0x0531, 38, 48, 1],
  [0x10a0, 38, 48, 1],
  [0x1e00, 75, 1, 2],
  [0x1ea0, 45, 1, 2],
  [0x1f08, 8, -8, 1],
  [0x1f18, 6, -8, 1],
  [0x1f28, 8, -8, 1],
  [0x1f38, 8, -8, 1],
  [0x1f48, 6, -8, 1],
  [0x1f59, 4, -8, 2],
  [0x1f68, 8, -8, 1],
  [0x1f88, 8, -8, 1],
  [0x1f98, 8, -8, 1],
  [0x1fa8, 8, -8, 1],
  [0x1fb8, 2, -8, 1],
  [0x1fba, 2, -74, 1],
  [0x1fbc, 1, -9, 1],
  [0x1fc8, 4, -86, 1],
  [0x1fcc, 1, -9, 1],
  [0x1fd8, 2, -8, 1],
  [0x1fda, 2, -100, 1],
  [0x1fe8, 2, -8, 1],
  [0x1fea, 2, -112, 1],
  [0x1fec, 1, -7, 1],
  [0x1ff8, 2, -128, 1],
  [0x1ffa, 2, -126, 1],
  [0x1ffc, 1, -9, 1],
  [0x2126, 1, -7517, 1],
  [0x212a, 1, -8383, 1],
  [0x212b, 1, -8262, 1],
  [0x2160, 16, 16, 1],
  [0x24b6, 26, 26, 1],
  [0xff21, 26, 32, 1],
];

let table: Uint16Array | null = null;

/** The lower case of code unit `c`, as Flash has it. */
export function lowerCase(c: number): number {
  if (table === null) {
    table = new Uint16Array(0x10000);
    for (let i = 0; i < table.length; i++) {
      table[i] = i;
    }

    for (const [start, count, delta, step] of RUNS) {
      for (let i = 0; i < count; i++) {
        const u = start + i * step;
        table[u] = u + delta;
      }
    }
  }

  return table[c];
}
