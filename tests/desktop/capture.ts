import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { bare } from "../player/cases.ts";
import { compiler } from "../player/scripts.ts";
import { type App, display, withApp } from "./app.ts";

const why = missing();
if (why) {
  console.log(`desktop capture: skipped. ${why}`);
  process.exit(0);
}
const out = fileURLToPath(new URL("out/capture/", import.meta.url));
mkdirSync(out, { recursive: true });
const source = `package {
  import flash.display.Sprite;
  import flash.display.BitmapData;
  import flash.media.Camera;
  import flash.media.Microphone;
  import flash.media.Video;
  import flash.events.Event;
  import flash.events.StatusEvent;
  import flash.events.SampleDataEvent;
  public class DesktopCapture extends Sprite {
    private var camera:Camera;
    private var mic:Microphone;
    private var video:Video;
    private var heard:Boolean = false;
    private var cameraGranted:Boolean = false;
    public function DesktopCapture() {
      camera = Camera.getCamera(); mic = Microphone.getMicrophone();
      trace("capture devices", camera != null, mic != null);
      trace("capture names before", Camera.names.join("") == "", Microphone.names.join("") == "");
      addEventListener(Event.ENTER_FRAME, names);
      if (!camera || !mic) return;
      camera.addEventListener(StatusEvent.STATUS, status);
      mic.addEventListener(StatusEvent.STATUS, status);
      video = new Video(160,120); addChild(video);
      camera.setMode(320,240,15);
      camera.addEventListener("videoFrame", frame);
      if ("permissionStatus" in Camera) {
        trace("permission before", Object(Camera).permissionStatus);
        Object(camera).addEventListener("permissionStatus", permitted);
        Object(camera).requestPermission();
      } else { startCamera(); }
      mic.rate = 44; mic.setSilenceLevel(0);
      mic.addEventListener(SampleDataEvent.SAMPLE_DATA, samples);
    }
    private function names(e:Event):void {
      if (Camera.names.join("") != "" && Microphone.names.join("") != "") {
        trace("capture names after", true, true);
        removeEventListener(Event.ENTER_FRAME, names);
      }
    }
    private function permitted(e:Event):void {
      trace("permission event", Object(e).status, Object(e.clone()).status);
      if (Object(e).status == "granted") startCamera();
    }
    private function startCamera():void { video.attachCamera(camera); }
    private function status(e:StatusEvent):void {
      trace("capture status", e.code);
      trace("capture muted", e.code, e.target.muted);
      if (e.code == "Camera.Unmuted") cameraGranted = true;
      if (e.code == "Camera.Muted" && cameraGranted && "permissionStatus" in Camera) {
        cameraGranted = false;
        Object(camera).requestPermission();
      }
    }
    private function frame(e:Event):void {
      if (camera.width > 0) {
        var bitmap:BitmapData = new BitmapData(160,120,true,0);
        bitmap.draw(video);
        trace("capture video", video.videoWidth, bitmap.getPixel32(80,60) != 0);
        bitmap.dispose(); camera.removeEventListener("videoFrame", frame);
      }
    }
    private function samples(e:SampleDataEvent):void {
      var audible:Boolean = false;
      while (e.data.bytesAvailable) { if (Math.abs(e.data.readFloat()) > 0.001) audible = true; }
      if (audible && !heard) { heard = true; trace("capture audio"); }
    }
  }
}`;
const movie = `${out}capture.swf`;
writeFileSync(movie, bare(compiler(out)("DesktopCapture", source), 1, "DesktopCapture"));
const idle = `${out}idle.swf`;
writeFileSync(
  idle,
  bare(
    compiler(out)(
      "Idle",
      "package { import flash.display.Sprite; public class Idle extends Sprite {} }",
    ),
    1,
    "Idle",
  ),
);
const descriptor = `${out}app.xml`;
writeFileSync(
  descriptor,
  `<application xmlns="http://ns.adobe.com/air/application/33.1"><id>org.swf2es.capture.test</id><versionNumber>1.0</versionNumber><filename>Capture test</filename><initialWindow><content>capture.swf</content><visible>true</visible></initialWindow></application>`,
);
const desktopPackage = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
const electron = `process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron")`;
const openModule = fileURLToPath(new URL("../../apps/desktop/dist/main/open.js", import.meta.url));
const opening = `process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})(${JSON.stringify(openModule)})`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) {
      return;
    }
    await pause();
  }
  assert.fail("capture state timed out");
}
async function boxes(app: App, answer: number | null, cameraOnly = false): Promise<void> {
  await app.main(`(() => {
    globalThis.captureBoxes = [];
    ${electron}.dialog.showMessageBox = (_window, options) => new Promise(resolve => {
      const box = { message:options.message, detail:options.detail, aborted:false };
      captureBoxes.push(box);
      options.signal?.addEventListener('abort', () => { box.aborted=true; resolve({response:1}); });
      if (${answer} !== null) resolve({response:${cameraOnly} && options.message.includes("microphone") ? 1 : ${answer}});
    });
    return true;
  })()`);
}
async function open(app: App, air = false): Promise<void> {
  await app.main(
    `(async () => { const m = ${opening}; ${air ? `await m.openAir({descriptor:${JSON.stringify(descriptor)},root:${JSON.stringify(out)},arguments:[]}, ${JSON.stringify(out)});` : `await m.openEntry(${JSON.stringify(movie)});`} return true; })()`,
  );
}
const screen = await display();
try {
  await withApp(
    screen.env,
    { recent: [] },
    [
      "--inspect=0",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
    async (app) => {
      await app.evaluate(`(() => {
      globalThis.captureTracks = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await original(...args); captureTracks.push(...stream.getTracks()); return stream; };
      return true;
    })()`);
      assert.equal(
        await app.evaluate(
          `navigator.mediaDevices.getUserMedia({video:true}).then(stream => { stream.getTracks().forEach(t => t.stop()); return false; }, () => true)`,
        ),
        true,
      );
      await boxes(app, null);
      await open(app);
      await until(() => app.main<boolean>("captureBoxes.length === 2"));
      const oldEpoch = await app.evaluate<number>("swf2esDesktop.capture.epoch()");
      await app.main(`(async () => { ${opening}.closeMovie(); return true; })()`);
      await until(() => app.main<boolean>("captureBoxes.every(box => box.aborted)"));
      assert.equal(
        await app.evaluate(`swf2esDesktop.capture.request(${oldEpoch}, 'camera')`),
        "denied",
      );
      await app.main(`(async () => {
        await ${opening}.openEntry(${JSON.stringify(idle)});
        ${opening}.current.movie.name = 'Title\\n\\u202e' + 'x'.repeat(400);
        return true;
      })()`);
      await boxes(app, 1);
      assert.equal(
        await app.evaluate(
          "swf2esDesktop.capture.request(swf2esDesktop.capture.epoch(), 'camera')",
        ),
        "denied",
      );
      const bounded = await app.main<{ message: string }[]>("captureBoxes");
      assert.equal(bounded.length, 1);
      assert.ok(bounded[0].message.length < 200);
      assert.ok(!/[\p{Cc}\p{Cf}]/u.test(bounded[0].message));
      // The bound counts code points: a cut pair would leave a lone surrogate.
      await app.main(
        `(() => { ${opening}.current.movie.name = 'T' + '\\u{1F600}'.repeat(200); return true; })()`,
      );
      await boxes(app, 1);
      assert.equal(
        await app.evaluate(
          "swf2esDesktop.capture.request(swf2esDesktop.capture.epoch(), 'microphone')",
        ),
        "denied",
      );
      const emoji = await app.main<{ message: string }[]>("captureBoxes");
      assert.equal(emoji.length, 1);
      assert.ok(emoji[0].message.startsWith(`T${"\u{1F600}".repeat(159)} `), emoji[0].message);
      assert.ok(!/\p{Cs}/u.test(emoji[0].message), "dialog cut a surrogate pair");
      await boxes(app, 1);
      await open(app);
      await app.until(
        "denied capture",
        () =>
          app.stdout.includes("capture status Camera.Muted") &&
          app.stdout.includes("capture status Microphone.Muted"),
      );
      assert.equal(await app.evaluate("captureTracks.length"), 0);
      const offered = await app.main<{ message: string; detail: string }[]>("captureBoxes");
      assert.equal(offered.length, 2);
      assert.ok(offered.some((box) => box.message.includes("camera")));
      assert.ok(offered.some((box) => box.message.includes("microphone")));
      assert.ok(offered.every((box) => box.detail.includes(movie)));
      await boxes(app, 0, true);
      await open(app);
      await until(() => app.evaluate<boolean>("captureTracks.some(t => t.readyState === 'live')"));
      assert.equal(
        await app.evaluate(`navigator.mediaDevices.getUserMedia({video:true, audio:true})
        .then(stream => { stream.getTracks().forEach(t => t.stop()); return false; }, () => true)`),
        true,
      );
      await boxes(app, 0);
      await open(app);
      await app.until(
        "live camera and microphone",
        () =>
          app.stdout.includes("capture audio") &&
          app.stdout.some((line) => line.startsWith("capture video 320 true")),
      );
      await until(() =>
        app.main<boolean>(
          `${electron}.BrowserWindow.getAllWindows()[0].getTitle().includes('[Camera + microphone live]')`,
        ),
      );
      assert.equal(
        await app.evaluate(`(async () => {
          const frame = document.createElement('iframe'); document.body.append(frame);
          try {
            return await frame.contentWindow.navigator.mediaDevices.getUserMedia({video:true})
              .then(stream => { stream.getTracks().forEach(t => t.stop()); return false; }, () => true);
          } finally { frame.remove(); }
        })()`),
        true,
      );
      assert.ok(app.stdout.includes("capture names before true true"));
      await app.until("device labels after consent", () =>
        app.stdout.includes("capture names after true true"),
      );
      await app.main(`(() => {
        globalThis.statusReads = 0;
        ${electron}.ipcMain.on('capture:status', () => statusReads++);
        return true;
      })()`);
      assert.equal(
        await app.evaluate(`(() => {
        const capture = swf2esDesktop.capture, epoch = capture.epoch();
        for (let i = 0; i < 1000; i++) {
          if (capture.status(epoch, 'camera') !== 'granted' || capture.status(epoch, 'microphone') !== 'granted') return false;
        }
        return true;
      })()`),
        true,
      );
      assert.ok(await app.main<boolean>("statusReads <= 2"));
      const stoppedAt = app.stdout.length;
      await app.main(
        `(() => { const item=${electron}.Menu.getApplicationMenu().getMenuItemById('stop-capture'); if(!item.enabled) throw new Error('stop disabled'); item.click(); return true; })()`,
      );
      await until(() =>
        app.evaluate<boolean>("captureTracks.every(t => t.readyState === 'ended')"),
      );
      assert.equal(
        await app.main(
          `${electron}.BrowserWindow.getAllWindows()[0].getTitle().includes(' live]')`,
        ),
        false,
      );

      await app.until("Stop status events", () => {
        const output = app.stdout.slice(stoppedAt);
        return (
          output.includes("capture muted Camera.Muted true") &&
          output.includes("capture muted Microphone.Muted true")
        );
      });

      assert.equal(
        await app.evaluate(`swf2esDesktop.capture.status(swf2esDesktop.capture.epoch(), 'camera')`),
        "denied",
      );
      // AIR requests explicit permission through the same dialog before attaching the camera.
      await boxes(app, 0);
      const airAt = app.stdout.length;
      await open(app, true);
      await app.until("AIR capture ready", () =>
        app.stdout.slice(airAt).includes("capture status Camera.Unmuted"),
      );
      await app.until("AIR permission event", () =>
        app.stdout.includes("permission event granted granted"),
      );
      assert.equal((await app.main<unknown[]>("captureBoxes")).length, 2);
      await until(() =>
        app.evaluate<boolean>("captureTracks.filter(t => t.readyState === 'live').length === 2"),
      );
      await app.main(
        `(() => { ${electron}.Menu.getApplicationMenu().getMenuItemById('stop-capture').click(); return true; })()`,
      );
      await app.until("AIR permission after Stop", () =>
        app.stdout.includes("permission event denied denied"),
      );
      await until(() =>
        app.evaluate<boolean>("captureTracks.every(t => t.readyState === 'ended')"),
      );
      // The platform can resolve getUserMedia after Stop or replacement; keep a healthy page alive.
      await app.evaluate(`(() => {
        globalThis.captureDelayed = false; globalThis.captureRelease = [];
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (...args) => {
          const stream = await original(...args);
          if (captureDelayed) await new Promise(resolve => captureRelease.push(resolve));
          return stream;
        };
        return true;
      })()`);
      for (const replace of [false, true]) {
        await boxes(app, 0);
        await app.evaluate(
          "(() => { captureDelayed = true; captureRelease = []; return true; })()",
        );
        await open(app, true);
        await until(() => app.evaluate<boolean>("captureRelease.length === 2"));
        const beforeStop = app.stdout.length;
        if (replace) {
          await boxes(app, 1);
          await open(app);
        } else {
          await app.main(
            `(() => { ${electron}.Menu.getApplicationMenu().getMenuItemById('stop-capture').click(); return true; })()`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 4500));
        assert.equal(
          await app.main(`${electron}.BrowserWindow.getAllWindows()[0].webContents.isCrashed()`),
          false,
        );
        assert.equal(
          await app.main(
            `${electron}.BrowserWindow.getAllWindows()[0].getTitle().includes(' live]')`,
          ),
          true,
        );
        await app.evaluate(
          "(() => { captureDelayed = false; captureRelease.forEach(resolve => resolve()); return true; })()",
        );
        await until(() =>
          app.evaluate<boolean>("captureTracks.every(t => t.readyState === 'ended')"),
        );
        assert.ok(!app.stdout.slice(beforeStop).some((line) => line.includes("Unmuted")));
        await until(() =>
          app.main<boolean>(
            `!${electron}.Menu.getApplicationMenu().getMenuItemById('stop-capture').enabled`,
          ),
        );
      }
      // A device that fails to open after consent is unavailable, not refused.
      await app.evaluate(`(() => {
        globalThis.captureCreate = document.createElement;
        document.createElement = function(name, ...rest) {
          if (name === 'video') throw new Error('no video element');
          return captureCreate.call(this, name, ...rest);
        };
        return true;
      })()`);
      await boxes(app, 0);
      const failedAt = app.stdout.length;
      await open(app);
      await app.until("camera unavailable", () =>
        app.stdout.slice(failedAt).includes("capture status Camera.Unavailable"),
      );
      await app.evaluate("(() => { document.createElement = captureCreate; return true; })()");
      assert.ok(!app.stdout.slice(failedAt).includes("capture status Camera.Muted"));
      assert.equal(
        await app.evaluate(`swf2esDesktop.capture.status(swf2esDesktop.capture.epoch(), 'camera')`),
        "granted",
      );
      // A reload while capturing: the old page may never hear the stop (it is unloading), and the
      // new one may take longer than the probe to load. The new page must not be killed for the
      // old page's tracks.
      await boxes(app, 0);
      await open(app, true);
      await until(() =>
        app.evaluate<boolean>("captureTracks.filter(t => t.readyState === 'live').length === 2"),
      );
      await boxes(app, 1);
      await app.main(`(() => {
        const contents = ${electron}.BrowserWindow.getAllWindows()[0].webContents;
        const send = contents.send;
        contents.send = function(channel, ...args) {
          return channel.startsWith('capture:') ? undefined : send.call(this, channel, ...args);
        };
        const finished = contents.listeners('did-finish-load');
        contents.removeAllListeners('did-finish-load');
        globalThis.reloadFinished = false;
        const late = (...args) => setTimeout(() => {
          finished.forEach(f => f(...args));
          reloadFinished = true;
        }, 3000);
        contents.on('did-finish-load', late);
        globalThis.restoreReload = () => {
          contents.send = send;
          contents.removeListener('did-finish-load', late);
          finished.forEach(f => contents.on('did-finish-load', f));
        };
        contents.reload();
        return true;
      })()`);
      // Past the two-second watchdog, and until the delayed load ends, the new page must live.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await until(() => app.main<boolean>("reloadFinished"));
      assert.equal(
        await app.main(`${electron}.BrowserWindow.getAllWindows()[0].webContents.isCrashed()`),
        false,
      );
      await app.main("(() => { restoreReload(); return true; })()");
      assert.equal(
        await app.main(
          `${electron}.BrowserWindow.getAllWindows()[0].getTitle().includes(' live]')`,
        ),
        false,
      );
      await until(() =>
        app.evaluate<boolean>("typeof swf2esDesktop === 'object'").catch(() => false),
      );
      await app.evaluate(`(() => {
        globalThis.captureTracks = [];
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await original(...args); captureTracks.push(...stream.getTracks()); return stream; };
        return true;
      })()`);
      await boxes(app, 0);
      await open(app, true);
      await until(() =>
        app.evaluate<boolean>("captureTracks.filter(t => t.readyState === 'live').length === 2"),
      );
      await boxes(app, 1);
      await app.evaluate("(() => { setTimeout(() => { for (;;) {} }, 0); return true; })()");
      await pause();
      await app.main(
        `(() => { ${electron}.Menu.getApplicationMenu().getMenuItemById('stop-capture').click(); return true; })()`,
      );
      assert.equal(
        await app.main(
          `${electron}.BrowserWindow.getAllWindows()[0].getTitle().includes(' live]')`,
        ),
        true,
      );
      // Replacing the movie must not cancel the shutdown of a stalled old page.
      await open(app);
      await until(() =>
        app.main<boolean>(`${electron}.BrowserWindow.getAllWindows()[0].webContents.isCrashed()`),
      );
      await until(() =>
        app.main<boolean>(
          `!${electron}.Menu.getApplicationMenu().getMenuItemById('stop-capture').enabled`,
        ),
      );
      assert.equal(
        await app.main(
          `${electron}.BrowserWindow.getAllWindows()[0].getTitle().includes(' live]')`,
        ),
        false,
      );
    },
    { coreDumps: false },
  );
  console.log("desktop capture: consent, fake devices, stop, AIR permission and page loss passed");
} finally {
  screen.stop();
}
