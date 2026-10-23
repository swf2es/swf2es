// Code hidden in an ignored tag, reached from the following DoAction.

import { readActions, readSwf } from "../packages/format/dist/index.js";
import { Avm1Assembler, constant } from "./avm1-assembler.ts";
import * as w from "./swf-writer.ts";

/** A branch patched after the prefix and the action block have their final positions. */
export function branch(bytes: Uint8Array, at: number, target: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt16(
    at + 3,
    target - at - 5,
    true,
  );
}

export function backwardActions(distant = false): { bytes: Uint8Array; offset: number } {
  if (distant) {
    const bytes = new Uint8Array(40040);
    const trace = new Avm1Assembler().push("distant prefix").trace().bytes();
    bytes.set(trace);
    for (const [at, target] of [
      [trace.length, 20000],
      [20000, 40000],
      [40000, 40021],
      [40016, 39990],
      [39990, 19990],
      [19990, 0],
    ]) {
      bytes.set([0x99, 2, 0, 0, 0], at);
      branch(bytes, at, target);
    }

    bytes.set(new Avm1Assembler().push("returned").trace().stop().end().bytes(), 40021);
    return { bytes, offset: 40016 };
  }

  const first = new Avm1Assembler()
    .constantPool("outside é", "callback")
    .push(constant(0))
    .trace()
    .defineFunction(
      "outside",
      [],
      new Avm1Assembler().push(constant(1)).trace().push(42).op("Return").end(),
    )
    .raw([0x99, 2, 0, 0, 0])
    .bytes();
  const second = new Avm1Assembler()
    .push("conditional prefix")
    .trace()
    .raw([0x99, 2, 0, 0, 0])
    .bytes();
  const body = new Avm1Assembler()
    .raw([0x99, 2, 0, 0, 0])
    .push(0, "outside")
    .op("CallFunction")
    .trace()
    .push(true)
    .raw([0x9d, 2, 0, 0, 0]);
  const afterIf = body.bytes().length;
  body.push("done").trace().stop().end();
  const code = body.bytes();
  const offset = first.length + second.length + 6;
  const bytes = new Uint8Array(offset + code.length);
  bytes.set(first);
  bytes.set(second, first.length);
  bytes.set(code, offset);
  branch(bytes, first.length - 5, offset + 5);
  branch(bytes, first.length + second.length - 5, offset + afterIf);
  branch(bytes, offset, 0);
  branch(bytes, offset + afterIf - 5, first.length);
  return { bytes, offset };
}

/**
 * Code before a block that the block jumps back into, whose loop goes round
 * in a unit and which jumps forward into the block's bytes again; and a
 * function of the block whose body jumps back into it, which up to SWF 4
 * runs as a SWF 5's.
 */
export function unitActions(): { bytes: Uint8Array; offset: number } {
  const jump = [0x99, 2, 0, 0, 0];
  const prefix = new Avm1Assembler()
    .push("n", "n")
    .op("GetVariable")
    .op("Increment")
    .op("SetVariable")
    .push("n")
    .op("GetVariable")
    .trace()
    .push("n")
    .op("GetVariable")
    .push(3)
    .op("Less2")
    .raw([0x9d, 2, 0, 0, 0])
    .raw(jump)
    .bytes();
  const body = new Avm1Assembler().push("in f").trace().push(7).op("Return").bytes();
  const block = new Avm1Assembler()
    .push("n", 0)
    .op("SetVariable")
    .defineFunction("f", [], new Avm1Assembler().raw(jump))
    .raw(jump)
    .push("done")
    .trace()
    .push(0, "f")
    .op("CallFunction")
    .trace()
    .stop()
    .end()
    .bytes();
  const offset = prefix.length + body.length;
  const bytes = new Uint8Array([...prefix, ...body, ...block]);
  const ifAt = prefix.length - 10;
  branch(bytes, ifAt, 0);
  // The prefix goes on past the jump into the block, after its own jump back.
  const functionJump = offset + block.indexOf(0x99);
  const blockJump = offset + block.indexOf(0x99, functionJump - offset + 1);
  branch(bytes, prefix.length - 5, blockJump + 5);
  branch(bytes, blockJump, 0);
  branch(bytes, functionJump, prefix.length);
  return { bytes, offset };
}

export function backwardSwf(distant = false): Uint8Array {
  const { bytes, offset } = backwardActions(distant);
  return w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.tag(253, bytes.subarray(0, offset - 6)),
      w.tag(12, bytes.subarray(offset), true),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** Many tiny blocks share preceding code, which must not accumulate analysis garbage. */
export function sharedBackwardSwf(count: number): Uint8Array {
  const prefix = new Uint8Array(4097);
  prefix.fill(1, 0, 4096);
  const swf = readSwf(
    w.swf({
      version: 8,
      width: 20,
      height: 20,
      frameCount: 1,
      tags: [
        w.tag(253, prefix),
        ...Array.from({ length: count }, () => w.doAction([0x99, 2, 0, 0, 0, 0])),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  const start = swf.tags[0].offset;
  for (const block of readActions(swf).blocks) {
    branch(swf.bytes, block.offset, start);
  }

  return swf.bytes;
}
