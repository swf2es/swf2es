// The desktop app's sandbox (apps/desktop/src/main/sandbox.ts) in node:
// what each SWF may read, as its UseNetwork bit chose, and that a grant
// lasts only while its SWF plays.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FILE_ORIGIN, Sandbox } from "../../apps/desktop/src/main/sandbox.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "swf2es-sandbox-")));
after(() => rmSync(home, { recursive: true, force: true }));
for (const [path, text] of [
  ["games/a.swf", "FWS"],
  ["games/data.txt", "data"],
  ["games/levels/1.txt", "level"],
  ["games/b.swf", "FWS"],
  ["secret.txt", "secret"],
  ["top.swf", "FWS"],
]) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text);
}

symlinkSync(join(home, "secret.txt"), join(home, "games/link.txt"));

/** The decoded path of a URL the SWF at `url` asks for by `relative`. */
const asked = (url: string, relative: string) =>
  decodeURIComponent(new URL(relative, url).pathname);

/** Play `swf` and fetch it, as the page does, which puts its grant in force. */
async function playing(sandbox: Sandbox, swf: string, network: boolean): Promise<string> {
  const url = sandbox.play(join(home, swf), network);
  assert.equal(await sandbox.resolve(asked(url, url)), join(home, swf));
  return url;
}

test("local-with-filesystem reads its own directory and below, and no network", async () => {
  const sandbox = new Sandbox(home);
  const url = await playing(sandbox, "games/a.swf", false);
  assert.equal(sandbox.type, "localWithFile");
  assert.equal(sandbox.networkAllowed(), false);
  assert.equal(await sandbox.resolve(asked(url, "data.txt")), join(home, "games/data.txt"));
  assert.equal(await sandbox.resolve(asked(url, "levels/1.txt")), join(home, "games/levels/1.txt"));
  // Out of its directory, by .., by an escaped slash, or by a link: refused.
  assert.equal(await sandbox.resolve(asked(url, "../secret.txt")), null);
  assert.equal(await sandbox.resolve(asked(url, "..%2Fsecret.txt")), null);
  assert.equal(await sandbox.resolve(asked(url, "link.txt")), null);
  assert.equal(await sandbox.resolve(`/x${asked(url, "data.txt").slice(2)}`), null);
});

test("local-with-networking reads only itself", async () => {
  const sandbox = new Sandbox(home);
  const url = await playing(sandbox, "games/a.swf", true);
  assert.equal(sandbox.type, "localWithNetwork");
  assert.equal(sandbox.networkAllowed(), true);
  assert.equal(await sandbox.resolve(asked(url, "data.txt")), null);
  assert.equal(await sandbox.resolve(asked(url, "../secret.txt")), null);
});

test("a SWF in the home directory reads only itself, though it has no network", async () => {
  const sandbox = new Sandbox(home);
  const url = await playing(sandbox, "top.swf", false);
  assert.equal(await sandbox.resolve(asked(url, "secret.txt")), null);
  assert.equal(await sandbox.resolve(asked(url, "games/data.txt")), null);
});

test("a SWF where every user's or program's files are reads only itself", async () => {
  // The sandbox's home is games/, so home's own directory holds every user's.
  const sandbox = new Sandbox(join(home, "games"));
  const url = await playing(sandbox, "top.swf", false);
  assert.equal(await sandbox.resolve(asked(url, "secret.txt")), null);

  // Every program's temporary directory, and a file another left there.
  const swf = join(tmpdir(), `swf2es-sandbox-${process.pid}.swf`);
  const other = join(tmpdir(), `swf2es-sandbox-${process.pid}.txt`);
  writeFileSync(swf, "FWS");
  writeFileSync(other, "another program's");
  try {
    const temporary = new Sandbox(home);
    const at = temporary.play(swf, false);
    assert.equal(await temporary.resolve(asked(at, at)), realpathSync(swf));
    assert.equal(await temporary.resolve(asked(at, `swf2es-sandbox-${process.pid}.txt`)), null);
  } finally {
    rmSync(swf);
    rmSync(other);
  }
});

test("a home that is a link is known as both, as are both parents", async () => {
  const parent = join(home, "users");
  mkdirSync(join(parent, "me"), { recursive: true });
  writeFileSync(join(parent, "me", "mine.swf"), "FWS");
  writeFileSync(join(parent, "me", "mine.txt"), "mine");
  writeFileSync(join(parent, "all.swf"), "FWS");
  writeFileSync(join(parent, "other.txt"), "another user's");
  const link = join(home, "home-link");
  symlinkSync(join(parent, "me"), link);
  const sandbox = new Sandbox(link);

  const mine = await playing(sandbox, "users/me/mine.swf", false);
  assert.equal(await sandbox.resolve(asked(mine, "mine.txt")), null);
  const all = await playing(sandbox, "users/all.swf", false);
  assert.equal(await sandbox.resolve(asked(all, "other.txt")), null);
  // And the link's own parent, which holds it as /home holds a home.
  const top = await playing(sandbox, "top.swf", false);
  assert.equal(await sandbox.resolve(asked(top, "secret.txt")), null);
});

test("the URL tells nothing of where the SWF is", () => {
  const url = new Sandbox(home).play(join(home, "games/a.swf"), false);
  assert.match(url, new RegExp(`^${FILE_ORIGIN}/[0-9a-f]{16}/a\\.swf$`));
  assert.equal(url.includes(home.split("/").at(-1) as string), false);
  // The same from run to run, for its SharedObjects.
  assert.equal(new Sandbox(home).play(join(home, "games/a.swf"), false), url);
});

test("only the SWF playing has a grant, from when the page fetches it", async () => {
  const sandbox = new Sandbox(home);
  const a = await playing(sandbox, "games/a.swf", false);
  const b = sandbox.play(join(home, "games/b.swf"), true);
  // Opened, not yet fetched: the last SWF's grant is gone, the next not yet in force.
  assert.equal(sandbox.type, null);
  assert.equal(sandbox.networkAllowed(), false);
  assert.equal(await sandbox.resolve(asked(a, "data.txt")), null);
  assert.equal(await sandbox.resolve(asked(b, b)), join(home, "games/b.swf"));
  assert.equal(sandbox.networkAllowed(), true);

  sandbox.stop();
  assert.equal(sandbox.type, null);
  assert.equal(await sandbox.resolve(asked(b, b)), null);
});

test("a remote SWF reads no local file, and has the network once the page asks for it", async () => {
  const sandbox = new Sandbox(home);
  const local = await playing(sandbox, "games/a.swf", false);
  sandbox.playRemote("http://swf.test/movie.swf");
  assert.equal(sandbox.type, null);
  assert.equal(sandbox.swf, "http://swf.test/movie.swf");
  assert.equal(sandbox.networkAllowed(), false);
  assert.equal(sandbox.startRemote("http://swf.test/other.swf"), false);
  assert.equal(sandbox.startRemote("http://swf.test/movie.swf"), true);
  assert.equal(sandbox.type, "remote");
  assert.equal(sandbox.networkAllowed(), true);
  // Asked for again, as a page that reloads does.
  assert.equal(sandbox.startRemote("http://swf.test/movie.swf"), true);
  // No file, the last SWF's included.
  assert.equal(await sandbox.resolve(asked(local, "data.txt")), null);
  assert.equal(await sandbox.resolve(asked(local, local)), null);
  assert.equal(await sandbox.resolve("/null/a.swf"), null);

  sandbox.stop();
  assert.equal(sandbox.startRemote("http://swf.test/movie.swf"), false);
  assert.equal(sandbox.networkAllowed(), false);
});
