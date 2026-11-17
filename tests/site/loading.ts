import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

interface Page {
  value<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: object): Promise<T>;
  until(expression: string): Promise<void>;
  navigate(path: string): Promise<void>;
  site: string;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let start = Date.now(); !condition(); ) {
    assert.ok(Date.now() - start < 10000, "the HTTP request did not open or close");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Real fetches, stalled both before headers and between body chunks. */
async function withDownloads(
  run: (origin: string, requests: Map<string, ServerResponse>) => Promise<void>,
): Promise<void> {
  const requests = new Map<string, ServerResponse>();
  const server = createServer((request, response) => {
    requests.set(request.url ?? "/", response);
    if (request.url === "/headers.swf") {
      return;
    }

    response.writeHead(request.url === "/missing.swf" ? 404 : 200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/octet-stream",
    });
    response.write(new Uint8Array([70, 87, 83]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function loadingChecks(page: Page): [string, () => Promise<void>][] {
  const { value, send, until, navigate, site } = page;
  const fresh = async () => {
    await navigate("play/");
    await until(
      "document.getElementById('demos').children.length > 0 && document.getElementById('loading').hidden",
    );
  };
  const submit = (url: string) =>
    value(`(() => {
    document.getElementById('url').value = ${JSON.stringify(url)};
    document.getElementById('url-form').requestSubmit();
  })()`);
  const click = (id: string) => value(`document.getElementById('${id}').click()`);

  return [
    [
      "Close aborts a first download waiting for headers or another body chunk",
      async () => {
        await withDownloads(async (origin, requests) => {
          for (const path of ["/headers.swf", "/body.swf"]) {
            await fresh();
            await submit(origin + path);
            await waitFor(() => requests.has(path));
            assert.equal(await value("document.getElementById('close').disabled"), false);
            await click("close");
            await waitFor(() => requests.get(path)?.destroyed === true);
            assert.equal(await value("document.getElementById('status').textContent"), "Closed.");
            assert.equal(await value("document.getElementById('loading').hidden"), true);
            assert.equal(await value("document.getElementById('player').player === null"), true);
          }
        });
      },
    ],
    [
      "another URL or a local file aborts the previous stalled download",
      async () => {
        await fresh();
        await withDownloads(async (origin, requests) => {
          await submit(`${origin}/headers.swf`);
          await waitFor(() => requests.has("/headers.swf"));
          await submit(`${origin}/body.swf`);
          await waitFor(() => requests.get("/headers.swf")?.destroyed === true);
          await waitFor(() => requests.has("/body.swf"));
          const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
            expression: "document.getElementById('file')",
          });
          await send("DOM.setFileInputFiles", {
            objectId: result.objectId,
            files: [`${site}demos/bounce.swf`],
          });
          await waitFor(() => requests.get("/body.swf")?.destroyed === true);
          await until("document.getElementById('status').textContent === 'Playing bounce.swf.'");
          await click("close");
        });
      },
    ],
    [
      "a pending or failed replacement preserves the current player's startup completion",
      async () => {
        await withDownloads(async (origin, requests) => {
          for (const path of ["/body.swf", "/missing.swf"]) {
            await fresh();
            await value(`(() => {
              const player = document.getElementById('player');
              const load = player.load;
              player.load = async function(...args) {
                await load.apply(this, args);
                await new Promise(resolve => { globalThis.finishLoadingTest = resolve; });
              };
              globalThis.restoreLoadingTest = () => { player.load = load; finishLoadingTest(); };
            })()`);
            try {
              const demo = await value<string>(
                "new URL('../demos/bounce.swf', location.href).href",
              );
              await submit(demo);
              await until("typeof globalThis.finishLoadingTest === 'function'");
              await submit(origin + path);
              if (path === "/missing.swf") {
                await until("document.getElementById('status').textContent.includes('404')");
              } else {
                await until("document.getElementById('loading-label').textContent.includes('KB')");
              }
              const status = await value("document.getElementById('status').textContent");
              if (path === "/missing.swf") {
                await waitFor(() => requests.get(path)?.destroyed === true);
              }

              await value("restoreLoadingTest()");
              await until("document.getElementById('reload').disabled === false");
              assert.equal(await value("!!document.getElementById('player').player"), true);
              assert.equal(await value("document.getElementById('status').textContent"), status);
              assert.equal(
                await value("document.getElementById('loading').hidden"),
                path === "/missing.swf",
              );
              await click("close");
              await waitFor(() => requests.get(path)?.destroyed === true);
            } finally {
              await navigate("play/");
            }
          }
        });
      },
    ],
  ];
}
