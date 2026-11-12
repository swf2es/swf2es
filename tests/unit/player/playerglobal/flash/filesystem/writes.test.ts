// What File and FileStream write over a host's file system, as adl (AIR
// 51.3, Windows) has it: FileStream's WRITE, APPEND and UPDATE modes at
// once and over frames, File's directories made and deleted, its files
// deleted, copied and moved, and the errors of each. adl traced the same
// checks (~/.cache/swf2es/adl-filewrite's probes); the paths here are a
// POSIX host's. Windows' AIR refuses to open a file another stream has
// open to write (IOError 3013), which swf2es does not: the checks read a
// file once its writer has closed. Then File.createTempFile and
// createTempDirectory, over a host in memory that can be made to have
// taken names, or to refuse: an empty file, or an empty directory, of a
// name not yet taken in the host's temporary directory, its cache
// directory, named as adl names one ("fla281f.tmp"), and, where none can
// be made, as adl's with its temporary directory read-only (Wine): the
// file's File with nothing there, and IllegalOperationError 2014 for the
// directory.
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
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
const out = fileURLToPath(new URL("../../../../out/player-filewrite/", import.meta.url));
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

/** Runs `f`: false where it throws. */
const tried = (f: () => void): boolean => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};

/** node's file system, as a host that writes gives it. */
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
        size: s.isDirectory() ? 0 : s.size,
        modified: s.mtimeMs,
        created: s.birthtimeMs,
      };
    } catch {
      return null;
    }
  },
  list: (path) => {
    try {
      return readdirSync(path).sort();
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
  write: (path, bytes, offset, length) =>
    tried(() => {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, existsSync(path) ? "r+" : "w+");
      try {
        writeSync(fd, bytes, 0, bytes.length, offset);
        ftruncateSync(fd, length);
      } finally {
        closeSync(fd);
      }
    }),
  createDirectory: (path) => tried(() => mkdirSync(path, { recursive: true })),
  remove: (path) => tried(() => rmSync(path, { recursive: true })),
  move: (from, to) =>
    tried(() => {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }),
};

/** Play `source` as an AIR application over `host` for `frames` frames: what it traced. */
async function play(
  name: string,
  source: string,
  frames: number,
  host: FileSystemHost = fileSystem,
): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air: true,
    fileSystem: host,
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
      player.tick();
      // A deferred delivery is a promise's turn away.
      await new Promise((done) => setTimeout(done, 0));
    }
  } finally {
    player.destroy();
  }

  return lines;
}

const preamble = `
  import flash.display.Sprite;
  import flash.events.*;
  import flash.filesystem.*;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;`;

const helpers = `
    private function t(label:String, f:Function):void {
      try {
        trace(label + ": " + f());
      } catch (e:Error) {
        // By its class, as adl's probe named it: flash.errors' classes are all named "Error".
        trace(label + ": THROWS " + getQualifiedClassName(e).replace(/^.*::/, "") + " " + e.errorID + (e.errorID == 0 ? " " + e.message : ""));
      }
    }

    private static function bytes(f:File):String {
      if (!f.exists) { return "missing"; }
      var s:FileStream = new FileStream(); s.open(f, FileMode.READ);
      var out:Array = []; while (s.bytesAvailable) { out.push(s.readUnsignedByte()); } s.close();
      return out.join(",");
    }

    private static function put(f:File, a:Array):void {
      var s:FileStream = new FileStream(); s.open(f, FileMode.WRITE);
      for each (var v:int in a) { s.writeByte(v); }
      s.close();
    }`;

