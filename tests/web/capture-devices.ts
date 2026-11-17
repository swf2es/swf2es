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

const prompted = new Set(["denied", "regrant"]);
for (const scenario of [
  "lifecycle",
  "revoke",
  "idle",
  "denied",
  "regrant",
  "unavailable",
  "filter",
  "cached",
]) {
  const result = await withPage(
    "runSwf",
    async (evaluate, send) => {
      if (prompted.has(scenario)) {
        await send("Browser.setPermission", { permission: { name: "camera" }, setting: "denied" });
        await send("Browser.setPermission", {
          permission: { name: "microphone" },
          setting: "denied",
        });
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
          if (scenario === 'unavailable') throw new DOMException('Device in use', 'NotReadableError');
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
        const wait = async (condition, label, ms = 10000) => {
          const until = performance.now() + ms;
          while (!condition()) {
            check(performance.now() < until, label + ' timed out');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        };
        const command = action => p.captureCommand(action);
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        try {
          await p.loadAir(openAirApp(Uint8Array.from(${JSON.stringify([...app])})), { keepFiles: false });
          await wait(() => count('capture: idle') === 1, 'idle frames');
          check(opens === 0 && count('capture: status') === 0, 'settings requested capture');
          check(traces.includes('capture: initial true true true true 2000 2000'), 'ABC defaults');
          if (scenario === 'idle') {
            // Devices the movie never opened have no consent to lose: Stop tells them nothing.
            p.setAttribute('allowcapture', 'false');
            await pause(1000);
            check(count('capture: status') === 0, 'Stop told idle devices');
            command('permission');
            await wait(() => count('capture: permission') === 2, 'permission after Stop');
            check(opens === 0 && errors.length === 0, 'idle Stop opened a device');
            return traces;
          }
          if (scenario === 'unavailable') {
            command('camera'); command('microphone');
            await wait(() => count('capture: status Camera.Unavailable') === 1 && count('capture: status Microphone.Unavailable') === 1, 'unavailable status');
            check(traces.includes('capture: status Camera.Unavailable status true true true'), 'camera unavailable event');
            check(traces.includes('capture: status Microphone.Unavailable status true true true'), 'microphone unavailable event');
            await pause(600);
            check(count('capture: status') === 2 && count('capture: samples') === 0, 'unavailable consent');
            check(errors.length === 0, 'uncaught errors');
            return traces;
          }
          if (scenario === 'filter' || scenario === 'cached') command(scenario);
          if (scenario === 'lifecycle') command('motion');
          command('camera');
          check(requests[0].video.frameRate.max === 15, 'setMode favorArea default');
          if (${prompted.has(scenario)}) {
            await wait(() => count('capture: status Camera.Muted') === 1, 'denial status');
            command('denied');
            check(traces.includes('capture: denied true 0 true'), 'denied frame');
            check(opens === 1 && tracks.length === 0, 'denied device open');
            command('microphone');
            await wait(() => count('capture: status Microphone.Muted') === 1, 'microphone denial status');
            check(count('capture: samples') === 0 && opens === 2 && tracks.length === 0, 'denied microphone open');
            // A refused script that asks again hears nothing new: the decision did not change.
            command('unsample'); command('microphone'); command('camera');
            await wait(() => opens === 4, 'second denied open');
            await pause(1000);
            check(count('capture: status Camera.Muted') === 1 && count('capture: status Microphone.Muted') === 1, 'repeated denial status');
            check(count('capture: status') === 2, 'status after denial');
            if (scenario === 'regrant') {
              // The user grants the devices later, in the browser's own controls.
              await new Promise(resolve => { globalThis.captureGrantReady = resolve; });
              command('unsample'); command('camera'); command('microphone');
              await wait(() => count('capture: picture') === 1 && count('capture: samples') === 1, 'grant after denial');
              for (const kind of ['Camera', 'Microphone']) {
                check(count('capture: status ' + kind + '.Unmuted') === 1, kind + ' Unmuted after denial');
                check(traces.includes('capture: status ' + kind + '.Unmuted status true true false'), kind + ' unmuted event');
              }
            }
          } else {
            await wait(() => count('capture: picture') === 1, 'camera picture');
            check(traces.includes('capture: picture 320 240 true 307200 255 76800'), 'camera copies');
            for (const text of ['small 2015', 'null 2007', 'null vector 2007']) {
              check(traces.includes('capture: ' + text), text);
            }
            if (scenario === 'lifecycle' || scenario === 'filter' || scenario === 'cached') {
              await new Promise(resolve => { globalThis.captureSnapshotReady = resolve; });
            }
            if (scenario === 'lifecycle') {
              await wait(() => traces.includes('capture: motion true true true'), 'camera activity', 30000);
              command('motion default');
              await wait(() => count('capture: default motion') === 1, 'default motion measurement');
            }
            command('microphone');
            await wait(() => count('capture: samples') === 1, 'microphone samples');
            check(traces.includes('capture: samples true true true bigEndian'), 'sample event');
            check(opens === 2, 'attach open count');
            if (scenario === 'revoke') {
              p.setAttribute('allowcapture', 'false');
              await wait(() => count('capture: status Camera.Muted') === 1 && count('capture: status Microphone.Muted') === 1, 'revocation status');
              await wait(() => tracks.every(t => t.readyState === 'ended'), 'revocation tracks');
              // Counted again over a while: revocation is reported once, not on each frame or reopen.
              command('camera'); command('unsample'); command('microphone');
              await pause(1000);
              check(count('capture: status Camera.Muted') === 1 && count('capture: status Microphone.Muted') === 1, 'repeated revocation status');
              command('permission');
              await wait(() => count('capture: permission') === 2, 'permission after Stop');
              check(traces.includes('capture: permission camera denied true') && traces.includes('capture: permission microphone denied true'), 'permission denial');
            } else {
              command('detach'); command('unsample');
              check(traces.includes('capture: retained true 320 240'), 'detached last frame');
              await wait(() => tracks.every(t => t.readyState === 'ended'), 'detach tracks');
              await new Promise(resolve => setTimeout(resolve, 200));
              command('retained');
              check(traces.includes('capture: still true'), 'detached image changed');
              command('camera'); command('microphone');
              await wait(() => count('capture: picture') === 2 && count('capture: samples') === 2, 'reopen');
              check(opens === 4, 'reopen count');
              command('transfer');
              check(traces.includes('capture: transfer 0'), 'camera transfer');
              command('unsample'); command('drop');
              for (let i = 0; i < 150 && tracks.some(t => t.readyState !== 'ended'); i++) {
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
      let finished = false;
      const settle = () => {
        finished = true;
      };
      void playback.then(settle, settle);
      // Whether the movie reached `name`; false if it ended first, whose result then tells why.
      const reach = async (name: string) => {
        for (let i = 0; i < 600 && !finished; i++) {
          const state = await evaluate<boolean>(`typeof ${name} === 'function'`);
          if (state.value === true) {
            return true;
          }

          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        assert.ok(finished, `AS3 movie did not reach ${name}`);
        return false;
      };
      if (scenario === "regrant" && (await reach("captureGrantReady"))) {
        for (const name of ["camera", "microphone"]) {
          await send("Browser.setPermission", { permission: { name }, setting: "granted" });
        }

        await evaluate("captureGrantReady()");
      }

      if (
        ["lifecycle", "filter", "cached"].includes(scenario) &&
        (await reach("captureSnapshotReady"))
      ) {
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
        // The fake pattern moves continuously; a few tries keep a slow frame from failing the check.
        let repainted = false;
        let previous = first;
        for (let i = 0; i < 5 && !repainted; i++) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const next = await snapshot();
          repainted = next.data.some((value, at) => value !== previous.data[at]);
          previous = next;
        }

        assert.ok(repainted, "stopped timeline did not repaint video");
        await evaluate("captureSnapshotReady()");
      }
      return playback;
    },
    false,
    {
      args: [
        "--use-fake-device-for-media-stream",
        ...(prompted.has(scenario) ? [] : ["--use-fake-ui-for-media-stream"]),
        "--js-flags=--expose-gc",
      ],
      timeout: 90000,
    },
  );
  assert.equal(result.exception, null, result.exception ?? "browser exception");
  assert.ok(result.value?.length);
  console.log(`AS3 capture: ${scenario} passed`);
  const motion = result.value?.find((line) => line.startsWith("capture: default motion"));
  if (motion) {
    console.log(motion);
  }
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

const childAbc = compile(
  "CaptureChild",
  `package {
  import flash.display.Sprite;
  import flash.media.Camera;
  import flash.media.Microphone;
  import flash.media.Video;
  import flash.events.SampleDataEvent;
  import flash.events.Event;
  public class CaptureChild extends Sprite {
    private var cam:Camera = Camera.getCamera();
    private var mic:Microphone = Microphone.getMicrophone();
    public function CaptureChild() {
      cam.addEventListener("status", cameraEvent);
      cam.addEventListener("videoFrame", cameraEvent);
      var video:Video = new Video(); addChild(video); video.attachCamera(cam);
      mic.addEventListener(SampleDataEvent.SAMPLE_DATA, sample);
    }
    private function cameraEvent(event:Event):void { trace("child: camera", event.type); }
    private function sample(event:SampleDataEvent):void { trace("child: samples"); }
  }
}`,
);
const child = bare(childAbc, 1, "CaptureChild");
const guestAbc = compile(
  "CaptureGuest",
  `package {
  import flash.display.Sprite;
  import flash.media.Camera;
  import flash.media.Microphone;
  import flash.events.Event;
  public class CaptureGuest extends Sprite {
    public function CaptureGuest() {
      Camera.getCamera().addEventListener("videoFrame", frame);
      Microphone.getMicrophone().setLoopBack(true);
      trace("child: guest");
    }
    private function frame(event:Event):void { trace("child: camera", event.type); }
  }
}`,
);
const guest = bare(guestAbc, 1, "CaptureGuest");
const parentAbc = compile(
  "CaptureParent",
  `package {
  import flash.display.Sprite;
  import flash.display.Loader;
  import flash.external.ExternalInterface;
  import flash.utils.ByteArray;
  import flash.media.Camera;
  import flash.media.Microphone;
  import flash.media.Video;
  import flash.events.Event;
  import flash.events.SampleDataEvent;
  public class CaptureParent extends Sprite {
    private var loader:Loader = new Loader();
    private var owned:int = 0;
    public function CaptureParent() {
      addChild(loader);
      var mode:String = loaderInfo.parameters.parent;
      if (mode == "yes") {
        Microphone.getMicrophone().addEventListener(SampleDataEvent.SAMPLE_DATA, sample);
      }
      if (mode == "owner") {
        // The parent's own capture, which the guest only listens to and loops as well.
        var own:Video = new Video(); addChild(own);
        Camera.getCamera().addEventListener("videoFrame", function(event:Event):void { owned++; });
        own.attachCamera(Camera.getCamera());
        Microphone.getMicrophone().setLoopBack(true);
      }
      ExternalInterface.addCallback("ownedFrames", function():int { return owned; });
      ExternalInterface.addCallback("resumeCamera", function():void {
        var video:Video = new Video(); addChild(video);
        Camera.getCamera().addEventListener("videoFrame", frame);
        video.attachCamera(Camera.getCamera());
      });
      ExternalInterface.addCallback("unloadCapture", function():void { loader.unloadAndStop(); trace("child: stopped"); });
      var bytes:ByteArray = new ByteArray();
      var bytesOf:Array = mode == "owner" ? [${[...guest].join(",")}] : [${[...child].join(",")}];
      for each(var value:int in bytesOf) { bytes.writeByte(value); }
      bytes.position = 0; loader.loadBytes(bytes);
    }
    private function sample(event:SampleDataEvent):void { trace("parent: samples"); }
    private function frame(event:Event):void {
      trace("parent: video"); Camera.getCamera().removeEventListener("videoFrame", frame);
    }
  }
}`,
);
const parent = [...bare(parentAbc, 1, "CaptureParent")];
for (const mode of ["no", "yes", "owner"]) {
  const unloaded = await withPage(
    "runSwf",
    (evaluate) =>
      evaluate<boolean>(`(async () => {
  await import('@swf2es/web');
  // A host may keep short stacks; the SWF that asked for capture must still be told apart.
  Error.stackTraceLimit = 2;
  const tracks = [], traces = [], errors = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args); tracks.push(...stream.getTracks()); return stream;
  };
  const { log, error } = console;
  console.log = (...args) => traces.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  const p = document.createElement('swf2es-player');
  p.setAttribute('allowscriptaccess', 'always'); document.body.append(p);
  p.setAttribute('flashvars', 'parent=${mode}');
  const live = () => tracks.filter(t => t.readyState === 'live').length;
  const wait = async (condition, label) => {
    const end = performance.now() + 10000;
    while (!condition()) {
      if (performance.now() > end) throw new Error(label + ': ' + traces.join('; ') + ' / ' + errors.join('; '));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    await p.load(Uint8Array.from(${JSON.stringify(parent)}));
    if ('${mode}' === 'owner') {
      await wait(() => live() === 2 && traces.includes('child: guest') && traces.includes('child: camera videoFrame'), 'guest capture');
      p.unloadCapture();
      await wait(() => traces.includes('child: stopped'), 'guest unload');
      const before = traces.length, frames = p.ownedFrames();
      await new Promise(resolve => setTimeout(resolve, 600));
      if (live() !== 2) throw new Error('guest unload stopped the parent camera or loopback: ' + live());
      await wait(() => p.ownedFrames() > frames, 'parent camera frames after guest unload');
      if (traces.slice(before).some(t => t.startsWith('child:'))) throw new Error('unloaded guest still hears capture events');
      if (errors.length) throw new Error(errors.join('; '));
      return true;
    }
    await wait(() => tracks.length === 2 && traces.includes('child: samples'), 'child capture');
    p.unloadCapture();
    await wait(() => live() === ('${mode}' === 'yes' ? 1 : 0), 'child tracks after unloadAndStop');
    const before = traces.length;
    p.resumeCamera();
    await wait(() => traces.slice(before).includes('parent: video'), 'parent camera');
    await new Promise(resolve => setTimeout(resolve, 250));
    if (traces.slice(before).some(t => t.startsWith('child:'))) throw new Error('unloaded child still hears capture events');
    if ('${mode}' === 'yes' && !traces.slice(before).includes('parent: samples')) throw new Error('child unload stopped parent microphone');
    if (errors.length) throw new Error(errors.join('; '));
    return true;
  } finally { p.destroy(); p.remove(); console.log = log; console.error = error; }
})()`),
    false,
    {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
      timeout: 30000,
    },
  );
  assert.equal(unloaded.exception, null, unloaded.exception ?? "browser exception");
  assert.equal(unloaded.value, true);
  console.log(`AS3 capture: child unloadAndStop with parent capture ${mode} passed`);
}
