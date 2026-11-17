import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { compiler } from "../player/scripts.ts";
import { zip } from "../zip-writer.ts";

const compile = compiler(fileURLToPath(new URL("out/capture-devices/", import.meta.url)));
const swf = bare(
  compile(
    "CaptureDevices",
    readFileSync(new URL("scripts/CaptureDevices.as", import.meta.url), "utf8"),
  ),
  1,
  "CaptureDevices",
  320,
  240,
);
const app = zip([
  {
    name: "META-INF/AIR/application.xml",
    data: `<application xmlns="http://ns.adobe.com/air/application/51.3">
      <id>org.swf2es.capture-test</id><filename>CaptureDevices</filename><versionNumber>1.0</versionNumber>
      <initialWindow><content>CaptureDevices.swf</content><width>320</width><height>240</height></initialWindow>
    </application>`,
  },
  { name: "CaptureDevices.swf", data: swf },
]);

for (const scenario of ["lifecycle", "revoke", "denied"]) {
  const result = await withPage(
    "runSwf",
    async (evaluate, send) => {
      if (scenario === "denied") {
        await send("Browser.setPermission", { permission: { name: "camera" }, setting: "denied" });
      }

      const playback = evaluate<string[]>(`(async () => {
        const { configure, openAirApp } = await import('@swf2es/web');
        configure({ cache: false });
        const scenario = ${JSON.stringify(scenario)};
        const traces = [], errors = [], tracks = [], requests = [];
        let opens = 0;
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (...args) => {
          opens++; requests.push(args[0]);
          const stream = await original(...args);
          tracks.push(...stream.getTracks());
          return stream;
        };
        const log = console.log, error = console.error;
        console.log = (...args) => traces.push(args.join(' '));
        console.error = (...args) => errors.push(args.join(' '));
        const p = document.createElement('swf2es-player');
        p.setAttribute('allowscriptaccess', 'always');
        p.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px';
        document.body.append(p);
        const count = prefix => traces.filter(t => t.startsWith(prefix)).length;
        const check = (ok, why) => { if (!ok) throw new Error(why + ': ' + traces.join('; ') + ' errors: ' + errors.join('; ')); };
        const wait = async (condition, label) => {
          const until = performance.now() + 10000;
          while (!condition()) {
            check(performance.now() < until, label + ' timed out');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        };
        const command = action => p.captureCommand(action);
        try {
          await p.loadAir(openAirApp(Uint8Array.from(${JSON.stringify([...app])})), { keepFiles: false });
          await wait(() => count('capture: idle') === 1, 'idle frames');
          check(opens === 0 && count('capture: status') === 0, 'settings requested capture');
          check(traces.includes('capture: initial true true true true 2000 2000'), 'ABC defaults');
          command('camera');
          check(requests[0].video.frameRate.max === 15, 'setMode favorArea default');
          if (scenario === 'denied') {
            await wait(() => count('capture: status Camera.Muted') === 1, 'denial status');
            command('denied');
            check(traces.includes('capture: denied true 0 true'), 'denied frame');
            check(opens === 1 && tracks.length === 0, 'denied device open');
          } else {
            await wait(() => count('capture: picture') === 1, 'camera picture');
            check(traces.includes('capture: picture 320 240 true 307200 255 76800'), 'camera copies');
            for (const text of ['small 2015', 'null 2007', 'null vector 2007']) {
              check(traces.includes('capture: ' + text), text);
            }
            if (scenario === 'lifecycle') {
              await new Promise(resolve => { globalThis.captureSnapshotReady = resolve; });
            }
            command('microphone');
            await wait(() => count('capture: samples') === 1, 'microphone samples');
            check(traces.includes('capture: samples true true true bigEndian'), 'sample event');
            check(opens === 2, 'attach open count');
            if (scenario === 'revoke') {
              p.setAttribute('allowcapture', 'false');
              await wait(() => count('capture: status Camera.Muted') === 1 && count('capture: status Microphone.Muted') === 1, 'revocation status');
              await wait(() => tracks.every(t => t.readyState === 'ended'), 'revocation tracks');
              command('permission');
              await wait(() => count('capture: permission') === 2, 'permission after Stop');
              check(traces.includes('capture: permission camera denied true') && traces.includes('capture: permission microphone denied true'), 'permission denial');
            } else {
              command('detach'); command('unsample');
              await wait(() => tracks.every(t => t.readyState === 'ended'), 'detach tracks');
              command('camera'); command('microphone');
              await wait(() => count('capture: picture') === 2 && count('capture: samples') === 2, 'reopen');
              check(opens === 4, 'reopen count');
              command('transfer');
              check(traces.includes('capture: transfer 0'), 'camera transfer');
              command('unsample'); command('drop');
              for (let i = 0; i < 30 && tracks.some(t => t.readyState !== 'ended'); i++) {
                gc();
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              check(tracks.every(t => t.readyState === 'ended'), 'collected video kept camera');
            }
            for (const kind of ['Camera', 'Microphone']) {
              check(count('capture: status ' + kind + '.Unmuted') === 1, 'duplicate ' + kind + ' Unmuted');
              check(traces.includes('capture: status ' + kind + '.Unmuted status true true false'), 'status event');
            }
          }
          check(errors.length === 0, 'uncaught errors');
          return traces;
        } finally {
          p.destroy(); p.remove(); console.log = log; console.error = error;
          navigator.mediaDevices.getUserMedia = original;
        }
      })()`);
      if (scenario === "lifecycle") {
        let ready = false;
        for (let i = 0; i < 400 && !ready; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const state = await evaluate<boolean>("typeof captureSnapshotReady === 'function'");
          ready = state.value === true;
        }
        assert.ok(ready, "AS3 movie did not reach snapshot stage");
        const snapshot = async () => {
          const shot = (await send("Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width: 320, height: 240, scale: 1 },
          })) as { data: string };
          return decodePng(new Uint8Array(Buffer.from(shot.data, "base64")));
        };
        const first = await snapshot();
        assert.ok(
          first.data.some((v, i) => i % 4 === 0 && v !== first.data[i + 1]),
          "stage has no colored camera pattern",
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
        const second = await snapshot();
        assert.notDeepEqual(first.data, second.data, "stopped timeline did not repaint video");
        await evaluate("captureSnapshotReady()");
      }
      return playback;
    },
    false,
    {
      args: [
        "--use-fake-device-for-media-stream",
        ...(scenario === "denied" ? [] : ["--use-fake-ui-for-media-stream"]),
        "--js-flags=--expose-gc",
      ],
      timeout: 45000,
    },
  );
  assert.equal(result.exception, null, result.exception ?? "browser exception");
  assert.ok(result.value?.length);
  console.log(`AS3 capture: ${scenario} passed`);
}

