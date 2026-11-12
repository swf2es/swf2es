// Local paths found as Windows and macOS find them, ignoring case
// (apps/desktop/src/main/case-paths.ts), and what an AIR application's
// File and a local SWF's loads then reach through it (air.ts, sandbox.ts).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import {
  createDirectoryOf,
  listOf,
  moveOf,
  readOf,
  removeOf,
  statOf,
  writeOf,
} from "../../apps/desktop/src/main/air.ts";
import { resolveCase } from "../../apps/desktop/src/main/case-paths.ts";
import { Sandbox } from "../../apps/desktop/src/main/sandbox.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "swf2es-case-")));
after(() => rmSync(home, { recursive: true, force: true }));
for (const [path, text] of [
  ["app/maps/meadow/pond-bank.swf", "FWS"],
  ["app/maps/meadow/Notes/readme.txt", "notes"],
  ["app/main.swf", "FWS"],
  ["app/twins/a.swf", "lower"],
  ["app/twins/A.swf", "upper"],
  ["app/Twin/x.txt", "one"],
  ["app/twin/x.txt", "two"],
  ["app/exact/c.txt", "lower"],
  ["app/exact/C.txt", "upper"],
  ["secret.txt", "secret"],
]) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text);
}

const app = join(home, "app");
const pond = join(app, "maps/meadow/pond-bank.swf");

test("a path that is there is kept, unlisted", () => {
  assert.equal(resolveCase(pond), pond);
  assert.equal(resolveCase(join(app, "twins/A.swf")), join(app, "twins/A.swf"));
});

test("a segment in another case, at any depth, is the entry equal to it ignoring case", () => {
  assert.equal(resolveCase(join(app, "maps/Meadow/pond-Bank.swf")), pond);
  assert.equal(resolveCase(join(app, "MAPS/meadow/pond-bank.swf")), pond);
  assert.equal(resolveCase(join(app, "Maps/MEADOW/Pond-Bank.SWF")), pond);
  assert.equal(
    resolveCase(join(app, "MAPS/Meadow/notes/README.TXT")),
    join(app, "maps/meadow/Notes/readme.txt"),
  );
  // A segment there exactly, after one found by case, wins over its twins in case.
  assert.equal(resolveCase(join(app, "EXACT/c.txt")), join(app, "exact/c.txt"));
  assert.equal(resolveCase(join(app, "EXACT/C.txt")), join(app, "exact/C.txt"));
  // Only on a file system that tells case apart.
  const asked = join(app, "MAPS/meadow/pond-bank.swf");
  assert.equal(resolveCase(asked, false), asked);
});

test("names compare as NFC, lowercased", () => {
  const decomposed = "Äiti.txt".normalize("NFD");
  writeFileSync(join(app, decomposed), "nfd");
  assert.equal(resolveCase(join(app, "äiti.TXT")), join(app, decomposed));
});

test("names that differ only in case are not guessed between, and said once", () => {
  const said = mock.method(console, "error", () => {});
  try {
    const asked = join(app, "twins/a.SWF");
    assert.equal(resolveCase(asked), asked);
    assert.equal(resolveCase(asked), asked);
    assert.equal(statOf(asked), null);
    const inTwin = join(app, "TWIN/x.txt");
    assert.equal(resolveCase(inTwin), inTwin);
    assert.equal(said.mock.callCount(), 2);
    assert.match(String(said.mock.calls[0].arguments[0]), /a\.swf, A\.swf|A\.swf, a\.swf/);
    // Exact still wins.
    assert.equal(readFileSync(resolveCase(join(app, "twins/a.swf")), "utf8"), "lower");
  } finally {
    said.mock.restore();
  }
});

test("what is missing stays missing; what follows the last found keeps its name", () => {
  assert.equal(
    resolveCase(join(app, "MAPS/meadow/castle.swf")),
    join(app, "maps/meadow/castle.swf"),
  );
  assert.equal(resolveCase(join(app, "MAPS/Forest/Glade.swf")), join(app, "maps/Forest/Glade.swf"));
  assert.equal(statOf(join(app, "MAPS/meadow/castle.swf")), null);
  assert.equal(readOf(join(app, "MAPS/Forest/Glade.swf")), null);
  assert.equal(resolveCase("relative/Path"), "relative/Path");
});

