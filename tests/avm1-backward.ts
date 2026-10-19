// Code hidden in an ignored tag, reached from the following DoAction.
import { Avm1Assembler, constant } from "./avm1-assembler.ts";
import * as w from "./swf-writer.ts";

/** A branch patched after the prefix and the action block have their final positions. */
function branch(bytes: Uint8Array, at: number, target: number): void {
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
