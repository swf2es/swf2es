import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [before, after, runsArg = "7", mode = "read"] = process.argv.slice(2);
if (!before || !after || !["read", "mutation"].includes(mode)) {
  throw new Error("Usage: compare.js <before.js> <after.js> [runs] [read|mutation]");
}
const runs = Number(runsArg);
const samples = [];
const out = new URL("out/", import.meta.url);
mkdirSync(out, { recursive: true });
const modules = {
  before: before.startsWith("file:") ? before : pathToFileURL(resolve(before)).href,
  after: after.startsWith("file:") ? after : pathToFileURL(resolve(after)).href,
};
const sourceHashes = {};
for (const version of ["before", "after"]) {
  const source = readFileSync(new URL(modules[version]), "utf8");
  sourceHashes[version] = createHash("sha256").update(source).digest("hex");
  if (modules[version].endsWith(".txt")) {
    const path = new URL(`${version}.js`, out);
    writeFileSync(path, source);
    modules[version] = path.href;
  }
}
for (let i = 0; i < runs; i++) {
  const pair = {};
  for (const version of i % 2 ? ["after", "before"] : ["before", "after"]) {
    pair[version] = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(mode === "mutation" ? "mutation-bench.js" : "bench.js", import.meta.url),
          ),
          ...(i % 2 ? ["--reverse"] : []),
        ],
        { encoding: "utf8", env: { ...process.env, DICTIONARY_MODULE: modules[version] } },
      ),
    );
  }
  assert.equal(pair.before.checksum, pair.after.checksum);
  samples.push(pair);
}
writeFileSync(
  new URL(`ab-${mode}.json`, out),
  JSON.stringify({ modules, sourceHashes, samples }, null, 2),
);
const stats = (values) => {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return {
    median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    min: values[0],
    max: values.at(-1),
  };
};
const show = (s) => `${s.median.toFixed(2)} (${s.min.toFixed(2)}–${s.max.toFixed(2)})`;
for (const { name } of samples[0].before.results) {
  const a = stats(
    samples.map((pair) => pair.before.results.find((result) => result.name === name).ms),
  );
  const b = stats(
    samples.map((pair) => pair.after.results.find((result) => result.name === name).ms),
  );
  console.log(
    `${name.padEnd(29)} ${show(a).padEnd(23)} ${show(b).padEnd(23)} ` +
      `${((b.median / a.median - 1) * 100).toFixed(1)}%`,
  );
}
