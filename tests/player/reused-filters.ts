// Kept filter outputs drawn again through the batcher (Pixi's
// FilterSystem.batchesReused) must come out as each filter's own pass drew
// them: the same frames drawn both ways, pixel for pixel, with the kept
// outputs under a mask, in faded and tinted parents, inside filters that run
// again and filters that are kept too, moving, inside render groups that
// scale and turn, and next to the ones the batcher must leave to their
// filters (coloured, inside a faded render group), and blended as the GPU blends.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

interface Result {
  case: string;
  worst: number;
  differing: number;
  gathered: number;
}

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<Result[]>(`(async () => {
    const { autoDetectRenderer, Container, Graphics, RenderTexture } = await import("pixi.js");
    const { FilterChain, displayFilters } = await import("/player/render/filters.js");
    const { measureFilterArea } = await import("/player/render/blend.js");
    const { filterDefaults } = await import("/player/display/filters.js");
    const glow = { ...filterDefaults("glow"), blurX: 8, blurY: 8, quality: 2, strength: 2, color: 0xffcc00 };
    const blur = { ...filterDefaults("blur"), blurX: 5, blurY: 5, quality: 1 };
    const shadow = { ...filterDefaults("dropShadow"), blurX: 6, blurY: 6, quality: 1, distance: 5, angle: 45 };
    const results = [];
    for (const resolution of [1, 1.45, 2]) {
      const renderer = await autoDetectRenderer({ width: 240, height: 180, resolution, preference: "webgl",
        antialias: false, backgroundAlpha: 0, useBackBuffer: true });
      renderer.filter.filterAreaHook = measureFilterArea;
      let gathered = 0;
      const gather = renderer.filter._gatherReused;
      renderer.filter._gatherReused = function (...args) {
        const done = gather.apply(this, args);
        gathered += done ? 1 : 0;
        return done;
      };
      const chains = [];
      const root = new Container();
      const art = (color, w = 30, h = 24) => new Graphics().rect(0, 0, w, h).fill(color).circle(w, h, 8).fill(0x3366cc);
      const filtered = (parent, records, color, x, y) => {
        const object = new Container();
        object.addChild(art(color));
        object.position.set(x, y);
        parent.addChild(object);
        const chain = new FilterChain(displayFilters(records), object, true, 1);
        object.filters = [chain];
        chains.push(chain);
        return { object, chain };
      };
      root.addChild(new Graphics().rect(0, 0, 240, 180).fill(0x204020));

      // Moving, by whole and part pixels, and two kept side by side, the first hidden at times, which
      // moves the others' quads to other slots.
      const moving = filtered(root, [glow], 0xcc3333, 10, 10);
      const hiding = filtered(root, [blur], 0x33cc33, 60, 10);
      filtered(root, [glow], 0x3333cc, 100, 10);

      // Under a mask that cuts them.
      const masked = new Container();
      const mask = new Graphics().rect(150, 0, 50, 40).fill(0xffffff);
      root.addChild(mask);
      masked.mask = mask;
      root.addChild(masked);
      filtered(masked, [glow], 0xcccc33, 140, 8);
      filtered(masked, [shadow], 0xcc33cc, 175, 12);

      // In a faded parent, faded itself, and in a tinted one.
      const faded = new Container();
      faded.alpha = 0.6;
      root.addChild(faded);
      filtered(faded, [glow], 0x33cccc, 10, 60).object.alpha = 0.7;
      const tinted = new Container();
      tinted.tint = 0xff8080;
      root.addChild(tinted);
      filtered(tinted, [blur], 0xffffff, 60, 60);

      // Inside a filter run again each frame, and inside one kept too.
      const outer = filtered(root, [shadow], 0x808080, 100, 60);
      filtered(outer.object, [glow], 0xcc3333, 10, 8);
      const keptOuter = filtered(root, [blur], 0x404040, 150, 60);
      filtered(keptOuter.object, [glow], 0x33cc33, 8, 6);

      // Inside a render group that scales and turns, and one faded, which the batcher leaves alone.
      const group = new Container({ isRenderGroup: true });
      group.position.set(20, 110);
      group.scale.set(1.25, 0.8);
      group.rotation = 0.2;
      root.addChild(group);
      filtered(group, [glow], 0xcc8833, 0, 0);
      filtered(group, [blur], 0x8833cc, 40, 4);
      const fadedGroup = new Container({ isRenderGroup: true });
      fadedGroup.alpha = 0.5;
      fadedGroup.position.set(120, 120);
      root.addChild(fadedGroup);
      filtered(fadedGroup, [glow], 0x33cc88, 0, 0);

      // Coloured, drawn by its own pass, and blended by the GPU, drawn through the batcher too.
      filtered(root, [glow], 0xffffff, 180, 120).chain.recolor({ rMul: 0.5, gMul: 1, bMul: 1, aMul: 1,
        rAdd: 40, gAdd: 0, bAdd: 0, aAdd: 0 });
      filtered(root, [blur], 0x6060ff, 200, 140).chain.blendOver("add");
      filtered(root, [glow], 0x9090ff, 150, 150).chain.blendOver("multiply");
      filtered(root, [blur], 0xff9090, 165, 155).chain.blendOver("multiply");
      filtered(root, [shadow], 0x90ff90, 60, 150).chain.blendOver("screen");

      const step = (frame) => {
        moving.object.position.set(10 + frame * 1.37, 10 + frame * 0.5);
        hiding.object.visible = frame % 3 !== 2;
        outer.chain.changed();
      };
      const draw = (target, batched) => {
        renderer.filter.batchesReused = batched;
        renderer.render({ container: root, target, clear: true });
        return renderer.extract.pixels({ target }).pixels;
      };
      const plain = RenderTexture.create({ width: 240, height: 180, resolution });
      const batched = RenderTexture.create({ width: 240, height: 180, resolution });
      for (let frame = 0; frame < 6; frame++) {
        step(frame);
        const a = draw(plain, false);
        step(frame);
        gathered = 0;
        const b = draw(batched, true);
        let worst = 0;
        let differing = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          worst = Math.max(worst, d);
          differing += d > 0 ? 1 : 0;
        }

        results.push({ case: resolution + "x frame " + frame, worst, differing, gathered });
      }

      for (const chain of chains) {
        chain.forget();
      }

      plain.destroy(true);
      batched.destroy(true);
      root.destroy({ children: true });
      renderer.destroy();
    }

    return results;
  })()`),
);
if (exception) {
  throw new Error(exception);
}

const results = value as Result[];
const bad = results
  .filter((r) => r.worst > 0)
  .map((r) => `${r.case}: ${r.differing} channels differ, by up to ${r.worst}`);
assert.deepEqual(bad, [], "kept outputs drawn through the batcher as their filters drew them");
// From the second frame on, all but the moving one's first and the outer filter run again are kept.
const few = results.filter((r) => !r.case.endsWith("frame 0") && r.gathered < 13);
assert.deepEqual(
  few.map((r) => `${r.case}: ${r.gathered} gathered`),
  [],
  "kept outputs drawn through the batcher",
);
console.log(
  `reused-filters: ${results.length} frames ok, ${results.map((r) => r.gathered).join(" ")} gathered`,
);
