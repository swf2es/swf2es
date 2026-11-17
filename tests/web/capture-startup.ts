// The browser's capture host reads the devices only for a SWF that names
// Camera or Microphone: a browser's first enumeration cost every cold start
// a tenth of a second and more. One that names them, at its start or in a
// SWF it loads later, still finds them in its first frame.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compiler } from "../player/scripts.ts";

const compile = compiler(fileURLToPath(new URL("out/capture-startup/", import.meta.url)));

const none = bare(
  compile(
    "CaptureNone",
    `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.media.Sound;
  public class CaptureNone extends Sprite {
    private var frames:int = 0;
    public function CaptureNone() {
      new Sound();
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        if (++frames == 10) { trace("none: frames"); }
      });
    }
  }
}`,
  ),
  1,
  "CaptureNone",
);

const names = bare(
  compile(
    "CaptureNames",
    `package {
  import flash.display.Sprite;
  import flash.media.Camera;
  import flash.media.Microphone;
  public class CaptureNames extends Sprite {
    public function CaptureNames() {
      trace("names:", Camera.names.length > 0, Microphone.names.length > 0, Camera.getCamera() != null);
    }
  }
}`,
  ),
  1,
  "CaptureNames",
);

// Only by the string of its full name, as getDefinitionByName finds a class.
const byName = bare(
  compile(
    "CaptureByName",
    `package {
  import flash.display.Sprite;
  import flash.utils.getDefinitionByName;
  public class CaptureByName extends Sprite {
    public function CaptureByName() {
      var camera:Object = getDefinitionByName("flash.media.Camera");
      trace("by name:", camera.names.length > 0);
    }
  }
}`,
  ),
  1,
  "CaptureByName",
);

const child = bare(
  compile(
    "CaptureLater",
    `package {
  import flash.display.Sprite;
  import flash.media.Camera;
  import flash.media.Microphone;
  public class CaptureLater extends Sprite {
    public function CaptureLater() {
      trace("child:", Camera.names.length > 0, Microphone.names.length > 0, Camera.getCamera() != null);
    }
  }
}`,
  ),
  1,
  "CaptureLater",
);

const parent = bare(
  compile(
    "CaptureLoader",
    `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.external.ExternalInterface;
  import flash.utils.ByteArray;
  public class CaptureLoader extends Sprite {
    private var loader:Loader = new Loader();
    public function CaptureLoader() {
      addChild(loader);
      ExternalInterface.addCallback("loadChild", function():void {
        var bytes:ByteArray = new ByteArray();
        for each (var value:int in [${[...child].join(",")}]) { bytes.writeByte(value); }
        bytes.position = 0;
        loader.loadBytes(bytes);
      });
      trace("parent: started");
    }
  }
}`,
  ),
  1,
  "CaptureLoader",
);

const swfs = { none: [...none], names: [...names], byName: [...byName], parent: [...parent] };
const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<string[]>(`(async () => {
  const swfs = ${JSON.stringify(swfs)};
  const calls = [];
  const media = navigator.mediaDevices;
  const enumerate = media.enumerateDevices.bind(media);
  media.enumerateDevices = () => { calls.push('enumerateDevices'); return enumerate(); };
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor) => { calls.push('query ' + descriptor.name); return query(descriptor); };
  const { configure } = await import('@swf2es/web');
  configure({ cache: false });
  const traces = [], errors = [], passed = [];
  const { log, error } = console;
  console.log = (...args) => traces.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  const check = (ok, why) => {
    if (!ok) throw new Error(why + ': ' + traces.join('; ') + ' calls: ' + calls.join(', ') + ' errors: ' + errors.join('; '));
    passed.push(why);
  };
  const wait = async (line) => {
    const until = performance.now() + 10000;
    while (!traces.includes(line)) {
      if (performance.now() > until) {
        throw new Error(line + ' timed out: ' + traces.join('; ') + ' errors: ' + errors.join('; '));
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const play = async (bytes) => {
    const p = document.createElement('swf2es-player');
    p.setAttribute('allowscriptaccess', 'always');
    document.body.append(p);
    await p.load(Uint8Array.from(bytes));
    return p;
  };
  try {
    let p = await play(swfs.none);
    await wait('none: frames');
    check(calls.length === 0, 'a SWF without capture code read the devices');
    p.destroy(); p.remove();

    p = await play(swfs.parent);
    await wait('parent: started');
    check(calls.length === 0, 'a loader without capture code read the devices');
    p.loadChild();
    await wait('child: true true true');
    check(calls.includes('enumerateDevices'), 'a loaded SWF that names Camera did not read the devices');
    p.destroy(); p.remove();

    calls.length = 0;
    p = await play(swfs.names);
    await wait('names: true true true');
    check(calls.filter(c => c === 'enumerateDevices').length === 1, 'enumerated other than once');
    check(calls.includes('query camera') && calls.includes('query microphone'), 'permissions not read');
    p.destroy(); p.remove();

    p = await play(swfs.byName);
    await wait('by name: true');
    p.destroy(); p.remove();
    check(errors.length === 0, 'uncaught errors');
    return passed;
  } finally { console.log = log; console.error = error; }
})()`),
  false,
  {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    // Four cold players in one page: room for a loaded CI runner.
    timeout: 120000,
  },
);
assert.equal(exception, null, exception ?? "browser exception");
assert.equal(value?.length, 6);
console.log("capture startup: devices read only for SWFs that name Camera or Microphone passed");
