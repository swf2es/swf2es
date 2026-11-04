import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOracle } from "../../../oracle/oracle.ts";
import * as w from "../../swf-writer.ts";

export async function recordAdobe(name: string, source: string, runs: number) {
  const out = fileURLToPath(new URL(`out/${name}/`, import.meta.url));
  mkdirSync(out, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const samples = { avmshell: [] as string[][], adl: [] as string[][] };
  for (let i = 0; i < runs; i++) {
    const path = `${out}${name}.as`;
    // The oracle caches stdout: a unique source digest forces a fresh process.
    writeFileSync(path, `// Fresh reference ${stamp}-${i}\n${source}`);
    const [result] = runOracle([path], out, { timeoutSeconds: 120, parallel: 1 });
    if (!result.compiled || result.exitCode !== 0) {
      throw new Error(result.compileLog + result.output);
    }
    samples.avmshell.push(result.output.split("\n").filter(Boolean));
  }

  const flash = process.env.SWF2ES_FLASH_HARNESS;
  const { runFlash } = await import(flash ? pathToFileURL(flash).href : "../../../oracle/flash.ts");
  const abc = new Uint8Array(readFileSync(`${out}${name}.abc`));
  const swf = w.swf({
    width: 32,
    height: 32,
    frameCount: 1,
    tags: [w.fileAttributes(true), w.doAbc(abc), w.showFrame(), w.end()],
  });
  process.env.SWF2ES_FLASH_FRESH = "1";
  for (let i = 0; i < runs; i++) {
    const [result] = await runFlash([{ swf, frames: 2, capture: [], alone: true }], 120000);
    if (result.incomplete || result.errors.length) {
      throw new Error(JSON.stringify(result));
    }
    samples.adl.push(result.output);
  }

  writeFileSync(`${out}reference-raw.json`, JSON.stringify(samples, null, 2));
  return samples;
}
