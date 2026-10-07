// Gives a codegen.wasm its identity: a custom section, "swf2es.build",
// holding the SHA-256 of the binary without it, which createCodegen reads
// as Codegen.identity. A host's module cache keys its modules by it, so a
// compiler built from other sources never reuses another's output, which
// COMPILER_VERSION, moved by hand, would not ensure.
//
//   node stamp.ts dist/codegen.wasm
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SECTION = "swf2es.build";

function leb(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  do {
    const byte = v & 0x7f;
    v >>>= 7;
    bytes.push(v ? byte | 0x80 : byte);
  } while (v);

  return bytes;
}

/** The binary without its own section, if a stamp before left one. */
function unstamped(wasm: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [wasm.subarray(0, 8)];
  let at = 8;
  while (at < wasm.length) {
    const start = at;
    const id = wasm[at++];
    let size = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = wasm[at++];
      size |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        break;
      }
    }

    const end = at + size;
    let ours = false;
    if (id === 0) {
      const length = wasm[at];
      ours = new TextDecoder().decode(wasm.subarray(at + 1, at + 1 + length)) === SECTION;
    }

    if (!ours) {
      kept.push(wasm.subarray(start, end));
    }

    at = end;
  }

  return Buffer.concat(kept);
}

const path = process.argv[2];
const wasm = unstamped(new Uint8Array(readFileSync(path)));
const digest = createHash("sha256").update(wasm).digest("hex");
const name = [...Buffer.from(SECTION)];
const payload = [...leb(name.length), ...name, ...Buffer.from(digest)];
writeFileSync(path, Buffer.concat([wasm, Buffer.from([0, ...leb(payload.length), ...payload])]));
