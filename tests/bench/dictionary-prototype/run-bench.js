import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[2] ?? 7);
const mutation = process.argv[3] === "mutation";
const prefix = mutation ? "mutation-" : "";
const out = new URL("out/", import.meta.url);
mkdirSync(out, { recursive: true });
const times = new Map();
const raw = [];
for (let i = 0; i < runs; i++) {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL(mutation ? "mutation-bench.js" : "bench.js", import.meta.url)),
        ...(i % 2 ? ["--reverse"] : []),
      ],
      { encoding: "utf8" },
    ),
  );
  if (mutation) {
    // Keep the native Map control in a separate process so it cannot change receiver feedback.
    const control = JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("mutation-bench.js", import.meta.url)), "--map"],
        { encoding: "utf8" },
      ),
    );
    result.results.push(...control.results);
    result.checksum += control.checksum;
  }
  raw.push(result);
  for (const { name, ms } of result.results) {
    const values = times.get(name) ?? [];
    values.push(ms);
    times.set(name, values);
  }
}
writeFileSync(new URL(`${prefix}timings.json`, out), JSON.stringify(raw, null, 2));
for (const [name, values] of [...times].sort(([a], [b]) => a.localeCompare(b))) {
  const sorted = values.toSorted((a, b) => a - b);
  const median =
    sorted.length % 2
      ? sorted[sorted.length >> 1]
      : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  console.log(
    `${name.padEnd(29)} ${median.toFixed(2)} ms (${Math.min(...values).toFixed(2)}–${Math.max(...values).toFixed(2)})`,
  );
}
