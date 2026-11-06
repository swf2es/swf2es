// flash.filesystem.File over a host's file system, as adl (AIR 51.3) has
// it: the native path and the URL of each File, app:/ kept as paths
// resolve and go up, what is refused, and what reads a file. adl ran the
// same scripts on Windows; the paths here are a POSIX host's, the rest as
// adl traced it.
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
const out = fileURLToPath(new URL("../../../../out/player-file/", import.meta.url));
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
};

async function play(name: string, source: string): Promise<string[]> {
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
    await player.start();
  } finally {
    player.destroy();
  }

  return lines;
}

/** The script that traces each of `checks`, or what it throws: label, then value or THROWS name id. */
function script(name: string, checks: [string, string][]): string {
  return `package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.events.InvokeEvent;
  import flash.filesystem.File;

  public class ${name} extends Sprite {
    private function t(label:String, f:Function):void {
      try {
        trace(label, f());
      } catch (e:Error) {
        trace(label, "THROWS", e.name, e.errorID);
      }
    }

    public function ${name}() {
      var app:File = File.applicationDirectory;
      var sub:File = app.resolvePath("sub dir");
      var txt:File = sub.resolvePath("a b.txt");
${checks.map(([label, body]) => `      t(${JSON.stringify(label)}, function():* { ${body} });`).join("\n")}
    }
  }
}
`;
}

test("a File's path and URL, and what it reads, as adl's", { skip }, async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(`${app}/sub dir`, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeFileSync(`${app}/sub dir/a b.txt`, "hello\n");

  const lines = await play(
    "Files",
    script("Files", [
      ["separator", "return File.separator;"],
      [
        "app",
        'return [app.nativePath, app.url, app.name, app.extension, app.isDirectory].join(" | ");',
      ],
      [
        "app/sub",
        'return [txt.nativePath, txt.url, txt.name, txt.extension, txt.exists, txt.isDirectory, txt.size, txt.type].join(" | ");',
      ],
      [
        "dotdot",
        'var f:File = app.resolvePath("x/../sub dir/./a b.txt"); return [f.nativePath, f.url, f.exists].join(" | ");',
      ],
      ["up", 'var f:File = app.resolvePath("../.."); return [f.nativePath, f.url].join(" | ");'],
      ["up then down", 'return app.resolvePath("../sub dir").url;'],
      ["app parent", "return app.parent;"],
      ["parent under app", 'return [txt.parent.url, sub.parent.url].join(" | ");'],
      [
        "new native",
        `var f:File = new File(${JSON.stringify(`${app}/sub dir/a b.txt`)}); return [f.url, f.exists, f.size].join(" | ");`,
      ],
      [
        "new file url",
        `var f:File = new File(${JSON.stringify(`file://${app}/sub%20dir/a%20b.txt`)}); return [f.nativePath == txt.nativePath, f.exists].join(" | ");`,
      ],
      [
        "new app url",
        'var f:File = new File("app:/sub dir/a b.txt"); return [f.nativePath == txt.nativePath, f.url].join(" | ");',
      ],
      ["new relative", 'return new File("sub dir/a b.txt").nativePath;'],
      ["new empty", "return new File().nativePath;"],
      ["new empty exists", "return new File().exists;"],
      ["set nativePath rel", 'var f:File = new File(); f.nativePath = "rel"; return f.nativePath;'],
      ["url bad", 'var f:File = new File(); f.url = "http://x/y"; return f.nativePath;'],
      [
        "missing",
        'var m:File = app.resolvePath("nope.swf"); return [m.exists, m.isDirectory, m.name, m.extension, m.type].join(" | ");',
      ],
      ["missing size", 'return app.resolvePath("nope.swf").size;'],
      ["missing modified", 'return app.resolvePath("nope.swf").modificationDate;'],
      ["dir size and type", 'return [sub.size, sub.type].join(" | ");'],
      ["root parent", 'return new File("/").parent;'],
      [
        "listing",
        'var l:Array = sub.getDirectoryListing(); return l.length + " " + l[0].name + " " + l[0].url;',
      ],
      ["list file", "return txt.getDirectoryListing().length;"],
      ["list missing", 'return app.resolvePath("nope").getDirectoryListing().length;'],
      ["rel", "return app.getRelativePath(txt);"],
      ["rel dotdot", 'return txt.getRelativePath(app.resolvePath("other/x"), true);'],
      ["rel unrelated", 'return txt.getRelativePath(app.resolvePath("other/x"));'],
      ["clone", 'var c:File = txt.clone(); return [c.url, c == txt].join(" | ");'],
      ["chars", 'return app.resolvePath("a!\'()*~-_.b&=+,;$@[]").url;'],
      ["unicode", 'return app.resolvePath("ä ö#?%.txt").url;'],
      ["resolve app url", 'return app.resolvePath("app:/sub dir").url;'],
      [
        "storage",
        'var s:File = File.applicationStorageDirectory; return [s.url, s.resolvePath("x").url].join(" | ");',
      ],
      ["flags", 'return [txt.isHidden, txt.isPackage, txt.isSymbolicLink].join(" | ");'],
      ["toString", "return String(txt);"],
    ]),
  );

  assert.deepEqual(lines, [
    "separator /",
    `app ${app} | app:/ | app |  | true`,
    `app/sub ${app}/sub dir/a b.txt | app:/sub%20dir/a%20b.txt | a b.txt | txt | true | false | 6 | .txt`,
    `dotdot ${app}/sub dir/a b.txt | app:/sub%20dir/a%20b.txt | true`,
    // ".." never climbs out of app:/.
    `up ${app} | app:/`,
    "up then down app:/sub%20dir",
    "app parent null",
    "parent under app app:/sub%20dir | app:/",
    `new native file://${app}/sub%20dir/a%20b.txt | true | 6`,
    "new file url true | true",
    "new app url true | app:/sub%20dir/a%20b.txt",
    "new relative THROWS ArgumentError 2004",
    "new empty THROWS Error 2037",
    "new empty exists THROWS Error 2037",
    "set nativePath rel THROWS ArgumentError 2004",
    "url bad THROWS ArgumentError 2004",
    "missing false | false | nope.swf | swf | .swf",
    "missing size THROWS Error 3003",
    "missing modified THROWS Error 3003",
    "dir size and type 0 | ",
    "root parent null",
    "listing 1 a b.txt app:/sub%20dir/a%20b.txt",
    "list file THROWS Error 3007",
    "list missing THROWS Error 3003",
    "rel sub dir/a b.txt",
    "rel dotdot ../../other/x",
    "rel unrelated null",
    "clone app:/sub%20dir/a%20b.txt | false",
    "chars app:/a!'()*~-_.b%26%3D%2B%2C%3B%24%40%5B%5D",
    "unicode app:/%C3%A4%20%C3%B6%23%3F%25.txt",
    "resolve app url app:/sub%20dir",
    "storage app-storage:/ | app-storage:/x",
    "flags false | false | false",
    "toString [object File]",
  ]);
});

test("the launch's InvokeEvent carries the directory it was launched from", { skip }, async () => {
  mkdirSync(app, { recursive: true });
  const lines = await play(
    "Launched",
    `package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.events.InvokeEvent;

  public class Launched extends Sprite {
    public function Launched() {
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void {
        trace(i.currentDirectory.nativePath, i.currentDirectory.url);
      });
    }
  }
}
`,
  );

  assert.deepEqual(lines, [`${app} file://${app}`]);
});