const refusal = zip([
  {
    name: "META-INF/AIR/application.xml",
    data: `<application xmlns="http://ns.adobe.com/air/application/51.3">
      <id>org.swf2es.capture-refusal</id><filename>RefusedCapture</filename><versionNumber>1.0</versionNumber>
      <initialWindow><content>RefusedCapture.swf</content></initialWindow></application>`,
  },
  {
    name: "RefusedCapture.swf",
    data: bare(
      compile(
        "RefusedCapture",
        `package {
      import flash.display.Sprite;
      import flash.media.Camera;
      import flash.media.Microphone;
      import flash.events.Event;
      public class RefusedCapture extends Sprite {
        public function RefusedCapture() {
          trace("refused", Object(Camera).permissionStatus, Object(Microphone).permissionStatus);
          var cameraClass:Class = Camera;
          var microphoneClass:Class = Microphone;
          var camera:Object = new cameraClass();
          var mic:Object = new microphoneClass();
          camera.addEventListener("permissionStatus", answer);
          mic.addEventListener("permissionStatus", answer);
          camera.requestPermission(); mic.requestPermission();
        }
        private function answer(event:Event):void { trace("answer", Object(event).status); }
      }
    }`,
      ),
      1,
      "RefusedCapture",
    ),
  },
]);
const refused = await withPage("runSwf", (evaluate) =>
  evaluate<string[]>(`(async () => {
  const { configure, openAirApp } = await import('@swf2es/web');
  const traces = [], errors = [];
  const { log, error } = console;
  console.log = (...args) => traces.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  navigator.mediaDevices.getUserMedia = () => { throw new Error('refused capture opened'); };
  try {
    for (const policy of ['attribute', 'configuration', 'null']) {
      configure({ allowCapture: policy !== 'configuration', capture: policy === 'null' ? null : undefined });
      const p = document.createElement('swf2es-player');
      if (policy === 'attribute') p.setAttribute('allowcapture', 'false');
      document.body.append(p);
      try {
        const at = traces.length;
        await p.loadAir(openAirApp(Uint8Array.from(${JSON.stringify([...refusal])})), {keepFiles:false});
        const until = performance.now() + 5000;
        while (traces.length < at + 3 && performance.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (traces.slice(at).join('|') !== 'refused denied denied|answer denied|answer denied') {
          throw new Error(policy + ': ' + traces.slice(at).join('|'));
        }
      } finally { p.destroy(); p.remove(); }
    }
    if (errors.length) throw new Error(errors.join('; '));
    return traces;
  } finally { console.log = log; console.error = error; }
})()`),
);
assert.equal(refused.exception, null, refused.exception ?? "browser exception");
assert.equal(refused.value?.length, 9);
console.log("AS3 capture: initial embedding refusal passed");
