// flash.filesystem.FileStream reading over a host's file system, as adl
// (AIR 51.3) has it: open and openAsync, what a stream not open, a write in
// READ mode and a bad file or mode throw, and the events of an
// asynchronous read. adl traced the same checks (~/.cache/swf2es/
// adl-filestream's probes); the paths here are a POSIX host's.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { FileSystemHost } from "../../../../../../packages/player/dist/index.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../../../out/player-filestream/", import.meta.url));
const app = `${out}app`;
const storage = `${out}storage`;

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** node's file system, as a host gives it. */
const fileSystem: FileSystemHost = {
  separator: "/",
  directories: {
    application: app,
    applicationStorage: storage,
    user: out,
    documents: out,
    desktop: out,
  },
  stat: (path) => {
    try {
      const s = statSync(path);
      return {
        directory: s.isDirectory(),
        size: s.size,
        modified: s.mtimeMs,
        created: s.birthtimeMs,
      };
    } catch {
      return null;
    }
  },
  list: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  },
  read: (path) => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  },
};

/** Play `source` as an AIR application for `frames` frames: what it traced. */
async function play(name: string, source: string, frames: number): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air: true,
    fileSystem,
    application: { descriptor: "<application/>", id: "test", arguments: [], currentDirectory: app },
  });
  await scripting.loadLibraries([libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary]);
  const player = new Player(bare(compiler(out)(name, source), 1, name), scripting);
  try {
    try {
      await player.start();
    } catch (e) {
      // Among the lines, where the assertion shows how far it got.
      lines.push(`UNCAUGHT ${JSON.stringify(e)} ${(e as { stack?: string }).stack ?? ""}`);
      return lines;
    }
    for (let i = 0; i < frames; i++) {
      player.advance(1000 / 24);
      // A deferred delivery is a promise's turn away.
      await new Promise((done) => setTimeout(done, 0));
    }
  } finally {
    player.destroy();
  }

  return lines;
}

const source = readFileSync(new URL("./Streams.as", import.meta.url), "utf8");

test("FileStream reads as adl's, at once and over frames", { skip }, async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(`${app}/sub`, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeFileSync(
    `${app}/data.bin`,
    Uint8Array.of(104, 101, 108, 108, 111, 1, 0, 0, 0, 2, 3, 4, 5, 6, 7),
  );
  writeFileSync(`${app}/big.bin`, new Uint8Array(300000).fill(7));

  const lines = await play("Streams", source, 20);
  const sync = lines.filter((l) => !/^(async|missing async|closed early|sync|big):/.test(l));
  assert.deepEqual(sync, [
    "fresh: THROWS IOError 2029",
    "fresh position: THROWS IOError 2029",
    "fresh settings: bigEndian 3 Infinity",
    "fresh read: THROWS IOError 2029",
    "open: 15 0",
    "utf: hello 5 10",
    "int: 16777216",
    "endian: 1 9",
    "bytes: 5 2,4 12",
    "bytes rest: 3 0",
    "eof: THROWS EOFError 2030",
    "past: 0 100",
    "past read: THROWS EOFError 2030",
    "write in read: THROWS IOError 2029",
    "truncate in read: THROWS IOError 2029",
    "closed: THROWS IOError 2029",
    "closed read: THROWS IOError 2029",
    "close twice: ok",
    "reopen: hello",
    "missing: THROWS IOError 3003",
    "directory: THROWS IOError 3006",
    "no path: THROWS IllegalOperationError 2037",
    "bad mode: THROWS ArgumentError 2004",
    "null file: THROWS TypeError 2007",
    "open while open: 0 15",
    "async read before complete: THROWS EOFError 2030",
  ]);

  // No open event; the bytes over frames, then complete, then close on a later frame.
  assert.deepEqual(
    lines.filter((l) => l.startsWith("async:")),
    [
      "async: after openAsync avail 0",
      "async: progress 15/15 avail 15",
      "async: complete",
      "async: read hello",
      "async: close",
    ],
  );
  assert.deepEqual(
    lines.filter((l) => /^(missing async|closed early|sync):/.test(l)),
    ["missing async: ioError 3003 0", "closed early: close event"],
  );
  assert.deepEqual(
    lines.filter((l) => l.startsWith("big:")),
    [
      "big: first progress 40960/300000 avail 40960",
      "big: complete avail 300000 after more than one progress true",
    ],
  );
});