const streams = `package {${preamble}

  public class Writes extends Sprite {${helpers}

    public function Writes() {
      var store:File = File.applicationStorageDirectory;
      var a:File = store.resolvePath("w/sub/a.bin");
      var fs:FileStream = new FileStream();
      t("write missing directories", function ():* { fs.open(a, FileMode.WRITE); return a.exists + " " + a.size; });
      t("write position", function ():* { return fs.position; });
      t("write bytesAvailable", function ():* { return fs.bytesAvailable; });
      t("write held", function ():* { fs.writeUTFBytes("hello"); return fs.position + " " + a.size; });
      t("write read", function ():* { fs.position = 0; return fs.readByte(); });
      t("write endian", function ():* { fs.endian = "littleEndian"; fs.position = 0; fs.writeShort(0x0102); fs.endian = "bigEndian"; return fs.position; });
      t("write truncate", function ():* { fs.truncate(); return fs.position + " " + a.size; });
      fs.close();
      t("write closed", function ():* { return bytes(a); });
      t("write after close", function ():* { fs.writeByte(1); return "wrote"; });
      t("write empties", function ():* { fs.open(a, FileMode.WRITE); fs.close(); return a.size; });

      put(a, [2, 1]);
      fs.open(a, FileMode.APPEND);
      t("append position", function ():* { return fs.position; });
      t("append bytesAvailable", function ():* { return fs.bytesAvailable; });
      t("append write", function ():* { fs.writeByte(7); return fs.position + " " + a.size; });
      t("append read", function ():* { return fs.readByte(); });
      t("append set position", function ():* { fs.position = 1; return "set"; });
      fs.close();
      t("append closed", function ():* { return bytes(a); });
      t("append missing", function ():* { var m:File = store.resolvePath("m/app.bin"); fs.open(m, FileMode.APPEND); fs.writeByte(1); fs.close(); return bytes(m); });

      put(a, [1, 2, 3]);
      fs.open(a, FileMode.UPDATE);
      t("update past the end", function ():* { fs.position = 1; fs.writeByte(9); fs.position = 5; fs.writeByte(8); return a.size + " " + fs.position; });
      fs.close();
      t("update closed", function ():* { return bytes(a); });
      var u:File = store.resolvePath("u.bin");
      t("update missing", function ():* { fs.open(u, FileMode.UPDATE); return u.exists + " " + fs.position + " " + fs.bytesAvailable; });
      t("update write and read", function ():* { var b:ByteArray = new ByteArray(); b.writeByte(1); b.writeByte(2); b.writeByte(3); b.writeByte(4); b.writeByte(5); fs.writeBytes(b); fs.position = 1; return fs.readByte() + " " + fs.position + " " + fs.bytesAvailable; });
      t("update truncate", function ():* { fs.writeByte(9); fs.truncate(); return fs.position; });
      t("update eof", function ():* { return fs.readByte(); });
      fs.close();
      t("update reopened", function ():* { fs.open(u, FileMode.UPDATE); return fs.position + " " + fs.bytesAvailable; });
      t("update past", function ():* { fs.position = 100; return fs.bytesAvailable; });
      fs.close();
      t("update truncated", function ():* { return bytes(u); });

      var appFile:File = File.applicationDirectory.resolvePath("x.bin");
      t("app write", function ():* { fs.open(appFile, FileMode.WRITE); return "opened"; });
      t("app update", function ():* { fs.open(File.applicationDirectory.resolvePath("data.bin"), FileMode.UPDATE); return "opened"; });
      t("app append", function ():* { fs.open(File.applicationDirectory.resolvePath("data.bin"), FileMode.APPEND); return "opened"; });
      t("app read", function ():* { fs.open(File.applicationDirectory.resolvePath("data.bin"), FileMode.READ); fs.close(); return "read"; });
      t("app by its path", function ():* { var f:File = new File(File.applicationDirectory.nativePath).resolvePath("y.bin"); fs.open(f, FileMode.WRITE); fs.close(); return f.exists; });
      t("write a directory", function ():* { fs.open(store.resolvePath("w"), FileMode.WRITE); return "opened"; });
      t("write under a file", function ():* { fs.open(store.resolvePath("u.bin/x"), FileMode.WRITE); return "opened"; });
      t("update a directory", function ():* { fs.open(store.resolvePath("w"), FileMode.UPDATE); return "opened"; });

      var big:File = store.resolvePath("big.bin");
      var held:FileStream = new FileStream();
      held.open(big, FileMode.WRITE);
      var chunk:ByteArray = new ByteArray();
      chunk.length = 1000;
      held.writeBytes(chunk);
      trace("held: " + big.size);
      var tick:Function = function (e:Event):void {
        trace("held next frame: " + big.size);
        removeEventListener(Event.ENTER_FRAME, tick);
        held.close();
      };
      addEventListener(Event.ENTER_FRAME, tick);

      var x:File = store.resolvePath("async.bin");
      var a1:FileStream = new FileStream();
      for each (var type:String in [Event.OPEN, Event.COMPLETE, Event.CLOSE, ProgressEvent.PROGRESS, OutputProgressEvent.OUTPUT_PROGRESS, IOErrorEvent.IO_ERROR]) {
        a1.addEventListener(type, function (e:Event):void {
          var extra:String = e is OutputProgressEvent ? " " + OutputProgressEvent(e).bytesPending + "/" + OutputProgressEvent(e).bytesTotal : "";
          trace("a1: " + e.type + extra + " size " + x.size);
          if (e.type == OutputProgressEvent.OUTPUT_PROGRESS) {
            a1.close();
          }
        });
      }
      a1.openAsync(x, FileMode.WRITE);
      trace("a1: opened " + x.exists);
      a1.writeUTFBytes("hello");
      trace("a1: wrote " + x.exists + " " + a1.position);
      a1.writeUTFBytes("!!");

      var a2:FileStream = new FileStream();
      a2.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void { trace("a2: ioError " + e.errorID + " " + e.text.replace(/file: .*/, "file: (path)")); });
      a2.openAsync(store.resolvePath("w"), FileMode.WRITE);
      t("a3", function ():* { new FileStream().openAsync(File.applicationDirectory.resolvePath("q.bin"), FileMode.WRITE); return "opened"; });

      put(store.resolvePath("d.bin"), [1, 2, 3, 4, 5, 6]);
      var a4:FileStream = new FileStream();
      a4.addEventListener(Event.COMPLETE, function (e:Event):void { trace("a4: complete " + a4.bytesAvailable); a4.writeByte(33); a4.close(); });
      a4.addEventListener(Event.CLOSE, function (e:Event):void { trace("a4: close " + bytes(store.resolvePath("d.bin"))); });
      a4.openAsync(store.resolvePath("d.bin"), FileMode.UPDATE);

      var a5:FileStream = new FileStream();
      var m:File = store.resolvePath("q/r/s.bin");
      a5.addEventListener(Event.COMPLETE, function (e:Event):void { trace("a5: complete " + a5.bytesAvailable + " " + m.exists); a5.close(); });
      a5.addEventListener(OutputProgressEvent.OUTPUT_PROGRESS, function (e:OutputProgressEvent):void { trace("a5: outputProgress " + e.bytesPending + "/" + e.bytesTotal); });
      a5.openAsync(m, FileMode.UPDATE);
      trace("a5: opened " + m.exists);
      a5.writeByte(1);

      // Opened again and written in one frame, never closed.
      var r:File = store.resolvePath("r.bin");
      var re:FileStream = new FileStream();
      re.open(store.resolvePath("other.bin"), FileMode.WRITE);
      re.writeByte(1);
      re.open(r, FileMode.WRITE);
      re.writeByte(5);
      re.writeByte(6);
      var later:Function = function (e:Event):void {
        trace("reopened: next frame " + r.size);
        removeEventListener(Event.ENTER_FRAME, later);
      };
      addEventListener(Event.ENTER_FRAME, later);

      // UPDATE over frames, written before the file is read in, and closed before it is.
      var e1:File = store.resolvePath("e1.bin");
      put(e1, [1, 2, 3, 4]);
      var a6:FileStream = new FileStream();
      a6.addEventListener(Event.COMPLETE, function (e:Event):void { a6.close(); });
      a6.addEventListener(Event.CLOSE, function (e:Event):void { trace("a6: closed " + bytes(e1)); });
      a6.openAsync(e1, FileMode.UPDATE);
      a6.position = 1;
      a6.writeByte(9);
      var e2:File = store.resolvePath("e2.bin");
      put(e2, [1, 2, 3, 4]);
      var a7:FileStream = new FileStream();
      a7.addEventListener(Event.CLOSE, function (e:Event):void { trace("a7: closed early " + bytes(e2)); });
      a7.openAsync(e2, FileMode.UPDATE);
      a7.position = 2;
      a7.writeByte(8);
      a7.close();

      // A failed open stops what the open before it had yet to do.
      var a8:FileStream = new FileStream();
      a8.addEventListener(Event.COMPLETE, function (e:Event):void { trace("a8: stale complete"); });
      a8.addEventListener(ProgressEvent.PROGRESS, function (e:Event):void { trace("a8: stale progress"); });
      a8.openAsync(e1, FileMode.READ);
      t("a8", function ():* { a8.open(store.resolvePath("missing.bin"), FileMode.READ); return "opened"; });
    }
  }
}
`;

