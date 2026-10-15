// A player's AVM1: a main AVM1 SWF's action blocks compiled to one module
// by codegen, and run with its root timeline (docs/avm1.md, "The frame").
// So far the root's own: as the root enters a frame, the DoInitAction
// blocks there run, each sprite's once, then its DoAction blocks, in tag
// order, as Flash runs a DoInitAction as its tag is reached and queues a
// DoAction to the frame's end. Clips' frames, clip events, buttons and the
// action queue's order come with the later steps.
import type { Codegen } from "@swf2es/codegen";
import { type ActionBlock, isAs3, readActions, type Swf, tags } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import type { MovieClip } from "../display/display.js";
import { evaluate } from "../scripting/evaluate.js";

export interface Avm1Options {
  /**
   * Where trace's text goes, as it is, the console's log by default: a
   * "\r" in it breaks Flash's log's line as a "\n" does.
   */
  print?: (line: string) => void;
  /** An error a block threw that nothing caught: the console's by default. The SWF plays on. */
  onUncaught?: (error: unknown) => void;
}

/** What runs as the root enters a frame: its DoInitAction blocks, then its DoAction blocks. */
interface FrameActions {
  inits: ActionBlock[];
  actions: ActionBlock[];
  /** Whether a tag Flash cannot read is in the frame, which stops the SWF there. */
  corrupt: boolean;
}

/** Names the scripts of AVM1 modules, as their stack frames show them. */
let modules = 0;

export class Avm1 {
  readonly rt = new avm1.Runtime();
  /** Whether the SWF has stopped for good at what Flash cannot read: nothing plays or runs after. */
  halted = false;
  private blocks: avm1.Blocks = [];
  /** By the root's frame, 1 the first. */
  private readonly frames = new Map<number, FrameActions>();
  /** The sprites whose DoInitAction has run. */
  private readonly initialized = new Set<number>();
  /** The operand stack, which every activation of a frame's actions shares. */
  private readonly st: avm1.Value[] = [];
  /** The root's frame whose actions ran last. */
  private ranFrame = 0;
  private readonly host: avm1.Host;
  private readonly onUncaught: (error: unknown) => void;

  constructor(
    readonly codegen: Codegen,
    options: Avm1Options = {},
  ) {
    const print = options.print ?? ((line: string) => console.log(line));
    this.onUncaught = options.onUncaught ?? ((error) => console.error(error));
    this.host = {
      trace: print,
      play: (target) => {
        (target as MovieClip).playing = true;
      },
      stop: (target) => {
        (target as MovieClip).playing = false;
      },
      halt: () => {
        this.halted = true;
      },
    };
  }

  /**
   * Compile the SWF's blocks and load their module. An ActionScript 3 SWF's
   * blocks are left, as Flash runs none of them.
   */
  async load(swf: Swf, list = readActions(swf)): Promise<void> {
    if (isAs3(swf) || list.blocks.length === 0) {
      return;
    }

    const module = this.codegen.compileActionsModule(swf.bytes, list);
    const { factory } = await evaluate(module, `swf2es-avm1-${++modules}.js`);
    this.blocks = (factory as unknown as avm1.Factory)(this.rt);

    const frameOf = (frame: number) => {
      let actions = this.frames.get(frame);
      if (!actions) {
        actions = { inits: [], actions: [], corrupt: false };
        this.frames.set(frame, actions);
      }

      return actions;
    };
    for (const block of list.blocks) {
      const owner = block.owner;
      if (block.length === 0 || owner.type === "clip" || owner.type === "button") {
        continue;
      }

      if (owner.timeline !== null) {
        continue;
      }

      const frame = frameOf(owner.frame + 1);
      (owner.type === "init" ? frame.inits : frame.actions).push(block);
    }

    // The root's tags Flash cannot read, by frame; a sprite's wait for clips' frames.
    const corrupt = new Set(list.corrupt);
    let frame = 1;
    for (const tag of swf.tags) {
      if (tag.code === tags.ShowFrame) {
        frame++;
      } else if (corrupt.has(tag.offset)) {
        frameOf(frame).corrupt = true;
      }
    }
  }

  /**
   * Run the actions of the frame the root has entered, if it entered one
   * since the last call: a root that is stopped, or of one frame, stays
   * on its frame and runs nothing. The operand stack starts empty, as each
   * frame's does in Flash, and the frame's DoAction blocks share a
   * constant pool, each starting with the one the block before left.
   */
  frame(root: MovieClip): void {
    if (this.halted || root.currentFrame === this.ranFrame) {
      return;
    }

    this.ranFrame = root.currentFrame;
    const frame = this.frames.get(root.currentFrame);
    if (!frame) {
      return;
    }

    this.st.length = 0;
    for (const block of frame.inits) {
      const owner = block.owner;
      if (owner.type !== "init" || this.initialized.has(owner.sprite)) {
        continue;
      }

      this.initialized.add(owner.sprite);
      // An init's pool is its own: the frame's blocks after it do not read it.
      this.run(block, [], root);
      if (this.halted) {
        return;
      }
    }

    // Flash stops at the tag, before the frame's end, where its DoActions would run.
    if (frame.corrupt) {
      this.halted = true;
      return;
    }

    let pool: avm1.Value[] = [];
    for (const block of frame.actions) {
      pool = this.run(block, pool, root);
      if (this.halted) {
        return;
      }
    }
  }

  /** Run `block` with `target` as its target, starting from constant pool `pool`; the pool it leaves. */
  private run(block: ActionBlock, pool: avm1.Value[], target: MovieClip): avm1.Value[] {
    const cx = new avm1.Activation(this.st, pool, target, this.host);
    const code = this.blocks[block.index]?.[0];
    if (!code) {
      return pool;
    }

    try {
      code(cx);
    } catch (error) {
      if (!(error instanceof avm1.Halt)) {
        this.onUncaught(error);
      }
    }

    return cx.pool;
  }
}
