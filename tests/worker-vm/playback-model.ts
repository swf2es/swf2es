import { createCodegen } from "../../packages/codegen/dist/index.js";
import { isAs3, readSwf } from "../../packages/format/dist/index.js";
import { Avm1 } from "../../packages/player/dist/avm1/avm1.js";
import { boundsIn } from "../../packages/player/dist/display/bounds.js";
import { MovieClip } from "../../packages/player/dist/display/display.js";
import type { Drawer } from "../../packages/player/dist/hosts.js";
import { Player } from "../../packages/player/dist/player.js";
import { playerglobalLibrary, Scripting } from "../../packages/player/dist/scripting.js";

export interface Controls {
  animation: string;
  count: number;
  paused: boolean;
}

export async function playbackModel(
  bytes: Uint8Array,
  drawer: Drawer,
  print: (line: string) => void,
) {
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const options = {
    audio: null,
    print,
    onUncaught(error: unknown) {
      throw new Error(`uncaught: ${String(error)}`);
    },
    externalInterface: {
      callOut: () => "<null/>",
      addCallback() {},
    },
  };
  let player: Player;
  if (isAs3(readSwf(bytes))) {
    const scripting = new Scripting(codegen, options);
    scripting.drawer = drawer;
    const builtin = new Uint8Array(await (await fetch("/libraries/builtin.abc")).arrayBuffer());
    await scripting.loadLibraries([builtin, playerglobalLibrary]);
    player = new Player(bytes, scripting);
  } else {
    const avm1 = new Avm1(codegen, options);
    avm1.drawer = drawer;
    player = new Player(bytes, null, avm1);
  }
  try {
    await player.start();
  } catch (error) {
    player.destroy();
    throw error;
  }
  const clip = player.root.children.find(
    (child): child is MovieClip => child instanceof MovieClip && child.timeline.labels.length > 0,
  );
  const labels = clip?.timeline.labels ?? [];
  const copies = clip ? [clip] : [];
  const original = clip ? { ...clip.matrix } : null;
  const art = clip ? boundsIn(clip, player.root, player.stage, true) : null;
  let controls: Controls = { animation: "all", count: 1, paused: false };
  let start = 1,
    next = (clip?.totalFrames ?? 1) + 1;
  let vmFrames = 0;
  const wrap = () => {
    for (let i = 0; i < copies.length; i++) {
      const item = copies[i];
      if (item.currentFrame >= next || item.currentFrame < start) {
        item.gotoFrame(start);
      }
      item.playing = true;
    }
  };
  return {
    player,
    labels: labels.map((label) => label.name),
    configure(value: Controls) {
      if (
        !Number.isInteger(value.count) ||
        value.count < 1 ||
        value.count > 32 ||
        (value.animation !== "all" && !labels.some((label) => label.name === value.animation))
      ) {
        throw new Error("invalid playback controls");
      }
      if (controls.animation === value.animation && controls.count === value.count) {
        controls = value;
        return;
      }
      controls = value;
      const index = labels.findIndex((label) => label.name === value.animation);
      start = index < 0 ? 1 : labels[index].frame;
      next =
        index < 0
          ? (clip?.totalFrames ?? 1) + 1
          : (labels[index + 1]?.frame ?? (clip?.totalFrames ?? 1) + 1);
      if (clip?.character?.type === "sprite" && original && art) {
        while (copies.length > value.count) {
          const removed = copies.pop();
          if (removed) {
            player.root.removeChild(removed);
          }
        }
        while (copies.length < value.count) {
          const copy = new MovieClip(clip.character.timeline, {
            ...player.library,
            construct: null,
            removing: null,
          });
          copy.character = clip.character;
          player.root.addChildAt(copy, player.root.children.length);
          copy.enterFirstFrame();
          copies.push(copy);
        }
        const columns = Math.ceil(Math.sqrt(copies.length)),
          rows = Math.ceil(copies.length / columns);
        const cellWidth = player.width / columns,
          cellHeight = player.height / rows;
        const scale = Math.min(
          1,
          (cellWidth * 0.85) / Math.max(1, art.xMax - art.xMin),
          (cellHeight * 0.85) / Math.max(1, art.yMax - art.yMin),
        );
        for (let i = 0; i < copies.length; i++) {
          const inRow = Math.min(columns, copies.length - Math.floor(i / columns) * columns);
          copies[i].setMatrix({
            a: original.a * scale,
            b: original.b * scale,
            c: original.c * scale,
            d: original.d * scale,
            tx:
              ((i % columns) + (columns - inRow) / 2 + 0.5) * cellWidth +
              (original.tx - (art.xMin + art.xMax) / 2) * scale,
            ty:
              (Math.floor(i / columns) + 0.5) * cellHeight +
              (original.ty - (art.yMin + art.yMax) / 2) * scale,
          });
          copies[i].gotoFrame(start);
          copies[i].playing = true;
        }
      }
    },
    advance(dt: number, exactFrames?: number) {
      let played = 0;
      if (exactFrames !== undefined) {
        if (!Number.isInteger(exactFrames) || exactFrames < 0 || exactFrames > 120) {
          throw new RangeError("invalid exact frame count");
        }
        for (let i = 0; i < exactFrames; i++) {
          player.tick();
          wrap();
          played++;
        }
      } else if (!controls.paused) {
        played = player.advance(Math.min(Math.max(0, dt), 250));
        wrap();
      }
      vmFrames += played;
      return { played, vmFrames };
    },
  };
}