test("FileStream writes as adl's, at once and over frames", { skip }, async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeFileSync(`${app}/data.bin`, Uint8Array.of(1, 2, 3));

  const lines = await play("Writes", streams, 10);
  const sync = lines.filter((l) => !/^(held( next frame)?|a[1245-7]|reopened):/.test(l));
  assert.deepEqual(sync, [
    "write missing directories: true 0",
    "write position: 0",
    "write bytesAvailable: THROWS IOError 2029",
    "write held: 5 0",
    "write read: THROWS IOError 2029",
    "write endian: 2",
    "write truncate: 2 2",
    "write closed: 2,1",
    "write after close: THROWS IOError 2029",
    "write empties: 0",
    "append position: 2",
    "append bytesAvailable: THROWS IOError 2029",
    "append write: 3 2",
    "append read: THROWS IOError 2029",
    "append set position: THROWS IllegalOperationError 2037",
    "append closed: 2,1,7",
    "append missing: 1",
    "update past the end: 3 6",
    "update closed: 1,9,3,0,0,8",
    "update missing: true 0 0",
    "update write and read: 2 2 3",
    "update truncate: 3",
    "update eof: THROWS EOFError 2030",
    "update reopened: 0 3",
    "update past: 0",
    "update truncated: 1,2,9",
    "app write: THROWS SecurityError 0 fileWriteResource",
    "app update: THROWS SecurityError 0 fileWriteResource",
    "app append: THROWS SecurityError 0 fileWriteResource",
    "app read: read",
    "app by its path: true",
    "write a directory: THROWS IOError 3006",
    "write under a file: THROWS IOError 3003",
    "update a directory: THROWS IOError 3006",
    "a3: THROWS SecurityError 0 fileWriteResource",
    "a8: THROWS IOError 3003",
  ]);

  // What is written reaches the file at the end of the frame.
  assert.deepEqual(
    lines.filter((l) => l.startsWith("held")),
    ["held: 0", "held next frame: 1000"],
  );
  // The file made and written on the next frame, told by outputProgress; then close on another.
  assert.deepEqual(
    lines.filter((l) => l.startsWith("a1:")),
    ["a1: opened false", "a1: wrote false 5", "a1: outputProgress 0/7 size 7", "a1: close size 7"],
  );
  assert.deepEqual(
    lines.filter((l) => l.startsWith("a2:")),
    ["a2: ioError 3006 Error #3006: Not a file. file: (path)"],
  );
  assert.deepEqual(
    lines.filter((l) => l.startsWith("a4:")),
    ["a4: complete 6", "a4: close 33,2,3,4,5,6"],
  );
  assert.deepEqual(
    lines.filter((l) => l.startsWith("a5:")),
    ["a5: opened false", "a5: outputProgress 0/1", "a5: complete 0 true"],
  );
  // What is written before the file is read in stands, around what it held; a stream opened
  // again flushes as it did; and nothing of an open a failed one replaced arrives (adl's, from
  // Probe5; adl's complete then reads nothing back, which swf2es does not copy).
  assert.deepEqual(lines.filter((l) => /^(a[67]|reopened):/.test(l)).sort(), [
    "a6: closed 1,9,3,4",
    "a7: closed early 1,2,8,4",
    "reopened: next frame 2",
  ]);
});

