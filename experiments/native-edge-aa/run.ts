import { mkdirSync, writeFileSync } from "node:fs";
import { withPage } from "../../tests/player/chrome.ts";
import { importMap } from "../../tests/player/serve.ts";

import { here, out } from "./paths.ts";

mkdirSync(out, { recursive: true });
writeFileSync(
  `${here}index.html`,
  `<!doctype html><style>body{margin:0}</style><script type="importmap">${JSON.stringify(importMap)}</script><script type="module" src="./page.ts"></script>`,
);
const mode = process.argv[2] ?? "capture";
await withPage(
  "captureAa",
  async (evaluate, send) => {
    if (mode === "paired") {
      const rows = [];
      for (const scenario of ["static", "rotate", "scale"]) {
        for (let round = 0; round < 5; round++) {
          const names = ["main-4", "coverage-4", "coverage-1"];
          for (let step = 0; step < names.length; step++) {
            const candidate = names[(round + step) % names.length];
            const answer = await evaluate(
              `pairedAa(${JSON.stringify(candidate)},${JSON.stringify(scenario)},${round})`,
            );
            if (answer.exception) {
              throw new Error(answer.exception);
            }
            rows.push({ candidate, scenario, round, results: answer.value });
            writeFileSync(`${out}paired.json`, JSON.stringify(rows, null, 2));
            console.log(JSON.stringify(rows.at(-1)));
          }
        }
      }
      return;
    }
    if (mode === "validate" || mode === "preview-check") {
      const answer = await evaluate(mode === "validate" ? "validateAa()" : "validatePreviewAa()");
      if (answer.exception) {
        throw new Error(answer.exception);
      }
      writeFileSync(
        `${out}${mode === "validate" ? "validation" : "preview-check"}.json`,
        JSON.stringify(answer.value, null, 2),
      );
      console.log(answer.value);
      return;
    }
    if (mode === "capture") {
      const diagonal = process.argv[3] === "diagonal";
      const answer = await evaluate<
        { mode: string; png: string; refused: number; error: number }[]
      >(`captureAa(${diagonal})`);
      if (answer.exception || !answer.value) {
        throw new Error(JSON.stringify(answer));
      }
      for (const capture of answer.value) {
        writeFileSync(
          `${out}${diagonal ? "diagonal-" : ""}${capture.mode}.png`,
          Buffer.from(capture.png.split(",")[1], "base64"),
        );
        console.log({ mode: capture.mode, refused: capture.refused, error: capture.error });
      }
      return;
    }
    if (mode === "allocations") {
      const rows = [];
      for (const scenario of ["static", "scale"]) {
        for (const name of ["main-8", "coverage-4"]) {
          await send("HeapProfiler.collectGarbage");
          await send("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          const result = await evaluate(
            `benchAa(${JSON.stringify(name)},${JSON.stringify(scenario)},240,640)`,
          );
          const { profile } = await send<{
            profile: { head: { selfSize: number; children: unknown[] } };
          }>("HeapProfiler.stopSampling");
          if (result.exception) {
            throw new Error(result.exception);
          }
          const sum = (node: { selfSize: number; children: unknown[] }): number =>
            node.selfSize + node.children.reduce<number>((n, c) => n + sum(c as typeof node), 0);
          rows.push({ name, scenario, bytes: sum(profile.head), result });
          writeFileSync(`${out}allocations.json`, JSON.stringify(rows, null, 2));
          console.log({ name, scenario, bytes: rows.at(-1)?.bytes });
        }
      }
      return;
    }
    const samples: unknown[] = [];
    const names = ["main-8", "main-4", "shader-only-8", "coverage-4", "coverage-1"];
    for (const scenario of ["static", "rotate", "scale"]) {
      for (let round = 0; round < 5; round++) {
        for (let step = 0; step < names.length; step++) {
          const name = names[(round + step) % names.length];
          const answer = await evaluate(
            `benchAa(${JSON.stringify(name)},${JSON.stringify(scenario)},90,640)`,
          );
          if (answer.exception) {
            throw new Error(answer.exception);
          }
          samples.push({ round, ...(answer.value as object) });
          writeFileSync(`${out}bench.json`, JSON.stringify(samples, null, 2));
          console.log(JSON.stringify(samples.at(-1)));
        }
      }
    }
  },
  true,
  { page: "aa/index.html", mounts: [["/aa/", here]], timeout: 120000 },
);
