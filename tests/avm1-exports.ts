// Flash's exports and #initclip across forward jumps, rewinds and a jump past the last frame.
import { flashAssembler, script } from "./avm1-script.ts";
import * as w from "./swf-writer.ts";

export const skippedExportsTrace = [
  "first:1",
  "future:undefined",
  "after:movieclip",
  "init one",
  "init two",
  "land:2:movieclip",
  "back:1:movieclip",
  "past:2",
];

export function skippedExports(version: number): Uint8Array {
  const actions = (source: string) => [...script(source, version)(flashAssembler()).end().bytes()];
  const frame = (source: string) => w.doAction(actions(source));

  return w.swf({
    version,
    width: 40,
    height: 40,
    frameCount: 4,
    tags: [
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      w.sprite(2, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.exportAssets([[1, "shared"]]),
      frame(`
        if (!done) {
          trace("first:" + attachMovie("shared", "first", 1)._totalframes);
          trace("future:" + typeof attachMovie("late", "early", 2));
          gotoAndStop(4);
          trace("after:" + typeof attachMovie("late", "after", 3));
        } else {
          trace("back:" + attachMovie("shared", "back", 4)._totalframes + ":" +
            typeof attachMovie("late", "still", 5));
          gotoAndStop(99);
          trace("past:" + attachMovie("shared", "past", 6)._totalframes);
        }
      `),
      w.showFrame(),
      w.exportAssets([
        [1, "late"],
        [2, "shared"],
      ]),
      w.doInitAction(1, actions('trace("init one");')),
      frame('trace("skipped two");'),
      w.showFrame(),
      w.doInitAction(2, actions('trace("init two");')),
      frame('trace("skipped three");'),
      w.showFrame(),
      frame(`
        trace("land:" + attachMovie("shared", "land", 7)._totalframes + ":" +
          typeof attachMovie("late", "landLate", 8));
        done = true;
        gotoAndStop(1);
      `),
      w.showFrame(),
      w.end(),
    ],
  });
}