const files = `package {${preamble}

  public class Files extends Sprite {${helpers}

    public function Files() {
      var store:File = File.applicationStorageDirectory;
      var d:File = store.resolvePath("d.bin");
      var u:File = store.resolvePath("u.bin");
      put(d, [1, 2, 3, 4, 5, 6]);
      put(u, [1, 2, 3]);
      put(store.resolvePath("w/sub/a.bin"), [7]);
      t("createDirectory nested", function ():* { var x:File = store.resolvePath("c1/c2"); x.createDirectory(); return x.exists + " " + x.isDirectory; });
      t("createDirectory there", function ():* { store.resolvePath("c1").createDirectory(); return "made"; });
      t("createDirectory on a file", function ():* { d.createDirectory(); return "made"; });
      t("createDirectory app", function ():* { File.applicationDirectory.resolvePath("newdir").createDirectory(); return "made"; });
      t("deleteFile missing", function ():* { store.resolvePath("nope").deleteFile(); return "deleted"; });
      t("deleteFile directory", function ():* { store.resolvePath("c1").deleteFile(); return "deleted"; });
      t("deleteDirectory file", function ():* { d.deleteDirectory(); return "deleted"; });
      t("deleteDirectory not empty", function ():* { store.resolvePath("c1").deleteDirectory(); return "deleted"; });
      t("deleteDirectory missing", function ():* { store.resolvePath("nope").deleteDirectory(); return "deleted"; });
      t("deleteDirectory with contents", function ():* { var x:File = store.resolvePath("c1"); x.deleteDirectory(true); return x.exists; });
      t("deleteFile", function ():* { var x:File = store.resolvePath("gone.bin"); put(x, [1]); x.deleteFile(); return x.exists; });
      t("copyTo", function ():* { var x:File = store.resolvePath("copy.bin"); d.copyTo(x); return bytes(x); });
      t("copyTo there", function ():* { d.copyTo(store.resolvePath("copy.bin")); return "copied"; });
      t("copyTo there overwrite", function ():* { u.copyTo(store.resolvePath("copy.bin"), true); return bytes(store.resolvePath("copy.bin")); });
      t("copyTo missing", function ():* { store.resolvePath("nope").copyTo(store.resolvePath("n2")); return "copied"; });
      t("copyTo missing directories", function ():* { var x:File = store.resolvePath("p1/p2/c.bin"); d.copyTo(x); return bytes(x); });
      t("copyTo directory", function ():* { var x:File = store.resolvePath("wcopy"); store.resolvePath("w").copyTo(x); return bytes(x.resolvePath("sub/a.bin")); });
      t("copyTo directory overwrite", function ():* { store.resolvePath("w").copyTo(store.resolvePath("wcopy"), true); return "copied"; });
      t("copyTo itself", function ():* { d.copyTo(d, true); return bytes(d); });
      t("copyTo from app", function ():* { File.applicationDirectory.resolvePath("data.bin").copyTo(store.resolvePath("fromapp.bin")); return bytes(store.resolvePath("fromapp.bin")); });
      t("copyTo into app", function ():* { d.copyTo(File.applicationDirectory.resolvePath("z.bin")); return "copied"; });
      t("moveTo", function ():* { var x:File = store.resolvePath("moved.bin"); store.resolvePath("copy.bin").moveTo(x); return store.resolvePath("copy.bin").exists + " " + bytes(x); });
      t("moveTo there", function ():* { u.moveTo(store.resolvePath("moved.bin")); return "moved"; });
      t("moveTo directory", function ():* { var x:File = store.resolvePath("wmoved"); store.resolvePath("wcopy").moveTo(x); return store.resolvePath("wcopy").exists + " " + x.resolvePath("sub/a.bin").exists; });
      t("moveTo from app", function ():* { File.applicationDirectory.resolvePath("data.bin").moveTo(store.resolvePath("stolen.bin")); return "moved"; });
      t("listing", function ():* { return store.getDirectoryListing().map(function (f:File, ...rest):String { return f.name; }).sort().join(","); });

      var ff:File = store.resolvePath("moved.bin");
      for each (var type:String in [Event.COMPLETE, IOErrorEvent.IO_ERROR]) {
        ff.addEventListener(type, function (e:Event):void { trace("async copy: " + e.type + (e is IOErrorEvent ? " " + IOErrorEvent(e).errorID : "")); });
      }
      ff.copyToAsync(store.resolvePath("moved.bin"));
      trace("async copy: asked");
      var gg:File = store.resolvePath("nope2");
      gg.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void { trace("async delete: ioError " + e.errorID + " " + e.text); });
      gg.deleteFileAsync();
      var hh:File = store.resolvePath("w");
      hh.addEventListener(FileListEvent.DIRECTORY_LISTING, function (e:FileListEvent):void { trace("async listing: " + e.files.length + " " + e.files[0].name); });
      hh.getDirectoryListingAsync();
      var kk:File = store.resolvePath("wmoved");
      kk.addEventListener(Event.COMPLETE, function (e:Event):void { trace("async move: complete " + kk.exists + " " + store.resolvePath("wmoved2/sub/a.bin").exists); });
      kk.moveToAsync(store.resolvePath("wmoved2"));
      t("async into app", function ():* { d.copyToAsync(File.applicationDirectory.resolvePath("z.bin")); return "asked"; });
    }
  }
}
`;

