// Opt-in feasibility probe: node tests/worker-vm/run.ts (after pnpm build).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flashAssembler, script } from "../avm1-script.ts";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
mkdirSync(out, { recursive: true });
libraryAbcs();
const abc = compileScripts(
  [{ name: "WorkerExternal", source: readFileSync(`${here}scripts/WorkerExternal.as`, "utf8") }],
  out,
).get("WorkerExternal");
assert.ok(abc);
writeFileSync(`${out}avm2.swf`, bare(abc, 1, "WorkerExternal", 20, 20));
const avm1 = `
var EI = flash.external.ExternalInterface;
EI.addCallback("nest", null, function(depth, failure) {
  trace("vm:" + depth);
  if (failure == "vm:" + depth) {
    trace("throw:" + depth);
    __op("Throw", "vm failure " + depth);
  }
  if (depth == 0) { return "leaf"; }
  return "vm(" + EI.call("probePage", depth - 1, failure) + ")";
});
EI.addCallback("outbound", null, function(depth, failure) {
  return EI.call("probePage", depth, failure);
});
EI.call("probePage", 0, "");
stop();`;
writeFileSync(
  `${out}avm1.swf`,
  w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.doAction([...script(avm1, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  }),
);

// Reuse the fork's existing build tool; no dependency or production bundle changes.
const esbuild = await import(
  new URL("../../vendor/pixijs/node_modules/esbuild/lib/main.js", import.meta.url).href
);
await esbuild.build({
  entryPoints: [`${here}page.ts`, `${here}thread.ts`],
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [
    {
      name: "existing-pixi-bundle",
      setup(build: { onResolve(options: { filter: RegExp }, resolve: () => object): void }) {
        build.onResolve({ filter: /^pixi\.js$/ }, () => ({
          path: "/pixi/pixi.mjs",
          external: true,
        }));
      },
    },
  ],
});
writeFileSync(
  `${out}index.html`,
  '<!doctype html><script type="module" src="/experiment/page.js"></script>',
);

interface Result {
  kind: string;
  mode: string;
  outcomes: { value?: unknown; error?: string }[];
  events: string[];
  reports: string[];
  calls: number;
  spins: number;
  transport: string[];
  blocking: null | {
    elapsed: number;
    microtaskRan: boolean;
    timerRan: boolean;
    rafRan: boolean;
    asyncTasks: number;
  };
}

const results: Result[] = [];
await withPage(
  "runWorkerVm",
  async (evaluate) => {
    const isolation = await evaluate<boolean>("crossOriginIsolated");
    assert.equal(isolation.value, true, "experiment needs SharedArrayBuffer isolation");
    for (const kind of ["avm1", "avm2"]) {
      const run = async (mode: string) => {
        const answer = await evaluate<Result>(
          `runWorkerVm(${JSON.stringify(kind)}, ${JSON.stringify(mode)})`,
        );
        assert.equal(answer.exception, null, JSON.stringify(answer));
        assert.ok(answer.value);
        results.push(answer.value);
        return answer.value;
      };
      const direct = await run("direct");
      const diagnostic = await run("diagnostic-spin");
      assert.equal(direct.outcomes.length, 126);
      assert.equal(direct.outcomes[0].value, "leaf");
      assert.notEqual(
        direct.outcomes[2].value,
        "leaf",
        `${kind}: the VM throw must interrupt its callback`,
      );
      for (let depth = 0; depth <= 6; depth++) {
        assert.ok(direct.events.includes(`throw:${depth}`), `${kind}: throw at depth ${depth}`);
      }
      assert.equal(direct.outcomes[96].value, "vm(page(vm(page(vm(page(leaf))))))");
      assert.deepEqual(diagnostic.outcomes, direct.outcomes, `${kind}: nested results/errors`);
      assert.deepEqual(diagnostic.events, direct.events, `${kind}: nested call order`);
      assert.deepEqual(diagnostic.reports, direct.reports, `${kind}: error reports`);
      assert.ok(diagnostic.calls > 0 && diagnostic.spins > 0);
      assert.deepEqual(diagnostic.transport, [
        "payload exceeds",
        "response exceeds",
        "nesting exceeds",
        "timeout; endpoint closed",
        "bridge closed",
        "worker wait cancelled",
      ]);
      const blocked = diagnostic.blocking;
      assert.ok(blocked);
      assert.ok(blocked.elapsed >= 90, JSON.stringify(blocked));
      assert.equal(blocked.microtaskRan, false);
      assert.equal(blocked.timerRan, false);
      assert.equal(blocked.rafRan, false);
      assert.ok(blocked.asyncTasks > 0, JSON.stringify(blocked));
      const rejected = await run("reject");
      assert.ok(rejected.outcomes.every((value) => value.error));
      assert.ok(rejected.reports.some((error) => error.includes("requires blocking main")));
      assert.equal(rejected.calls, 0);
      assert.equal(rejected.spins, 0);
      console.log(
        `${kind}: ${direct.outcomes.length} synchronous result/error comparisons and call order match main; ` +
          `diagnostic spin blocks main for ${blocked.elapsed.toFixed(1)} ms; ` +
          `async worker work allows ${blocked.asyncTasks} main tasks; nonblocking callbacks rejected`,
      );
    }
  },
  false,
  {
    mounts: [["/experiment/", out]],
    page: "experiment/index.html",
    timeout: 45_000,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
);
writeFileSync(`${out}results.json`, `${JSON.stringify(results, null, 2)}\n`);
