import { readFileSync, writeFileSync } from "node:fs";
import { IMAGE } from "../../../oracle/oracle.ts";
import { recordAdobe } from "./adobe.ts";
import { createReference } from "./reference.ts";

const root = new URL("./", import.meta.url);
const source =
  readFileSync(new URL("oracle-adapter.as", root), "utf8") +
  readFileSync(new URL("scenarios.as", root), "utf8");
const runs = Number(process.argv[2] ?? 3);
const samples = await recordAdobe("DictionaryPrototype", source, runs);
const fixture = createReference(source, samples, IMAGE);
writeFileSync(new URL("reference.json", root), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `${Object.keys(fixture.stable).length} stable cases; ${Object.keys(fixture.layout).length} layout cases`,
);