test("File makes, deletes, copies and moves as adl's", { skip }, async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeFileSync(`${app}/data.bin`, Uint8Array.of(104, 101, 108, 108, 111));

  const lines = await play("Files", files, 4);
  assert.deepEqual(lines, [
    "createDirectory nested: true true",
    "createDirectory there: made",
    "createDirectory on a file: THROWS IOError 3002",
    "createDirectory app: THROWS SecurityError 0 fileWriteResource",
    "deleteFile missing: THROWS IOError 3003",
    "deleteFile directory: THROWS IOError 3001",
    "deleteDirectory file: THROWS IOError 3007",
    "deleteDirectory not empty: THROWS IOError 3010",
    "deleteDirectory missing: THROWS IOError 3003",
    "deleteDirectory with contents: false",
    "deleteFile: false",
    "copyTo: 1,2,3,4,5,6",
    "copyTo there: THROWS IOError 3012",
    "copyTo there overwrite: 1,2,3",
    "copyTo missing: THROWS IOError 3003",
    "copyTo missing directories: 1,2,3,4,5,6",
    "copyTo directory: 7",
    "copyTo directory overwrite: copied",
    "copyTo itself: THROWS IOError 3014",
    "copyTo from app: 104,101,108,108,111",
    "copyTo into app: THROWS SecurityError 0 fileWriteResource",
    "moveTo: false 1,2,3",
    "moveTo there: THROWS IOError 3012",
    "moveTo directory: false true",
    "moveTo from app: THROWS SecurityError 0 fileWriteResource",
    "listing: d.bin,fromapp.bin,moved.bin,p1,u.bin,w,wmoved",
    "async copy: asked",
    "async into app: THROWS SecurityError 0 fileWriteResource",
    "async copy: ioError 3014",
    "async delete: ioError 3003 Error #3003: File or directory does not exist.",
    "async listing: 1 sub",
    "async move: complete false true",
  ]);
});

