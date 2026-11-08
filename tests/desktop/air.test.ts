// The desktop app's AIR applications in node (apps/desktop/src/main/air.ts
// and descriptor.ts): an application named adl's way on the command line,
// what its descriptor says, its launch and storage, the file system its
// File reads and writes, and the sandbox it plays in (sandbox.ts).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, test } from "node:test";
import {
  airCommand,
  airLaunch,
  createDirectoryOf,
  listOf,
  moveOf,
  removeOf,
  statOf,
  writeOf,
} from "../../apps/desktop/src/main/air.ts";
import { Sandbox } from "../../apps/desktop/src/main/sandbox.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "swf2es-air-")));
after(() => rmSync(home, { recursive: true, force: true }));

const DESCRIPTOR = `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
    <id>org.example.app</id>
    <filename>App</filename>
    <!-- <content>Commented.swf</content> -->
    <initialWindow>
        <content>bin/Main.swf</content>
        <title>Tom &amp; Jerry&#39;s</title>
        <width>960</width>
        <height>550</height>
    </initialWindow>
</application>`;

test("the command line names an application as adl's does", () => {
  mkdirSync(join(home, "app", "root"), { recursive: true });
  const cwd = join(home, "app");
  assert.deepEqual(airCommand(["--trace", "App-app.xml", "--", "test", "pass word"], cwd), {
    descriptor: join(cwd, "App-app.xml"),
    root: null,
    arguments: ["test", "pass word"],
  });
  // A directory after the descriptor is where its content is.
  assert.deepEqual(airCommand(["App-app.xml", "root"], cwd), {
    descriptor: join(cwd, "App-app.xml"),
    root: join(cwd, "root"),
    arguments: [],
  });
  // What follows "--" is the application's, a descriptor's name among it.
  assert.equal(airCommand(["movie.swf", "--", "other.xml"], cwd), null);
});

test("an application's launch, its storage made, and the file system its File reads", () => {
  const app = join(home, "launch");
  mkdirSync(join(app, "bin"), { recursive: true });
  writeFileSync(join(app, "App-app.xml"), DESCRIPTOR);
  writeFileSync(join(app, "bin", "Main.swf"), "FWS");
  writeFileSync(join(app, ".hidden"), "");
  const userData = join(home, "user-data");
  const opened = airLaunch(
    { descriptor: join(app, "App-app.xml"), root: null, arguments: ["a"] },
    home,
    userData,
    { documents: join(home, "docs"), desktop: join(home, "desk"), cache: join(home, "cache") },
  );

  assert.equal(opened.content, join(app, "bin", "Main.swf"));
  assert.equal(opened.relative, "bin/Main.swf");
  assert.equal(opened.title, "Tom & Jerry's");
  assert.deepEqual([opened.width, opened.height], [960, 550]);
  assert.equal(opened.launch.id, "org.example.app");
  assert.equal(opened.launch.descriptor, DESCRIPTOR);
  assert.deepEqual(opened.launch.arguments, ["a"]);
  assert.equal(opened.launch.currentDirectory, home);
  assert.equal(opened.launch.separator, sep);
  assert.equal(opened.launch.directories.application, app);
  const storage = join(userData, "air", "org.example.app", "Local Store");
  assert.equal(opened.launch.directories.applicationStorage, storage);
  assert.ok(statSync(storage).isDirectory());

  const file = statOf(join(app, "bin", "Main.swf"));
  assert.deepEqual([file?.directory, file?.size, file?.hidden], [false, 3, false]);
  assert.deepEqual(
    [statOf(join(app, "bin"))?.directory, statOf(join(app, "bin"))?.size],
    [true, 0],
  );
  assert.equal(statOf(join(app, ".hidden"))?.hidden, true);
  assert.equal(statOf(join(app, "nope")), null);
  assert.deepEqual(listOf(join(app, "bin")), ["Main.swf"]);
  assert.equal(listOf(join(app, "nope")), null);
});

test("the file system an application's FileStream and File write", () => {
  const at = join(home, "writes");
  const file = join(at, "a", "b", "data.bin");
  assert.ok(writeOf(file, Uint8Array.of(1, 2, 3), 0, 3));
  assert.deepEqual([...readFileSync(file)], [1, 2, 3]);
  // Into the middle, then past the end with zeros between; then cut.
  assert.ok(writeOf(file, Uint8Array.of(9), 1, 3));
  assert.ok(writeOf(file, Uint8Array.of(8), 5, 6));
  assert.deepEqual([...readFileSync(file)], [1, 9, 3, 0, 0, 8]);
  assert.ok(writeOf(file, new Uint8Array(0), 2, 2));
  assert.deepEqual([...readFileSync(file)], [1, 9]);
  assert.equal(writeOf(join(file, "under"), Uint8Array.of(1), 0, 1), false);

  assert.ok(createDirectoryOf(join(at, "c", "d")));
  assert.ok(statSync(join(at, "c", "d")).isDirectory());
  assert.ok(moveOf(join(at, "a"), join(at, "moved", "a")));
  assert.deepEqual([...readFileSync(join(at, "moved", "a", "b", "data.bin"))], [1, 9]);
  assert.equal(existsSync(join(at, "a")), false);
  assert.equal(moveOf(join(at, "nope"), join(at, "x")), false);
  assert.ok(removeOf(join(at, "moved")));
  assert.equal(existsSync(join(at, "moved")), false);
  assert.equal(removeOf(join(at, "moved")), false);
});

test("an application's sandbox: granted as its content is read, reaching the network, gone as it stops", () => {
  const sandbox = new Sandbox(home);
  const content = join(home, "launch", "bin", "Main.swf");
  sandbox.playApplication(content);
  // Not before the page reads the content: the SWF before it never runs in its sandbox.
  assert.equal(sandbox.application, false);
  assert.equal(sandbox.startApplication(join(home, "launch", "other.swf")), false);
  assert.equal(sandbox.startApplication(content), true);
  assert.equal(sandbox.application, true);
  assert.equal(sandbox.type, "application");
  assert.equal(sandbox.networkAllowed(), true);
  // Once granted, the rest of the file system.
  assert.equal(sandbox.startApplication(join(home, "anything")), true);
  sandbox.stop();
  assert.equal(sandbox.application, false);
  assert.equal(sandbox.startApplication(content), false);
});
