import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compiler } from "../player/scripts.ts";

const abc = compiler(fileURLToPath(new URL("out/capture/", import.meta.url)))(
  "CaptureEmbedding",
  `package {
  import flash.display.Sprite;
  import flash.media.Camera;
  import flash.media.Video;
  public class CaptureEmbedding extends Sprite {
    public function CaptureEmbedding() {
      var camera:Camera = Camera.getCamera();
      if (camera) { var video:Video = new Video(); addChild(video); video.attachCamera(camera); }
    }
  }
}`,
);
const bytes = [...bare(abc, 1, "CaptureEmbedding")];
const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<number>(`(async () => {
  const { configure, replaceFlash } = await import('@swf2es/web');
  const opened = [];
  const capture = {
    cameras: [{id: 'generated', name: 'Generated camera'}],
    openCamera(device, mode, events, signal) {
      const live = { closed: false, signal }; opened.push(live);
      events.state('granted');
      return { close() { live.closed = true; }, setMode() {} };
    }
  };
  let checks = 0;
  const check = (ok, why) => { if (!ok) throw new Error(why); checks++; };
  const element = document.createElement('swf2es-player');
  document.body.append(element);
  const bytes = Uint8Array.from(${JSON.stringify(bytes)});
  try {
    configure({ capture, allowCapture: false });
    await element.load(bytes);
    check(opened.length === 0, 'configuration failed to refuse capture');
    configure({ allowCapture: true });
    element.setAttribute('allowcapture', 'false');
    await element.load(bytes);
    check(opened.length === 0, 'attribute failed to refuse capture');
    element.removeAttribute('allowcapture');
    await element.load(bytes);
    check(opened.length === 1 && !opened[0].closed, 'allowed capture did not open');
    element.setAttribute('allowcapture', 'false');
    check(opened[0].signal.aborted && opened[0].closed, 'revocation left capture running');
    element.removeAttribute('allowcapture');
    await element.load(bytes);
    check(opened.length === 2, 'new load did not restore capture permission');
    await element.load(bytes);
    check(opened[1].closed && opened[1].signal.aborted, 'replacement left old capture running');
    element.destroy();
    check(opened[2].closed && opened[2].signal.aborted, 'destroy left capture running');
    configure({ capture: null });
    await element.load(bytes);
    check(opened.length === 3, 'null host did not disable capture');
    configure({ capture, allowCapture: true });
    const holder = document.createElement('div');
    holder.innerHTML = '<embed src="generated.swf" type="application/x-shockwave-flash" allowcapture="false">';
    const replacement = replaceFlash(holder)[0];
    document.body.append(holder);
    try {
      await replacement.load(bytes);
      check(replacement.getAttribute('allowcapture') === 'false' && opened.length === 3,
        'Flash replacement discarded capture refusal');
    } finally { replacement.destroy(); holder.remove(); }
    return checks;
  } finally { element.destroy(); element.remove(); }
})()`),
);
assert.equal(exception, null, exception ?? "browser exception");
assert.equal(value, 9);
console.log("capture embedding: configuration, attribute and lifetime passed");