/** A file system in memory, "/"-separated: its files' bytes, and its directories. */
class MemoryFiles {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set(["/", "/app", "/storage", "/user", "/temp"]);
  /** Whether it refuses every write. */
  refuses = false;

  host(cache: string | undefined, writes = true): FileSystemHost {
    const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
    const host: FileSystemHost = {
      separator: "/",
      directories: {
        application: "/app",
        applicationStorage: "/storage",
        user: "/user",
        documents: "/user",
        desktop: "/user",
        cache,
      },
      stat: (path) => {
        const file = this.files.get(path);
        if (file) {
          return { directory: false, size: file.length, modified: 0, created: 0 };
        }

        return this.directories.has(path)
          ? { directory: true, size: 0, modified: 0, created: 0 }
          : null;
      },
      list: (path) => {
        if (!this.directories.has(path)) {
          return null;
        }

        return [...this.files.keys(), ...this.directories]
          .filter((p) => p !== "/" && parentOf(p) === path)
          .map((p) => p.slice(p.lastIndexOf("/") + 1))
          .sort();
      },
      read: (path) => this.files.get(path) ?? null,
    };
    if (!writes) {
      return host;
    }

    return {
      ...host,
      write: (path, bytes, offset, length) => {
        if (this.refuses || this.directories.has(path)) {
          return false;
        }

        const old = this.files.get(path) ?? new Uint8Array(0);
        const next = new Uint8Array(length);
        next.set(old.subarray(0, Math.min(old.length, length)));
        next.set(bytes.subarray(0, Math.max(0, Math.min(bytes.length, length - offset))), offset);
        this.files.set(path, next);
        this.directories.add(parentOf(path));
        return true;
      },
      createDirectory: (path) => {
        if (this.refuses || this.files.has(path)) {
          return false;
        }

        this.directories.add(path);
        return true;
      },
      remove: (path) => {
        if (this.refuses) {
          return false;
        }

        return this.files.delete(path) || this.directories.delete(path);
      },
    };
  }
}

