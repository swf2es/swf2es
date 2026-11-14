import assert from "node:assert/strict";
import { createHash } from "node:crypto";

type Expected = string | { sha256: string; length: number };
type Engine = "avmshell" | "adl";
type Samples = Record<Engine, string[][]>;

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const expected = (value: string): Expected =>
  value.length <= 160 ? value : { sha256: digest(value), length: value.length };

export function createReference(source: string, samples: Samples, image: string) {
  const parse = (lines: string[]) => {
    const records = new Map(
      lines
        .filter((line) => !line.startsWith("total\t"))
        .map((line) => {
          const [category, name, ...rest] = line.split("\t");
          assert.ok(category === "stable" || category === "layout");
          const result = rest.join("\t");
          assert.ok(!result.startsWith("THREW:"), `${name}: ${result}`);
          return [name, { category, result }] as const;
        }),
    );
    assert.equal(lines.at(-1), `total\t${records.size}`);
    return records;
  };
  const rows = {
    avmshell: samples.avmshell.map(parse),
    adl: samples.adl.map(parse),
  };
  assert.ok(rows.avmshell.length && rows.adl.length);
  const all = [...rows.avmshell, ...rows.adl];
  const first = all[0];
  assert.ok(all.every((sample) => sample.size === first.size));
  const stable: Record<string, Expected> = {};
  const layout: Record<string, { final: Expected; visits: Record<Engine, string[]> }> = {};
  for (const [name, record] of first) {
    const results = all.map((sample) => {
      const value = sample.get(name);
      assert.equal(value?.category, record.category, name);
      assert.ok(value);
      return value.result;
    });
    if (record.category === "stable") {
      assert.ok(
        results.every((value) => value === record.result),
        `${name}: unstable reference`,
      );
      stable[name] = expected(record.result);
    } else {
      const finals = results.map((result) => result.split(";final=")[1]);
      assert.ok(finals[0] !== undefined && finals.every((value) => value === finals[0]), name);
      layout[name] = {
        final: expected(finals[0]),
        visits: {
          avmshell: [
            ...new Set(rows.avmshell.map((sample) => sample.get(name)?.result.split(";final=")[0])),
          ]
            .filter((value): value is string => value !== undefined)
            .sort(),
          adl: [...new Set(rows.adl.map((sample) => sample.get(name)?.result.split(";final=")[0]))]
            .filter((value): value is string => value !== undefined)
            .sort(),
        },
      };
    }
  }
  return {
    sourceSha256: digest(source),
    avmshellImage: image,
    runsPerEngine: { avmshell: rows.avmshell.length, adl: rows.adl.length },
    stable,
    layout,
  };
}
