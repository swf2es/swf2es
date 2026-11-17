import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<number>(`(async () => {
    const { RenderView } = await import('@swf2es/player/scene');
    const { VideoObject, Container, VideoSource } = await import('@swf2es/player');
    const { BitmapObject } = await import('/player/display/bitmapobject.js');
    const { BitmapStore } = await import('/player/bitmap/bitmap.js');
    const { bitmapDataNatives } = await import('/player/playerglobal/flash/display/BitmapData.js');
    const { filterDefaults } = await import('/player/display/filters.js');
    const { CONTENT } = await import('/player/display/displayobject.js');
    const view = new RenderView({ width: 48, height: 40, preserveDrawingBuffer: true });
    const reference = new RenderView({ width: 48, height: 40, preserveDrawingBuffer: true });
    const gl = view.gl;
    let checks = 0, uploads = 0, reads = 0;
    const check = (ok, why) => { if (!ok) throw new Error(why); checks++; };
    const source = new VideoSource();
    const canvas = new OffscreenCanvas(4, 4);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const publish = (color) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height / 2);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, canvas.height / 2, canvas.width, canvas.height / 2);
      source.publish({ width: canvas.width, height: canvas.height, image: canvas,
        readPixels() { reads++; return ctx.getImageData(0, 0, canvas.width, canvas.height).data; } });
    };
    const image = gl.texImage2D.bind(gl);
    gl.texImage2D = (...args) => { if (args.at(-1) === canvas) uploads++; return image(...args); };
    const pixels = (v, root) => {
      v.render(root);
      const data = new Uint8Array(48 * 40 * 4);
      v.gl.readPixels(0, 0, 48, 40, v.gl.RGBA, v.gl.UNSIGNED_BYTE, data);
      check(v.gl.getError() === v.gl.NO_ERROR, 'WebGL error');
      return data;
    };
    const root = new Container();
    const parent = new Container(); root.addChildAt(parent, 0);
    const video = new VideoObject(); video.boxWidth = 16; video.boxHeight = 16;
    video.matrix.tx = 4; video.matrix.ty = 4; video.source = source;
    parent.addChildAt(video, 0);
    const other = new VideoObject(); other.boxWidth = 8; other.boxHeight = 8;
    other.matrix.tx = 28; other.matrix.ty = 4; other.source = source;
    root.addChildAt(other, 1);
    const equalReference = () => {
      const expected = new Container();
      const group = new Container(); group.filters = parent.filters; expected.addChildAt(group, 0);
      for (const [v, p] of [[video, group], [other, expected]]) {
        const bitmap = new BitmapObject(source.bitmap());
        bitmap.matrix = { ...v.matrix, a: v.matrix.a * v.boxWidth / canvas.width,
          b: v.matrix.b * v.boxWidth / canvas.width, c: v.matrix.c * v.boxHeight / canvas.height,
          d: v.matrix.d * v.boxHeight / canvas.height };
        bitmap.colorTransform = v.colorTransform; bitmap.smoothing = v.smoothing;
        bitmap.filters = v.filters; bitmap.visible = v.visible;
        p.addChildAt(bitmap, p.children.length);
      }
      const actual = pixels(view, root), wanted = pixels(reference, expected);
      check(actual.every((p, i) => Math.abs(p - wanted[i]) <= 1), 'video differs from bitmap reference');
    };
    try {
      publish('#ff0000');
      const first = pixels(view, root);
      check(uploads === 1, 'shared source uploaded more than once');
      check(reads === 0, 'render requested CPU pixels');
      const top = ((40 - 8 - 1) * 48 + 8) * 4;
      const bottom = ((40 - 16 - 1) * 48 + 8) * 4;
      check(first[top] === 255 && first[top + 2] === 0, 'top row orientation');
      check(first[bottom] === 0 && first[bottom + 2] === 255, 'bottom row orientation');
      check(view.unchanged(root), 'unchanged frame marked dirty');
      pixels(view, root);
      check(uploads === 1, 'unchanged frame uploaded again');
      equalReference();
      parent.filters = [{ ...filterDefaults('blur'), blurX: 4, blurY: 4, quality: 1 }];
      parent.invalidate(CONTENT);
      equalReference(); pixels(view, root);
      publish('#00ff00');
      check(!view.unchanged(root), 'new frame did not invalidate the stage');
      equalReference();
      check(uploads === 2, 'new frame not uploaded exactly once');
      video.smoothing = true; other.smoothing = true;
      video.matrix.a = 0.85; video.matrix.b = 0.2; video.matrix.c = -0.15;
      video.colorTransform = { rMul: 0.5, gMul: 0.75, bMul: 1, aMul: 0.8,
        rAdd: 20, gAdd: 0, bAdd: 0, aAdd: 0 };
      video.invalidate(CONTENT);
      equalReference();
      canvas.width = 8; canvas.height = 2;
      publish('rgba(255, 0, 0, 0.5)'); pixels(view, root);
      check(uploads === 3, 'resized frame upload');

      // Invoke the actual native with no renderer and forbid any GPU readback.
      const target = new BitmapStore(16, 16, true, 0);
      const beforeRead = reads;
      const rt = { toString: String };
      const natives = bitmapDataNatives({ rt });
      const read = gl.readPixels;
      gl.readPixels = () => { throw new Error('video CPU copy used GPU readback'); };
      try {
        natives['flash.display::BitmapData#draw'](rt).call({ $store: target },
          { $display: video }, null, null, null, null, false);
      } finally { gl.readPixels = read; }
      check(target.pixels[0] === 0x80800000 && target.pixels[15 * 16] === 0xff0000ff,
        'BitmapData.draw(video) CPU pixels or display-box scaling');
      check(reads === beforeRead + 1, 'native did not obtain CPU frame on demand');
      equalReference();

      const beforeLoss = pixels(view, root);
      const loss = gl.getExtension('WEBGL_lose_context');
      check(!!loss, 'context-loss extension unavailable');
      await new Promise(resolve => {
        view.canvas.addEventListener('webglcontextlost', resolve, { once: true }); loss.loseContext();
      });
      await new Promise(resolve => {
        view.canvas.addEventListener('webglcontextrestored', resolve, { once: true }); loss.restoreContext();
      });
      const restored = pixels(view, root);
      check(restored.every((p, i) => p === beforeLoss[i]), 'context restore changed video');
      check(uploads === 4, 'context restore did not upload source again');
      video.clear(); other.clear();
      check(pixels(view, root).every(p => p === 255), 'clear left a frame visible');
      publish('#ffff00'); equalReference();
      video.source = null; other.source = null;
      check(pixels(view, root).every(p => p === 255), 'detach left a frame visible');
      video.source = source; other.source = source; equalReference();
      source.publish(null);
      check(pixels(view, root).every(p => p === 255), 'ended source left a frame visible');
      return checks;
    } finally { view.destroy(); reference.destroy(); }
  })()`),
);
assert.equal(exception, null, exception ?? "browser exception");
assert.ok(value !== null && value > 30);
console.log(`live video: ${value} checks passed`);
