// The browser build, swf2es, as a page gets it from a CDN, in headless
// Chrome: packages/swf2es/dist served from another origin with the headers
// unpkg and jsDelivr send, and pages that load it with one <script
// type="module"> tag, under the Content-Security-Policy its README gives.
// From its file's URL, as unpkg redirects to it, an AS3 SWF traces and an
// AVM1 SWF plays. From the package's own URL, as jsDelivr serves the file,
// on a cross-origin isolated page, two Flash Workers share a Mutex: their
// Web Workers start on the CDN's worker.js through a blob: module of the
// page's. Nothing is reported as an error, and nothing asked of the CDN is
// missing. Run after `pnpm build`, which builds the bundle.
//
//   node tests/web/cdn.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";
import { abc, tables, u30 } from "../unit/codegen/abc-builder.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = fileURLToPath(new URL("../../packages/swf2es/dist/", import.meta.url));
const out = `${here}out/cdn/`;
const VERSION = "swf2es@0.1.0";

if (!existsSync(`${dist}swf2es.js`)) {
  throw new Error("packages/swf2es is not built: run pnpm build first");
}

/** What the CDN was asked for, and what it did not have. */
const asked: string[] = [];
const missing: string[] = [];
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};
const cdn = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  asked.push(path);
  // jsDelivr serves the main file at the package's URL; every file under its path in the package.
  const file =
    path === `/${VERSION}`
      ? `${dist}swf2es.js`
      : path.startsWith(`/${VERSION}/dist/`)
        ? normalize(join(dist, path.slice(`/${VERSION}/dist/`.length)))
        : null;
  const headers = {
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  if (file === null || !file.startsWith(dist) || !existsSync(file)) {
    missing.push(path);
    response.writeHead(404, headers);
    response.end();
    return;
  }

  response.writeHead(200, {
    ...headers,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  response.end(readFileSync(file));
});
await new Promise<void>((done) => cdn.listen(0, "127.0.0.1", done));
// Another port, so another origin than the pages'.
const origin = `http://127.0.0.1:${(cdn.address() as { port: number }).port}`;

// Strings 1 trace, 2 "", 3 the line. Namespace 1 public. Multiname 1 trace.
// findpropstrict trace, pushstring 3, callpropvoid trace 1, returnvoid.
const as3Line = "as3 from the cdn";
const hello = abc(
  {
    strings: ["trace", "", as3Line],
    namespaces: [[0x16, ...u30(2)]],
    multinames: [[0x07, ...u30(1), ...u30(1)]],
  },
  tables({
    methods: [{}],
    scripts: [{ init: 0 }],
    bodies: [
      {
        method: 0,
        code: [0xd0, 0x30, 0x5d, 1, 0x2c, 3, 0x4f, 1, 1, 0x47],
        maxStack: 2,
        maxScopeDepth: 2,
      },
    ],
  }),
);
// ActionPush of the line, ActionTrace, ActionStop, ActionEnd.
const avm1Line = "avm1 from the cdn";
const pushed = [0, ...Buffer.from(avm1Line), 0];
const avm1Actions = [0x96, pushed.length & 0xff, pushed.length >> 8, ...pushed, 0x26, 0x07, 0x00];
const workerMutexTrace = readFileSync(`${here}../player/references/worker-mutex/trace.txt`, "utf8")
  .replace(/\n$/, "")
  .split(/\r|\n/);

const site = `${out}site/`;
mkdirSync(site, { recursive: true });
writeFileSync(
  `${site}as3.swf`,
  w.swf({
    width: 100,
    height: 100,
    frameCount: 1,
    tags: [w.fileAttributes(true), w.doAbc(hello, "hello"), w.showFrame(), w.end()],
  }),
);
writeFileSync(
  `${site}avm1.swf`,
  w.swf({
    version: 8,
    width: 100,
    height: 100,
    frameCount: 1,
    tags: [w.doAction(avm1Actions), w.showFrame(), w.end()],
  }),
);
const mutex = compileScripts(["WorkerMutex"], out).get("WorkerMutex") as Uint8Array;
// SWF 26, as the player tests' worker-mutex case has it.
const mutexSwf = bare(mutex, 1, "WorkerMutex");
mutexSwf[3] = 26;
writeFileSync(`${site}worker-mutex.swf`, mutexSwf);

/** A page of the given players that loads the bundle from `src` under the README's policy. */
const page = (src: string, players: string[]) => `<!doctype html>
<html>
<head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'self' ${origin} 'unsafe-eval' 'wasm-unsafe-eval'; worker-src ${origin} blob:">
<script type="module" src="${src}"></script>
</head>
<body>
${players.map((swf) => `<swf2es-player src="${swf}" width="100" height="100"></swf2es-player>`).join("\n")}
</body>
</html>`;
writeFileSync(
  `${site}index.html`,
  page(`${origin}/${VERSION}/dist/swf2es.js`, ["as3.swf", "avm1.swf"]),
);
writeFileSync(`${site}workers.html`, page(`${origin}/${VERSION}`, ["worker-mutex.swf"]));

/**
 * Load the page again, with the console and exceptions listened to from
 * its start, until `done` holds of its traces; its traces and errors.
 */
async function play(
  fresh: () => Promise<void>,
  listen: (method: string, listener: (params: Record<string, unknown>) => void) => void,
  send: <R>(method: string, params?: object) => Promise<R>,
  done: (traces: string[]) => boolean,
): Promise<{ traces: string[]; errors: string[] }> {
  const traces: string[] = [];
  const errors: string[] = [];
  listen("Runtime.consoleAPICalled", (params) => {
    const args = params.args as { value?: unknown; description?: string }[];
    const text = args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
    if (params.type === "log") {
      traces.push(text);
    } else if (params.type === "error" || params.type === "warning") {
      errors.push(text);
    }
  });
  listen("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails as {
      exception?: { description?: string };
      text: string;
    };
    errors.push(details.exception?.description ?? details.text);
  });
  // What the browser itself reports: a refusal by the policy, a failed load.
  await send("Log.enable");
  listen("Log.entryAdded", (params) => {
    const entry = params.entry as { level: string; text: string; url?: string };
    if (entry.level === "error" && !entry.url?.endsWith("/favicon.ico")) {
      errors.push(`${entry.text} ${entry.url ?? ""}`);
    }
  });
  await fresh();

  const start = Date.now();
  while (!done(traces) && errors.length === 0 && Date.now() - start < 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { traces, errors };
}

