// Each tool/file runs in a fresh process. Build first; see docs/benchmarks.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
interface Result {
  tool: string;
  methods: number;
  instructions: number;
  parseMs: number;
  totalMs: number;
  parseRounds: number;
  totalRounds: number;
  parseSamples: number[];
  totalSamples: number[];
  parseMBps?: number;
  decodeNsPerInstruction?: number;
}
type Run = (rounds: number, decode: boolean) => number;

function time(run: Run, decode: boolean) {
  run(3, decode);
  const start = performance.now();
  run(1, decode);
  const rounds = Math.max(1, Math.round(40 / Math.max(performance.now() - start, 0.01)));
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    run(rounds, decode);
    samples.push((performance.now() - start) / rounds);
  }

  return { ms: [...samples].sort((a, b) => a - b)[2], rounds, samples };
}

async function worker(tool: string, file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  let run: Run;
  if (tool === "swf2es") {
    const dir = new URL("../../packages/codegen/dist-test/", import.meta.url);
    const { instantiate } = await import(new URL("testing.js", dir).href);
    const testing = await instantiate(
      await WebAssembly.compile(readFileSync(new URL("testing.wasm", dir))),
      { env: {} },
    );
    run = (rounds, decode) => {
      const count = testing.benchCompare(bytes, rounds, decode);
      if (count < 0) {
        throw new Error(`swf2es verifier error ${-count}`);
      }

      return count;
    };
  } else if (tool === "Ruffle Wasm") {
    const wasm = await WebAssembly.compile(
      readFileSync(`${here}ruffle/target/wasm32-unknown-unknown/release/swf2es_ruffle_bench.wasm`),
    );
    if (WebAssembly.Module.imports(wasm).length) {
      throw new Error("Expected a standalone Ruffle Wasm module");
    }
    const instance = await WebAssembly.instantiate(wasm);
    const api = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      bench_alloc(len: number): number;
      bench_free(ptr: number, len: number): void;
      bench_run(ptr: number, len: number, rounds: number, decode: number): number;
    };
    run = (rounds, decode) => {
      // Like swf2es, transfer input once per batch, inside the timing boundary.
      const ptr = api.bench_alloc(bytes.length);
      try {
        new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
        return api.bench_run(ptr, bytes.length, rounds, Number(decode));
      } finally {
        api.bench_free(ptr, bytes.length);
      }
    };
  } else {
    // AwayJS checks browser global names while loading; parsing uses no DOM.
    Object.assign(globalThis, { self: globalThis, window: globalThis });
    const log = console.log;
    const info = console.info;
    const debug = console.debug;
    console.log = console.error;
    console.info = console.error;
    console.debug = console.error;
    const bundle = process.env.AWAYFL_BUNDLE || `${here}out/awayfl.js`;
    const { ABCFile, analyze, Settings, initlazy } = await import(
      pathToFileURL(resolve(bundle)).href
    );
    initlazy();
    // Preserve one output instruction per input opcode for count comparisons.
    Settings.OPTIMISE_ON_IR = false;
    console.log = log;
    console.info = info;
    console.debug = debug;
    run = (rounds, decode) => {
      let count = 0;
      for (let i = 0; i < rounds; i++) {
        const abc = new ABCFile({ app: null, url: file }, bytes);
        count = abc._methods.length;
        if (decode) {
          count = 0;
          for (let m = 0; m < abc._methods.length; m++) {
            const method = abc.getMethodInfo(m);
            if (!method.getBody()) {
              continue;
            }
            const result = analyze(method);
            if (result.error) {
              throw new Error(`AwayFL method ${m}: ${result.error.message}`);
            }

            count += result.set.length;
          }
        }
      }

      return count;
    };
  }
  const methods = run(1, false);
  const instructions = run(1, true);
  const parse = time(run, false);
  const total = time(run, true);
  console.log(
    JSON.stringify({
      tool,
      methods,
      instructions,
      parseMs: parse.ms,
      totalMs: total.ms,
      parseRounds: parse.rounds,
      totalRounds: total.rounds,
      parseSamples: parse.samples,
      totalSamples: total.samples,
    }),
  );
}

const includeWasm = process.argv.includes("--ruffle-wasm");
const args = process.argv.slice(2).filter((arg) => arg !== "--ruffle-wasm");
if (args[0] === "--worker") {
  await worker(args[1], args[2]);
} else {
  if (!args.length) {
    throw new Error("usage: node tests/bench/compare.ts file.abc [...]");
  }
  const results = [];
  for (const input of args) {
    const file = resolve(input);
    const bytes = readFileSync(file);
    const rows: Result[] = [];
    for (const tool of ["swf2es", "AwayFL", "Ruffle", ...(includeWasm ? ["Ruffle Wasm"] : [])]) {
      const stdout =
        tool === "Ruffle"
          ? execFileSync(`${here}ruffle/target/release/swf2es-ruffle-bench`, [file], {
              encoding: "utf8",
            })
          : execFileSync(
              process.execPath,
              [fileURLToPath(import.meta.url), "--worker", tool, file],
              { encoding: "utf8" },
            );
      const row: Result = JSON.parse(stdout);
      row.parseMBps = bytes.length / 1000 / row.parseMs;
      row.decodeNsPerInstruction = ((row.totalMs - row.parseMs) * 1e6) / row.instructions;
      rows.push(row);
    }
    if (rows.some((row) => row.methods !== rows[0].methods)) {
      throw new Error(`Method count mismatch: ${file}`);
    }
    if (
      rows[1].instructions !== rows[2].instructions ||
      rows[0].instructions > rows[2].instructions ||
      (includeWasm && rows[3].instructions !== rows[2].instructions)
    ) {
      throw new Error(`Unexpected instruction count mismatch: ${file}`);
    }
    results.push({
      file: input,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rows,
    });
  }
  console.log(
    JSON.stringify(
      {
        artifacts: {
          ...(includeWasm
            ? {
                ruffleWasmSha256: createHash("sha256")
                  .update(
                    readFileSync(
                      `${here}ruffle/target/wasm32-unknown-unknown/release/swf2es_ruffle_bench.wasm`,
                    ),
                  )
                  .digest("hex"),
              }
            : {}),
          wasmSha256: createHash("sha256")
            .update(
              readFileSync(
                new URL("../../packages/codegen/dist-test/testing.wasm", import.meta.url),
              ),
            )
            .digest("hex"),
          awayflBundleSha256: createHash("sha256")
            .update(readFileSync(process.env.AWAYFL_BUNDLE || `${here}out/awayfl.js`))
            .digest("hex"),
          cargoLockSha256: createHash("sha256")
            .update(readFileSync(`${here}ruffle/Cargo.lock`))
            .digest("hex"),
        },
        machine: {
          cpu: cpus()[0].model,
          os: `${process.platform} ${release()}`,
          arch: process.arch,
          node: process.version,
          rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
        },
        results,
      },
      null,
      2,
    ),
  );
}