/** The script that traces each of `checks`, or what it throws: label, then value or THROWS class id. */
function tempScript(name: string, checks: [string, string][]): string {
  return `package {
  import flash.display.Sprite;
  import flash.filesystem.*;
  import flash.utils.getQualifiedClassName;

  public class ${name} extends Sprite {
    private function t(label:String, f:Function):void {
      try {
        trace(label + ": " + f());
      } catch (e:Error) {
        trace(label + ": THROWS " + getQualifiedClassName(e).replace(/^.*::/, "") + " " + e.errorID);
      }
    }

    private static function describe(f:File):String {
      return [f.nativePath, f.url, f.name, f.extension, f.exists, f.isDirectory, f.isDirectory ? f.getDirectoryListing().length : f.size, f.parent.nativePath].join(" | ");
    }

    public function ${name}() {
${checks.map(([label, body]) => `      t(${JSON.stringify(label)}, function():* { ${body} });`).join("\n")}
    }
  }
}
`;
}

/** adl's names: "fla", up to four hexadecimal digits, ".tmp". */
const NAME = /^fla[0-9a-f]{1,4}\.tmp$/;

test("createTempFile and createTempDirectory make each a new one in the temporary directory", {
  skip,
}, async () => {
  const memory = new MemoryFiles();
  const lines = await play(
    "TempMade",
    tempScript("TempMade", [
      ["file", "return describe(File.createTempFile());"],
      ["file", "return describe(File.createTempFile());"],
      ["directory", "return describe(File.createTempDirectory());"],
      ["directory", "return describe(File.createTempDirectory());"],
      [
        "written",
        'var f:File = File.createTempFile(); var s:FileStream = new FileStream(); s.open(f, FileMode.WRITE); s.writeUTFBytes("hello"); s.close(); s.open(f, FileMode.READ); var text:String = s.readUTFBytes(s.bytesAvailable); s.close(); return text + " " + f.size;',
      ],
      [
        "in a directory",
        'var d:File = File.createTempDirectory(); var f:File = d.resolvePath("x.txt"); var s:FileStream = new FileStream(); s.open(f, FileMode.WRITE); s.writeUTFBytes("x"); s.close(); return d.getDirectoryListing().length + " " + f.exists;',
      ],
    ]),
    0,
    memory.host("/temp"),
  );

  assert.equal(lines.length, 6, lines.join("\n"));
  const made = lines.slice(0, 4).map((line) => {
    const [label, rest] = line.split(": ");
    const [nativePath, url, name, extension, exists, directory, content, parent] =
      rest.split(" | ");
    assert.match(name, NAME, line);
    assert.equal(nativePath, `/temp/${name}`, line);
    assert.equal(url, `file:///temp/${name}`, line);
    assert.equal(extension, "tmp", line);
    assert.equal(exists, "true", line);
    assert.equal(directory, String(label === "directory"), line);
    // Empty: no bytes, or nothing in it.
    assert.equal(content, "0", line);
    assert.equal(parent, "/temp", line);
    return nativePath;
  });

  assert.equal(new Set(made).size, 4, lines.join("\n"));
  for (const path of made.slice(0, 2)) {
    assert.deepEqual(memory.files.get(path), new Uint8Array(0));
  }

  for (const path of made.slice(2)) {
    assert.ok(memory.directories.has(path), path);
  }

  assert.deepEqual(lines.slice(4), ["written: hello 5", "in a directory: 1 true"]);
});