test("File's reads, lists and stats find a path in another case", () => {
  assert.equal(statOf(join(app, "Maps/Meadow/Pond-Bank.swf"))?.size, 3);
  assert.equal(statOf(join(app, "MAPS"))?.directory, true);
  assert.deepEqual(listOf(join(app, "maps/MEADOW"))?.sort(), ["Notes", "pond-bank.swf"]);
  assert.equal(
    new TextDecoder().decode(readOf(join(app, "MAPS/meadow/notes/Readme.txt")) ?? new Uint8Array()),
    "notes",
  );
});

test("writes go into a directory there in another case, and a new file keeps its name", () => {
  const save = join(home, "save");
  mkdirSync(join(save, "slots"), { recursive: true });
  const bytes = new TextEncoder().encode("slot");
  assert.equal(writeOf(join(save, "SLOTS/Slot1.dat"), bytes, 0, bytes.length), true);
  assert.deepEqual(readdirSync(join(save, "slots")), ["Slot1.dat"]);
  assert.equal(existsSync(join(save, "SLOTS")), false);

  // A file there in another case is written over, as Windows writes it.
  const more = new TextEncoder().encode("again");
  assert.equal(writeOf(join(save, "slots/SLOT1.DAT"), more, 0, more.length), true);
  assert.deepEqual(readdirSync(join(save, "slots")), ["Slot1.dat"]);
  assert.equal(readFileSync(join(save, "slots/Slot1.dat"), "utf8"), "again");

  assert.equal(createDirectoryOf(join(save, "Slots/Backup")), true);
  assert.deepEqual(readdirSync(join(save, "slots")).sort(), ["Backup", "Slot1.dat"]);

  // A move's source in another case; a rename of its case alone renames it.
  assert.equal(moveOf(join(save, "SLOTS/slot1.dat"), join(save, "Slots/backup/Slot1.dat")), true);
  assert.deepEqual(readdirSync(join(save, "slots/Backup")), ["Slot1.dat"]);
  assert.equal(
    moveOf(join(save, "slots/Backup/Slot1.dat"), join(save, "slots/Backup/SLOT1.dat")),
    true,
  );
  assert.deepEqual(readdirSync(join(save, "slots/Backup")), ["SLOT1.dat"]);

  assert.equal(removeOf(join(save, "SLOTS/BACKUP")), true);
  assert.deepEqual(readdirSync(join(save, "slots")), []);
});

test("no way out through .. that the path as given lacks", async () => {
  // Names are found in the directories the path names; .. is followed as given.
  assert.equal(
    resolveCase(`${join(app, "MAPS/Meadow")}/../../../SECRET.TXT`),
    `${join(app, "maps/meadow")}/../../../secret.txt`,
  );

  // A SWF in local-with-filesystem reads its own directory below in any case, and still nothing above.
  const sandbox = new Sandbox(join(home, "nobody"));
  const url = sandbox.play(join(app, "main.swf"), false);
  const asked = (relative: string) => decodeURIComponent(new URL(relative, url).pathname);
  assert.equal(await sandbox.resolve(asked(url)), join(app, "main.swf"));
  assert.equal(await sandbox.resolve(asked("Main.SWF")), join(app, "main.swf"));
  assert.equal(await sandbox.resolve(asked("Maps/Meadow/pond-Bank-16.swf")), null);
  assert.equal(await sandbox.resolve(asked("Maps/Meadow/Pond-Bank.swf")), pond);
  assert.equal(await sandbox.resolve(asked("../SECRET.txt")), null);
  assert.equal(await sandbox.resolve(asked("..%2FSecret.TXT")), null);
  assert.equal(await sandbox.resolve(asked("MAPS/..%2F..%2FSecret.TXT")), null);
});
