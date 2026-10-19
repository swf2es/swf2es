import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bridgeFiles } from "../../apps/desktop/src/main/files.ts";

type Host = Parameters<typeof bridgeFiles>[3];
type Handler = Parameters<Host["ipcMain"]["handle"]>[1];
type Owner = NonNullable<ReturnType<Parameters<typeof bridgeFiles>[1]>>;

function bridge(paths: string[]) {
  const contents = new EventEmitter();
  const owner = { webContents: contents } as unknown as Owner;
  const handlers = new Map<string, Handler>();
  const ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  });
  const host: Host = {
    ipcMain: ipc as unknown as Host["ipcMain"],
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: paths }),
      showSaveDialog: async () => ({ canceled: false, filePath: paths[0] }),
    },
  };
  let allowed = true;
  bridgeFiles(
    () => allowed,
    () => owner,
    () => true,
    host,
  );
  const invoke = async (name: string, ...args: unknown[]) => {
    const handler = handlers.get(name);
    assert.ok(handler);

    return handler({} as Parameters<Handler>[0], ...args);
  };

  return {
    invoke,
    contents,
    host,
    deny: () => {
      allowed = false;
    },
  };
}

test("a failed multi-file selection grants none of its files", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "swf2es-file-selection-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const valid = join(folder, "valid.txt");
  await writeFile(valid, "selected content");
  const b = bridge([valid, join(folder, "missing.txt")]);
  await assert.rejects(b.invoke("files:browse", [], true), { code: "ENOENT" });
  // A sibling stat can finish after Promise.all has rejected.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(b.invoke("files:read", 1), /invalid file capability/);
  b.host.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [valid] });
  const selected = await b.invoke("files:browse", [], false);
  assert.equal(selected[0].id, 1);
  assert.equal(
    new TextDecoder().decode(await b.invoke("files:read", selected[0].id)),
    "selected content",
  );
});

test("selected files grant reads and save destinations grant only one write", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "swf2es-file-grants-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "selected.txt");
  await writeFile(file, "selected");
  const b = bridge([file]);
  const selected = await b.invoke("files:browse", [], false);
  assert.equal(new TextDecoder().decode(await b.invoke("files:read", selected[0].id)), "selected");
  await assert.rejects(
    b.invoke("files:write", selected[0].id, Uint8Array.of(65)),
    /invalid file capability/,
  );
  const destination = await b.invoke("files:save", "selected.txt");
  await assert.rejects(b.invoke("files:read", destination.id), /invalid file capability/);
  await b.invoke("files:write", destination.id, Uint8Array.of(65));
  assert.equal(await readFile(file, "utf8"), "A");
  await assert.rejects(
    b.invoke("files:write", destination.id, Uint8Array.of(66)),
    /invalid file capability/,
  );
});

test("navigation while selection metadata is pending grants no files", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "swf2es-file-navigation-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "selected.txt");
  await writeFile(file, "selected");
  const b = bridge([file]);
  const selection = b.invoke("files:browse", [], false);
  await Promise.resolve();
  b.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(await selection, []);
  await assert.rejects(b.invoke("files:read", 1), /invalid file capability/);
});

for (const operation of ["browse", "save"] as const) {
  test(`navigation while a ${operation} dialog is open invalidates its result`, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "swf2es-file-dialog-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const file = join(folder, "selected.txt");
    await writeFile(file, "selected");
    const b = bridge([file]);
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    b.host.dialog.showOpenDialog = async () => {
      await wait;
      return { canceled: false, filePaths: [file] };
    };
    b.host.dialog.showSaveDialog = async () => {
      await wait;
      return { canceled: false, filePath: file };
    };
    const pending =
      operation === "browse"
        ? b.invoke("files:browse", [], false)
        : b.invoke("files:save", "selected.txt");
    b.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    finish();
    assert.deepEqual(await pending, operation === "browse" ? [] : null);
    await assert.rejects(b.invoke("files:read", 1), /invalid file capability/);
    await assert.rejects(b.invoke("files:write", 1, Uint8Array.of(65)), /invalid file capability/);
    assert.equal(await readFile(file, "utf8"), "selected");
  });
}

test("navigation revokes existing grants and untrusted callers cannot open dialogs", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "swf2es-file-revocation-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "selected.txt");
  await writeFile(file, "selected");
  const b = bridge([file]);
  const selected = await b.invoke("files:browse", [], false);
  b.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(new TextDecoder().decode(await b.invoke("files:read", selected[0].id)), "selected");
  b.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  await assert.rejects(b.invoke("files:read", selected[0].id), /invalid file capability/);
  b.deny();
  b.host.dialog.showOpenDialog = async () => {
    throw new Error("untrusted caller opened a dialog");
  };
  b.host.dialog.showSaveDialog = async () => {
    throw new Error("untrusted caller opened a dialog");
  };
  assert.deepEqual(await b.invoke("files:browse", [], false), []);
  assert.equal(await b.invoke("files:save", "selected.txt"), null);
});