const tempSource = (name: string) =>
  tempScript(name, [
    ["file", 'var f:File = File.createTempFile(); return f.nativePath + " " + f.exists;'],
    ["directory", 'var f:File = File.createTempDirectory(); return f.nativePath + " " + f.exists;'],
  ]);

test("a name taken is passed by, and with none left nothing is made", { skip }, async () => {
  // Every name but one taken, by files and directories alike.
  const memory = new MemoryFiles();
  for (let unique = 1; unique <= 0xffff; unique++) {
    const path = `/temp/fla${unique.toString(16)}.tmp`;
    if (unique === 0xbeef) {
      continue;
    }

    if (unique % 2) {
      memory.files.set(path, new Uint8Array([1]));
    } else {
      memory.directories.add(path);
    }
  }

  assert.deepEqual(await play("TempTaken", tempSource("TempTaken"), 0, memory.host("/temp")), [
    "file: /temp/flabeef.tmp true",
    "directory: THROWS IllegalOperationError 2014",
  ]);
});

test("where none can be made, the file's File is given with nothing there, as adl's", {
  skip,
}, async () => {
  // adl with its temporary directory read-only: a name, not made, for the file; a refusal for
  // the directory.
  const refusing = new MemoryFiles();
  refusing.refuses = true;
  for (const [name, host] of [
    ["TempRefused", refusing.host("/temp")],
    ["TempReadOnly", new MemoryFiles().host("/temp", false)],
  ] as const) {
    const lines = await play(name, tempSource(name), 0, host);
    assert.match(lines[0], /^file: \/temp\/fla[0-9a-f]{1,4}\.tmp false$/);
    assert.deepEqual(lines.slice(1), ["directory: THROWS IllegalOperationError 2014"]);
  }

  // A host with no temporary directory has nowhere to name one.
  assert.deepEqual(
    await play("TempNoCache", tempSource("TempNoCache"), 0, new MemoryFiles().host(undefined)),
    ["file: THROWS IllegalOperationError 2014", "directory: THROWS IllegalOperationError 2014"],
  );
});