const mounts: [string, string][] = [["/cdn-test/", site]];
// Defined once the bundle has loaded.
const ready = "customElements.get('swf2es-player')";
let failures = 0;

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`ok ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("an AS3 and an AVM1 SWF play from the bundle's file on another origin", () =>
  withPage(
    ready,
    async (_evaluate, send, fresh, listen) => {
      const { traces, errors } = await play(fresh, listen, send, (t) =>
        [as3Line, avm1Line].every((line) => t.includes(line)),
      );
      assert.deepEqual(errors, []);
      assert.deepEqual([...traces].sort(), [as3Line, avm1Line].sort());
      // codegen.wasm and the renderer's chunk beside it, by relative URL.
      assert.ok(asked.includes(`/${VERSION}/dist/codegen.wasm`), asked.join(" "));
      assert.ok(
        asked.some((path) => path.startsWith(`/${VERSION}/dist/chunks/`)),
        asked.join(" "),
      );
    },
    false,
    { page: "cdn-test/index.html", mounts, isolated: false },
  ),
);

asked.length = 0;
await check("Flash Workers share memory, on an isolated page, from the package's URL", () =>
  withPage(
    ready,
    async (_evaluate, send, fresh, listen) => {
      const { traces, errors } = await play(fresh, listen, send, (t) => t.includes("free true"));
      assert.deepEqual(errors, []);
      assert.deepEqual(traces, workerMutexTrace);
      // Under the package's URL's dist/, not beside it at the CDN's root.
      for (const file of ["codegen.wasm", "worker.js"]) {
        assert.ok(asked.includes(`/${VERSION}/dist/${file}`), `${file}: ${asked.join(" ")}`);
      }

      assert.ok(
        asked.some((path) => path.startsWith(`/${VERSION}/dist/chunks/`)),
        asked.join(" "),
      );
    },
    false,
    { page: "cdn-test/workers.html", mounts },
  ),
);

cdn.close();
await check("the CDN had every file asked of it", async () => {
  assert.deepEqual(missing, []);
});

if (failures > 0) {
  console.log(`${failures} checks failed`);
  process.exitCode = 1;
}
