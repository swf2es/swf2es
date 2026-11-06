import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordAdobe } from "./adobe.ts";

const runs = Number(process.argv[2] ?? 7);
const mode = process.argv[3] ?? "read";
assert.ok(mode === "read" || mode === "mutation");
const name = mode === "read" ? "ReadBench" : "MutationBench";
const samples = await recordAdobe(
  name,
  readFileSync(new URL(`${name}.as`, import.meta.url), "utf8"),
  runs,
);
const checked = (lines: string[]) => lines.filter((line) => !line.startsWith("time:")).join("\n");
const expected = checked(samples.avmshell[0]);
assert.ok([...samples.avmshell, ...samples.adl].every((lines) => checked(lines) === expected));
for (const engine of ["avmshell", "adl"] as const) {
  const times = new Map<string, number[]>();
  for (const lines of samples[engine]) {
    for (const line of lines) {
      const match = /^time: (\S+) ([\d.]+)$/.exec(line);
      if (match) {
        times.set(match[1], [...(times.get(match[1]) ?? []), Number(match[2])]);
      }
    }
  }

  for (const [name, values] of times) {
    values.sort((a, b) => a - b);
    const middle = values.length >> 1;
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    console.log(`${engine}/${name}: ${median} (${values[0]}–${values.at(-1)}) ms`);
  }
}
