// A morph whose fill is many wobbly closed contours stacked almost on top of
// each other, each turned a little, so that neighbours cross at many points:
// the tessellator's worst case, which grows steeply with the contours
// (about 0.2 s at 40, 1.5 s at 80). For the tests of what keeps its
// blends and their triangles (parts.test.ts, timeline.test.ts).
import { readMorphShape, readSwf } from "../../../../packages/format/dist/index.js";
import type { MorphCharacter } from "../../../../packages/player/dist/display/timeline.js";
import * as w from "../../../swf-writer.ts";

/** `count` contours of `points` points each, contour c turned by c * `turn`, in twips. */
function deck(count: number, points: number, turn: number, grow: number): w.PathCommand[][] {
  const contours: w.PathCommand[][] = [];
  for (let c = 0; c < count; c++) {
    const a = c * turn;
    const at = (k: number): [number, number] => {
      const u = (k / points) * Math.PI * 2;
      const r = (200 + 12 * Math.sin(u * 9)) * grow;
      const x = r * Math.cos(u) * 0.7;
      const y = r * Math.sin(u);
      return [
        Math.round((300 + x * Math.cos(a) - y * Math.sin(a)) * 20),
        Math.round((300 + x * Math.sin(a) + y * Math.cos(a)) * 20),
      ];
    };
    const commands: w.PathCommand[] = [{ move: at(0) }];
    for (let k = 1; k < points; k++) {
      commands.push({ line: at(k) });
    }

    commands.push({ line: at(0) });
    contours.push(commands);
  }

  return contours;
}

/** The morph's DefineMorphShape, character 1: the deck grows by a fifth from its start to its end. */
export function crossingMorphTag(count: number, points = 200, color = 0xff336699): Uint8Array {
  const start = deck(count, points, 0.004, 1);
  const end = deck(count, points, 0.004, 1.2);
  return w.morphShape({
    id: 1,
    startBounds: [0, 12000, 0, 12000],
    endBounds: [0, 12000, 0, 12000],
    fills: [{ start: color, end: color }],
    start: start.map((commands) => ({ fill1: 1, commands })),
    end,
  });
}

/** A SWF of `tags` and a frame, as a load reads it. */
export function movieOf(...tags: Uint8Array[]): Uint8Array {
  return w.swf({
    width: 600,
    height: 600,
    frameRate: 24,
    frameCount: 1,
    tags: [w.fileAttributes(false), ...tags, w.showFrame(), w.end()],
  });
}

/** The morph alone, as no library holds it. */
export function crossingMorph(count: number, points = 200): MorphCharacter {
  const swf = readSwf(movieOf(crossingMorphTag(count, points)));
  const t = swf.tags.find((tag) => tag.code === 46);
  if (!t) {
    throw new Error("no morph");
  }

  const morph = readMorphShape(swf.bytes, t.code, t.offset, t.length);
  return { type: "morph", id: 1, morph, blends: new Map(), bitmap: () => null };
}
