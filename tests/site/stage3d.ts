import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { bare } from "../player/cases.ts";
import { decodePng } from "../player/image.ts";
import { compileScripts } from "../player/scripts.ts";

interface Page {
  value<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: object): Promise<T>;
  until(expression: string): Promise<void>;
  navigate(path: string): Promise<void>;
  out: string;
  site: string;
}

export function stage3DChecks(page: Page): [string, () => Promise<void>][] {
  const { value, send, until, navigate, out, site } = page;
  const logHas = (text: string) =>
    `document.getElementById('log').innerText.includes(${JSON.stringify(text)})`;
  const backendRequests =
    "performance.getEntriesByType('resource').filter(e => /\\/app\\/stage3d.js|\\/modules\\/context3d\\/webgl\\//.test(e.name)).length";
  const clear = () => value("document.getElementById('log').replaceChildren()");
  const click = (id: string) => value(`document.getElementById('${id}').click()`);
  const ready = () => until(logHas("site-stage3d ready"));
  const remember = () =>
    value(`(() => {
      globalThis.siteStage3DCanvas = [...document.getElementById('player').shadowRoot.querySelectorAll('canvas')]
        .find(c => c.width === 32 && c.height === 32);
      if (!globalThis.siteStage3DCanvas) throw new Error('no Stage3D surface');
    })()`);
  const retired = async () => {
    assert.equal(
      await value(
        "!siteStage3DCanvas.isConnected && siteStage3DCanvas.getContext('webgl2').isContextLost()",
      ),
      true,
    );
    await value("delete globalThis.siteStage3DCanvas");
  };
  const open = async () => {
    const abc = compileScripts(
      [
        {
          name: "SiteStage3D",
          source: readFileSync(new URL("SiteStage3D.as", import.meta.url), "utf8"),
        },
      ],
      `${out}stage3d`,
    ).get("SiteStage3D") as Uint8Array;
    const file = `${out}stage3d.swf`;
    writeFileSync(file, bare(abc, 1, "SiteStage3D", 96, 96));
    const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('file')",
    });
    await send("DOM.setFileInputFiles", { objectId: result.objectId, files: [file] });
    await until(logHas("site-stage3d worker replied"));
    await until(logHas("site-stage3d unavailable 3702"));
  };

  return [
    [
      "closing during the optional Stage3D import cannot restart the SWF",
      async () => {
        await send("Page.addScriptToEvaluateOnNewDocument", {
          source: "performance.setResourceTimingBufferSize(5000)",
        });
        await navigate("index.html");
        await open();
        assert.equal(await value(backendRequests), 0, "default playback fetched the backend");
        const path = `${site}app/stage3d.js`;
        const source = readFileSync(path, "utf8");
        const original = `${site}app/stage3d-original.js`;
        writeFileSync(original, source);
        writeFileSync(
          path,
          `
          export { createStage3D } from "./stage3d-original.js";
          await new Promise(resolve => { globalThis.releaseSiteStage3D = resolve; });
        `,
        );
        try {
          await click("stage3d");
          await until("typeof globalThis.releaseSiteStage3D === 'function'");
          await click("close");
          await value("releaseSiteStage3D()");
          // Await the same import so its late completion can resume play().
          await value("import(new URL('app/stage3d.js', document.baseURI).href).then(() => true)");
        } finally {
          writeFileSync(path, source);
          rmSync(original);
        }

        assert.equal(await value("document.getElementById('status').textContent"), "Closed.");
        assert.equal(await value("document.getElementById('player').hidden"), true);
        assert.equal(await value("document.getElementById('player').player === null"), true);
      },
    ],
    [
      "Stage3D opts in, draws beside a real Worker, restarts and releases its contexts",
      async () => {
        await navigate("index.html");
        assert.equal(await value("document.getElementById('stage3d').checked"), false);
        await open();
        assert.equal(await value(backendRequests), 0, "default playback fetched the backend");
        await clear();
        await click("stage3d");
        await ready();
        assert.ok((await value<number>(backendRequests)) > 0);
        assert.equal(
          await value(
            "document.getElementById('player').shadowRoot.querySelectorAll('canvas').length",
          ),
          2,
        );
        await remember();
        const box = await value<number[]>(`(() => {
          const rect = siteStage3DCanvas.getBoundingClientRect();
          return [rect.x + 16, rect.y + 16];
        })()`);
        const shot = await send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          clip: { x: box[0], y: box[1], width: 1, height: 1, scale: 1 },
        });
        const pixel = decodePng(Buffer.from(shot.data, "base64"));
        assert.deepEqual([...pixel.data], [0, 255, 0, 255]);
        const report = new URL(
          await value<string>(`(() => {
            const link = document.getElementById('report');
            link.dispatchEvent(new Event('focus'));
            return link.href;
          })()`),
        );
        assert.match(report.searchParams.get("body") ?? "", /Stage3D: enabled \(experimental\)/);
        await clear();
        await click("reload");
        await ready();
        await retired();
        await remember();
        await clear();
        await click("stage3d");
        await until(logHas("site-stage3d unavailable 3702"));
        await until(logHas("site-stage3d worker replied"));
        await retired();
        assert.equal(
          await value(
            "document.getElementById('player').shadowRoot.querySelectorAll('canvas').length",
          ),
          1,
        );
        await clear();
        await click("stage3d");
        await ready();
        await remember();
        await click("close");
        await retired();
        assert.equal(await value("document.getElementById('status').textContent"), "Closed.");
        await navigate("index.html");
        assert.equal(await value("document.getElementById('stage3d').checked"), false);
        assert.equal(await value(backendRequests), 0, "a fresh page eagerly fetched the backend");
      },
    ],
  ];
}
