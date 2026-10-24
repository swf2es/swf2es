import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { bare } from "../player/cases.ts";
import { decodePng } from "../player/image.ts";
import { compileScripts } from "../player/scripts.ts";

interface Page {
  value<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: object): Promise<T>;
  until(expression: string): Promise<void>;
  navigate(path: string): Promise<void>;
  out: string;
}

interface Frame {
  logical: number[];
  pixels: number[];
  player: number[];
  surface: number[];
  fullscreen: number[];
}

export function fullscreenChecks(page: Page): [string, () => Promise<void>][] {
  const { value, send, until, navigate, out } = page;
  const metrics = (width: number, height: number, deviceScaleFactor = 1) =>
    send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  const enter = async () => {
    const result = await send<{ exceptionDetails?: object }>("Runtime.evaluate", {
      expression: "document.getElementById('fullscreen').click()",
      userGesture: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    await until("document.fullscreenElement === document.getElementById('stage')");
  };
  const exit = async () => {
    await value("document.exitFullscreen().then(() => true)");
    await until(
      "!document.fullscreenElement && !document.getElementById('stage').classList.contains('composed-fullscreen')",
    );
  };
  const state = () =>
    value<Frame>(`(() => {
      const player = document.getElementById('player');
      const s = player.player.scripting;
      const rect = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      return {
        logical: [s.stageWidth, s.stageHeight],
        pixels: [siteFullscreenSurface.width, siteFullscreenSurface.height],
        player: rect(player),
        surface: rect(siteFullscreenSurface),
        fullscreen: rect(document.getElementById('stage')),
      };
    })()`);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.1, `${a} != ${b}`);

  return [
    [
      "fullscreen enlarges Stage3D and its overlay together, keeps input and restores layout",
      async () => {
        await metrics(320, 600);
        await navigate("index.html");
        const abc = compileScripts(
          [
            {
              name: "SiteFullscreen",
              source: readFileSync(new URL("SiteFullscreen.as", import.meta.url), "utf8"),
            },
          ],
          `${out}fullscreen`,
        ).get("SiteFullscreen") as Uint8Array;
        const file = `${out}fullscreen.swf`;
        writeFileSync(file, bare(abc, 1, "SiteFullscreen", 96, 96));
        await value("document.getElementById('stage3d').click()");
        const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
          expression: "document.getElementById('file')",
        });
        await send("DOM.setFileInputFiles", { objectId: result.objectId, files: [file] });
        await until("document.getElementById('log').innerText.includes('site-fullscreen ready')");
        await value(`globalThis.siteFullscreenSurface = [...document.getElementById('player').shadowRoot.querySelectorAll('canvas')]
          .find(c => c.width === 32 && c.height === 32)`);
        const before = await state();
        const pixel = async (x: number, y: number, expected: number[]) => {
          const shot = await send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            clip: { x, y, width: 1, height: 1, scale: 1 },
          });
          assert.deepEqual([...decodePng(Buffer.from(shot.data, "base64")).data], expected);
        };
        const pointer = async () => {
          const count =
            "(document.getElementById('log').innerText.match(/site-fullscreen pointer 26 10/g) || []).length";
          const previous = await value<number>(count);
          const current = await state();
          const scale = current.surface[2] / 32;
          for (const type of ["mousePressed", "mouseReleased"]) {
            await send("Input.dispatchMouseEvent", {
              type,
              x: current.surface[0] + 26.25 * scale,
              y: current.surface[1] + 10.25 * scale,
              button: "left",
              clickCount: 1,
            });
          }

          await until(`${count} > ${previous}`);
        };
        const fitted = async () => {
          await until(`(() => {
            const box = document.getElementById('stage');
            const scale = Math.min(box.clientWidth / ${before.logical[0]}, box.clientHeight / ${before.logical[1]});
            return Math.abs(siteFullscreenSurface.getBoundingClientRect().width - 32 * scale) < 0.1;
          })()`);
          const current = await state();
          const scale = current.surface[2] / 32;
          assert.deepEqual(current.logical, before.logical);
          assert.deepEqual(current.pixels, [32, 32]);
          near(current.player[2], before.logical[0] * scale);
          near(current.player[3], before.logical[1] * scale);
          near(current.player[0] + current.player[2] / 2, current.fullscreen[2] / 2);
          near(current.player[1] + current.player[3] / 2, current.fullscreen[3] / 2);
          near(current.surface[0], current.player[0]);
          near(current.surface[1], current.player[1]);
          return current;
        };

        try {
          await enter();
          await metrics(1200, 900);
          const current = await fitted();
          const scale = current.surface[2] / 32;
          assert.ok(scale > 2, "fixed Stage3D surface did not enlarge");
          await pixel(
            current.surface[0] + 8 * scale,
            current.surface[1] + 8 * scale,
            [0, 255, 0, 255],
          );
          await pixel(
            current.surface[0] + 26 * scale,
            current.surface[1] + 10 * scale,
            [255, 255, 255, 255],
          );
          await pointer();
          await metrics(900, 1200, 2);
          await until(`(() => {
            const canvases = document.getElementById('player').shadowRoot.querySelectorAll('canvas');
            return devicePixelRatio === 2 && canvases[canvases.length - 1].width === ${before.logical[0] * 2};
          })()`);
          await fitted();
          await pointer();
          await exit();
          await until("siteFullscreenSurface.getBoundingClientRect().width === 32");
          assert.deepEqual((await state()).pixels, [32, 32]);
          assert.equal(
            await value(
              "document.getElementById('stage').classList.contains('composed-fullscreen')",
            ),
            false,
          );
          await pointer();
          await enter();
          await exit();
          await value(`globalThis.savedFullscreenRequest = document.getElementById('stage').requestFullscreen;
            document.getElementById('stage').requestFullscreen = () => Promise.reject(new Error('test refusal'));
            document.getElementById('fullscreen').click()`);
          await until(
            "document.getElementById('status').textContent === 'Full screen was refused.'",
          );
          assert.equal(
            await value(
              "document.getElementById('stage').classList.contains('composed-fullscreen')",
            ),
            false,
          );
          assert.equal(
            await value(
              "document.getElementById('stage').style.getPropertyValue('--fullscreen-width')",
            ),
            "",
          );
        } finally {
          await value(`if (globalThis.savedFullscreenRequest) {
            document.getElementById('stage').requestFullscreen = savedFullscreenRequest;
            delete globalThis.savedFullscreenRequest;
          }`);
          if (await value("!!document.fullscreenElement")) {
            await exit();
          }

          await value("document.getElementById('close').click()");
          assert.equal(
            await value(
              "!siteFullscreenSurface.isConnected && siteFullscreenSurface.getContext('webgl2').isContextLost()",
            ),
            true,
          );
          await value("delete globalThis.siteFullscreenSurface");
          await metrics(1000, 1100);
        }
      },
    ],
    [
      "ordinary playback keeps its responsive fullscreen viewport",
      async () => {
        await navigate("index.html?swf=demos%2Fbounce.swf");
        await until("document.getElementById('status').textContent === 'Playing bounce.swf.'");
        try {
          await enter();
          await until(
            "document.getElementById('player').clientWidth === document.getElementById('stage').clientWidth",
          );
          assert.equal(
            await value(
              "document.getElementById('stage').classList.contains('composed-fullscreen')",
            ),
            false,
          );
        } finally {
          if (await value("!!document.fullscreenElement")) {
            await exit();
          }
        }
      },
    ],
  ];
}
